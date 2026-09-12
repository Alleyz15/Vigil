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

/**
 * The pending co-signature has to be CREATED before it can be captured.
 *
 * Session 17B reserved S1's delivery leg for the courier, so the operator's
 * queue no longer contains a pending case at boot - which is the real flow, and
 * which silently broke this script until it was run. A capture script that
 * assumes a fixture exists is a fixture dependency nobody declared.
 *
 * Submitting is idempotent for our purposes: if the draft has already been
 * submitted in this process, the endpoint records another attempt and the case
 * is already in the queue either way. If it has already been co-signed, the
 * lookup below fails loudly rather than capturing a frame that does not show
 * what the filename claims.
 */
const draftsResponse = await fetch(`${BASE}/api/courier/drafts`);
if (!draftsResponse.ok) {
  throw new Error(`Courier drafts returned ${draftsResponse.status}.`);
}
const { items: drafts } = await draftsResponse.json();
const s1Draft = drafts.find((draft) => draft.scenarioId === "S1");

if (s1Draft && s1Draft.attempts.length === 0) {
  const submitted = await fetch(`${BASE}/api/courier/drafts/${s1Draft.draftId}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signed: true }),
  });
  if (!submitted.ok) {
    throw new Error(`Courier submission returned ${submitted.status}.`);
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
if (!pendingS1) {
  throw new Error(
    "No S1 handoff awaiting co-signature was found. The courier draft may already have " +
      "been co-signed in this server process; restart the dev server and retry.",
  );
}

capture("operator-inbox-1920x1080.png", "/operator/inbox?scenario=S1");
capture("all-handoffs-1920x1080.png", "/operator/handoffs");
capture(
  "handoff-s1-pending-1920x1080.png",
  `/operator/handoffs/${encodeURIComponent(pendingS1.eventId)}`,
);
capture("courier-submission-1920x1080.png", "/courier");
capture("gate-evidence-1920x1080.png", "/demo/gate");

/**
 * The split screen, at the beat that carries the argument.
 *
 * The submission above put this handoff into `awaiting_cosignature`, so the
 * frame lands on "courier signature valid, and still not a credential" without
 * the script arranging anything of its own. Captured AFTER the operator frames
 * and BEFORE any co-signature, because co-signing moves it to the sealed phase
 * and there is deliberately no way back in a process (no reset endpoint).
 */
capture("cosign-split-1920x1080.png", "/demo/cosign");

/**
 * The recipient surface, so all three roles exist as evidence at one size.
 *
 * The token is resolved from the workbench at capture time, exactly like the
 * pending event id above. Hardcoding one would bind this script to a seed.
 */
/**
 * The dev server intermittently resets a connection when several large JSON
 * responses are requested back to back, right after Chrome has been driving
 * it. That is a transient transport failure, not a missing fixture, and it
 * must not throw away six frames that are already on disk.
 */
async function getJson(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  return null;
}

const handoffsPayload = await getJson(`${BASE}/api/operator/handoffs`);
if (!handoffsPayload) {
  throw new Error("Operator handoffs could not be read.");
}
const { items: handoffs } = handoffsPayload;

// Bounded and fault-tolerant on purpose: each detail response is a large
// object and the dev server resets the connection under a rapid sequential
// scan of all of them. A transient reset must not fail a capture run that has
// already written six good frames.
let recipientToken = null;
for (const handoff of handoffs.slice(0, 12)) {
  try {
    const body = await getJson(
      `${BASE}/api/operator/handoffs/${encodeURIComponent(handoff.eventId)}`,
    );
    if (body?.recipientConfirmation) {
      recipientToken = body.recipientConfirmation.tokenId;
      break;
    }
  } catch {
    // Try the next handoff rather than abandoning the run.
  }
}

if (!recipientToken) {
  throw new Error(
    "No recipient confirmation token was found on any handoff. The recipient frame would " +
      "otherwise be captured from a page that cannot show what its filename claims.",
  );
}

capture("recipient-confirm-1920x1080.png", `/confirm/${encodeURIComponent(recipientToken)}`);
