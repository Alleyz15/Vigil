import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tileCache = process.env.VIGIL_QA_TILE_CACHE;
const tileMode = process.env.VIGIL_QA_TILE_MODE ?? "record";
if (tileCache) mkdirSync(tileCache, { recursive: true });
if (!["record", "replay"].includes(tileMode)) throw new Error("Unknown QA tile fixture mode.");
const tileFile = (url) => join(tileCache, `${createHash("sha256").update(url).digest("hex")}.png`);

/**
 * A REFUSED TILE IS STILL A VALID PNG, AND THAT IS THE TRAP.
 *
 * openstreetmap.org answers a denied tile request with HTTP 200 and an image
 * reading "Access blocked", carrying `x-blocked` and `x-totp: INVALID`. The
 * settle check below waits for every `.leaflet-tile` to finish loading, and a
 * refusal notice finishes loading perfectly — so a frame showing eight copies of
 * that notice satisfied every assertion and would have been written out as a
 * map. `response.ok` cannot see it either.
 *
 * So the refusal is read from the header the server sends. A capture that
 * cannot get tiles must fail, not write a frame that claims to show a map.
 */
function assertTileServed(url, headers) {
  const blocked = headers.get?.("x-blocked") ?? headers["x-blocked"] ?? headers["X-Blocked"];
  if (blocked) throw new Error(`Tile server refused ${url}: ${blocked}`);
}

/**
 * WHY THIS RECORDER NAMES ITSELF.
 *
 * The tile usage policy requires "a valid HTTP User-Agent that clearly
 * identifies your application", and says plainly that "traffic that uses these
 * defaults will be blocked because we cannot identify or contact the actual
 * application". Node's `fetch` sends a default, so every tile this recorder
 * fetched came back as a refusal — while the browser beside it, sending a
 * browser agent, was served the real thing. Measured: the same tile URL returns
 * the "Access blocked" image under curl's default agent and a real tile under
 * this one.
 *
 * The recorder fetches only the tiles the page is actively displaying, which is
 * what separates it from the bulk downloading the policy forbids.
 */
const TILE_USER_AGENT = "Vigil/0.1 (HackAI 2026 prototype; QA screenshot capture; https://github.com/)";

export async function captureStable(chromePath, url, target) {
  const profile = mkdtempSync(join(tmpdir(), "vigil-stable-"));
  const proc = spawn(chromePath, ["--headless=new", "--hide-scrollbars", "--disable-gpu",
    "--remote-debugging-port=0", "--force-prefers-reduced-motion", `--user-data-dir=${profile}`, "about:blank"]);
  let ws;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      const active = join(profile, "DevToolsActivePort");
      if (existsSync(active)) { port = Number(readFileSync(active, "utf8").split("\n")[0]); break; }
      await sleep(100);
    }
    if (!port) throw new Error("Chrome DevTools did not start.");
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    let onEvent = () => {};
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) { onEvent(message); return; }
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
      pending.set(mid, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const tileRequests = new Map(), tileBodies = new Map(), tileReads = [], fixtureErrors = [];
    const cancelledRequests = new Set();
    const interceptionError = async (error, networkId) => {
      await sleep(100);
      // Leaflet aborts offscreen tiles when its initial bounds settle.
      if (error.message === "Invalid InterceptionId." && cancelledRequests.has(networkId)) return;
      fixtureErrors.push(error);
    };
    onEvent = (message) => {
      if (message.method === "Network.loadingFailed" && message.params.canceled) cancelledRequests.add(message.params.requestId);
      if (message.method === "Fetch.requestPaused") {
        const { requestId, request, networkId } = message.params;
        const file = tileFile(request.url);
        if (existsSync(file)) {
          const bytes = readFileSync(file);
          tileBodies.set(request.url, createHash("sha256").update(bytes).digest("hex"));
          send("Fetch.fulfillRequest", { requestId, responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: bytes.toString("base64") }).catch(error => interceptionError(error, networkId));
        } else if (tileMode === "replay") {
          fixtureErrors.push(new Error(`Missing recorded QA tile: ${request.url}`));
          send("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(error => interceptionError(error, networkId));
        } else {
          // Record the real response even if Leaflet cancels this intermediate
          // viewport's request; a later replay must never depend on live tiles.
          tileReads.push(fetch(request.url, { headers: { "User-Agent": TILE_USER_AGENT } }).then(async (response) => {
            if (!response.ok) throw new Error(`QA tile recording failed (${response.status}): ${request.url}`);
            assertTileServed(request.url, response.headers);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error(`QA tile is not PNG: ${request.url}`);
            if (!existsSync(file)) writeFileSync(file, bytes, { flag: "wx" });
            const recorded = readFileSync(file);
            tileBodies.set(request.url, createHash("sha256").update(recorded).digest("hex"));
            await send("Fetch.fulfillRequest", { requestId, responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: recorded.toString("base64") })
              .catch(error => interceptionError(error, networkId));
          }).catch(error => fixtureErrors.push(error)));
        }
      }
      if (message.method === "Network.responseReceived" && message.params.response.url.includes(".tile.openstreetmap.org/")) {
        try {
          assertTileServed(message.params.response.url, message.params.response.headers ?? {});
        } catch (error) {
          fixtureErrors.push(error);
        }
        tileRequests.set(message.params.requestId, message.params.response.url);
      }
      if (!tileCache && message.method === "Network.loadingFinished" && tileRequests.has(message.params.requestId)) {
        const requestId = message.params.requestId;
        tileReads.push(send("Network.getResponseBody", { requestId }).then((response) => {
          const bytes = Buffer.from(response.body, response.base64Encoded ? "base64" : "utf8");
          const url = tileRequests.get(requestId);
          tileBodies.set(url, createHash("sha256").update(bytes).digest("hex"));
        }).catch(error => fixtureErrors.push(error)));
      }
    };
    await send("Network.enable");
    if (tileCache) await send("Fetch.enable", { patterns: [{ urlPattern: "https://*.tile.openstreetmap.org/*", requestStage: "Request" }] });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    /**
     * A FAILED NAVIGATION STILL RENDERS A PAGE, and that page has an <h1>.
     *
     * With no server listening, Chrome shows "This site can't be reached" —
     * `document.readyState` is `complete`, `document.querySelector('main, h1')`
     * matches its heading, the fonts load, nothing animates, and three
     * consecutive frames are identical. Every condition below is satisfied, and
     * the script writes that error page out under the filename of the surface it
     * claims to show. Measured, not imagined: it did exactly that here.
     *
     * `Page.navigate` reports the failure in `errorText`; the script simply was
     * not reading it.
     */
    const navigation = await send("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`Navigation failed for ${url}: ${navigation.errorText}`);
    let previous, stable = 0, lastState;
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      if (fixtureErrors.length) throw fixtureErrors[0];
      const state = await evaluate(`(() => ({
        ready: document.readyState === 'complete' && !!document.querySelector('main, h1'),
        fonts: document.fonts.status,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        loadingTiles: [...document.querySelectorAll('.leaflet-tile')].filter(i => !i.complete || !i.naturalWidth).length,
        // ANY map still loading, not one page's wording. This matched the literal
        // string 'Loading route map' — the operator's map — so when the sender
        // gained one saying 'Loading the service-area map', the check could not
        // see it: the predicate below only demands tiles IF a map is already
        // mounted, so a frame taken while the panel still read "loading" passed
        // every assertion. A capture must not photograph a page that is still
        // arriving.
        loadingMap: /loading[^.\\n]{0,40}map/i.test(document.body?.innerText ?? ''),
        mapTiles: document.querySelectorAll('.leaflet-tile').length,
        mapPresent: !!document.querySelector('.leaflet-container'),
        tileUrls: [...document.querySelectorAll('.leaflet-tile')].map(i => i.src).sort(),
        mapPaths: [...document.querySelectorAll('.leaflet-overlay-pane path')].map(p => ({ d: p.getAttribute('d'), stroke: p.getAttribute('stroke'), opacity: p.getAttribute('stroke-opacity') })),
        animations: document.getAnimations().filter(a => a.playState === 'running').length,
        zooming: !!document.querySelector('.leaflet-zoom-anim'),
        fingerprints: [...(document.body?.innerText ?? '').matchAll(/ed25519:[^\\s]+/g)].map(m => m[0])
      }))()`);
      lastState = state;
      if (state.ready && state.fonts === "loaded" && state.reducedMotion && !state.loadingMap && (!state.mapPresent || state.mapTiles > 0) && !state.loadingTiles && !state.animations && !state.zooming) {
        const shot = Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
        stable = previous?.equals(shot) ? stable + 1 : 0;
        previous = shot;
        if (stable >= 2) {
          await Promise.all(tileReads);
          if (fixtureErrors.length) throw fixtureErrors[0];
          writeFileSync(target, shot);
          writeFileSync(`${target}.json`, JSON.stringify({ url, ...state, tileMode: tileCache ? tileMode : "live", tileHashes: Object.fromEntries(tileBodies), consecutiveIdenticalFrames: stable + 1 }, null, 2));
          return;
        }
      } else { previous = undefined; stable = 0; }
      await sleep(250);
    }
    throw new Error(`Screenshot did not settle: ${url}: ${JSON.stringify(lastState)}`);
  } finally {
    ws?.close();
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill();
    await Promise.race([exited, sleep(5000)]);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* OS cleans a late Chrome profile lock. */ }
  }
}
