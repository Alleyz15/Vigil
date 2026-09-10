import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "docs", "screenshots", "session-17a");
const BASE = process.env.VIGIL_BASE_URL ?? "http://localhost:3000";

const candidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chromePath = candidates.find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error("Chrome not found. Set CHROME_PATH to its executable.");

mkdirSync(OUT, { recursive: true });

function capture(name, path) {
  const profile = mkdtempSync(join(tmpdir(), "vigil-capture-"));
  const target = join(OUT, name);
  try {
    const result = spawnSync(
      chromePath,
      [
        "--headless=new",
        "--hide-scrollbars",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-size=1920,1080",
        "--force-device-scale-factor=1",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=5000",
        `--user-data-dir=${profile}`,
        `--screenshot=${target}`,
        `${BASE}${path}`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );

    if (result.status !== 0) {
      throw new Error(result.stderr || `Chrome exited with status ${result.status}.`);
    }
    process.stdout.write(`${target}\n`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

const inboxResponse = await fetch(`${BASE}/api/operator/inbox`);
if (!inboxResponse.ok) {
  throw new Error(`Operator inbox returned ${inboxResponse.status}.`);
}

const inbox = await inboxResponse.json();
const pendingS1 = inbox.items.find(
  (item) => item.scenarioId === "S1" && item.state === "awaiting_cosignature",
);
if (!pendingS1) throw new Error("No S1 handoff awaiting co-signature was found.");

capture("operator-inbox-1920x1080.png", "/operator/inbox?scenario=S1");
capture("all-handoffs-1920x1080.png", "/operator/handoffs");
capture(
  "handoff-s1-pending-1920x1080.png",
  `/operator/handoffs/${encodeURIComponent(pendingS1.eventId)}`,
);
capture("gate-evidence-1920x1080.png", "/demo/gate");
