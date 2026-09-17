/**
 * The landing page, captured at a TRUE 1920x1080 viewport and CHECKED.
 *
 * Why not `chrome --screenshot` like capture-console.mjs:
 *   - a URL fragment (`/#ai`) lands on an unpainted region and returns a blank
 *     frame;
 *   - a tall `--window-size` distorts every `vh`-based layout, and this page is
 *     built from them — the hero is 82vh and the pipeline section is pinned for
 *     eight viewports. A capture at the wrong height is a picture of a page no
 *     viewer gets.
 * So this drives Chrome over the DevTools protocol: emulate a 1080-tall
 * viewport, scroll, wait for the state, capture.
 *
 * This lived in a session scratchpad until session 21. A recording that depends
 * on a file a tool will delete is session 17B's "script nobody runs" again.
 *
 * Every frame is preceded by a check that the page is in the state the
 * filename claims, and the run FAILS rather than writing a mislabelled frame:
 *
 *   hero        worst-case text contrast over real footage, at five paused
 *               times; a no-scrim control that must read lower (else the probe
 *               is inert); full-bleed width; no horizontal scroll
 *   pipeline    the phase attribute equals the phase being captured
 *   frame order REPORTED, not asserted — see the note where it is measured
 *   reduced     no video, no pinned sequence, the static list and the diagram
 *   narrow      below lg, the static list rather than the pinned sequence
 *
 * Needs the dev server on VIGIL_BASE_URL (default http://localhost:3000). It
 * reads state and writes nothing, so unlike capture-console.mjs it can be run
 * against any process, any number of times.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = process.env.VIGIL_QA_OUT ?? join(ROOT, "docs", "screenshots", "landing");
const BASE = process.env.VIGIL_BASE_URL ?? "http://localhost:3000";

const HEADLINE_MIN = 7;
const BODY_MIN = 4.5;
/**
 * How many paused frames the hero probe reads across one loop.
 *
 * NOT five evenly spaced frames. With light text over dark footage the failure
 * is a thin bright line crossing a glyph, which lasts a fraction of a second;
 * evenly spaced frames can step straight over it. The probe reads the whole
 * loop densely and reports the WORST frame per text block — the one where a
 * line sits closest to, or across, the text. The worst case is the standard.
 */
const HERO_SAMPLES = 96;

const chromePath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
]
  .filter(Boolean)
  .find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error("Chrome not found. Set CHROME_PATH to its executable.");

mkdirSync(OUT, { recursive: true });

/** `node scripts/qa/capture-landing.mjs pipeline` runs one group; no argument runs all. */
const ONLY = new Set(process.argv.slice(2));
const run = (group) => ONLY.size === 0 || ONLY.has(group);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextPort = 9340;

async function openPage({ width = 1920, height = 1080, reducedMotion = false, hideScrollbars = true } = {}) {
  const port = nextPort++;
  const profile = mkdtempSync(join(tmpdir(), "vigil-landing-"));
  const proc = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--autoplay-policy=no-user-gesture-required",
    ...(hideScrollbars ? ["--hide-scrollbars"] : []),
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);

  let wsUrl;
  for (let attempt = 0; attempt < 40 && !wsUrl; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) throw new Error("Chrome's DevTools endpoint never came up.");

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const raw = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });

  const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => raw(method, params, sessionId);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  if (reducedMotion) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
  }

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  const waitFor = async (expression, what, timeoutMs = 20_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${what}.`);
  };

  const screenshot = async (params = {}) =>
    Buffer.from((await send("Page.captureScreenshot", { format: "png", ...params })).data, "base64");

  // Windows keeps the profile locked until Chrome has actually exited, so wait
  // for the exit and tolerate a late lock: a temp directory left behind must
  // never fail a run whose frames are already on disk.
  const close = async () => {
    ws.close();
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill();
    await Promise.race([exited, sleep(5000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Left for the OS to clean.
    }
  };

  await send("Page.navigate", { url: `${BASE}/` });
  await waitFor(`document.readyState === "complete" && !!document.querySelector("main > header h1")`, "the landing page");
  await sleep(2500); // hydration, fonts, Lenis's dynamic import

  return { send, evaluate, waitFor, screenshot, close };
}

function save(name, buffer) {
  writeFileSync(join(OUT, name), buffer);
  console.log(`  wrote ${name}`);
}

function fail(message) {
  throw new Error(message);
}

/**
 * The dev overlay's issue badge, read out of its shadow root.
 *
 * Session 21's reduced-motion frame carried a red "1 Issue" badge: a hydration
 * mismatch that happened only for reduced-motion viewers, so no motion-allowed
 * frame showed it. A frame with that badge in it is not evidence of the page,
 * and nothing else in this script would have noticed, so every page checks.
 */
async function assertNoDevIssues(page, where) {
  const issue = await page.evaluate(`(async () => {
    const root = document.querySelector("nextjs-portal")?.shadowRoot;
    const badge = root && [...root.querySelectorAll("button")].find(b => /issue/i.test(b.textContent));
    if (!badge) return null;
    badge.click();
    await new Promise(r => setTimeout(r, 1000));
    return (root.querySelector("[role=dialog], dialog") ?? root).innerText.slice(0, 600);
  })()`);
  if (issue) fail(`${where}: the dev overlay reports an issue:
${issue}`);
}

/**
 * Out-of-focus cards, glyph core against the card's own surface, from pixels.
 *
 * Opacity is applied to the whole card, so neither the text colour nor the
 * surface colour is in any stylesheet: both are composites over the page. The
 * surface is read from a strip inside the bottom padding; the text is the pixel
 * with the most contrast against it inside each line box. Null when no card is
 * out of focus (the reveal, where the model cards are REMOVED — deliberately
 * unreadable, and not what this measures).
 */
async function outOfFocusContrast(page, shot) {
  return page.evaluate(`(async () => {
    const cards = [...document.querySelectorAll('[data-pipeline-phase] [data-card-state="out-of-focus"]')];
    if (cards.length === 0) return null;
    const img = new Image(); img.src = "data:image/png;base64,${shot.toString("base64")}"; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const lin = x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    const lum = (r, gg, b) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const px = (x, y, w, h) => { const d = g.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data; const out = []; for (let p = 0; p < d.length; p += 4) out.push(lum(d[p], d[p + 1], d[p + 2])); return out; };
    let least = Infinity;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const surface = px(r.x + 6, r.y + r.height - 8, r.width - 12, 3).sort((a, b) => a - b);
      const bg = surface[Math.floor(surface.length / 2)];
      for (const el of card.querySelectorAll("span.font-semibold, span.block")) {
        const range = document.createRange(); range.selectNodeContents(el);
        let best = 1;
        for (const q of range.getClientRects()) for (const v of px(q.x, q.y, q.width, q.height)) best = Math.max(best, ratio(v, bg));
        least = Math.min(least, best);
      }
    }
    return Math.round(least * 100) / 100;
  })()`);
}

/** Mermaid draws its own SVG text, scaled with the SVG; the type floor has to be read from the render. */
async function renderedDiagramLabelPx(page) {
  return page.evaluate(`(() => {
    const svg = document.querySelector("#ai figure svg");
    const label = svg?.querySelector(".nodeLabel, foreignObject div, text");
    if (!svg || !label) return null;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return Math.round(parseFloat(getComputedStyle(label).fontSize) * scale * 10) / 10;
  })()`);
}

/**
 * Worst-case contrast behind each text block, READ FROM PIXELS, in either
 * direction.
 *
 * The text is hidden (visibility, so layout does not move) and the frame under
 * it is captured. For every pixel inside each line box the WCAG ratio against
 * the text's own colour is computed and the minimum kept. That covers dark text
 * over a dark patch (sessions 20–21) and light text over a bright line (session
 * 22) with one rule, rather than a darkest-pixel shortcut that silently assumes
 * which way round the page is.
 */
async function heroTargets(page) {
  return page.evaluate(`(() => {
    const header = document.querySelector("main > header");
    const boxes = (el, name) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return { name, color: getComputedStyle(el).color,
        rects: [...range.getClientRects()].map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height })) };
    };
    return [
      boxes(header.querySelector("h1"), "headline"),
      boxes(header.querySelector("h1 + p"), "standfirst"),
      boxes(header.querySelector("p"), "eyebrow"),
      ...[...header.querySelectorAll("ol li span.font-medium")].map((el, i) => boxes(el, "question " + (i + 1))),
      ...[...header.querySelectorAll("ol li span.font-mono")].map((el, i) => boxes(el, "number " + (i + 1))),
    ];
  })()`);
}

async function setStyle(page, id, css) {
  await page.evaluate(`(() => {
    document.getElementById(${JSON.stringify(id)})?.remove();
    if (${JSON.stringify(css)}) {
      const style = document.createElement("style");
      style.id = ${JSON.stringify(id)};
      style.textContent = ${JSON.stringify(css)};
      document.head.appendChild(style);
    }
  })()`);
}

const HIDE_TEXT = "main > header > :not([aria-hidden]) { visibility: hidden !important; }";
// The ground is the first child; the scrim layers are the divs after it.
const NO_SCRIM = "main > header > [aria-hidden] > div:not(:first-child) { display: none !important; }";

/** Per-target minimum ratio, plus how visible the footage still is on the right. */
async function readHeroFrame(page, targets) {
  const shot = await page.screenshot();
  return page.evaluate(`(async () => {
    const image = new Image();
    image.src = "data:image/png;base64,${shot.toString("base64")}";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const linear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const luminance = (r, g, b) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    // The text colour WITH its alpha. text-background/75 is not the colour
    // background at 75% brightness; it is background composited over whatever
    // is behind each glyph. Reading only RGB measured translucent text as if it
    // were opaque and overstated it — the first dark-hero run reported the
    // standfirst above the headline. Blended per pixel, as the browser does.
    const cssColour = css => {
      const k = document.createElement("canvas").getContext("2d");
      k.fillStyle = css; k.fillRect(0, 0, 1, 1);
      const d = k.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const blocks = ${JSON.stringify(targets)}.map(target => {
      const text = cssColour(target.color);
      let worst = Infinity;
      for (const r of target.rects) {
        const d = context.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))).data;
        for (let p = 0; p < d.length; p += 4) {
          const bg = luminance(d[p], d[p + 1], d[p + 2]);
          const fg = luminance(
            text.a * text.r + (1 - text.a) * d[p],
            text.a * text.g + (1 - text.a) * d[p + 1],
            text.a * text.b + (1 - text.a) * d[p + 2],
          );
          worst = Math.min(worst, ratio(fg, bg));
        }
      }
      return [target.name, Math.round(worst * 100) / 100];
    });
    // Footage visibility: the brightest pixel against the typical one, in the
    // right third of the hero where no text sits. A number near 1 means the
    // lines have disappeared into the ground.
    const header = document.querySelector("main > header").getBoundingClientRect();
    const x0 = Math.round(canvas.width * 2 / 3), y0 = Math.max(0, Math.round(header.top));
    const d = context.getImageData(x0, y0, canvas.width - x0, Math.round(header.height)).data;
    const lums = [];
    for (let p = 0; p < d.length; p += 16) lums.push(luminance(d[p], d[p + 1], d[p + 2]));
    lums.sort((a, b) => a - b);
    const peak = lums[Math.floor(lums.length * 0.999)], typical = lums[Math.floor(lums.length * 0.5)];
    return { blocks: Object.fromEntries(blocks), lineVisibility: Math.round(ratio(peak, typical) * 100) / 100 };
  })()`);
}

async function pauseVideoAt(page, fraction) {
  await page.evaluate(`(async () => {
    const video = document.querySelector("main > header video");
    video.pause();
    await new Promise(resolve => {
      video.addEventListener("seeked", resolve, { once: true });
      video.currentTime = video.duration * ${fraction};
    });
  })()`);
  await sleep(120);
}

// ---------------------------------------------------------------------------
console.log("hero: footage, contrast, bleed");
if (run("hero")) {
  const page = await openPage();
  await page.waitFor(`(() => { const v = document.querySelector("main > header video"); return !!v && v.readyState >= 2; })()`, "the hero video to load");
  const targets = await heroTargets(page);

  await setStyle(page, "qa-hide-text", HIDE_TEXT);
  const worst = {}; // name -> { ratio, fraction }
  const frames = [];
  for (let i = 0; i < HERO_SAMPLES; i += 1) {
    const fraction = i / HERO_SAMPLES;
    await pauseVideoAt(page, fraction);
    const reading = await readHeroFrame(page, targets);
    frames.push({ fraction, ...reading });
    for (const [name, ratio] of Object.entries(reading.blocks)) {
      if (!worst[name] || ratio < worst[name].ratio) worst[name] = { ratio, fraction };
    }
  }

  // REFINE. The coarse pass is 1/96 of the loop apart, longer than a frame, so
  // a worse frame can sit between two samples. Around each block's worst
  // sample, read every step of roughly one video frame (1/30 s) out to the
  // neighbouring samples, and keep whichever is lower.
  const duration = await page.evaluate(`document.querySelector("main > header video").duration`);
  const frameStep = 1 / 30 / duration;
  const refined = { reads: 0, distinct: new Set() };
  for (const name of Object.keys(worst)) {
    const centre = worst[name].fraction;
    for (let f = centre - 1 / HERO_SAMPLES; f <= centre + 1 / HERO_SAMPLES; f += frameStep) {
      const fraction = (f + 1) % 1;
      await pauseVideoAt(page, fraction);
      const reading = await readHeroFrame(page, targets);
      refined.reads += 1;
      refined.distinct.add(reading.blocks[name]);
      for (const [block, ratio] of Object.entries(reading.blocks)) {
        if (ratio < worst[block].ratio) worst[block] = { ratio, fraction };
      }
    }
  }
  // A refinement that reads one decoded frame over and over refines nothing.
  console.log(`  refinement: ${refined.reads} frame-step reads, ${refined.distinct.size} distinct readings`);
  if (refined.distinct.size < Object.keys(worst).length + 2) {
    fail("the refinement pass produced almost no distinct readings; seeking is not landing on different frames");
  }

  console.table(Object.fromEntries(Object.entries(worst).map(([name, w]) => [name, { worst: w.ratio, atFraction: Math.round(w.fraction * 1000) / 1000 }])));
  const everyFifth = frames.filter((_, i) => i % Math.round(HERO_SAMPLES / 5) === 0);
  for (const name of ["headline", "standfirst"]) {
    const sparse = Math.min(...everyFifth.map((f) => f.blocks[name]));
    console.log(`  ${name}: worst of ${HERO_SAMPLES} frames ${worst[name].ratio}:1; worst of 5 evenly spaced ${sparse}:1`);
  }
  const visibility = frames.map((f) => f.lineVisibility);
  console.log(`  footage line visibility on the right third: ${Math.min(...visibility)}–${Math.max(...visibility)} (1.00 = invisible)`);

  for (const [name, { ratio, fraction }] of Object.entries(worst)) {
    const floor = name === "headline" ? HEADLINE_MIN : BODY_MIN;
    if (ratio < floor) fail(`hero ${name} is ${ratio}:1 at loop fraction ${fraction}, below ${floor}:1. Strengthen the scrim; do not dim the text.`);
  }

  // The control, at the headline's worst frame: removing the scrim must lower
  // the reading, or the probe is measuring something other than the scrim.
  await pauseVideoAt(page, worst.headline.fraction);
  await setStyle(page, "qa-no-scrim", NO_SCRIM);
  const control = await readHeroFrame(page, targets);
  await setStyle(page, "qa-no-scrim", "");
  console.log(`  control at the worst frame: headline ${control.blocks.headline}:1 without the scrim, ${worst.headline.ratio}:1 with it; line visibility ${control.lineVisibility} raw`);
  if (control.blocks.headline >= worst.headline.ratio) fail("Removing the scrim did not lower the measured contrast; the probe is inert.");

  await setStyle(page, "qa-hide-text", "");
  await sleep(150);
  save("landing-hero-1920x1080.png", await page.screenshot());
  await pauseVideoAt(page, worst.standfirst.fraction);
  save("landing-hero-standfirst-worst-1920x1080.png", await page.screenshot());

  const bleed = await page.evaluate(`(() => {
    const layer = document.querySelector("main > header > [aria-hidden]").getBoundingClientRect();
    const band = document.querySelector("[data-transition-band] > div").getBoundingClientRect();
    return { left: layer.left, width: layer.width, bandLeft: band.left, bandWidth: band.width, client: document.documentElement.clientWidth };
  })()`);
  if (Math.abs(bleed.left) > 1 || Math.abs(bleed.width - bleed.client) > 1) {
    fail(`hero backdrop is not full-bleed: left ${bleed.left}, width ${bleed.width}, document ${bleed.client}`);
  }
  if (Math.abs(bleed.bandLeft) > 1 || Math.abs(bleed.bandWidth - bleed.client) > 1) {
    fail(`transition band is not full-bleed: left ${bleed.bandLeft}, width ${bleed.bandWidth}`);
  }
  await assertNoDevIssues(page, "hero");
  await page.close();
}

// A classic scrollbar is the case that makes 100vw overflow, so check with one.
if (run("hero")) {
  const page = await openPage({ hideScrollbars: false });
  const overflow = await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  const scrollbar = await page.evaluate(`window.innerWidth - document.documentElement.clientWidth`);
  console.log(`  horizontal overflow ${overflow}px with a ${scrollbar}px scrollbar`);
  if (overflow > 0) fail(`the page scrolls horizontally by ${overflow}px`);
  await page.close();
}

// ---------------------------------------------------------------------------
console.log("transition: the hero-to-page seam");
if (run("transition")) {
  /**
   * THE SEAM, READ FROM PIXELS. Session 23 found the session-22 band's "hard
   * edge" was not a colour mismatch — hero and band met at the same 16,24,31 —
   * but a MACH BAND: a flat hero meeting a ramp at full slope. So what is
   * measured is SLOPE AT THE JUNCTIONS: the lightness step across the band's
   * first 8px and its last 8px, against the steepest 8px step anywhere in it —
   * the same property `transition.test.ts` pins on the curve itself (< 5% eight
   * pixels in from each edge).
   *
   * A 24px window was tried second and failed at 0.365 on the bottom. That was
   * the check, not the band: this curve is skewed low by design, so 24–32px from
   * the bottom its slope is still 30–45% of the steepest and only reaches zero
   * AT the edge. A Mach band is a slope jump where two regions meet; measuring
   * further in measures the curve's intended shape, not a seam.
   *
   * Inside the band, over 8px, on purpose. The first version read 2px steps from
   * 8px ABOVE the band and failed at 0.239 — on the hero's own ±1-level pixel
   * noise, which at the dark end is a large L* step. A raw per-row dump showed the
   * band's first 36px flat to the digit; the probe was reading the neighbour. A linear ramp scores 1.0 at
   * its ends; the eased band must score low at both. And the section after the
   * band must carry no rule that would cut the transition as it completes.
   */
  const page = await openPage();
  await page.evaluate(`(async () => { const v = document.querySelector("main > header video"); if (v) { v.pause(); await new Promise(r => { v.addEventListener("seeked", r, { once: true }); v.currentTime = 1; }); } })()`);
  const geometry = await page.evaluate(`(() => {
    const band = document.querySelector("[data-transition-band]").getBoundingClientRect();
    const next = document.querySelector("[data-transition-band] + section");
    return { top: band.top + scrollY, height: band.height, nextRule: next ? getComputedStyle(next).borderTopWidth : null };
  })()`);
  await page.evaluate(`window.scrollTo({ top: ${Math.max(0, Math.round(geometry.top - 300))}, behavior: "instant" })`);
  await sleep(600);
  const shot = await page.screenshot();
  save("landing-transition-1920x1080.png", shot);

  const measured = await page.evaluate(`(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${shot.toString("base64")}"; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const band = document.querySelector("[data-transition-band]").getBoundingClientRect();
    const lin = x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    // Perceptual lightness (CIE L*), so a step means the same thing dark or light.
    const lstar = (r, gg, b) => { const y = 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b); return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; };
    const columns = [300, 1100, 1800];
    const top = Math.round(band.top), bottom = Math.round(band.bottom);
    const series = columns.map(x => { const out = []; for (let y = top; y <= bottom; y += 8) { const d = g.getImageData(x, y, 1, 1).data; out.push([y, lstar(d[0], d[1], d[2])]); } return out; });
    const steps = s => s.slice(1).map((p, i) => [p[0], Math.abs(p[1] - s[i][1])]);
    const within = (st, lo, hi) => Math.max(0, ...st.filter(([y]) => y >= lo && y <= hi).map(([, v]) => v));
    return columns.map((x, i) => {
      const st = steps(series[i]);
      const steepest = within(st, top, bottom);
      return { x, steepest: +steepest.toFixed(2),
        topEnd: +(within(st, top + 8, top + 8) / steepest).toFixed(3),
        bottomEnd: +(within(st, bottom, bottom) / steepest).toFixed(3) };
    });
  })()`);
  console.table(measured);
  console.log(`  rule on the section after the band: ${geometry.nextRule}`);
  // Checked BEFORE the slope: a rule is a dark 1px line in the band's last row,
  // which the slope check would also catch — but name the wrong cause.
  if (geometry.nextRule !== "0px") fail(`the section after the band carries a ${geometry.nextRule} rule that cuts the transition`);
  for (const column of measured) {
    if (column.topEnd > 0.2 || column.bottomEnd > 0.2) {
      fail(`transition seam at x=${column.x}: slope at the ends is ${column.topEnd} (top) / ${column.bottomEnd} (bottom) of the steepest step — a Mach band`);
    }
  }
  await page.close();
}

// ---------------------------------------------------------------------------
console.log("pipeline: pinned steps");
const PHASE_FRAMES = [
  { phase: 0, name: "landing-step-1-parse-1920x1080.png" },
  { phase: 4, name: "landing-step-3-plan-1920x1080.png" },
  { phase: 12, name: "landing-step-7-gate-1920x1080.png" },
  { phase: 15, name: "landing-reveal-1920x1080.png" },
];
if (run("pipeline")) {
  const page = await openPage();
  const geometry = await page.evaluate(`(() => {
    const el = document.querySelector("[data-pipeline-phase]");
    const rect = el.getBoundingClientRect();
    return { top: rect.top + window.scrollY, height: rect.height, viewport: window.innerHeight, visible: el.offsetParent !== null };
  })()`);
  if (!geometry.visible) fail("the pinned sequence is not displayed at 1920x1080 with motion allowed");
  const range = geometry.height - geometry.viewport;

  for (const { phase, name } of PHASE_FRAMES) {
    const y = Math.round(geometry.top + (range * (phase + 0.5)) / 16);
    await page.evaluate(`window.scrollTo({ top: ${y}, behavior: "instant" })`);
    await page.waitFor(`document.querySelector("[data-pipeline-phase]").dataset.pipelinePhase === "${phase}"`, `phase ${phase}`);
    await sleep(1100); // the 0.6s state change plus its stagger, settled
    const shot = await page.screenshot();
    const unfocused = await outOfFocusContrast(page, shot);
    if (unfocused !== null) {
      console.log(`  phase ${phase}: least readable out-of-focus card ${unfocused}:1`);
      if (unfocused < BODY_MIN) fail(`an out-of-focus card reads ${unfocused}:1 at phase ${phase}, below ${BODY_MIN}:1`);
    }
    save(name, shot);
  }

  /**
   * FRAME ORDER — A MEASUREMENT, NOT A GUARD, and the difference was measured.
   *
   * The idea was to catch jitter between Lenis and useScroll: a rendered phase
   * that trails the scroll position by a varying number of frames. Session 21
   * injected the case it exists for — Lenis on its own requestAnimationFrame
   * loop instead of motion's — six runs, 90 boundaries: 1 outlier. The shared
   * loop over the same 90: 3 outliers, one of 10 frames. The injection did not
   * produce the failure this check was written to catch, so by rule 1f it
   * proves nothing, and it does not fail the run.
   *
   * The absolute number is not comparable between configurations either: the
   * sampler is itself a rAF callback, so where it falls relative to Lenis in a
   * frame moves the reading by one. It is printed so a regression in a real
   * browser has a baseline to be compared against, not as evidence.
   */
  await page.evaluate(`window.scrollTo({ top: ${Math.round(geometry.top)}, behavior: "instant" })`);
  await sleep(600);
  await page.evaluate(`(() => {
    const el = document.querySelector("[data-pipeline-phase]");
    const top = el.getBoundingClientRect().top + window.scrollY;
    const range = el.getBoundingClientRect().height - window.innerHeight;
    window.__qaFrames = [];
    const sample = () => {
      const expected = Math.min(15, Math.max(0, Math.floor(((window.scrollY - top) / range) * 16)));
      window.__qaFrames.push([expected, Number(el.dataset.pipelinePhase)]);
      if (window.__qaFrames.length < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`);
  for (let tick = 0; tick < 90; tick += 1) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 960, y: 540, deltaX: 0, deltaY: 120 });
    await sleep(30);
  }
  await page.waitFor(`window.__qaFrames.length >= 600`, "frame samples", 30_000);
  const frames = await page.evaluate(`window.__qaFrames`);
  const lags = [];
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i][0] !== frames[i - 1][0]) {
      const target = frames[i][0];
      let lag = 0;
      while (i + lag < frames.length && frames[i + lag][1] !== target) lag += 1;
      lags.push(lag);
    }
  }
  await assertNoDevIssues(page, "pipeline");
  console.log(`  measurement only: ${lags.length} phase boundaries crossed under Lenis; rendered phase trailed by [${lags.join(", ")}] frames`);
  await page.close();
}

// ---------------------------------------------------------------------------
console.log("reduced motion: the argument without animation");
if (run("reduced")) {
  const page = await openPage({ reducedMotion: true });
  const state = await page.evaluate(`(() => {
    const section = document.getElementById("ai");
    return {
      video: !!document.querySelector("main > header video"),
      pinned: document.querySelector("[data-pipeline-phase]")?.offsetParent !== null,
      staticSteps: [...section.querySelectorAll("ol > li")].filter(li => li.offsetParent !== null).length,
    };
  })()`);
  if (state.video) fail("a reduced-motion viewer was handed the looping video");
  if (state.pinned) fail("a reduced-motion viewer was shown the pinned sequence");
  if (state.staticSteps !== 8) fail(`the static list shows ${state.staticSteps} steps, not 8`);
  await page.waitFor(`!!document.querySelector("#ai figure svg")`, "the mermaid diagram");
  const labelPx = await renderedDiagramLabelPx(page);
  console.log(`  diagram labels render at ${labelPx}px`);
  if (labelPx === null || labelPx < 12) fail(`the diagram's labels render at ${labelPx}px, below the 12px floor`);

  /**
   * A reduced-motion viewer gets the figure, not a count-up waiting at zero.
   *
   * NumberFlow draws digits in a shadow root and publishes the value through
   * ElementInternals.ariaLabel, which no DOM query can see — so this reads the
   * accessibility tree, which is also what a screen reader is given. The frame
   * that found this showed "0.0%" where E4a measured 33.3%.
   */
  await page.send("Accessibility.enable");
  const { nodes } = await page.send("Accessibility.getFullAXTree");
  // Every stat on the page, not only this section's: the count-up is shared.
  const figures = nodes
    .filter((node) => node.role?.value === "image" && /^\d+(\.\d+)?$/.test(node.name?.value ?? ""))
    .map((node) => node.name.value);
  console.log(`  stats read [${figures.join(", ")}]`);
  if (figures.length === 0) fail("no stat values were found in the accessibility tree");
  if (figures.includes("0.0")) fail(`a decimal stat renders as 0.0 under reduced motion: [${figures}]`);
  await assertNoDevIssues(page, "reduced motion");

  const box = await page.evaluate(`(() => {
    const section = document.getElementById("ai");
    section.scrollIntoView({ behavior: "instant", block: "start" });
    const r = section.getBoundingClientRect();
    return { x: 0, y: r.top + window.scrollY, width: document.documentElement.clientWidth, height: r.height };
  })()`);
  await sleep(800);
  save("landing-reduced-motion-ai-1920.png", await page.screenshot({ captureBeyondViewport: true, clip: { ...box, scale: 1 } }));
  await page.close();
}

console.log("narrow: static below lg");
if (run("narrow")) {
  const page = await openPage({ width: 820, height: 1180 });
  const state = await page.evaluate(`(() => ({
    pinned: document.querySelector("[data-pipeline-phase]")?.offsetParent !== null,
    staticSteps: [...document.querySelectorAll("#ai ol > li")].filter(li => li.offsetParent !== null).length,
  }))()`);
  if (state.pinned || state.staticSteps !== 8) fail(`below lg: pinned=${state.pinned}, static steps=${state.staticSteps}`);
  await page.evaluate(`document.getElementById("ai").scrollIntoView({ behavior: "instant" })`);
  await page.waitFor(`!!document.querySelector("#ai figure svg")`, "the mermaid diagram below lg");
  const narrowLabelPx = await renderedDiagramLabelPx(page);
  if (narrowLabelPx === null || narrowLabelPx < 12) fail(`below lg the diagram's labels render at ${narrowLabelPx}px`);
  console.log(`  diagram labels render at ${narrowLabelPx}px`);
  await assertNoDevIssues(page, "narrow");
  console.log("  static list, 8 steps, no pinned sequence");
  await page.close();
}

console.log(`done: ${OUT}`);
process.exit(0);
