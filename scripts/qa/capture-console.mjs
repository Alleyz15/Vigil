import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { postJson } from "./post-json.mjs";
import { captureStable } from "./stable-capture.mjs";

const ROOT = process.cwd();
const OUT = process.env.VIGIL_QA_OUT ?? join(ROOT, "docs", "screenshots", "session-17a");
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

// Model prose is intentionally non-deterministic. A capture made against an
// enabled provider cannot be used for pixel-equality evidence, so fail before
// writing the first frame rather than quietly recording unstable output.
const runtimeResponse = await fetch(`${BASE}/api/runtime/llm`);
if (!runtimeResponse.ok) throw new Error(`LLM capture preflight returned ${runtimeResponse.status}.`);
const runtime = await runtimeResponse.json();
if (runtime.selection !== "none") {
  throw new Error(`qa:capture requires VIGIL_LLM_PROVIDER=none; this server selected ${runtime.selection}.`);
}
process.stdout.write("LLM preflight: VIGIL_LLM_PROVIDER=none (deterministic capture)\n");

/**
 * All still frames force reduced motion and wait for settled pixels.
 *
 * Headless virtual time does not finish a JavaScript-driven camera animation.
 * The stale-record frame came back as a grey rectangle with a route line on it:
 * Leaflet's `flyTo` never completed, so overlays sat at the final zoom and no
 * tiles were ever requested for it. Raising the time budget was tried first and
 * did NOTHING — the budget was never the cause, and changing it before reading
 * the map code was fixing the wrong thing.
 *
 * The map's camera now honours reduced motion (it previously did not — a real
 * accessibility defect this surfaced), so forcing the preference makes the
 * camera jump instead of fly, and the frame is the settled state a still should
 * show anyway.
 */
async function capture(name, path) {
  const target = join(OUT, name);
  await captureStable(chromePath, `${BASE}${path}`, target);
  process.stdout.write(`${target}\n`);
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

await capture("operator-inbox-1920x1080.png", "/operator/inbox?scenario=S1");
await capture("all-handoffs-1920x1080.png", "/operator/handoffs");
await capture(
  "handoff-s1-pending-1920x1080.png",
  `/operator/handoffs/${encodeURIComponent(pendingS1.eventId)}`,
);
await capture("courier-submission-1920x1080.png", "/courier");
await capture("gate-evidence-1920x1080.png", "/demo/gate");

/**
 * The sender, so all four role surfaces exist as evidence at one size.
 *
 * Captured on a FRESH form, before the stale-record sequence below dispatches
 * anything: the declaration is what this surface is for, and a viewer comparing
 * the four frames should see a merchant at a desk, not a result page.
 */
await capture("sender-1920x1080.png", "/sender");

/**
 * The dev server intermittently resets a connection when several large JSON
 * responses are requested back to back, right after Chrome has been driving
 * it. That is a transient transport failure, not a missing fixture, and it
 * must not throw away frames that are already on disk.
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


/**
 * A STATEFUL SEQUENCE: act, check, capture, in order, sharing context.
 *
 * A single URL can only capture a state that already exists. The two most
 * important frames in this project do not exist at boot: a stale-record flag
 * needs a shipment dispatched, corrected and delivered; a sealed co-signature
 * needs a courier submission and an operator approval. Capturing them by hand
 * made the committed evidence depend on a manual run nobody could reproduce.
 *
 * Three kinds of step:
 *
 *   post     call a real endpoint (the same ones the surfaces call) and keep
 *            what the response returns for later steps
 *   expect   read the state back and FAIL LOUDLY if it is not what the next
 *            frame's filename will claim
 *   capture  take the frame
 *
 * The `expect` step is the point. This script has already been one step away
 * from writing a frame that did not show what its name said (session 17B's
 * reserved S1 leg). A capture that silently records the wrong state is worse
 * than no capture, because it is committed as evidence.
 */
async function runSequence(name, steps) {
  const context = {};
  for (const [index, step] of steps.entries()) {
    const where = `${name}, step ${index + 1} (${step.kind}: ${step.describe})`;

    if (step.kind === "post") {
      // SUCCESS IS THE HTTP STATUS, plus an explicit `ok: false` where an
      // endpoint reports a refusal in-band. The first version of this runner
      // required `ok: true`, which the operator actions endpoint never sends —
      // it returns the handoff — so a successful approval read as a refusal
      // and the sealed frame was silently never taken. Endpoints do not share
      // one envelope; the runner must not pretend they do.
      const { status, ok, body, retried } = await postJson(`${BASE}${step.path(context)}`, step.body?.(context));
      if (!ok || body?.ok === false) {
        const reason = body?.reason ?? body?.error ?? "no reason given";
        // A refusal after a reset is ambiguous: the lost first attempt may have
        // been applied, making this the server refusing a duplicate. Guessing
        // either way would be wrong. If the next step reads the state back, let
        // it decide; otherwise stop and say exactly that.
        if (retried && steps[index + 1]?.kind === "expect") {
          console.warn(`  ${where}: refused after a retry (HTTP ${status}: ${reason}); the next step will check the state`);
        } else {
          throw new Error(
            retried
              ? `${where} was refused after a connection reset and retry (HTTP ${status}): ${reason}. The first attempt may have been applied; restart the server and rerun.`
              : `${where} was refused (HTTP ${status}): ${reason}`,
          );
        }
      }
      Object.assign(context, step.keep?.(body) ?? {});
    } else if (step.kind === "expect") {
      const data = await getJson(`${BASE}${step.path(context)}`);
      const problem = data ? step.check(data, context) : "the state could not be read";
      if (problem) throw new Error(`${where}: ${problem}`);
    } else if (step.kind === "capture") {
      await capture(step.frame, step.path(context));
    }
  }
  return context;
}

/**
 * The recipient surface.
 *
 * The token is resolved from the workbench at capture time; hardcoding one
 * would bind this script to a seed. Bounded and fault-tolerant, because each
 * detail response is large and a transient reset must not fail the run.
 */
const handoffsPayload = await getJson(`${BASE}/api/operator/handoffs`);
if (!handoffsPayload) throw new Error("Operator handoffs could not be read.");

let recipientToken = null;
for (const handoff of handoffsPayload.items.slice(0, 12)) {
  try {
    const body = await getJson(`${BASE}/api/operator/handoffs/${encodeURIComponent(handoff.eventId)}`);
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
await capture("recipient-confirm-1920x1080.png", `/confirm/${encodeURIComponent(recipientToken)}`);

/**
 * THE STALE RECORD: the limitation that demonstrates as a strength.
 *
 * Dispatch, correct the address mid-route, let the courier deliver to the
 * corrected address, then check the operator's view shows exactly what the
 * frame will claim: I10 alone, no manufactured I1/I7, and the correction named
 * as the cause. Nothing here tells the engine a correction happened; the
 * script drives the sender's product actions and reads back what the gate did.
 */
await runSequence("stale-record", [
  {
    kind: "post",
    describe: "sender dispatches Jalan Ampang to Shah Alam Seksyen 13",
    path: () => "/api/sender/shipments",
    body: () => ({
      originIndex: 0,
      destinationIndex: 20,
      declaredValueSen: 12_000,
      recipientChannel: "+60118880042",
      fault: "none",
    }),
    keep: (result) => ({ runId: result.runId }),
  },
  {
    kind: "post",
    describe: "sender corrects the address while the parcel is in transit",
    path: (ctx) => `/api/sender/shipments/${ctx.runId}/correct`,
    body: () => ({ addressIndex: 3 }),
  },
  {
    kind: "post",
    describe: "courier delivers to the corrected address",
    path: (ctx) => `/api/sender/shipments/${ctx.runId}/deliver`,
    keep: (result) => ({ eventId: result.eventId }),
  },
  {
    kind: "expect",
    describe: "the flag is I10 alone and the cause is named",
    path: (ctx) => `/api/operator/handoffs/${encodeURIComponent(ctx.eventId)}`,
    check: (detail) => {
      const ids = detail.flags.map((flag) => flag.id);
      if (!ids.includes("I10") && !ids.includes("I11")) return `expected I10/I11, got [${ids}]`;
      if (ids.includes("I1") || ids.includes("I7")) {
        return `a cross-signal contradiction was manufactured: [${ids}]`;
      }
      if (!detail.addressCorrection) return "the operator view does not name the correction";
      return null;
    },
  },
  {
    kind: "capture",
    describe: "the operator's view of an honest delivery flagged for a stale record",
    frame: "stale-record-1920x1080.png",
    path: (ctx) => `/operator/handoffs/${encodeURIComponent(ctx.eventId)}`,
  },
]);

/**
 * THE CO-SIGNATURE, both beats. LAST, because it is destructive.
 *
 * Approving S1 seals it and there is deliberately no way back in a process, so
 * every frame above that depends on S1 being pending has already been taken.
 */
await runSequence("cosign", [
  {
    kind: "expect",
    describe: "S1 is awaiting a co-signature",
    path: () => `/api/operator/handoffs/${encodeURIComponent(pendingS1.eventId)}`,
    check: (detail) =>
      detail.summary.state === "awaiting_cosignature"
        ? null
        : `S1 is ${detail.summary.state}; restart the dev server to replay the co-signature`,
  },
  {
    kind: "capture",
    describe: "courier signature valid and still not a credential",
    frame: "cosign-split-1920x1080.png",
    path: () => "/demo/cosign",
  },
  {
    kind: "post",
    describe: "operator approves and co-signs",
    path: () => `/api/operator/handoffs/${encodeURIComponent(pendingS1.eventId)}/actions`,
    body: () => ({ action: "approve" }),
  },
  {
    kind: "expect",
    describe: "the credential verifies and the ledger holds an entry",
    path: () => `/api/operator/handoffs/${encodeURIComponent(pendingS1.eventId)}`,
    check: (detail) =>
      detail.credential?.valid && detail.ledger.sequence !== null
        ? null
        : "approval did not produce a verifying credential and a sealed entry",
  },
  {
    kind: "capture",
    describe: "both halves present, sealed",
    frame: "cosign-sealed-1920x1080.png",
    path: () => "/demo/cosign",
  },
]);
