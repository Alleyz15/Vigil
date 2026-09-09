import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "docs", "screenshots", "session-12");
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

capture(
  "timeline-s1-exception-1920x1080.png",
  "/timeline?scenario=S1&frame=exception",
);
capture("gate-explorer-1920x1080.png", "/gate");
capture("reasoning-stream-1920x1080.png", "/stream");
