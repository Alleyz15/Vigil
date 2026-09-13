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
const OUT = join(ROOT, "docs", "screenshots", "landing");
const BASE = process.env.VIGIL_BASE_URL ?? "http://localhost:3000";

const HEADLINE_MIN = 7;
const BODY_MIN = 4.5;
/** Paused positions through the loop, as fractions of its duration. 0.5833 is the darkest sampled frame. */
const VIDEO_TIMES = [0, 0.2917, 0.5, 0.5833, 0.75];

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
 * Worst-case contrast behind each text block, READ FROM PIXELS.
 *
 * The same frame is captured twice: as a viewer sees it, and with the hero's
 * text hidden (visibility, so layout does not move). The second frame is the
 * exact background under each line box; its darkest pixel against the text's
 * own colour is the worst case. Deriving this from the scrim's opacity was
 * tried in the plan and got the standfirst wrong by a third — the theme's
 * muted colour and the gradient's coverage both differed from the guess.
 */
async function measureContrast(page) {
  const targets = await page.evaluate(`(() => {
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
    ];
  })()`);

  await page.evaluate(`(() => {
    const style = document.createElement("style");
    style.id = "qa-hide-text";
    style.textContent = "main > header > :not([aria-hidden]) { visibility: hidden !important; }";
    document.head.appendChild(style);
  })()`);
  await sleep(150);
  const background = await page.screenshot();
  await page.evaluate(`document.getElementById("qa-hide-text").remove()`);

  return page.evaluate(`(async () => {
    const image = new Image();
    image.src = "data:image/png;base64,${background.toString("base64")}";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const linear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const luminance = (r, g, b) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const cssLuminance = css => {
      const k = document.createElement("canvas").getContext("2d");
      k.fillStyle = css; k.fillRect(0, 0, 1, 1);
      const d = k.getImageData(0, 0, 1, 1).data;
      return luminance(d[0], d[1], d[2]);
    };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return ${JSON.stringify(targets)}.map(target => {
      const text = cssLuminance(target.color);
      let darkest = 1;
      for (const r of target.rects) {
        const d = context.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))).data;
        for (let p = 0; p < d.length; p += 4) darkest = Math.min(darkest, luminance(d[p], d[p + 1], d[p + 2]));
      }
      return { name: target.name, ratio: Math.round(ratio(text, darkest) * 100) / 100 };
    });
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
  await sleep(300);
}

// ---------------------------------------------------------------------------
console.log("hero: footage, contrast, bleed");
if (run("hero")) {
  const page = await openPage();
  await page.waitFor(`(() => { const v = document.querySelector("main > header video"); return !!v && v.readyState >= 2; })()`, "the hero video to load");

  const table = [];
  for (const fraction of VIDEO_TIMES) {
    await pauseVideoAt(page, fraction);
    const measured = await measureContrast(page);
    table.push({ t: fraction, ...Object.fromEntries(measured.map((m) => [m.name, m.ratio])) });
    for (const { name, ratio } of measured) {
      const floor = name === "headline" ? HEADLINE_MIN : BODY_MIN;
      if (ratio < floor) fail(`hero ${name} is ${ratio}:1 over the footage at t=${fraction}, below ${floor}:1. Strengthen the scrim; do not lighten the text.`);
    }
    if (fraction === 0.5833) save("landing-hero-1920x1080.png", await page.screenshot());
  }
  console.table(table);

  // The control. If removing the scrim does not lower the reading, the probe is
  // measuring something other than the scrim and every number above is inert.
  await page.evaluate(`(() => {
    const style = document.createElement("style");
    style.id = "qa-no-scrim";
    style.textContent = "main > header > [aria-hidden] > div:not(:first-child) { display: none !important; }";
    document.head.appendChild(style);
  })()`);
  await sleep(150);
  const control = await measureContrast(page);
  await page.evaluate(`document.getElementById("qa-no-scrim").remove()`);
  const controlHeadline = control.find((m) => m.name === "headline").ratio;
  const withScrim = table.find((row) => row.t === 0.5833).headline;
  console.log(`  control: headline ${controlHeadline}:1 with the scrim removed, ${withScrim}:1 with it`);
  if (controlHeadline >= withScrim) fail("Removing the scrim did not lower the measured contrast; the probe is inert.");

  const bleed = await page.evaluate(`(() => {
    const layer = document.querySelector("main > header > [aria-hidden]").getBoundingClientRect();
    return { left: layer.left, width: layer.width, client: document.documentElement.clientWidth };
  })()`);
  if (Math.abs(bleed.left) > 1 || Math.abs(bleed.width - bleed.client) > 1) {
    fail(`hero backdrop is not full-bleed: left ${bleed.left}, width ${bleed.width}, document ${bleed.client}`);
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
    save(name, await page.screenshot());
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
