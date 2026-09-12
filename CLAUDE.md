# Vigil

Agentic handoff trust verifier for last-mile logistics fraud.
HackAI 2026, Track 02 (Secure Logistics & Digital Trust). Solo project. Deadline **15 Oct 2026**.

`track idea.md` is the source of truth for the full plan, demo scenarios, experiments and
scoring rubric. This file is the working context: the rules that must survive between sessions.

---

## Core concept

Vigil does **not** try to prove a delivery happened. Every individual signal — photo, GPS,
OTP, signature — can be forged, and any system claiming otherwise is lying. So we change the
question from *"is this delivery real?"* to two answerable ones:

1. **Do these claims agree with each other?** Forging GPS is easy. Making GPS, cell tower,
   WiFi, accelerometer, photo EXIF and server receipt time all tell the same story, dozens of
   times, without leaving a pattern, is expensive.
2. **How many times can a fraudster do this before the shape of their behaviour gives them away?**

Three pillars:

| Pillar | One line |
|---|---|
| Cross-signal consistency | Any one signal is forgeable; all of them agreeing is not |
| Orthogonal gate | Single-event contradiction and cumulative pattern are two independent axes |
| Constitutive approval | Without the operator's signature, a high-risk handoff cannot assemble a valid credential |

---

## Architectural rules

These are not style preferences. Breaking one dismantles the argument the project is built on.

### 1. The verdict is always deterministic

The LLM appears in **exactly two** places:

- `plan` — selecting 0–2 optional tools from a **closed zod enum**
- `explain` — writing human-readable prose **after** the verdict is already sealed

**Removing the LLM entirely must produce byte-identical verdicts.** Only the operator's
explanation degrades, into a structured flag list. Never let an LLM decide accept/reject.
If a change would make a verdict depend on model output, the change is wrong.

**"Remove the LLM and the verdicts are identical" is not a promise. It is a test that runs.**

`lib/agent/machine.test.ts` and `lib/agent/shipment.test.ts` seal verdicts three ways — with
`llm: undefined`, with fake model A, and with fake model B — where A and B disagree with each
other about which tools to select and about how to describe what happened. The sealed
`Verdict` must be **byte-identical** across all three; only the prose may differ. The shipment
version does it over a whole six-leg timeline and also compares the resulting ledger chains.

**If a future session ever needs to relax this, the architecture has already broken** — the
model has acquired influence over an outcome it must never touch. Fix the seam, not the test.
This is a pitch line: the honest answer to "how do we know the LLM is not deciding?" is to run
the suite.

This is **enforced, not just asserted**. Every rule in `lib/engine/`, `lib/pattern/` and
`lib/gate/` is a pure function of its arguments — the caller assembles the input, the rules do
arithmetic on it — and
`lib/purity.test.ts` reads the source of all three pure trees (`engine`, `pattern`, `gate`) and
fails the build if any module on the verdict path reaches a file, a socket, a database,
`process.env`, `Math.random`, or the wall clock. A future session that "just needs to look one
thing up" inside a rule is stopped there, with a message saying why. Thresholds arrive as an
argument for the same reason.

`lib/credential/` gets a **narrow, justified allowance**: `node:crypto` only, and only in the
verifier and message builder. The reason is stated in the test — verifying a signature is a
pure function of (message, key, signature), and determinism is the property the purity rule
actually protects. Every other ban still applies there, including `process.env`, which is
confined to `keys.ts`. A narrow allowance beats a hole in the check.

### 2. The two axes are separate, and load-bearing

This split is deliberate. **Do not "simplify" it back into a single scoring pass.**

```
verify        -> axis 1: single-event inconsistency  (H1-H4, I1-I16)
fetch_history -> axis 2: per-courier rolling pattern (P1-P5)
gate          -> the ONLY place the two axes meet
```

They are stored as two fields and **never summed**. The reason is the matrix:

| Single-event | Pattern | Outcome |
|---|---|---|
| High | Low | **flag** — probably a device fault (GPS drift in a tunnel), ask for more evidence |
| Low | **High** | **escalate** — every event passes on its own, but the distribution is wrong |
| High | High | **freeze** the scope |
| Low | Low | accept |

Row 2 is the whole project. Every other system does per-event adjudication; a careful
fraudster can keep each event under the threshold, but cannot change their own distribution.
Collapsing the axes into one number makes row 2 unreachable and deletes the differentiator.

The node ordering exists to make this structural rather than merely intended: axis 1 is
produced at `verify`, axis 2 at `fetch_history`, and they are combined nowhere but `gate`.

**This is enforced by `lib/purity.test.ts`**, which reads every source file under `lib/` and
fails on arithmetic joining an inconsistency-shaped term to a pattern-shaped one, and on any
module outside `lib/gate` reading both scores together (bar a short allowlist that stores or
reports them separately). Same category as the I/O ban: the architectural claim is verifiable
by running the test suite, not by reading a document.

The clearest statement of why is a test — *"cannot be expressed by any single combined
number"* in `lib/gate/gate.test.ts`. Three couriers whose axis scores sum to **exactly 80**
need three different actions:

| single | pattern | sum | action | because |
|---:|---:|---:|---|---|
| 0 | 80 | 80 | **escalate** | investigate the courier |
| 80 | 0 | 80 | **flag** | re-check the event |
| 40 | 40 | 80 | **freeze** | stop the scope |

No function of `single + pattern` can tell these apart. The sum discards *which axis* the risk
came from, and that is precisely what decides what an operator should do next.

### 2a. The generator must not know the detector's thresholds

The fifth architectural claim the suite verifies rather than the README asserts, and the one
that decides whether the experiments mean anything.

`lib/purity.test.ts` fails the build if any module under `lib/generate/` imports
`lib/engine/thresholds`, `lib/pattern/thresholds`, `lib/gate/thresholds`, or so much as names a
threshold constant. A generator that reads `p1.maxDeliveriesInWindow` to decide how fast the
fraudster scans is not producing a fraudster; it is producing something shaped to trip a rule,
and a detection rate measured on it would stay high even if the rule were nonsense.

**The generator emits BEHAVIOUR** — "one parcel every twenty seconds", "the courier is in a
basement carpark", "the recipient agrees not to complain". **The detectors compute statistics.**
If a threshold moves, the generator does not.

### 2b. Noise parameters must straddle the rules, never sit under them

The same guard, aimed at the failure mode that is easiest to commit by accident.

**Parameters are drawn from distributions that straddle the rules, not from bands chosen to sit
under them.** Basement GPS accuracy is a long-tailed draw: it lands at 60 m sometimes — under the
"too vague to judge" line, so the location rules stay *evaluable* and can fire on a genuine drift
— and at 250 m other times, over it, so they honestly report `not_evaluated`. **That crossing is
where the false positives come from, and rigging it away reproduces the exact problem the noise
model exists to fix.**

A noise band picked so that its worst case lands just below a threshold is not a model of the
world. It is `0%` written in a different file, and it is worse than the original because it looks
like it was measured.

**So: a future session must not tune the noise model "to reduce spurious alerts."** Every
parameter carries a citation or the literal word **assumption** in `lib/generate/noise.ts` and in
DATASET.md, and it is changed only when the claim about the world is wrong — never because of
what it does to a number downstream. Swapping *"our clean data does not trip our rules"* for
*"our noisy data happens to trip our rules"* leaves the circularity exactly where it was.

### 3. Approval is constitutive, not decorative

Operator approval is **not** `approved = true` in a table. A high-risk handoff requires a
token co-signed by the courier's key **and** the operator's key. The courier's half alone
**fails signature verification**. If a judge asks whether the approval button is real, the
answer is: without it, the credential does not verify.

Shift limits are a hard stop **even with a valid co-sign**.

### 3c. The credential is a SIDECAR. It must never live inside the EPCIS event.

**Do not "tidy" the credential into `vigil:credential`.** It looks like it belongs there — it
is handoff data, and `vigil:courierId` sets the precedent — and putting it there breaks the
co-sign flow in a way that only surfaces on the first full two-phase run.

Two correct designs collide. Co-signing is inherently two-phase:

```
courier submits (courier-signed)  ->  gate: requiresCosign  ->  operator co-signs  ->  seals
```

If the credential were part of the event, the co-signed resubmission would be a **different
payload under the same eventID**. The ledger would do exactly what it is built to do and abort
it as `EVENT_ID_REUSE`. **The result: co-signing freezes the courier for co-signing.**

So the credential rides alongside — `runAgent(event, deps, { credential })` — and the ledger
keeps hashing the event alone. Two behaviours fall out of that for free rather than being
special-cased, which is worth knowing before anyone "simplifies" them:

- the co-signed resubmission is byte-identical, so it seals as a first sighting;
- a courier-only retry arriving *after* sealing hits the ordinary NO-OP replay path.

`lib/agent/cosign.test.ts` holds both, plus a test asserting the sealed payload hash is
unchanged by whether a credential rode along.

### 3d. Two failure modes, two different outcomes

| What happened | Outcome | Why |
|---|---|---|
| A signature is forged, mismatched or unverifiable | **seal `freeze`** (`abortCode: CREDENTIAL_INVALID`, flag `C1`) | An attack is evidence, and evidence belongs in the ledger |
| A required operator co-signature is simply absent | **seal nothing**, halt `PENDING_COSIGNATURE` | The handoff decided nothing, so it must write nothing |

Sealing the pending case would record a decision nobody made — and worse, it would bind the
eventID, so the co-signed resubmission of the very same event could never be sealed.

### 3a. When the machine cannot judge, the signature becomes constitutive

**This is what the co-sign primitive is FOR**, and the cold-start case is where it earns its
keep. A courier with too little history has no pattern score. The gate does **not** invent a
low one on their behalf — it accepts the handoff and makes an operator's signature part of the
credential (`basis: "single_event_only"`, `requiresCosign: true`).

**A future session must not "simplify" cold start into a default-low score.** Doing so
silently certifies handoffs on no evidence, which is the exact failure mode this whole project
argues against — and it would do it to every new hire, invisibly, at the moment they are least
established. The two tests that hold this line sit next to each other in
`lib/gate/gate.test.ts`: *the signature case* and *the cold-start case*. Together they are the
argument that the system neither over-flags newcomers nor certifies on no evidence.

This converts a stated blind spot into designed behaviour. **It is a pitch line:** the honest
answer to "what about a brand-new courier you have no baseline for?" is not a shrug about cold
start — it is that the system knows it cannot judge, says so in the record, and requires a
human to put their name on it.

### 1c. No production module may contain a function that asks a model for a verdict

Not even unused. Not even for measurement. Not behind a flag.

E4 needs one deciding prompt to show that path is unreliable — it lives in
`scripts/experiments/e4-llm-instability.ts` and nowhere else. A reachable one in `lib/llm`
would be exactly the path the architecture forbids, sitting in the codebase waiting to be wired
up, and **building it in to prove it is unsafe would be self-defeating.**

If a future session needs a model verdict for any reason, it goes in a script under
`scripts/`, not in `lib/`.

### 1d. Untested configuration is unverified code

**A default or a config path that no test can reach is not configuration; it is unverified
code.** This applies equally to model ids, endpoint fallbacks, environment-variable resolution
and timeout values. A value looking plausible in a source file says nothing about whether the
service still accepts it or whether URL composition reaches the intended route.

Two live preflights found the same failure shape in consecutive sessions. Session 13 found a
retired `gemini-2.0-flash` default that had survived six sessions because every integration test
skipped without a key. Session 14 found that Ollama's stub defaulted to an OpenAI-compatible
`/v1` base while the configured root URL omitted `/v1`; the shared caller would therefore have
requested `/chat/completions`, a route the local server does not expose. Both would have failed
on demo day despite looking configured.

### 1e. External API output is untrusted input

An external service response is untrusted in exactly the same sense as a delivery note. The
Open-Meteo adapter may pass only zod-validated numeric observations and deterministic WMO labels
into the explanation node. It must never pass through provider prose, HTML, an error message, or
any other natural-language field returned over the network.

This is the session-14 prompt-injection finding applied to integrations: adding a trusted API key
does not make the response trusted as an instruction. A future session must not "enrich" an
explanation with the provider's own description string. Normalise at the boundary, then expose
only the fields the product actually reads.

Weather is corroborating context, never a verdict input. Open-Meteo historical data is regional
reanalysis at roughly 9 km resolution for this scenario date. It can show that regional
conditions were consistent with a benign explanation; it cannot prove that a particular
carpark was wet. The UI and RESULTS.md must state that limit where the claim is shown.

Provider defaults and URL construction therefore require offline request-contract tests that
exercise the real fallback values without needing a live key. Live tests remain necessary for
model retirement and service availability, but skipping them must not also skip construction,
URL and timeout coverage.

### 1f. An injection that changes nothing proves nothing

Every architectural guard in this project is verified by **injecting a real violation and reading
the failure**. Session 17B found the flaw in that method itself, and it is worth stating separately
from any one guard.

The new operator-action test was checked by making `approve` write to the verdict rows:

```ts
db.update(verdicts).set({ decision: "accept" }).run();   // test still passed
db.update(verdicts).set({ decision: "freeze" }).run();   // test failed, naming the row
```

**The first injection was a false pass.** Every row in that harness was already `accept`, so the
"mutation" wrote the value that was there and changed nothing. The test was correct the whole
time; the *probe* was inert. And a test that passes under an inert injection is indistinguishable
from a test that passes under a real one — the transcript looks identical.

**So the discipline is not "check that it fails".** It is:

> **Check that it fails FOR THE REASON YOU EXPECT, naming the thing you broke.**

Read the assertion message, confirm it names the specific row, file or value the injection
touched, and confirm the failing test is the one aimed at that violation. A guard "verified" by a
probe that wrote an identical value, deleted an empty table, or edited a file nothing reads has
not been verified at all.

### 1g. A test suite verifies the invariants someone thought to write

**Found by opening the page, not because anything reported it.**

Session 17B built the courier's shipment as a separately-seeded instance of an existing scenario,
on the reasonable-sounding theory that a different world seed yields a different identity. It does
not: `uuidFrom` derives an event id from the scenario name and leg alone — `"S1-delivery"` — and
the seed never enters it. Two shipments therefore shared one event id, and because the workbench
keys entries by event id, promoting the courier's submission **silently overwrote the operator's
identically-identified case.**

What that walked through untouched:

- seven mechanically enforced architectural constraints
- 608 passing tests
- 100% statement, branch, function and line coverage on `engine`, `pattern` and `gate`
- a clean `tsc --noEmit`, a clean eslint, a successful production build

Nothing threw. The only symptom was one pending item in the inbox where there should have been
two, and the only way to see it was to look.

> **Coverage measures which lines ran. It does not measure which properties hold.** A suite
> verifies the invariants somebody thought to write down, and *"two different worlds must produce
> different event identities"* was not one of them — in this codebase or in the head of anyone who
> reviewed the plan.

**A design approval resting on an unverified assumption about existing code is a guess with a
signature on it.** The premise here — that seeds separate identities — was never checked against
`uuidFrom` by either the author or the reviewer. Cheap to check, and it was the whole basis of the
decision. Before relying on a property of code you did not just write, go and read the code.

#### Two categories of defect this project keeps finding, with different defences

| # | Defect | Category |
|---|---|---|
| 1 | retired `gemini-2.0-flash` default (session 13) | code no test could reach |
| 2 | Ollama base URL calling a route that does not exist (session 14) | code no test could reach |
| 3 | `propose_reroute` success path, never exercised (session 17B) | code no test could reach |
| 4 | `uuidFrom` ignoring the world seed (session 17B) | **invariant no test expressed** |
| 5 | `npm run qa:capture` broken by reserving S1's leg (session 17B) | code no test could reach |
| 6 | `fetch_route_history` and `lookup_recipient_history` selecting nothing (session 18) | **code no test could reach — and the most consequential yet** |

**Number 6 is the one that cost the most.** Two of the plan node's three tools had **no
implementation at all**. They were in the closed enum, in the deterministic heuristic, and named
in the prompt the model reads — and `externalContext` returned early unless the selected tool was
`check_traffic_weather`. Choosing either did nothing.

Every test passed, because **nothing asserted that selecting a tool had an effect**. The parity
tests assert the verdict does not change when tools change, which is the opposite property and is
equally satisfied by a tool that does nothing at all. The enum, the heuristic and the prompt all
described a capability the system did not have.

That is why the whole Agentic AI story looked thin: the model's one real decision mostly selected
inert options. A future session proposing "the model's contribution looks optional" should check
whether the options do anything before concluding the model is redundant.

The first three are **unexercised code**: something written once, unreachable by any real test,
and therefore never questioned. They are found by **tracing before building** — reading the
configuration, the schema semantics or the call graph against what the code claims (see rule 1d,
and rule 4d's cheap check).

The fourth is **exercised code with an unstated property**. Tracing does not find it, because
every line involved runs constantly and does exactly what it says. It is found only by **using the
thing** — and once found, the fix is to make the property hold *by construction* rather than to
add an assertion hoping the next one is remembered. Uniqueness here comes from reserving a leg
from a scenario already present, not from choosing a seed and trusting it.

**So: a browser walk-through of a new surface is not decoration on top of a green suite. It is the
only instrument that detects category 4.**

### 1a. Structured LLM output is accepted or rejected WHOLE, never filtered

A model's response passes every gate or none of it is used. Do not implement
per-citation filtering, per-tool filtering, or "keep the valid parts" as a usability
improvement — it is the same failure as rule 3b in a different coat.

**Why.** Dropping the bad members of a response and keeping the rest lets a model launder an
invented claim by surrounding it with valid ones. A summary that cites `["C1", "I7"]` where I7
never fired is not "mostly right with one bad citation" — it is prose written from a picture
that included a rule that did not happen, and stripping the citation leaves the prose, which
now reads as sourced. Both `PlanResponse` and `ExplainResponse` are all-or-nothing, and the
failure path is the deterministic one.

### 1b. The LLM cannot change a verdict, and the sharpest test says so

Beyond the parity triple (rule 1), `lib/llm/llm.test.ts` has the stronger version: a model
selects a tool the deterministic heuristic would **not** have chosen, the run genuinely gathers
different evidence (`externalContext` is populated in one and absent in the other), and the
sealed verdict is byte-identical.

That is the claim in its strongest form. Not "the model was ignored" — the model changed what
happened, and the decision did not move.

### 3b. Never fabricate a permissive default from unparseable data

A mandate whose stored JSON will not parse, or does not satisfy the schema, yields **no
mandate** — not a partially populated one, not a permissive one. `loadActiveMandate` returns
`undefined` with a reason, H2 then refuses the handoff for want of an authorisation, and the
decision is `freeze`.

"We cannot read what this courier is permitted to do" must never be interpreted generously.
The same rule applies anywhere authorisation data is read: **fail closed, and say why.**

### 3e. The UI must not assert precision the data does not have

Two ways the console could lie without a word of it being false, both banned:

- **Plotting `not_evaluated` at the origin.** A null score means the axis could not be
  evaluated. Drawing it at zero claims a measurement nobody made. The gate explorer puts those
  points in **gutter bands outside the numeric scale**, hollow, with the reason on hover —
  "the courier has four handoffs and the floor is ten" is a materially stronger statement than
  "unknown".
- **Mixing illustrative points into an observation series.** The same-sum trio — (0,80), (80,0),
  (40,40) — is drawn in its own series, outlined, explicitly labelled as reference points.
  **No real event in the dataset sits at (80,0) or (40,40)**: S1 scores 100 and the middle case
  does not occur. Do not "fix" the annotation layer by hunting for real points that match — there
  are none, and finding near-misses to stand in for them would be the invention this rule forbids.
- **Inventing map geometry for evidence that has none.** Coordinate-bearing evidence may link to
  a marker, circle or polygon. Evidence without measured coordinates stays unlinked. Guessing a
  location so every flag can pulse on the map would turn an absent measurement into a spatial
  claim, exactly like plotting `not_evaluated` at zero.

All three are the same class of error as collapsing the three-state `RuleResult` into a boolean
(rule 4). The console displays what was measured, says what was not, and marks what is
illustration.

### 3f. The verdict is a fact; the operator chooses the disposition

An operator may approve, reject, request evidence, escalate or propose a reroute. Those are
**post-gate operational dispositions**. None of them may edit, replace or reinterpret a sealed
deterministic verdict. If a human can rewrite the verdict, then the claim that the engine always
decides is false even if no LLM is involved.

Approval is not a special `approved` path and never flips a database flag. The operator completes
the credential, then the **identical EPCIS event runs through the identical agent pipeline again**.
The sidecar credential is simply complete on the second run, so the event can now seal. The UI
must show this as a second verification run, not as a state toggle.

`lib/purity.test.ts` and the operator-action tests must keep this mechanically true: no action
handler may update a sealed verdict row, and approval must resubmit the unchanged event through
`runAgent`.

**Why `approve` needs a DIFFERENT assertion from the other four actions.** A future session
reading only *"operator actions cannot mutate verdicts"* will write one uniform check and think it
is done. It is not, and the reason is the thing worth carrying:

> **"Appends a second run" and "rewrote the first" are indistinguishable to a suite that only
> counts rows.**

That is the class of hole that never produces an error. Four of the five actions seal nothing, so
for them the assertion is simply that every verdict row is byte-identical afterwards. `approve` is
the only one that legitimately **writes** — it reruns the byte-identical event with a completed
sidecar, which seals a second ledger entry and projects a second verdict row. So its assertion is
necessarily different and stronger: every **pre-existing** row survives byte-identical, and the
only permitted delta is an **added** row carrying the same event hash.

Session 17A had exactly one such test and it covered `reject`. Four of five enum members were
unguarded, and the one that writes was the one nobody was watching. Session 17B replaced it with
two layers:

- `lib/workbench/actions.test.ts` — table-driven over every member of `OperatorActionName`, with
  the split assertion above, plus a coverage check that fails if a sixth action is added and left
  uncovered. `propose_reroute` currently has no reachable success path in the seeded workbench, so
  it is asserted on its **refusal**: a guard that throws must throw before it writes anything, or
  a refusal leaves a half-applied action behind.
- `lib/purity.test.ts` — **the seventh architectural constraint verified by running the suite.**
  No source under `lib/workbench/` or `app/api/operator/` may call `.update(verdicts)` or
  `.delete(verdicts)`. It bans the **verb**, not the table, because inserting is the mechanism and
  updating in place is the failure. Both layers were confirmed non-vacuous by injecting a real
  mutation and reading the failure message, as with the never-summed and no-I/O guards.

### 3g. Text that restates a decision must be DERIVED from the decision

Three instances now, all the same instinct, so it is recorded once as a rule rather than three
times as observations:

| Surface | Derived from | The hardcoded version |
|---|---|---|
| Courier submission result | `VerificationResult` + `ledgerStatus` | "your submission needs approval" — still said after the credential check changed its mind |
| Reroute rejected alternatives | the selector's own filter predicates | "no authorised reroute exists" — true, and useless |
| Plan rejected alternatives | `considerTools`, over the closed enum | a UI re-deriving "why not that one?" — a second copy of the eligibility rules |

**A correct message that does not tell the operator what to do next has not done its job.**
*"No authorised reroute exists for this address"* is true of every excluded candidate and actionable
for none of them. *"This parcel is outside the mandate's EPC scope"* names the blocker, so the
operator knows whether to widen a mandate, activate a counter, or escalate instead. `covers`
therefore became `refusal`, returning the predicate that failed rather than a boolean.

And the drift argument is the same one that bans recomputing a verdict in the browser: a view that
works out its own explanation is a **second implementation** of the rule it is explaining, and the
two part company the first time the rule moves. Ask the decider why; never re-derive it downstream.

#### The corollary: never fabricate a rationale nobody produced

When the **model** selects the tools, the panel shows the deterministic set as a **labelled
comparison** — never as the model's reasoning. The model is not asked to justify itself, and
presenting the heuristic's reasons under its choice would invent a justification that does not
exist.

**That is the same class of error as a hallucinated citation (rule 1a), moved from the explanation
node into the UI layer.** Prose assembled from a picture of something that did not happen reads as
sourced precisely because it is well-formed. A future session adding *"why did the model pick
this?"* to that panel will believe it is an improvement; it is the failure rule 1a exists to
prevent, one layer further out. If the reason cannot be obtained from whoever actually decided,
the honest rendering is to say who decided and show the alternative separately.

### 4. Missing evidence is not clean evidence

Every rule returns **three** states, never a boolean:

```ts
type RuleResult =
  | { status: "triggered"; flag: Flag }
  | { status: "clear" }              // the signals were there and they agreed
  | { status: "not_evaluated"; reason: string };   // the signals were not there
```

**Do not collapse this into a boolean.** `clear` means two independent signals were compared
and agreed. `not_evaluated` means there was nothing to compare. A courier in a tunnel loses
GPS precision, cell service and WiFi; scoring that absence as "clean" makes **S6 (a tunnel)
arithmetically identical to S1 (spoofing)** — both would score zero on the location rules for
opposite reasons. Those two scenarios are the entire false-positive argument, and the third
state is the only thing that separates them.

The same reasoning applies to `i8IntegrityFailed`: an attestation with verdict `unevaluated`
is `not_evaluated`, never `clear`. Treating silence as approval is how attestation gets defeated.

**Operator-facing output:** the engine returns a `coverage` block, rendered as
**"12 of 16 checks evaluable"** next to the score. This is intended UI, not debug output. A
score of 0 from 12 evaluated checks and a score of 0 from 2 evaluated checks are different
claims, and an operator who cannot tell them apart is being misled by their own dashboard.

### 4d. S2 was rebuilt because the original scenario contradicted the engine

`track idea.md` §8 originally described the signature case as **batch scanning from a van**: the
courier parks and scans a load of parcels addressed across the neighbourhood. **The condo-lobby
version now in `lib/generate/scenarios/` is not a watered-down substitute for that. The van
version is unbuildable**, and a future session that sees the original wording should not "restore"
it.

Traced against the built engine:

- Scanning from one spot puts every scan hundreds of metres to kilometres from its recipient
  address, so **I10/I11 fire on every event** — the events are not clean.
- Moving the claimed positions onto the addresses to fix that makes consecutive scans imply
  impossible speeds, so **I3 fires** instead — still not clean.

Either way axis 1 catches it, and S2 stops being the case only the pattern axis can see, which
is the entire reason S2 exists.

**The condo tower keeps every event genuinely clean** — 40 parcels for one building, scanned at
twenty-second intervals: the addresses really are clustered so P4 correctly stays silent, the
scans are at the doors so I10/I11 are clean, the distances are metres so I3 is clean, and every
event scores **0** on all sixteen checks. What remains is the shape: **P1** (a delivery rate no
one can walk) and **P2** (the customers complain).

**This was found by tracing, not by running** — reading the scenario against the built rules
before writing the generator. It is worth knowing that the check is cheap and catches this class
of problem: a scenario can be internally coherent and still contradict the system it is meant to
exercise.

**The argument it produced is a pitch line:**

> A fraudster can fake **WHERE**. They cannot fake **HOW FAST**, or **WHETHER THE CUSTOMER GOT
> IT**. P1 is a property of the *set*; P2 is an outcome that *arrives later*. Neither exists
> inside any single event.

That is the clearest statement of why the pattern axis is not a supplement to the single-event
axis but a **structurally different kind of evidence** — and therefore why rule 2's ban on
summing them is not fussiness.

### 4e. Direction is part of the signal

**A rule that collapses two physically different situations into one magnitude is measuring the
wrong quantity, and no amount of retuning fixes it.** Before changing a bad threshold, check
whether `abs(...)`, an unsigned distance, or a symmetric band has folded together mechanisms
whose causes and bounds are different.

I4/I5 exposed this exactly. `recordTime - eventTime > 0` means the server received a scan after
the device says it happened: store-and-forward upload latency can make that gap arbitrarily long.
`eventTime - recordTime > 0` means the device claims the event happened in the server's future:
upload latency cannot cause that, and the benign bound comes from clock synchronisation and
oscillator drift. **One direction is bounded by nothing; the other is bounded by physics.** Taking
the absolute value made the old derivation wrong in the upload-delay direction and unfalsifiable
in the clock-ahead direction.

The second failure was visible without an experiment. I4 awarded exactly **30 points**, while the
gate's `highInconsistency` cut is exactly **30** and its own derivation says one environmental
hiccup should not cross the cut alone. I4 therefore defeated the gate's stated design by
construction. **This was found by reading the engine and gate threshold modules against each
other**, a check worth repeating: any rule whose points equal a gate cut deserves the same
scrutiny and an explicit claim that the rule is reliable enough to alert on its own.

### 4f. A house rule: never collapse a three-state fact into two states

This project has now refused the same reduction **four times, in four unrelated places**. It is
one instinct, not four decisions, and a future session should recognise it as such rather than
re-deriving it each time — or worse, "simplifying" one of them back.

| Where | The two-state version | What it would destroy |
|---|---|---|
| `RuleResult` (rule 4) | `passed: boolean` | `clear` and `not_evaluated` become the same, so S6 (a tunnel) is arithmetically identical to S1 (spoofing) |
| Gate explorer (rule 3e) | plot `not_evaluated` at the origin | an unmeasured axis becomes a measured zero |
| Map overlays (rule 3e) | give every flag a location | evidence without coordinates becomes a spatial claim |
| `RunView.ledgerStatus` | `sealed: boolean` | an honest double-tap and a forgery attempt become the same event |
| `ToolConsideration` | `selected: boolean` alone | "eligible but displaced by the cap" collapses into "not relevant", hiding that a real option was left on the table |

The last one is session 17B's. `sealed` collapses the ledger's `recorded` and `noop` into one
value. That is exactly right for the operator's question — *is there an entry?* — and exactly
wrong for the courier's, because **a courier tapping twice on a bad connection and someone
reusing an event id with different content are the two things the idempotency design exists to
tell apart** (rule 5). Hashing the canonicalised payload rather than the raw bytes is what buys
that distinction; rendering both through one boolean throws the purchase away, silently, in the
one place a real person would see the accusation. `RunView` therefore carries `ledgerStatus`
alongside `sealed` rather than replacing it: the operator's boolean is still the right shape for
the operator.

**The test for whether this rule applies:** if the third state means *"we did not, or could not,
observe this"* — or *"this is the benign member of a pair the system can distinguish"* — then a
boolean is a lie of omission, and the cost of the extra state is one field.

### 4b. Every rule is a contradiction between signals, not a lone heuristic

This is the shape every rule in the system takes, on both axes. A lone heuristic measures one
thing and guesses; a contradiction needs two independent sources to disagree, which is far
harder to forge and far less likely to fire on honest work.

**P4 is the clearest illustration.** "Deliveries are clustered" is a lone heuristic, and it
flags any courier working a single condo tower — they have done nothing wrong. The rule instead
asks whether the **scan points** are clustered *while the **recipient addresses** are spread*:
two signals disagreeing. Clustered scans **and** clustered addresses is a building. Clustered
scans against spread addresses is batch-scanning from the van.

`P3` follows the same shape (a distribution disagreeing with what environmental noise produces),
as does every I-rule. Write new rules to it. If a proposed rule reads one signal and thresholds
it, look for the second signal it should be contradicting.

### 4c. P3's trap: the cleanest courier has the tightest distribution

A courier scoring `0, 0, 0, 0, 0` has a standard deviation of **zero** — the tightest
distribution available. A naive low-variance rule flags the best courier in the fleet.

That would be the single worst false positive this system can produce, and it would invalidate
the S0 baseline outright: the honest courier is exactly the one whose scores do not vary.

**P3 therefore requires low variance around a NON-ZERO mean** (`mean >= p3MinMeanScore &&
stdev < p3MaxStdDev`). Someone consistently at 25±1 is hugging a threshold; someone
consistently at 0 is doing their job. **Never relax the mean condition.** Two tests guard it:
a perfectly clean courier over 40 handoffs, and a well-behaved courier with ordinary noise.

### 4a. Every rule that applies to a subset of bizSteps must state its gate

`I10`/`I11` (distance from the recipient address) and `I12` (missing proof of delivery) are
gated to `delivering` and `accepting` via `DELIVERY_STEPS` in `lib/engine/inconsistency.ts`.

Ungated, they fire on **every sortation and line-haul scan in the S0 baseline** — a depot scan
is legitimately 300 km from the recipient and legitimately has no signature, so every normal
parcel would accumulate +45 on I12 alone. That buries the "fewer false alerts" claim the brief
explicitly scores, under thousands of false positives generated by our own rule set.

Any future rule that only makes sense for some business steps must declare its gate explicitly
and return `not_evaluated` outside it. `lib/engine/engine.test.ts` has an S0 regression test —
a full collection → sortation → line-haul → out-for-delivery → delivery timeline that must
score **0 at every leg**. If a rule change breaks the false-positive claim, that test fails
before a judge ever sees the number.

### 5. A double-tap is never a fraud alert

The nonce ledger hashes the **canonicalised parsed payload**, not raw request bytes. A retry
that merely reorders JSON keys — which HTTP clients, proxies and retry libraries do routinely
— must hash identically and return the original verdict as a NO-OP.

Hashing raw bytes would turn a courier tapping twice in a dead spot into an `EVENT_ID_REUSE`
forgery alert against a real person. **False positives are an explicit scoring criterion in
this competition**, and that one would be the worst kind: confidently wrong, and aimed at
someone who did nothing.

### 6. The ledger is a file, not a table

`data/ledger/nonce-ledger.jsonl` is append-only and hash-chained (`prevHash` -> `entryHash`).
A table is mutable by anyone with a connection, and "we only ever INSERT" is a promise about
our code; a hash-chained file is a property of the artefact. `verifyChain()` returns the
**index** of the first break, so tampering is located, not just detected.

The `verdicts` table is a queryable projection for the console. If it ever disagrees with the
ledger, **the ledger wins**.

### 7. A failed forgery is evidence, not a discard

An `EVENT_ID_REUSE` rejection writes an **abort record** to the ledger. Someone attempting to
reuse a legitimate `eventID` with different content is the single most incriminating thing in
the dataset, and throwing it away because it "didn't succeed" would discard the best evidence
the system ever sees. An audit trail that records only what was accepted is not an audit trail.

This is a **demo beat**: show the attempt sitting in the chain, immutably, next to the verdict
it tried to overwrite. Abort records never create or overwrite an eventID binding, so an
attacker cannot rebind an ID by submitting a forgery after the fact.

### 8. A mocked attestation must never look real in our own data

`VigilDeviceIntegrity.attestationSource` is **required**, with no default, and must be one of
`mocked | play-integrity | device-check`.

Do not make it optional. Do not give it a default. Do not infer it.

The prototype simulates Play Integrity, and a simulated attestation that is indistinguishable
from a real one *inside our own dataset* is precisely the forgery this project claims to
detect. Defaulting the field would mean our own synthetic data commits the fraud we are
selling a defence against — and a judge who spots that has grounds to discount every number
in the submission. The cost of keeping it required is one explicit field per fixture.

---

## Stack — decided, do not substitute

- Next.js (App Router) + TypeScript, Node 22+ (running 24)
- **zod** — a core dependency, not a helper. It carries the closed tool enum and the
  fail-closed citation check
- SQLite + better-sqlite3 + Drizzle ORM
- Append-only `.jsonl` for the nonce ledger (deliberately not a DB table)
- Node built-in `crypto` for Ed25519 and sha256 — no external crypto library
- `@turf/turf` for geo math, `seedrandom` for reproducible synthetic data
- Tailwind 4 + shadcn/ui, ECharts for the two-axis gate explorer, native `EventSource` for SSE
- `motion` only, and only for timeline leg entrance, custom-row layout transitions and verdict
  badge changes. Gate threshold feedback and the SSE sequence are deliberately animation-free;
  no GSAP or three.js. See the Console conventions for the reasons.
- vitest

### Dependency decisions

**`npm audit` reports 4 moderate advisories. Leave them.** They are a dev-server esbuild issue
(GHSA-67mh-4wv8-2f99) reached only through drizzle-kit's transitive `@esbuild-kit/*` deps.
`npm audit fix --force` "resolves" it by downgrading drizzle-kit to 0.18.1, which is a breaking
change to our migration tooling to patch something that never runs in production and is not
reachable from anything we ship. **Do not run `npm audit fix --force`.**

**`@types/node` is pinned to `^24`,** not create-next-app's `^20`. Node 24 is the runtime and
vitest 5 requires `>=24`. Do not revert it.

---

## Layout

```
app/                     Next.js App Router
lib/
  epcis/                 GS1 EPCIS 2.0 as zod schemas
    primitives.ts        EPC/SGLN URIs, ISO-8601 with mandatory offset
    vocabulary.ts        CBV bizStep / disposition enums
    sensor.ts            sensorElementList + the vigil: extension
    events.ts            ObjectEvent | TransactionEvent | AssociationEvent
  db/
    schema.ts            parcels, couriers, device enrollments, OTP challenges,
                         mandates, events, verdicts
    client.ts            better-sqlite3 + Drizzle
    migrate.ts           programmatic migrations (tests, seeds)
    migrations/          generated SQL
  ledger/
    canonical.ts         canonical JSON -> sha256
    types.ts             LedgerRecord, Verdict, CheckResult
    ledger.ts            NonceLedger: check / commit / submit / verifyChain
  engine/                AXIS 1 ONLY. Pure functions, no I/O.
    thresholds.ts        every number, one source comment each; band tables
    custody.ts           disposition -> permitted bizStep (H1's policy table)
    geo.ts               turf wrappers; the only place lat/lng is inverted
    types.ts             EngineInput, RuleResult, Flag, Evidence, EngineResult
    hard.ts              H1 H2 H3 (abort, do not score)
    inconsistency.ts     I1-I16 (score) + the rule registry
    engine.ts            hard checks -> scoring -> clamp -> coverage
    fixtures.ts          shared test fixtures; never imported by a rule
  pattern/               AXIS 2 ONLY. Pure functions, no I/O.
    thresholds.ts        axis-2 numbers, one source comment each
    types.ts             PatternInput, PastHandoff, PatternOutcome
    rules.ts             P1-P5 + the rule registry
    pattern.ts           cold-start gate, runs rules, coverage
  gate/                  THE ONLY PLACE THE TWO AXES MEET. Pure.
    thresholds.ts        axis cut points, severity order
    types.ts             GateInput, GateResult, ShiftContext
    gate.ts              the matrix (incl. absence cells), then limits/cooldown
  credential/            THE CONSTITUTIVE CO-SIGN. Deterministic; node:crypto only.
    types.ts             SignedPayload, Credential, VerificationResult
    message.ts           what is signed (reuses lib/ledger canonicalize)
    verify.ts            verifyCredential() — reports what it found, not a boolean
    sign.ts              signing helpers for the injector and the console
    keys.ts              env-var keys. The ONLY impure file here.
  mandate/
    schema.ts            CourierMandate zod. Shape only.
  console/               THE CONSOLE'S READ MODEL. Server-side, memoised.
    dataset.ts           runs the agent once, serves what it sealed
    playback.ts          the timeline stepping machine (pure, no React)
  llm/                   THE MODEL SEAM. Two nodes, neither able to move a verdict.
    types.ts             LlmProvider, LlmTelemetry (counters, by reason)
    schemas.ts           PlanResponse / ExplainResponse — all-or-nothing
    prompts.ts           the two prompts; neither asks for a judgement
    plan.ts              tool selection + the REAL deterministic heuristic
    explain.ts           citation validation, decision-word check, fallback
    providers/           gemini.ts, anthropic.ts, ollama.ts, fake.ts
  weather/               OPEN-METEO ADAPTER. Optional context, never a verdict input.
    types.ts             validated query, observation, cache and result shapes
    open-meteo.ts        archive request + exact coordinate/hour disk cache
    wmo.ts               deterministic labels; provider prose never crosses the boundary
  reroute/               POST-GATE NEXT ACTION. Deterministic and separately co-signed.
    propose.ts           mandate-aware pickup/reassignment selection
    credential.ts        exact-action Ed25519 credential; courier + operator required
    assemble.ts          database rows into the pure proposal input
    persist.ts           queryable proposal and approval-state projection
  generate/              SYNTHETIC DATA. Emits behaviour; never reads a threshold.
    data/                kl-addresses.json, with its provenance in the file
    rng.ts               seedrandom wrappers; the only source of randomness
    world.ts             couriers, mandates, parcels, reference sites
    timeline.ts          the six-leg shipment, built THROUGH the EPCIS schema
    carefulness.ts       the fraudster's 0-4 capability ladder
    split.ts             deterministic holdout for the experiments
    scenarios/           S0-S6 + warm-up history
    identity-cases.ts    experiment-only OTP-channel and replacement-device cases
    ingest.ts            runs a generated scenario through the real agent
  purity.test.ts         guards the I/O ban, the never-summed rule AND
                         the generator/detector separation
  assemble/              WHERE THE I/O IS. Deliberately NOT under the purity test.
    types.ts             Resolution: what was found, what was missing, and why
    mandate.ts           mandate row -> validated CourierMandate (fails closed)
    engine-input.ts      event + mandate + previous + referenceSites
    pattern-input.ts     the courier's window + stored scores + disputes
    gate-input.ts        both axis results + shift context + parcel value
    persist.ts           projects a sealed handoff into the console tables
  agent/
    nodes-list.ts        the eight node names (kept apart from the context)
    trace.ts             THE SSE CONTRACT. Frozen from session 4.
    context.ts           AgentContext, the closed ToolName enum
    nodes.ts             the eight node implementations
    machine.ts           the switch driver
    fixtures.ts          a seeded world: real SQLite, real ledger, fake clock
app/
  timeline/              view 1 — normal activity to a meaningful exception
  stream/                view 2 — the eight nodes, live over SSE
  gate/                  view 3 — the two axes and four actions
  api/                   thin, read-only: scenarios, shipment, scatter, stream
components/
  console/               the three views + shared display primitives
  ui/                    shadcn (Radix). NEVER wrapped in AnimatePresence.
data/
  ledger/                nonce-ledger.jsonl (gitignored)
  db/                    vigil.db (gitignored)
```

### The EPCIS extension namespace

Mock-location flags, cell observations, WiFi scans and integrity attestations are not in the
CBV. They live under `vigil:` inside `sensorElementList`, which is where EPCIS 2.0 says user
extensions go — so "why is your custom data in a standards event?" has a spec-shaped answer.
`vigil:courierId` sits at the event root for the same reason: EPCIS models parties and
locations, not the individual who pressed the button, and that claim is *unverified* by
construction.

Everything under `vigil:` is a **signal**, never a **judgement**. Nothing there says
"fraudulent". The engine decides that by finding contradictions across signals.

`attestationSource` is required and must be one of `mocked | play-integrity | device-check`.
A simulated attestation must never be indistinguishable from a real one **in our own data** —
that is exactly the forgery we claim to detect.

---

## The SSE trace contract

**Frozen from session 4.** The operator console is built against this shape, so add optional
fields if you must, but do not rename one, remove one, or change a frame's meaning.
`lib/agent/trace.test.ts` is what stops it moving.

Four frame types, zod-validated on the way out so a malformed frame fails in the server rather
than in a browser:

| type | carries |
|---|---|
| `tool_start` | `seq`, `node`, `at` |
| `tool_end` | `seq`, `node`, `at`, `durationMs`, `summary?`, `error?` |
| `thought` | `seq`, `node`, `at`, `text` — free text, **the only frame an LLM will ever author**, never read by the engine |
| `result` | `seq`, `at`, `decision?`, `basis?`, `requiresCosign?`, `inconsistencyScore?`, `patternScore?`, `flags`, `halted?` |

- `seq` is monotonic from 0 and is **the ordering authority**. SSE delivery order is not
  something a client should have to trust.
- `verify` and `fetch_history` carry their flag ids, axis score and coverage in `summary`.
- Exactly one `result` frame, always last, emitted whether or not the run completed. A halted
  run still produces one, naming where it stopped.
- The result frame keeps the two axis scores as **separate fields**. There is no combined
  field, and a client must never add them. A test asserts no `totalScore`/`riskScore` appears.
- `toSseMessage()` is the wire format: `event: <type>
data: <json>

`.

## Console conventions

### Three anti-references

Use these as the ruler for every product-facing layout decision:

1. **Vigil is not an analytics dashboard.** The operator is here to process work, not admire
   charts. Queues, evidence, decisions and next actions lead; aggregate visualisation is a demo
   tool outside the primary workflow.
2. **Vigil is not a scenario browser.** Scenario selection is a demo affordance, not a product
   feature. It belongs in a quiet corner and must say honestly that it loads a named, seeded
   synthetic shipment.
3. **Vigil is not a courier surveillance system.** Vigil cross-checks claims between courier,
   recipient and operator. It does not rank workers, infer productivity or frame risk as employee
   monitoring. That framing is technically wrong and a bad logistics-sponsor pitch.

### Layout: three routes, not tabs

`/timeline`, `/stream`, `/gate` under one shell. Deep links (`/timeline?scenario=S2`) go
straight into the argument during a demo, and the stream view holds a live `EventSource` that a
tab switch would either tear down or leave running invisibly. Desktop operator console; dense
is fine, cramped is not.

### Animation policy

`motion` (Framer Motion) only. **No GSAP** — there is no scroll-driven narrative here and two
animation libraries is pure overhead.

**Where motion is used:** timeline leg entrance and play-through, layout transitions when a leg
expands, verdict badge state changes.

**Where animation is banned, and why:**

| Surface | Rule | Why |
|---|---|---|
| Gate explorer recolour | `animation: false` on the ECharts option | Any easing reads as lag. The value of that view is "I drag, it changes NOW" |
| SSE node sequence | CSS colour transition on the state change only | The stream already has genuine timing because the nodes really are executing. Added entrance animation makes it impossible to tell which delays are computation and which are decoration — which is the whole point of showing the reasoning |
| Flag expansion | Radix `data-state` keyframes, no bounce | An operator clicks this dozens of times a shift |

### NEVER wrap a Radix component in `AnimatePresence`

shadcn components are Radix underneath and animate via `data-state` CSS keyframes
(`tw-animate-css`). Wrapping one in `AnimatePresence` puts two unmount mechanisms in a fight and
produces intermittent ghosting that is painful to debug — it reproduces unreliably and looks
like a rendering bug rather than a structural one.

**The split:** Radix components keep their own `data-state` animation. `motion` is for our own
lists and cards only. `CollapsibleContent` in `timeline-view.tsx` is the reference case — it
sits inside a `motion.li` but is not itself wrapped.

This is now the **sixth architectural constraint enforced by the suite**. `lib/purity.test.ts`
fails if either `gate-explorer.tsx` or `stream-view.tsx` imports `motion`, renders a `motion.*`
element, or introduces `AnimatePresence`. Reading the policy is optional; violating it is not.

### Recording pace and capture

The six-leg timeline uses **1.9 seconds per ordinary leg at 1x**, reveals leg one immediately,
and holds longer on the exception. The `0.75x / 1x / 1.5x` control separates a slower review
pace, the recording default, and live presentation. Long timelines still compress so S2's forty
handoffs remain watchable. Speed changes timing only; the pure playback reducer still owns what
each tick means.

`npm run qa:capture` renders the four current operator-console evidence frames in local Chrome at
an explicit **1920x1080** viewport and writes them under `docs/screenshots/session-17a/`. The
pending S1 detail URL is resolved from the workbench API at capture time; the script does not
hardcode an event id or fabricate a display fixture.

### The verdict is never recomputed in the browser

`lib/console/dataset.ts` runs the real agent server-side, once per process, and the routes read
what it sealed. A browser that recomputed a score would be showing a second opinion nobody
signed, and the two would drift the first time a threshold moved.

### The operator workbench is stateful by design

The session-8 console regenerated each scenario into a temporary SQLite database, read it, then
destroyed it. That is correct for a read-only viewer and **fatally wrong for a work queue**: an
operator action would disappear on the next request, a pending co-signature could not be resumed,
and recipient responses could never become later pattern evidence.

The operator workbench therefore owns a long-lived server-side SQLite/ledger harness for the demo
process. Routes read and mutate that one operational state; they do not regenerate a scenario per
request. A future session must not "simplify" this back into per-request generation. Doing so
silently converts real controls into a reset-on-refresh facade.

**Two consequences worth knowing before debugging it.**

**The singleton survives HMR.** `globalThis.__vigilOperatorWorkbench` holds a built instance, so
editing `lib/workbench/` in `next dev` recompiles the module and keeps the OLD object. A new
method appears as `workbench.X is not a function` until the dev server is restarted. That is dev
ergonomics, not a product defect — but it will waste an hour if it is not written down.

**Entries are keyed by event id, and generated event ids are not as unique as they look.**
`uuidFrom` derives the id from the scenario name and leg alone (`"S1-delivery"`), so the world
seed does not enter it: two shipments built from the same scenario under DIFFERENT seeds share an
event id. Session 17B's first courier implementation built the draft as a separately-seeded
instance and therefore silently overwrote the operator's identically-identified case on promote.
**Nothing threw and every test passed; it was visible only by opening the inbox.** Anything that
adds a shipment to this map must reserve it from a scenario already present rather than building a
second instance of one — `lib/workbench/courier.test.ts` asserts no draft collides.

### The SSE route needs a plain Node server

`app/api/stream/route.ts` runs a real event through `runAgent` and streams the frames it emits.
**It will not survive a serverless function timeout** — Vercel's free tier cuts off at 10
seconds and preparing S2 alone takes longer. This is part of why the demo runs locally and is
recorded rather than deployed.

## Commands

```bash
npm run dev          # Next dev server
npm test             # vitest, all lib/ tests
npm run typecheck    # tsc --noEmit  (run `npm run build` first: Next generates route types)
npm run lint
npm run test:coverage # engine + pattern + gate; must stay at 100% branch
node scripts/fetch-addresses.mjs  # refresh the geocoded address cache (one-off)
npm run weather:cache:s6 # fill/check the fixed S6 Open-Meteo archive cache
npm run db:generate  # regenerate migrations after editing lib/db/schema.ts
npm run db:migrate
```

---

## Session log

### Session 17B — courier, recipient, rejected alternatives, browser verification (complete)

629 tests passing, 7 live-provider tests skipped. `tsc --noEmit` clean, eslint clean, the
production build clean; `lib/engine/`, `lib/pattern/` and `lib/gate/` remain at 100% statements,
branches, functions and lines. No detector threshold moved and no experiment was rerun.

Four surfaces landed, and every one was walked in a browser rather than only compiled.

**The operator-action invariant was weaker than 17A claimed.** There was one test and it covered
`reject`. `OperatorActionName` has five members, so four were unguarded — and the unguarded one
that matters is `approve`, the only action that legitimately writes. It is now table-driven over
the whole enum with a coverage check that fails when a sixth action is added, plus a structural
ban on `.update(verdicts)` / `.delete(verdicts)` as **the seventh constraint verified by running
the suite**. See rule 3f for why `approve` needs a different assertion from the other four.

**`/courier` makes the two-phase co-sign legible.** Unsigned halts `PENDING_COURIER_SIGNATURE`,
writes nothing, and is deliberately **not queued** — nobody is waiting on an operator, so queueing
it would hand them work they cannot action. A courier-only credential reads *"Signature valid, but
insufficient"*, derived from `VerificationResult` rather than hardcoded. The co-signed rerun seals
as a **first sighting, not `EVENT_ID_REUSE`**, which is rule 3c asserted rather than described. A
later retry of the same bytes is a **NO-OP replay** — behaviour that has existed since session 1
and had never been visible anywhere.

**`/confirm/[token]` closes the P2 loop in data, not on screen.** E1 measured that the careful
fraudster is caught by the customer complaint; that input used to come from the generator writing
disputes directly. The load-bearing test asserts a dispute raised through the recipient's own link
is read by `assemblePatternInput` — same table, same join, no special wiring.

**Rejected alternatives are disclosed for both selectors.** `covers` became `refusal`, returning
the predicate that failed, so the panel says *"this parcel is outside the mandate's EPC scope"*
instead of the true-and-useless *"no authorised reroute exists"*. See rule 3g.

**`/verify` recomputes the hash chain in the visitor's browser.** Verified live: *"Chain intact
across 19 records"*, then *"Chain breaks at record 2"* on a tampered copy, then the served ledger
byte-identical afterwards.

#### `walkChain` takes precomputed hashes, and the obvious "improvement" would break it

The tempting refactor is to let the walker own its hashing. **It must not.** Node hashes
synchronously with `node:crypto`; a browser can only hash asynchronously through `crypto.subtle`.
A walker that owned the digest would force one of those two to keep its own copy of the sequence
ordering, the `prevHash` linkage and the first-broken-index — and the copy that drifts is always
the one without the tests. Passing the hashes in confines the async/sync difference to *"how do I
hash a string"*, which is exactly where it belongs, and keeps **one chain walker** shared by
`NonceLedger.verifyChain()` and the page. That single walker is what makes the whole exercise
worth anything: the page and the server cannot reach different conclusions about the same file.

`canonicalize` was **moved**, not copied, for the same class of reason — see rule 5.

#### The Node / Web Crypto pin in `chain.test.ts`

`crypto.subtle` exists in Node 24, so the code that runs in a visitor's browser is exercised by
vitest directly rather than only by clicking a button. One test asserts the Node and Web Crypto
recipes produce **identical entry hashes on real records**.

> **A verification tool that miscomputes would confidently report a break in an intact chain —
> accusing the artefact of exactly what it exists to disprove.**

That is the sharpest statement of why the test exists, and a future session must not weaken it to
"both return a 64-character string". The two digests are the only thing that differs between the
server and the page; if they disagree, `/verify` becomes a machine for manufacturing false
accusations against our own ledger.

#### The `qa:capture` regression — the fifth instance, and the most instructive

Reserving S1's delivery leg for the courier removed the pending co-signature from the operator's
queue at boot. That is the correct product behaviour. It also **silently broke
`npm run qa:capture`**, which had been looking that case up by assuming it existed at boot.

**I introduced it in Part A and found it by accident in Part D**, while diagnosing something else
entirely. A green suite of 621 tests, a clean typecheck, a clean lint, a successful production
build — and the one script the demo video depends on threw on its first line of real work.

**The demo-critical scripts are not covered by the test suite.** `npm run qa:capture`,
`npm run weather:cache:s6` and the `scripts/experiments/` entry points are run by hand or not at
all, and nothing will tell us if they break again. **Run them manually before submission**, and
treat a change to workbench construction or scenario shape as a reason to run the capture script
specifically.

The script now submits the courier draft before looking for the pending case, so it captures the
*flow* rather than a fixture, and fails loudly if the draft has already been co-signed instead of
writing a frame that does not show what its filename claims.

#### Tooling note, timeboxed and unresolved

**The interactive browser pane's `screenshot` action returns blank frames** on the operator detail
page, intermittently and including after `scroll_to`. **The headless capture path is healthy** —
`npm run qa:capture` renders all five frames at 1920x1080 with Leaflet tiles loaded, under
`--virtual-time-budget=5000` and `--run-all-compositor-stages-before-draw`.

Since the demo video uses the headless path, this was timeboxed and left. Content and structure
were verified by reading the rendered markup instead, which is honest verification of what is in
the DOM and **not** verification of visual presentation. A future session should not re-diagnose
this from scratch: the two paths are different, and only the healthy one matters for submission.

#### Design decisions worth not re-litigating

- **Courier drafts are legs RESERVED from their own scenario**, never separately-seeded instances.
  The first attempt duplicated an event identity; see rule 1g.
- **A positive confirmation never enters `disputes`** — it would corrupt P2's numerator *and* the
  fleet baseline computed from the same table.
- **`no_response` is written only when a window closes**, and the API rejects it with a 400 from a
  caller. Silence is an observation, never an assertion.
- **The recipient link is scoped to the handoff on screen**, never listed. A listing endpoint
  hands out every capability at once.
- **The heuristic's reasons are never presented as the model's rationale.** Rule 3g's corollary.

#### New rules recorded this session

`1f` (an injection that changes nothing proves nothing), `1g` (a suite verifies the invariants
someone thought to write, with the two defect categories and their different defences), `3g` (text
that restates a decision must be derived from it), and `4f` extended to five instances.

#### Still open after 17B

Rejected-alternative disclosure for `propose_reroute`'s **success** path is unexercised: no seeded
scenario yields a proposal, so the panel shows the rejection half and says so with a provenance
label. `seedDraftIdentity` remains a deliberate duplicate awaiting its fold-back. The submission
artefacts — write-up, recorded demo, RESULTS.md refresh — are the remaining work.

### Session 17A — operator workbench and spatial evidence (complete)

**The product now opens on work, not an explanation of the system.** `/operator/inbox` is the
priority queue; `/operator/handoffs` proves the automatic path with an explicit numerator,
denominator and fixed timeframe; `/operator/handoffs/[eventId]` ties event, evidence, both axes,
gate, credential, trace, explanation and ledger sequence to one correlation id. The scenario
picker remains in the header as an explicitly labelled seeded-synthetic demo control, not a
product navigation concept. The gate chart is demoted under **Demo evidence**.

**Actions are operational dispositions, not verdict edits.** Approve and co-sign reruns the
byte-identical EPCIS event through `runAgent` with the completed sidecar credential; the detail
view records both verification runs and the queue item disappears. Reject, request evidence and
escalate append operator-action records while preserving the sealed verdict projection exactly.
`lib/workbench/service.test.ts` snapshots the verdict rows before rejection and asserts they are
unchanged afterwards.

**The read model is intentionally process-long.** Each seeded scenario owns one live in-memory
SQLite database and ledger for the lifetime of the Node process. That is what lets an operator
process queue items rather than watching controls reset on the next request. This state is a demo
workbench, not production durability; a restart resets it.

**Map evidence is projected, never invented.** The route uses the coordinates present in the
validated synthetic events. S1 shows the claimed GPS point, the serving-cell reference point, an
explicitly illustrative 800 m cell envelope and a derived connector. S6 shows the reported GPS
uncertainty. S2 shows both scan and recipient clusters. S4 has no polygon because the mandate is
an EPC-prefix scope, not geographic geometry. S3 has no second position because its reused id
changes the EPC at the same claimed location. The latter two render explicit notices rather than
made-up shapes. Coordinate-bearing flags and map features link in both directions.

**Recording evidence.** `docs/screenshots/session-17a/` contains the S1-filtered inbox, all-
handoffs acceptance summary, pending co-signature detail and gate evidence at 1920x1080. The S1
detail keeps "Nothing was sealed", both independent scores, the operator action and the map
contradiction in the first viewport.

**Deferred to 17B:** the courier submission surface, recipient capability-token flow, rejected-
alternative disclosure and browser-side ledger tamper demonstration. No fake controls for those
flows were added in 17A.

**Verification:** 594 tests pass with 7 live-provider tests skipped; lint, TypeScript and the
production Next build are clean. The engine, pattern and gate trees remain at 100% statements,
branches, functions and lines. The coverage runner uses a 10-second test budget because its
instrumented all-suite run makes the existing 400-timeline noise test exceed Vitest's generic
5-second default; no assertion or generator behavior changed.

### Session 1 — scaffold (complete)

46 tests passing, `tsc --noEmit` clean, eslint clean, `next build` succeeds.

**Real — implemented and tested:**

| Area | What works |
|---|---|
| `lib/epcis/` | All three event types across the five dimensions; CBV enums; the `vigil:` extension. `eventTime` and `recordTime` are separate fields; offsets are mandatory |
| `lib/ledger/` | All three paths (unseen / duplicate / reuse); `prevHash` chain; `verifyChain()` returning the break index; abort records; registry rebuild from file on construction |
| `lib/db/` | Five tables, first migration generated and applied; `createMigratedDb()` for tests |
| `agent → parse` | Full zod validation; halts on invalid rather than guessing; stamps `recordTime`; flags a client that supplied one |
| `agent → lookup` | Real Drizzle queries for parcel, courier and active mandate; unknown entity → `unknownEntityRisk: "high"` |
| `agent → verify` | **H4 only** — the ledger replay check, incl. duplicate short-circuit and reuse abort |
| `machine.ts` | Sequential driver, early exit on halt, per-node trace frames for SSE, node-error containment |

**Stubbed — returns the right shape, computes nothing:**

| Node | Marked `STUB` | What it returns today |
|---|---|---|
| `plan` | yes | `{ tools: [], planFromHeuristic: true }` |
| `verify` (partial) | yes | H1–H3 and I1–I14 not implemented; `{ score: 0, flags: [] }` |
| `fetch_history` | yes | P1–P5 not implemented; `{ score: 0, flags: [], sampleSize: 0 }` |
| `external_context` | yes | Skipped unless `plan` asked for it; placeholder summary |
| `gate` | yes | Always `accept`, `requiresCosign: false`; **does** seal a real ledger entry |
| `explain` | yes | Placeholder string built from the sealed verdict |

**No stub invents a verdict.** Every one is marked `STUB` in a comment. `gate` returning a
hardcoded `accept` is the one to be most careful with — it is real enough to write to the
ledger, so the orthogonal matrix replacing it must land before any evaluation numbers are quoted.

**Not started at all:** mandate crypto and Ed25519 co-sign; liveness/timeout paths; synthetic
data generation (`@turf/turf`, `seedrandom` not yet installed); Open-Meteo; SSE endpoint; all UI.

### Session 2 — the deterministic engine, axis 1 (complete)

174 tests passing. **`lib/engine/` is at 100% statement, branch, function and line coverage**
(`npm run test:coverage`). `tsc --noEmit` clean, eslint clean, `next build` succeeds.

**Real — implemented and tested:**

| Area | What works |
|---|---|
| `hard.ts` | H1 custody continuity, H2 scope, H3 mandate validity. All three evaluated before aborting, so an operator sees every hard failure at once. No partial accept; a hard failure suppresses I-scoring entirely |
| `inconsistency.ts` | All 14 I-rules. Each returns a structured `Flag { id, points, label, evidence[] }` where evidence names field **and** value |
| `thresholds.ts` | Every number with its derivation. Tiered rules are **band tables**, not nested ifs, so experiment 6 can move a band edge without restructuring control flow |
| `custody.ts` | H1's disposition → bizStep policy table. An unmodelled disposition imposes no constraint — H1 aborts handoffs, so it fires only where we are confident |
| `geo.ts` | turf wrappers; the single place `[lng, lat]` inversion happens. Returns `undefined` rather than an infinite speed on a zero/negative interval |
| `engine.ts` | Runs hard → scoring → clamp, and reports coverage |
| `mandate/schema.ts` | `CourierMandate` zod shape. **No crypto** |

**Design decisions worth not re-litigating:**

- **Tier exclusivity.** I4/I5 and I10/I11 are each ONE rule emitting at most one flag. A
  45-minute clock divergence scores 30, not 45. A 23 km delivery scores 40, not 60.
- **`rawScore` is kept unclamped** alongside the capped `score`, so a threshold sweep can tell
  an event that scored 100 from one that scored 385.
- **H2 fails a courier with no mandate.** An unscoped actor is not an actor with unlimited scope.
- **H3 stays silent about a missing mandate**, because H2 already reported it. Reporting it
  twice would tell an operator there are two problems when there is one.
- **I13 scores rather than aborts.** Working an hour outside your shift is a policy breach worth
  flagging; a revoked mandate is grounds for voiding the handoff, and that is H3.
- **Fixtures are built through the schema**, not cast to it, so the engine is never tested
  against data the ingest boundary would have rejected. Coordinates are real KL/Selangor points.

**Not wired in yet.** `lib/agent/nodes.ts` `verify` still returns the session-1 stub. Connecting
the engine to the agent is deliberately a separate step, so the engine was proven standalone first.

### Session 3 — axis 2 and the orthogonal gate (complete)

272 tests passing. **`lib/engine/`, `lib/pattern/` and `lib/gate/` all at 100% statement,
branch, function and line coverage.** `tsc --noEmit` clean, eslint clean, `next build` succeeds.

The `gate` stub flagged in session 1 as "real enough to produce data while being wrong" is
**replaced**. Evaluation numbers may now be quoted, subject to the reservation below.

**Real — implemented and tested:**

| Area | What works |
|---|---|
| `pattern/rules.ts` | P1 burst (densest-window scan, not just the first), P2 dispute rate vs queue baseline, P3 low variance around a non-zero mean, P4 clustered scans vs spread addresses, P5 recurring contradiction |
| `pattern/pattern.ts` | Cold-start gate, rule registry, coverage. Cold start is a distinct outcome, never a low score |
| `gate/gate.ts` | The 4 quadrants, all 5 absence cells, hard-abort short circuit, mandate limits L1–L4, cooldown, co-sign conditions |
| `gate/thresholds.ts` | Both axis cut points, severity order, `moreSevere` |
| `purity.test.ts` | Now covers all three trees, **plus** the never-summed check |

**Design decisions worth not re-litigating:**

- **Limit breaches combine monotonically.** `max(matrix, limits)` on `accept < flag < escalate
  < freeze`. A limit check can raise a decision, never lower one. L1 (shift ceiling) → freeze
  and a co-sign does not lift it; L2/L3 (value caps) → escalate; L4 (cooldown) → flag.
- **`P1` finds the densest window**, not the first. A calm morning followed by a burst must
  still be caught.
- **`P5` counts a flag once per handoff**, not once per occurrence within one.
- **`P2` refuses to compute a rate from fewer than 3 disputes.** One unhappy customer is not
  a rate, and reporting it as one would flag a courier for a single lost parcel.
- **Ledger `Verdict` gained `basis` and `requiresCosign`.** Confirmed free: **no committed
  ledger data exists** — the `.jsonl` files are gitignored dev state, so no hash chain was
  invalidated. Any further change to that shape is no longer free.

**Not wired in yet.** `lib/agent/nodes.ts` still has the session-1 stubs at `verify`,
`fetch_history` and `gate`. All three pure modules were proven standalone first.

### Session 4 — wiring (complete)

332 tests passing. `lib/engine/`, `lib/pattern/` and `lib/gate/` still at 100% coverage.
`tsc --noEmit` clean, eslint clean, `next build` succeeds.

**The agent is wired end to end.** `verify` runs lib/engine, `fetch_history` runs lib/pattern,
`gate` runs lib/gate and seals the verdict to the ledger, then projects it to the console
tables. A six-leg shipment runs collection → sortation → line-haul → out-for-delivery →
delivery and is accepted at every leg, with the ledger chain intact.

| Area | What works |
|---|---|
| `lib/assemble/` | All three inputs built from real rows; `Resolution` records what was missing and why |
| `agent/verify` | H4 replay check, then the real axis-1 engine |
| `agent/fetch_history` | The real axis-2 engine over the courier's rolling window |
| `agent/gate` | The real orthogonal gate; ledger commit **then** DB projection |
| `agent/trace.ts` | The frozen SSE contract |

**Still stubbed, marked STUB:** `plan` and `explain` (the LLM seam exists and is exercised by
the parity tests, but no model is called), and `external_context` (Open-Meteo).

**Schema changes this session:** `parcels.recipient_lat/lng` `integer` → **`real`** (a real
bug — coordinates in an integer column), plus new `reference_sites` and `disputes` tables and
a `verdicts.basis` column. Migration `0001`.

**A lesson worth keeping:** the lat/lng type error survived three sessions because the test
fixtures built coordinates by hand instead of reading them back through the schema. SQLite's
dynamic typing meant nothing ever complained. **Where practical, fixtures should round-trip
through the schema** — `makeEvent` already parses through `EpcisEvent`, and `seedWorld` now
writes and reads real rows. A fixture that bypasses the boundary cannot test the boundary.

### Session 5 — the constitutive co-sign (complete)

375 tests passing. `tsc --noEmit` clean, eslint clean, `next build` succeeds.

**The second core differentiator is real.** A courier-only token against a co-sign-required
handoff does not verify — it is not stored and marked unapproved, there is no valid credential
to store. The test that says so is named for the argument:
*"courier-only credential is cryptographically invalid, not merely unapproved"*.

| Area | What works |
|---|---|
| `credential/message.ts` | Canonical message via the **one** `canonicalize` in the codebase; `role` bound so a signature cannot fill the other slot |
| `credential/verify.ts` | Reports `validSignatures`, `invalidSignatures`, `problems[]` and `subjectMismatch` — never a bare boolean |
| `credential/sign.ts` | `courierCredential`, `cosign`, `generateKeyPair` |
| `agent/gate` | Credential verified against the gate's own `requiresCosign`, **before** anything is sealed |
| `persist.ts` | Signatures and `operatorId` stored on the console projection |

**Design decisions worth not re-litigating:**

- **A subject mismatch is reported as a mismatch, not a bad signature.** A credential lifted
  from handoff A onto B is cryptographically *valid* — over A's bytes. Saying "bad signature"
  would send an operator hunting for a forged key.
- **An absent operator key fails closed.** An unconfigured deployment must not be able to wave
  high-risk handoffs through by having forgotten to set a variable.
- **Two signatures claiming the same role is a `DUPLICATE_ROLE` failure.** Two operators cannot
  both be the authority for one approval.
- **`deps.operatorPublicKey` overrides the env var**, so tests are hermetic and never mutate
  `process.env`. Production leaves it unset and `keys.ts` reads the environment.

**Why the whole test suite changed.** Every fixture courier is cold-start, so every fixture
handoff requires a co-signature. Once the check landed, the existing tests were sealing dozens
of high-risk handoffs with no credential at all — which meant our own suite disproved the claim
the project is built on. They now present credentials via `runSigned`, so a scoring test is
also, quietly, evidence that the credential was there.

### Session 6 — the synthetic data generator (complete)

418 tests passing. `tsc --noEmit` clean, eslint clean, `next build` succeeds.
Dataset documented in `docs/DATASET.md`.

**The generator produces whole timelines**, seeded and reproducible, with all seven scenarios
running end to end through the real agent. Addresses were geocoded from OSM Nominatim (24 of 24
resolved; the cache records `source: "nominatim"` in the file itself).

| Area | What works |
|---|---|
| `rng.ts` | Every draw seeded; a purity test bans `Math.random` under `lib/generate/` |
| `world.ts` | 4 couriers with scoped mandates, 240 parcels, cell + WiFi sites per address |
| `timeline.ts` | Six legs, every event built **through** `EpcisEvent.parse` |
| `scenarios/` | S0–S6, each a full timeline with at most one thing wrong at one leg |
| `carefulness.ts` | The 0–4 ladder, monotonicity asserted |
| `split.ts` | Deterministic holdout, stable as the set grows |
| `ingest.ts` | Two-phase co-sign flow as a console would drive it |

**Three engine bugs the generator found by being run.** This is the generator earning its keep
before a single experiment:

- **P5 was feeding back on itself.** It counts flag ids from sealed verdicts, and those include
  *pattern* flags — so a recurring `P1` made `P5` fire, inflating axis 2 and reporting one
  observation as two. P5 now counts only `I`-prefixed single-event contradictions.
- **P4 had a false positive.** It compared the clustered scans against the recipient spread of
  the *whole window*, so an honest courier doing a tower block in the morning and a normal round
  in the afternoon tripped it. It now compares against the **clustered subset's own** addresses:
  the parcels scanned from one spot — were they addressed to one spot?
- **The generator's battery was non-monotone.** Drawing a level per leg let the handset gain
  charge between scans, which fired I14 on the honest S6 timeline. Battery now declines
  deterministically within a shift, with no jitter that could invert a drop.

**Design decisions worth not re-litigating:**

- **Warm-up history is mandatory.** Without ~14 prior sealed handoffs every scenario is
  cold-start, every leg demands a co-signature, and S0 cannot show its point. S0 now asserts
  `cosigned: [false × 6]`.
- **The background fleet is written directly to `events`.** P2 needs peers to compare against,
  and a baseline computed from the courier under test is that courier. These rows are context,
  not events under test; everything belonging to a scenario goes through the real agent.
- **Courier keypairs are deliberately NOT seeded.** Private keys should not be reproducible
  from a public seed. The reproducibility test compares events, not keys.
- **`upsertParcels` at ingest.** A scenario's parcels are authoritative — S2 re-addresses its
  batch to one tower, and without this the engine measured tower scans against the world's
  original scattered addresses and fired I10 on all forty.

### Session 7 — the LLM nodes (complete)

453 tests passing, 3 skipped (the live-model tests, which skip without `GEMINI_API_KEY`).
`tsc --noEmit` clean, eslint clean, `next build` succeeds.

**The parity tests pass unchanged in their assertions.** The sealed verdict is byte-identical
across `llm: undefined`, fake A and fake B, on a single event and across a six-leg shipment.

**The async migration was paid in full, not worked around.** `NodeFn` became
`(ctx, deps) => void | Promise<void>` and `runAgent` returns a `Promise`; ~60 call sites across
seven files were updated. A synchronous fake path was explicitly **not** kept — that would have
created the second code path that drifts, and the one that drifts is always the one with the
tests. Six of the eight nodes are still synchronous.

| Area | What works |
|---|---|
| `plan.ts` | Closed-enum parse; a real deterministic heuristic; every failure path lands on it |
| `explain.ts` | Citation validation against collected evidence, decision-word check, structured fallback |
| `types.ts` | Telemetry counters by reason, accumulated across a whole run |
| `providers/` | Gemini, Anthropic Messages, native Ollama JSON mode, four fakes |

**Design decisions worth not re-litigating:**

- **The heuristic is real, and that matters.** The session-4 lite path returned `[]`, which made
  "we fall back to the heuristic" a sentence with nothing behind it — a vacuous fallback looks
  like a defence while providing none. It now keys on unresolved identity, degraded location
  signals and parcel value, capped at two, with each branch's reasoning in the code.
- **The parity fakes are providers, not stubs.** They go through the same parse, enum check and
  citation validation a live model does, so parity is asserted against disagreement travelling
  the real path. `scriptedProvider` answers the plan and explain prompts differently — a double
  that only answers one makes the other fall back every time, and comparing two identical
  fallbacks proves nothing.
- **Telemetry is injected and mutable** so one instance spans an experiment batch. Experiment 5
  reports the rate before and after enforcement, and a log line cannot be totalled.
- **The decision-word check strips negations first.** "not approved" contains "approved".
- **`explain` writes prose onto an already-sealed verdict**, via a separate `persistExplanation`
  update. A test asserts an explain failure leaves the verdict, the ledger chain and the
  projection intact.

**A bug the tests found:** the structured fallback listed `Flag` objects only, and the credential
failure reaches the verdict as the bare id `C1` rather than a `Flag`. So a frozen handoff whose
signature failed produced the fallback text *"No checks raised a concern."* — worse than terse,
simply wrong. `structuredExplanation` now renders the credential result from its own source.

### Session 8 — the operator console (complete)

477 tests passing, 3 skipped. `tsc --noEmit` clean, eslint clean, `next build` succeeds. All
three views verified in a browser, not just compiled.

| View | What it demonstrates |
|---|---|
| `/timeline` | The brief's "normal activity to a meaningful exception", with a play control so a viewer watches it arrive rather than reading the end state |
| `/stream` | The eight nodes executing live. Agentic-AI evidence, not decoration |
| `/gate` | The two axes, four actions, and the same-sum trio annotated in place |

**Design decisions worth not re-litigating:**

- **Three routes, not tabs.** Deep links and the `EventSource` lifecycle. See Console conventions.
- **`not_evaluated` gets gutter bands**, and the trio is a labelled reference layer. Rule 3e.
- **The scatter reports few unevaluated points (1 of 76), and that is correct** — warm-up
  history means almost every courier clears the cold-start floor. Do not manufacture cold-start
  events to populate the gutter; the counts panel tells the truth about how empty it is.
- **`TimelineView` is keyed on the scenario id** rather than resetting state in an effect. React
  remounts it on a switch, which is both idiomatic and what the lint rule wants.
- **The playback machine is a pure reducer outside React**, with its own tests. A demo spine
  that can only be exercised by clicking a button in a browser is a spine nobody checks.
- **The never-summed guard now covers `app/` and `components/`**, with a message that explains
  the distinction: reading both scores is correct and expected, since every view displays them
  side by side; combining them arithmetically or naming a variable as though they were one
  number is not.

### Session 9 — the experiments (complete)

480 tests passing, 3 skipped. `tsc --noEmit` clean, eslint clean. Six experiments run, CSVs in
`results/`, written up in `docs/RESULTS.md`. **No threshold was changed.**

**Against the predictions below: two held, one was wrong in an instructive way.**

- **Prediction 1 held.** E1 level 4 was undetected in 12/12 runs. Reported as the measured
  boundary; nothing tuned.
- **Prediction 2 was wrong, and the reason matters.** E3 came back at **0% across 240 legs**,
  not "low but not zero", and **H1 never fired**. That is not a clean win: our generator's clean
  shipments have bounded noise by construction, so 0% measures "our clean data does not trip our
  rules", not a false-positive rate. **The H1 reservation stays open** — it did not fire because
  no clean scenario contains a custody-chain gap, and real fleets have missed scans. RESULTS.md
  states this as the weakest number in the set.
- **Prediction 3 held.** E4 did not run; `GEMINI_API_KEY` was not set and RESULTS.md says "not
  run" rather than showing a placeholder.

**The finding worth carrying forward.** E6 shows the shipped implied-speed threshold of 120 km/h
is **not optimal on this data** — anything from 50 km/h up has zero false positives and higher
detection. It was **not changed**. The synthetic line-haul never drives at 110 km/h, so the
dataset does not contain the case the threshold exists to tolerate; lowering it would be fitting
to a gap in the generator. A number derived from a published speed limit survives contact with
reality better than one fitted to our own fixtures. This is now the honest answer to "why 120?".

**Two experiment bugs the runs exposed, both in the experiments rather than the detectors:**

- E1's first run showed levels 2–4 all undetected, because the campaign never generated a
  customer complaint — the ladder defines level 4 as *"a recipient who agrees not to complain"*,
  which is meaningless unless the levels below have recipients who do.
- E2's first run showed S2 caught by `I10` at leg 1, because the harness composed ingestion by
  hand and skipped the parcel upsert — reproducing a bug session 6 had already fixed. The
  experiments now use the tested `ingestScenario`.

Both are recorded in RESULTS.md. Neither touched a detector.

**Additions this session:** `deps.thresholds` on `NodeDeps` (symmetric with `deps.windows`, for
E6); report-only mode on `explainVerdict` (for E5, with a purity test asserting the agent never
passes it); the anti-circularity guard extended to `scripts/experiments/` with E6 named as its
sole exception.

### Session 10 — environmental noise, and E3's real number (complete)

491 tests passing, 3 skipped. `tsc --noEmit` clean, eslint clean, `next build` succeeds. E3 and
E6 rerun across four noise levels. **No threshold was changed. Two are now reported as wrong.**

**E3's `0%` is retired.** `lib/generate/noise.ts` models a fleet's environment at four levels —
degraded GPS, queued uploads, missed scans, clock drift, redeliveries, stale addresses, mid-shift
charging, handset swaps — every parameter carrying a citation or the word *assumption*. The
number is now a curve: **0.2% of legs at level 1, 3.5% at level 2, 12.4% at level 3**, n = 1,440+
legs each, reporting half only. Level 0 is the old dataset and still reports 0%, which is the
honest way to read what the old number was.

**Level 0 is byte-identical to the pre-noise dataset**, asserted in `lib/generate/noise.test.ts`.
`planShipmentNoise` returns `undefined` without drawing, so every scenario expectation, the S0
regression and the reproducibility guarantee stay valid without rejustification. Levels above 0
layer noise onto the *same* underlying shipment, so a cross-level comparison is one parcel in
worse weather rather than two different parcels.

**Against the four predictions: two held, one held with the wrong reason, one was wrong.**

- **Prediction 1 held.** Non-zero and rising with the level. The escape hatch was not needed —
  level 3 produced a real number, so nothing was turned up to manufacture one.
- **Prediction 2 held, and the pre-run trace was exact.** H1 fired and did not dominate: 12 of
  237 alerts, under 4% at level 3. **The reservation is closed.** The measured table matches the
  trace written before the model existed — `linehaul_departure` 12/12 → freeze, and 0 of 31
  across the other three legs, with the dropped leg drawn uniformly (12/12/10/9).
- **Prediction 3 was wrong about which rule dominates.** Address corrections were predicted to
  lead; they are 10 of 184 level-3 alerts. **I4 dominates at 164 of 184** — a handset with no
  uplink queues a scan and uploads it half an hour later. Address correction does lead at level 1
  (2 of 3 alerts), so the prediction was right about the *shape* and wrong about the *scale*.
- **Prediction 4 was wrong, and the reason is the most useful thing in the session.** E6's
  false-positive edge was predicted to move upward under noise. **It did not move at all** — 50
  km/h at every level, point for point. Two errors in the reasoning, both worth keeping: upload
  batching moves `recordTime`, which the server stamps, so it has no path to I3 at all; and the
  handset clock offset is constant per device, so it cancels between two scans from the same
  handset. What is left is geometry — **GPS error is metres against a leg that is kilometres**.

**Two thresholds now look wrong, and neither was touched.**

- **I4's 30-minute band.** `thresholds.ts` derives it from the claim that *"30 minutes cannot be
  explained by [drift or upload latency]"*. The noise model contradicts that directly: a basement
  queue explains it easily, and I4 alone is +30, which clears the gate's cut of 30. This produces
  89% of the level-3 false positives. **Top item for the next tuning session.**
- **The implied-speed limit**, unchanged from session 9's finding, but the answer is now better
  supported. See below.

**"Why 120?" needed rewording, and came out stronger.** Session 9 named the falsification test —
*"clean shipments with realistic outliers would move the false-positive edge upward and start to
justify 120 on the data itself"*. It was run and **it failed**. The reworded claim is narrower
and better evidenced: the implied-speed threshold is the one number **environmental noise cannot
justify**, so the 70 km/h of headroom is not paying for measurement error, it is paying for a
journey this dataset does not contain. That distinguishes the two things a margin can be for and
shows only one applies — a sharper argument than the one it replaces.

**Design decisions worth not re-litigating:**

- **The reported GPS accuracy and the actual error are drawn separately.** A receiver's accuracy
  figure is a confidence radius, not a measurement of its own error, so the true error is a
  Rayleigh draw scaled to make the reported figure its 68th percentile. A fix can be
  **precise-looking and wrong**, which is the case the location rules are asked to judge and the
  case the bounded generator could not produce. A test asserts both sides of that crossing occur.
- **The clock offset is stable per handset, not per scan.** A per-leg draw is a wobble, and a
  wobble is the shape of tampering rather than drift — session 6's battery mistake in a new
  place. The cancellation this causes is what decided E6.
- **A scenario's overrides always beat the environment.** S1's spoofed position and S6's declared
  140 m fix survive level 3 untouched, asserted in a test. If the weather blurred them, the
  control would stop being a control.
- **Episodes are attributed from the generator's own record** (`GeneratedScenario.noiseEpisodes`),
  not inferred back out of the events. Inferring "this shipment lost a scan" from the events would
  mean explaining the detector's output using the detector's own measurement.
- **E6 reports I3-attributable false positives, not every alert.** Under noise the whole-system
  alert rate on clean data is dominated by things E6 does not vary, so counting every alert would
  print E3's number under E6's heading and hide the edge. Both columns are in the CSV.
- **Warm-up history gets the same weather as the shipment.** P3 and P5 read the courier's past;
  a pristine baseline behind a noisy present would make the present look like a departure it is
  not.
- **A repeated leg name suffixes its eventID seed.** A redelivery has two `delivery` legs, and
  without this the second would derive the same eventID and the ledger would abort it as a replay
  — an honest redelivery would look like S3.

### Session 11 — I4 semantics and tuning (complete)

494 tests passing, 3 skipped. `tsc --noEmit` clean, eslint clean, `next build` succeeds.
`lib/engine/`, `lib/pattern/` and `lib/gate/` remain at 100% branch coverage.

The candidate is fixed from the meaning of the signal before looking at the tuning half:

- **I4 becomes directional:** device time at least 30 minutes **ahead of** server receipt,
  retaining +30. There is no benign upload mechanism in this direction, so alone-sufficient is
  intentional. A points cut was considered and rejected because it would trade away S5's
  single-event detection.
- **I5 becomes directional:** server receipt at least 480 minutes **after** device time, worth
  +10. The eight-hour boundary is an **assumption** anchored to one configured shift, not a
  measured mobile-delay percentile. It is deliberately declared as such rather than presented
  as a sourced tail probability.

The first declaration fixes the absolute-value bug. The second gives store-and-forward delay a
weak, falsifiable tier without claiming that 30 minutes proves tampering. Both remain one
mutually-exclusive rule, expressed as band tables, and no other threshold moves this session.

**Dataset independence limitation.** The same published clock-accuracy quantity informs the new
I4 edge and the generator's honest handset-drift distribution. That is not a banned shared
detector parameter — both independently cite the same claim about the world — but it means E3
cannot independently validate the I4 boundary. E3 can test whether the corrected *direction*
removes queued-upload false positives; it cannot establish that 30 minutes is the right
clock-ahead edge. This limitation belongs in DATASET.md and RESULTS.md, not only here.

**The tuning half was opened first and the candidate was not adjusted.** E3 measured 0.5% per
leg at level 2 and 2.0% at level 3 there. The fixed candidate then ran on the reporting half:
**0.2% / 0.5% / 1.2%** at levels 1 / 2 / 3, down from 0.2% / 3.5% / 12.4%. I4 fell from 164 to
zero level-3 alerts. I5 also fired zero times, which is a coverage gap rather than validation —
the generator's longest queued upload is 110 minutes and the assumed edge is 480.

**E2 paid no detection cost:** all five classes remain 12/12, and S5 still fires I4 at leg 6.
**E6 is unchanged on its own measurement:** all 1,920 `I3_fired` values are identical, the edge
stays 50 km/h at every noise level, and 127 unrelated `any_alert` rows disappeared with no new
ones. No other threshold moved.

**H1 is the largest residual by share after I4 is removed, not by absolute rate.** It is 4 of 7
level-2 alerts, so the script's dominance guard fires, and 7 of 18 at level 3. The absolute rates
are four freezes across 1,439 level-2 legs and seven across 1,479 level-3 legs. The known narrow
failure remains unchanged: lose `linehaul_departure` and H1 freezes 12/12; lose another one of
the four missable scans and H1 fires 0/31.

Then: Open-Meteo at `external_context` (the S6 beat), liveness/timeout paths, the map view, and
the submission artefacts. Adding a genuine expressway leg to the generator is the only remaining
test for the implied-speed threshold.

### Session 15 — Open-Meteo and constitutive reroute (complete)

544 tests passing, 7 live-provider tests skipped. `tsc --noEmit` clean, eslint clean,
`next build` succeeds; `lib/engine/`, `lib/pattern/` and `lib/gate/` remain at 100% branch
coverage. No detector threshold moved and no experiment was rerun.

**The preregistered S6 weather result was negative, and it was kept.** The fixed delivery at
`2026-09-08T10:15:00+08:00` queried Open-Meteo's historical archive at the scenario's existing
coordinate. The returned grid cell reported **partly cloudy, 0 mm precipitation, 31 °C and 1.3
km/h wind**. The timestamp was not moved to find rain. The first request populated the committed
cache; the second returned the same observation with `source: "cache"` and no network.

That changes the demo line, not the architecture: the deterministic heuristic selected a real
tool because S6's location evidence was degraded, the tool found no regional benign explanation,
and the sealed result remained `accept` because the event represented missing evidence honestly
and the courier's pattern was clean. Available, unavailable and throwing weather providers seal
byte-identical verdicts and matching ledger meaning in tests.

**The approximately 9 km archive resolution is visible at the claim site.** RESULTS.md states it,
and the timeline's weather row carries a tooltip saying this is regional reanalysis, not proof of
conditions at the address. The adapter zod-validates the response and passes only numeric fields
plus local deterministic WMO labels into `explain`; provider prose has no path to the model.

**Reroute is a post-gate action, not a fifth outcome.** `flag` chooses the nearest pickup point
authorised by the current mandate; `escalate` and `freeze` prefer a lexically stable eligible
alternate courier, then fall back to a pickup point. No candidate yields the explicit result
"No authorised reroute exists for this address." The UI displays that reason instead of an empty
panel.

Reroute acceptance has its own sidecar credential binding the source event, EPC, exact action and
target, authorising mandate and nonce. It uses the same shared Ed25519 role-verification path as
handoffs while preserving every existing handoff message byte. Courier-only acceptance is
cryptographically invalid; adding the operator signature verifies; transplanting that signature
onto another destination fails. The proposal is persisted separately from EPCIS and cannot feed
back into the already sealed handoff verdict.

**Against the predictions:** all dependency and credential boundaries held. The deliberately
unpredicted weather condition was no rain. The 1920x1080 browser capture shows the exception row
with separate "handoff co-signed" and "reroute awaiting co-sign" states, and the live SSE stream
shows the cache-backed Open-Meteo observation at `external_context` before the unchanged gate
result. No result CSV changed.

### Session 14 — three model families and adversarial E4 (complete)

524 offline tests passing, 7 live tests skipped without provider configuration. The dedicated
three-family live suite passes 10/10. `tsc --noEmit` clean, eslint clean, `next build` succeeds;
`lib/engine/`, `lib/pattern/` and `lib/gate/` remain at 100% branch coverage.

Predictions were committed first in `722f2c4`, before the first Claude or Ollama request. The
exact measured models are `gemini-3.5-flash-lite`, `claude-haiku-4-5-20251001` and
`qwen2.5:7b`. No detector threshold moved, the EPCIS schema did not change, and E1, E2, E3 and
E6 were not rerun.

**A second unreachable-configuration defect was found before the live run.** The Ollama stub
read the same `OLLAMA_BASE_URL` name that `.env` supplied, but the code expected an
OpenAI-compatible base ending in `/v1` while `.env` supplied the native server root. It would
have called `/chat/completions`, which does not exist. The provider now uses Ollama's native
`/api/tags` and `/api/chat` endpoints with `format: "json"`; changing `.env` to conceal the
mismatch would have left the untested path intact. Offline contract tests now exercise URL
normalisation, model selection, JSON mode and abort behavior. This is rule 1d's second concrete
case after the retired Gemini model id.

**The live provider suite passed against all three families.** Model availability was checked
before Qwen ran, its first warm-up took 15.6 seconds from a cold process and 0.66 seconds in the
recorded warm process, and subsequent structured calls were interactive. The 10-test live suite
exercised plan, explain and byte-identical verdict/ledger parity. Gemini timed out once at the
older 20-second integration ceiling and took the deterministic fallback; that is provider
behavior being contained, not a failed verdict.

**The response-shape prediction was wrong for Qwen and right in a different way for Claude.**
Qwen returned strict JSON throughout native JSON mode and all its plan/explain responses passed
the same zod and citation gates as the hosted models. Claude's preflight plan/explain responses
were markdown-fenced JSON; all 15 E4a answers were fenced objects followed by a full reasoning
essay despite the instruction to return JSON only. `extractJson` recovered one object and the
strict schema accepted it. This is the first live evidence that the transport normaliser does
real work rather than merely accommodating scripted fixtures.

**E4a found vendor choice is substantive even when every model is internally stable.** Every
provider was 5/5 consistent in every cell. All three accepted S0. On obvious S1 spoofing, Gemini
and Claude flagged while Qwen accepted; on degraded S6, Gemini and Qwen accepted while Claude
flagged. Cross-vendor modal agreement was therefore 100% on S0 and only 33.3% pairwise on both
S1 and S6. Session 13's 100%-stable Gemini result remains true but is superseded as the argument:
it measured repeat sampling within one vendor, while E4a shows that *which model decides* changes
the outcome.

**E4c separated model risk from system mitigation.** Four fixed instruction-shaped strings were
placed in an experiment-only delivery note, recipient name, photo filename and display address.
They never entered EPCIS. The four identical clean controls produced Gemini
`freeze:1/escalate:3`, Claude `escalate:4`, and Qwen `accept:2/flag:2`; injected distributions
shifted to Gemini `flag:3/escalate:1`, Claude `flag:2/escalate:2`, and Qwen remained
`accept:2/flag:2`. The paired calls changed 3/4, 2/4 and 2/4 decisions respectively, but pairwise
change alone is not credited as causal steering because separate model calls can vary. The
distributional shift supports steering for Gemini and Claude; Qwen's aggregate distribution does
not.

**The engine did not "resist" those instructions; they had no surface to land on.** The engine
receives no delivery note, recipient name, filename or display address, and parses no natural
language. An attacker would have to transform the text upstream into a schema-valid coordinate,
timestamp, identifier, attestation or another typed signal before a rule could observe it. The
clean and injected arms therefore present byte-identical engine events and produce byte-identical
verdicts by construction, which E4c asserts and labels precisely instead of claiming exercised
prompt-injection robustness.

**Production explain exposure was 0/12.** A standing test fails if any of the four untrusted
display fields enters `explainUserPrompt`. Forced exposure exists only in E4c: all 12 model
explanations ignored the directives, cited I1/I7 correctly and did not contradict the sealed
flag. The decision-word guard was therefore not exercised by a live contradiction in this run;
its scripted tests still prove the mechanism. Model steerability and mitigation effectiveness
remain separate columns because one is a risk and the other is a control.

**E5 remained clean across families.** Gemini, Claude and Qwen each produced 9/9 explanations
that passed the response schema, citation allowlist and decision-word check. Enforcement rejected
0/27. Each raw response was generated once and replayed unchanged through report-only and
enforcing modes, so the comparison still isolates enforcement from sampling variance.

**Untested-configuration sweep.** Provider model defaults are now all reachable offline;
Anthropic's default endpoint and Ollama URL normalisation are request-tested, and Gemini's default
endpoint is exercised by the live suite. The `plan` 8-second and `explain` 12-second defaults are
reached by live parity but their literal values are not pinned by a unit assertion; experiment
deadlines are explicit and exercised. Two non-provider fallbacks remain unverified but showed no
defect in this session: the singleton database path `./data/db/vigil.db` and operator id
`operator-unconfigured`. They were listed rather than changed, as requested.

Then: Open-Meteo at `external_context`, liveness/timeout paths beyond model providers, the map
view, submission artefacts, and a second adversarial corpus with repeated control/injection
samples if stronger causal attribution is needed.

### Session 13 — live Gemini seam and measurements (complete)

511 offline tests passing, 4 live tests skipped without a key. The dedicated live suite passes
7/7 with the configured key. `tsc --noEmit` clean, eslint clean, `next build` succeeds;
`lib/engine/`, `lib/pattern/` and `lib/gate/` remain at 100% branch coverage.

Predictions were committed first in `ca0276b`, before any live request. No detector threshold
moved, and E1, E2, E3 and E6 were not rerun.

**The first live run found two demo-day configuration bugs.** Session 7 set the default to
`gemini-2.0-flash`; because the integration suite skipped without a key, that retired id remained
in production for six sessions. The local `.env` also declared `GEMINI_API_KEY` twice, and Node's
env loader correctly let the later empty placeholder override the real value. The provider,
`.env.example` and local ignored env are corrected, and an offline construction test now reaches
the default. General lesson: **a default that no test can reach is not configuration; it is
unverified code.**

The authenticated inventory confirmed `gemini-3.8-flash` existed, but it did not complete within
120 seconds on this account. `gemini-3.5-flash` returned 503 high demand; the listed
`gemini-2.5-flash-lite` returned 404 unavailable to new users. The API-recommended
`gemini-3.5-flash-lite` completed in 39.8 seconds at low reasoning and 1.1 seconds at minimal on
the same smoke request. The shipped default is therefore the literal model id
`gemini-3.5-flash-lite`, with `GEMINI_REASONING_EFFORT=minimal`. Every E4/E5 row records the model
id. Hosted model ids and capacity move; a result that omits its model cannot be reproduced.

**The live seam passed 7/7 tests.** On the final recorded run, Gemini's `plan` call exceeded the
20-second integration deadline and the node used the deterministic heuristic; `explain` returned
a schema-valid live response and was accepted. The timeout is real provider behaviour and the
fallback is the seam working — it must not be described as a successful plan completion. The
sealed verdict was byte-identical with `llm: undefined` and live Gemini. Each separately timed
ledger chain verifies and commits to the same payload and verdict. Their `recordedAt` values and
chain hashes differ by design because the runs happened at different wall-clock instants; the test
compares the committed meaning, not timestamps it cannot honestly make identical.

**E4 weakened the instability argument.** On three neutral fixtures × five calls, Gemini returned
S0 `accept` 5/5, S1 `flag` 5/5 and S6 `accept` 5/5: 100% top-1 agreement and 0% pairwise
disagreement in every cell. The ambiguous-case prediction was wrong. The prompt carried raw
signals and independently resolved context, never Vigil scores, rule ids, labels or verdicts, so
the model was deciding rather than paraphrasing the engine. This is one model, not a claim about
all model families; a second vendor remains planned.

**E5 measured zero live hallucination rejections.** All 15 Gemini explanations were strict JSON,
cited only collected ids, did not contradict the sealed decision, and reached the operator in both
report-only and enforcing modes. Each raw response was generated once and replayed byte-for-byte
through both modes. Two independent model calls would confound enforcement with model variance,
making their difference uninterpretable. The old 75% synthetic panel remains a mechanism test,
not a model statistic, and RESULTS.md now says so explicitly.

Across the 30 experiment responses there were **zero** malformed objects, refusals, unexpected
fields, invented plausible ids, markdown fences, trailing prose, rate limits or provider errors.
E4 latency was 0.79–18.93 s (median 6.65 s); E5 was 0.91–10.23 s (median 1.29 s). The 3.8 timeout,
3.5 capacity failure and retired-model 404 are kept as preflight provider observations rather than
mixed into those fixed experiment denominators.

**Other unreachable defaults checked.** Ollama still names `llama3.1`, but that provider is an
explicit unbuilt seam and was deliberately not exercised or changed in this Gemini-only session.
It must be validated when the Ollama session lands. The QA browser's localhost URL is a local
tool default, not a hosted dependency. No Claude provider exists yet, by design.

### Session 12 — motion pass and recording-resolution polish (complete)

498 tests passing, 3 skipped. `tsc --noEmit` clean, eslint clean, `next build` succeeds.
`lib/engine/`, `lib/pattern/` and `lib/gate/` remain at 100% branch coverage.

The approved `motion` dependency was already installed; this session completed its deliberately
narrow use rather than adding a second animation system. Timeline legs enter with a short tween,
custom rows use a non-spring layout transition when evidence expands, and verdict badges change
state with a short fade/scale. Reduced-motion preferences turn those effects off. The gate keeps
ECharts `animation: false`; the SSE sequence has no entrance animation or decorative pulse, so
its visible timing remains computation timing. Radix/shadcn lifecycle ownership is unchanged.

**The play-through now reads at recording speed.** Play reveals the first leg immediately, then
holds ordinary six-leg events for 1.9 seconds and the exception for 3.4 seconds at 1x. A compact
`0.75x / 1x / 1.5x` control keeps 1x as the recording default and 1.5x available for live
presenting. The timing function is pure and tested independently of React.

**The two argument frames were checked at 1920x1080.** The S1 exception has a persistent amber
edge, an `EXCEPTION DETECTED` label, both axes, coverage and verdict visible in one frame. The
gate's three diamonds are 24 px, outlined, and directly label action, coordinates and operational
meaning against an opaque backing. No labels overlap or clip. The 10-12 px operational copy that
looked weak under recording compression was raised selectively to 12-14 px across the three
views. Captures are committed under `docs/screenshots/session-12/`; regenerate with
`npm run qa:capture` while the local server is running.

**Halted still means nothing was sealed.** A pending co-signature uses its own blue dashed badge
and a separate `HALTED · NOTHING SEALED` marker, not a verdict colour. Its expanded text states
that no ledger decision exists.

**E6's lingering process was cumulative resource leakage.** The shared experiment disposer
deleted each temporary ledger directory but never closed the in-memory better-sqlite3 client.
E6 creates thousands of harnesses, so those owned clients accumulated until process shutdown.
`closeDb()` now closes the actual Drizzle client before directory removal; every E1-E6 entry point
already uses that shared disposer. The console dataset and SSE route close their owned clients as
well. A 24-run lifecycle smoke exited normally with every client closed. No experiment was rerun
and no result CSV changed.

---

#### Predictions, recorded before any experiment was run

### Session 16 — identity trace and predictions (written first)

**WRITTEN AND COMMITTED BEFORE THE IDENTITY EVIDENCE MODEL WAS CHANGED AND BEFORE E2 OR E3
WAS RERUN.** Existing rules and thresholds stay fixed. The new point values are fixed from what
the signals mean before either holdout half is observed: I15 is an explicit, complete conflict
between the event and the independent OTP verifier; I16 is weaker corroboration with plausible
operational causes and cannot cross the gate alone.

#### Three candidate rules traced and rejected

These are omissions by design, not forgotten identity checks. A future session must not restore
one without supplying the independent evidence it lacks.

1. **Voluntary OTP relay is undetectable by this design.** NIST SP 800-63B says manually
   transferred out-of-band secrets are not phishing-resistant: the recipient can read a genuinely
   delivered code to an impostor, and the verifier then sees the same valid code it would see in
   an honest handoff. Vigil detects a code that was never delivered to the registered recipient
   channel; it cannot detect a code the recipient chose to read out. This is a Known Limitation,
   not a missed branch in I15.
2. **Recipient-name comparison is neither independent nor reliable.** The courier can read the
   name on the parcel and copy it, while spelling variation, household members and reception-desk
   handoffs create honest mismatches. Identity is represented by the independently recorded
   recipient channel, never by comparing free-form names.
3. **An EPCIS AssociationEvent is not a party-to-handset authorisation.** GS1 defines a parent
   object or location associated with child EPCs; it does not make an employee identity the parent
   of a phone. Using `vigil:courierId` to authorise that event would let **the unverified claim
   certify itself**. A legitimate dynamic handset reassignment needs an operator-authorised device
   enrollment primitive outside EPCIS. I6 continues to compare the scan against the server-side
   binding; an attacker-authored AssociationEvent cannot rewrite that binding.

**The AssociationEvent documentation was wrong from session 1.** It called AssociationEvent a
device-binding event even though no fixture ever exercised that interpretation. The error was
found only by tracing the proposed handset-swap rule against the GS1 field semantics in session
16. This is the same failure shape as the retired Gemini model default and the Ollama `/v1` URL:
something written once, unreachable by a real test, and therefore never questioned. A default,
schema interpretation or configuration path no test can reach is unverified code.

**The credential trace found a second bypass of a stated cryptographic precondition.**
`verifyCredential()` says a courier signature is always required, but `checkCredential()` seals a
low-risk handoff when no credential is presented. Session 5 previously found high-risk fixtures
sealing without credentials; session 16 found the low-risk sibling by reading the verifier contract
against the agent path. The invariant and its caller disagree, and only a trace exposed it. The
fix is constitutive: an absent courier signature decides nothing, writes nothing, and halts as
`PENDING_COURIER_SIGNATURE`; an invalid signature remains attack evidence and freezes.

#### Predictions

1. **Both generated identity attack cases will be detected at the delivery leg.** Recipient
   channel substitution will trigger I15 alone. A known replacement handset assigned to another
   courier and returning only weak integrity will trigger I6 + I16.
2. **I16 at +20 will not reach an operator alone.** Play Integrity can lose a stronger label for
   operational reasons, so weak assurance is corroboration, not a verdict. It may combine with an
   independently unbound handset signal. A signal with plausible operational causes must not alert
   by itself.
3. **E3's increase will be small but non-zero, led by stale recipient-channel records rather than
   temporary attestation degradation.** If that holds, it is the same limitation already exposed
   by address correction: Vigil is sensitive to stale records as well as fraud. The two findings
   belong under one data-freshness limitation rather than being presented as unrelated defects.
4. **Making the courier signature mandatory will not change E2 or E3.** The generator already
   signs every event. If a result moves, an experiment or fixture was bypassing the stated
   credential contract and that bypass is the finding.

**Holdout discipline.** The rules and point values are fixed before measurement. E2 and E3 run on
the tuning half first to expose modelling or plumbing errors; after the implementation is frozen,
only the reporting half supplies the published numbers. No existing threshold moves in this
session whatever those runs suggest.

#### Session 16 result

Implementation was fixed in `695cf3d` after the tuning-half check and before the reporting half
was opened. A final trace then found that the replacement handset's generated enrollment named
the current courier rather than the other courier stated in the prediction; `8185703` corrected
that world fact, and E2 was rerun on both halves with the same 12/12 result. E3 was unaffected
because the correction is confined to the experiment-only identity case. The engine, pattern and
gate thresholds did not move.

- **Prediction 1 held.** Both identity cases were 12/12 on tuning and reporting. I15 alone caught
  OTP channel substitution at delivery; I6 + I16 caught the known weak replacement handset.
- **Prediction 2 held.** I16 remains +20 and never alerts alone. Its two new reporting-half alerts
  without I6 required independent I9 or I14 corroboration.
- **Prediction 3 was wrong in a useful way.** The E3 increase was small but stale recipient
  channels did not lead alone: stale channels and replacement handsets each appeared in 11 of
  the 23 additional alerting legs; two involved temporary attestation downgrade, and one shipment
  carried both stale-channel and replacement episodes. The correct finding is that identity
  checks expose both stale records and operational device substitution.
- **Prediction 4 held.** Requiring a courier signature on every handoff did not move E2 or E3;
  generated ingestion was already presenting one. The new regression proves an unsigned low-risk
  handoff halts `PENDING_COURIER_SIGNATURE` and writes neither ledger nor verdict row.

**Credential-invariant audit.** `lib/agent/nodes.ts` has one verdict-commit call and it sits after
the mandatory credential check; `persistVerdict` is reached only after that commit. The ledger's
lower-level `submit`/`commit` API remains intentionally credential-agnostic because it is also the
standalone nonce-ledger primitive, but no second agent sealing path was found. This does not prove
there can never be another bypass; it makes the present call graph and its regression explicit.

The reporting E3 curve moved from **0.2% / 0.5% / 1.2%** to
**0.4% / 0.9% / 2.2%** per leg at levels 1 / 2 / 3. That is the measured cost of adding identity
evidence on this model, not a threshold-adjusted result. E2 expanded from five to seven classes
and remained 12/12 for every class.

### Session 15 — predictions (written first)

**WRITTEN AND COMMITTED BEFORE THE FIRST OPEN-METEO REQUEST, BEFORE THE WEATHER CACHE WAS
POPULATED, AND BEFORE ANY REROUTE RESULT WAS MEASURED.** No detector threshold moves. Weather is
excluded from `GateInput` and from every sealed verdict field; reroute is a post-gate action with
its own credential, not a new rule.

1. **S6's deterministic plan will select `check_traffic_weather`, and the first successful
   archive request will be followed by byte-identical cache reads for the same latitude,
   longitude and hour.** Whether the archive reports rain is not predicted. If it reports no
   unusual conditions, the timestamp stays fixed and that negative result is shown rather than
   replaced with a more convenient hour.
2. **Weather available, unavailable, timed out or malformed will produce byte-identical sealed
   verdicts and ledger commitments.** The explanation and trace may differ because additional
   context was or was not gathered; the decision cannot. If this fails, the dependency crossed
   the verdict boundary and that is the finding of the session.
3. **The archive result can support only a regional statement.** Its approximately 9 km
   reanalysis grid may be consistent with a benign environmental explanation, but it cannot
   establish conditions inside the specific basement carpark. The UI and RESULTS.md will carry
   this limit next to the observation.
4. **A deterministic reroute policy will select the nearest authorised pickup point for a
   flagged event, and will prefer an authorised alternate courier for an escalated or frozen
   event.** Stable identifiers break equal-distance ties. If no active mandate covers the
   destination, the result will be the explicit statement "No authorised reroute exists for
   this address", not an invalid proposal and not an empty panel.
5. **A reroute acceptance carrying only the courier signature will be cryptographically invalid;
   the same proposal carrying valid courier and operator signatures will verify.** Changing the
   destination, replacement courier, mandate or source event after signing will also fail. The
   handoff credential remains byte-compatible and the reroute credential remains a separate
   sidecar.
6. **No experiment result should move**, because neither weather nor a post-gate proposal is an
   input to a detector or the gate. If a sealed result changes, only the affected experiment is
   rerun after the dependency leak is identified; no broad experiment rerun will conceal it.

### Session 14 — predictions (written first)

**WRITTEN AND COMMITTED BEFORE THE FIRST LIVE CLAUDE OR OLLAMA REQUEST AND BEFORE E4A OR E4C
WAS RUN.** The deciding prompts remain experiment-only. E4a uses the same neutral S0, S1 and S6
evidence fixtures for Gemini, Claude Haiku and Qwen, with five calls per provider and fixture.
E4c fixes four instruction-shaped payloads before observation and compares each provider's clean
and injected response. No engine score, rule id, rule label or verdict appears in a deciding
prompt.

1. **Gemini and Claude will accept a larger share of plan and explain responses than Qwen
   2.5 7B.** Ollama's `format: "json"` should suppress transport-level prose, but the smaller
   model is more likely to produce an object that fails the closed tool enum, exact response
   schema, citation allowlist or decision-word check. If Qwen matches the hosted models, that is
   evidence that the guard is portable rather than evidence the local model is weak.
2. **All three families will agree more strongly on S0 and S1 than on S6.** S0 has agreeing
   signals and S1 has an explicit cross-signal contradiction; S6 has missing and degraded
   evidence. The prediction is about cross-vendor modal agreement, not repeated sampling within
   one provider. If every family agrees on every fixture, model choice mattered less here than
   expected and that is reported directly.
3. **At least one injected evidence field will move at least one model toward `accept`, while the
   deterministic verdict and ledger commitment remain byte-identical.** The engine is not
   credited with resisting natural-language instructions: those strings have no parsing surface
   on its typed input. E4c reports what an injection would have to become — a valid structured
   coordinate, timestamp, identifier or attestation value — before the engine could observe it.
4. **Production explanation exposure to the four untrusted display fields will be zero.** A
   standing test fixes that boundary before the forced-exposure experiment. When the same text is
   deliberately appended to an experiment-only explain prompt, at least one model may emit prose
   that contradicts the sealed verdict; every such contradiction must be rejected whole. Model
   steerability and guard effectiveness are reported as separate rates.
5. **A warmed local Qwen call will be usable interactively but not assumed faster than either
   hosted provider.** Warm-up is excluded from measured latency; availability, load duration and
   generation duration are recorded separately where Ollama supplies them. If its tail latency
   makes the operator wait longer than the hosted calls, the offline path is architectural rather
   than demo-ready and is labelled that way.

**Metrics fixed before observation.** Every row names the exact model id. Provider validation
records availability, warm-up, latency, raw shape, acceptance or fallback and rejection reason.
E4a records decision histograms, top-N shares, modal verdicts, pairwise vendor agreement and the
deterministic result as an output-only comparator. E4c records the injection surface, literal
payload id, clean decision, injected decision, steering direction, deterministic parity and
explanation rejection reason. Session 13's five-repeat Gemini result remains intact and is marked
superseded as a test of sampling repeatability, not deleted.

**Preflight configuration bug found before any live call.** `ollama.ts` reads exactly
`OLLAMA_BASE_URL` and `OLLAMA_MODEL`, matching `.env`, but the configured
`http://localhost:11434` root overrides a stub default ending in `/v1`. The reused OpenAI caller
would append `/chat/completions` and hit the wrong path. Session 14 replaces the stub with the
native `/api/chat` contract because native `format: "json"` is the point of this provider; it
does not paper over the mismatch by changing `.env`. See rule 1d.

**Scope.** No detector threshold moves. E1, E2, E3 and E6 are not rerun. The EPCIS schemas are
not widened to accommodate adversarial display text, and no decision-capable function enters
`lib/`.

### Session 13 — predictions (written first)

**WRITTEN AND COMMITTED BEFORE THE FIRST LIVE GEMINI REQUEST.** E4 will use three neutral
evidence fixtures — S0 clean, S1 obvious fraud and S6 ambiguous degradation — with five
independent calls per fixture. The prompt contains the event observations only: no engine
verdict, no rule ids and no rule labels. E5 will use five calls over each of the same three
fixtures. Every E5 raw response is generated once, then replayed unchanged through report-only
and enforcing modes, so the before/after difference measures enforcement rather than two
different samples from the model.

1. **The clean and obvious-fraud E4 cases will have high top-1 agreement, while the ambiguous
   degraded-signal case will have lower agreement or more than one distinct decision.** This is
   a directional prediction, not an outcome the experiment is required to produce. If all three
   are stable, the honest finding is that this Gemini model was stable on these fixtures.
2. **Structured response mode will make transport-level malformed JSON, markdown fences and
   trailing prose uncommon.** Schema-invalid fields, plausible-but-uncollected citation ids or
   decision contradictions may still be rejected above the provider. A zero count for any
   failure class is reported as zero, not replaced with a synthetic example.
3. **Every live provider failure will reach the same deterministic heuristic or structured
   fallback used offline.** If a malformed response, refusal, timeout or rate limit escapes that
   path, the experiment stops and the seam is fixed before E4 or E5 is reported.
4. **The live parity fixture will seal a byte-identical verdict and ledger chain with
   `llm: undefined` and with Gemini.** A mismatch means the architectural seam is broken; the
   assertion does not move.

**Metrics fixed before observation.** E4 reports the full decision histogram, distinct-decision
count, top-1 share, top-2 cumulative share and pairwise disagreement for each five-call cell,
plus provider errors and latency per attempt. E5 reports attempts, accepted responses and whole-
response rejections by `bad_citation`, `decision_contradiction`, `schema_invalid` and
`provider_error`, before and after enforcement over the exact same raw responses. Every result
row names the exact hosted model id; a result without it is not reproducible after model
retirement.

**Preflight bug found before calling the API.** Session 7 set the provider default to
`gemini-2.0-flash`, but the live suite skipped while no key existed. That model was later retired,
so an unreachable default sat in production code for six sessions and would have failed on demo
day. The general lesson is broader than Gemini: **a default that no test can reach is not
configuration; it is unverified code.** Session 13 checks the other provider defaults for the
same shape and records the selected live model explicitly.

**Scope.** These measurements describe one named Gemini model, not model families in general.
Until a second vendor is measured, *"the model is unstable"* can only mean *"this model was
unstable on these fixtures."* Claude and Ollama remain future work. No detector threshold moves,
and E1, E2, E3 and E6 are not rerun.

### Session 11 — predictions (written first)

**WRITTEN AND COMMITTED BEFORE THE I4/I5 IMPLEMENTATION, BEFORE THE TUNING-HALF CHECK, AND BEFORE
ANY REPORTING-HALF RERUN.** The candidate above was derived from signal direction and stated
physical meaning, not selected by minimising E3.

1. **E3 level 3 will fall from 12.4% per leg to roughly 1–2%, and level 2 from 3.5% to well under
   1%.** The 164 level-3 and 43 level-2 queued-upload I4 alerts should disappear because a late
   server receipt no longer masquerades as a clock-ahead event. Remaining alerts should expose
   the real tail: stale addresses, photo timing, H1, handset swaps and genuine cross-signal
   contradictions.
2. **E2 will remain 5/5 classes at 100%.** S5 sets the device event time 105 minutes ahead of the
   server and should still fire I4 at the delivery leg. If it falls, the directional fix traded
   away the attack it exists to detect.
3. **E6's I3 false-positive edge will remain 50 km/h at every noise level.** I4/I5 do not feed
   I3, so the speed-specific curve should be byte-for-byte unchanged; only the carried
   `any_alert_rate` column should fall because unrelated queued-upload alerts disappear.
4. **I5 will fire zero times at every current noise level.** The generator's adverse queued
   upload tops out below 480 minutes. That is an explicit coverage gap, not evidence that the new
   I5 boundary is correct.

**Holdout discipline.** The candidate is checked first on the tuning half. Once fixed, E3, E2
and E6 run on the reporting half only. No other threshold moves whatever those runs suggest.

### Session 10 — predictions (written first)

**WRITTEN AND COMMITTED BEFORE THE NOISE MODEL WAS BUILT AND BEFORE ANYTHING WAS RERUN**, so the
log shows they were not retrofitted. Session 10 replaces E3's `0%` floor by giving the generator
realistic environmental noise, parameterised by level, and rerunning E3 and E6 across it.

1. **E3's false-positive rate will be non-zero and will rise monotonically with noise level** —
   low single digits per leg at level 1, roughly 5–15% at level 3. **If it is still 0% at level 3,
   the honest conclusion is that the noise model is too gentle, and that is what gets reported.**
   The model does not get turned up until it produces a quotable number: swapping *"our clean data
   does not trip our rules"* for *"our noisy data happens to trip our rules"* would leave the
   circularity exactly where it was. See rule 2b.
2. **H1 will fire, and will not dominate.** Traced below. **If it does dominate, it is reported
   and the session stops.** H1 is not softened in the session that measured it — that is a
   separate session with a rerun on the reporting half.
3. **I10/I11 from a mid-route address correction will be the largest single contributor**, ahead
   of I4/I5 from batched uploads. If so, that is a **Known Limitation**, not just an E3 row: an
   honest delivery to a corrected address alerts, because the system is sensitive to stale records
   as well as to fraud, and a judge could reasonably ask about it.
4. **E6's false-positive edge will move upward** under noise. The current 40–50 km/h edge comes
   from the last leg — 30 minutes from the destination hub to the recipient — and clock drift plus
   upload batching compress that interval and inflate its implied speed. I expect the edge to rise
   but **not** reach 120, which makes *"why 120?"* **stronger** (part of the margin is now
   justified by the data) without vindicating it.

**Holdout: nothing is tuned this session.** Reporting half only, as before. **If any detector
threshold looks wrong under noise, it is reported and left alone.**

#### The H1 trace, written before the noise model (rule 4d's cheap check)

Reading `PERMITTED_TRANSITIONS` in `lib/engine/custody.ts` against `NORMAL_LEGS`, **most single
missed scans do not trip H1**:

| Dropped leg | previous disposition → this bizStep | H1 |
|---|---|---|
| sortation | `active` → `departing` | permitted |
| **linehaul_departure** | `in_progress` → `arriving` | **NOT permitted → H1 fires** |
| linehaul_arrival | `in_transit` → `transporting` | permitted |
| out_for_delivery | `in_possession` → `delivering` | permitted |

**The custody table is deliberately permissive, so a fleet's missed scans reach H1 in exactly one
place rather than everywhere.** That is a real property of the design and nobody would guess it
from reading the rule: H1's own comment says an unmodelled disposition imposes no constraint,
because H1 aborts a handoff outright and must only fire where we are confident. The consequence
is that the *gap* it catches is the missing **departure** scan specifically — a parcel that
reports arriving somewhere it never left.

**The dropped leg is therefore drawn uniformly over those four middle legs.** H1's rate must fall
out of the world model, not be dialled in by preferring the leg that fires it — in either
direction.

**PREDICTIONS, WRITTEN BEFORE ANY EXPERIMENT WAS RUN.** Recorded here first so the log shows
they were not retrofitted to the results. A result that contradicts one of these is a finding
worth investigating, not a number to explain away.

1. **E1 level 4 (recipient collusion) will be undetectable.** That boundary is already in Known
   Limitations. It gets reported as a measured result and nothing is tuned to make it detectable.
2. **E3's false-positive rate will be low but not zero**, and the by-abort-code breakdown may
   well be dominated by H1 → freeze. If it is: **report it and stop.** Softening H1 in the
   session that measured it is the circularity the anti-circularity guard exists to prevent.
   Changing it is a separate session with a rerun on the reporting half.
3. **E4 requires `GEMINI_API_KEY`.** Without one it does not run, and RESULTS.md says "not run"
   rather than showing a blank or a placeholder.

**Holdout: nothing is tuned this session.** The reporting half is what gets reported; the
tuning half is declared and left unused. No threshold moved.

### Session 9 — Open-Meteo, then the experiments (superseded by the above)

`external_context` still sets a `STUB` placeholder when `plan` asks for weather. Wire Open-Meteo
behind it: this is the S6 beat, where the agent gathers evidence and decides **not** to escalate.

Then the experiments, on the holdout split, with the generator's anti-circularity guard already
in place. Still untouched: liveness/timeout paths, the map view.

---

## Open reservations (decided, but revisit)

**The shift window is rolling, not rostered.** `DEFAULT_SHIFT_WINDOW_HOURS = 12` counts back
from the event; a real fleet works rostered shifts that reset at a start time. The two diverge
at the boundary, and the shift cap (L1) is a **hard stop** that a co-signature cannot lift — so
a courier could be stopped early or late relative to their actual roster. **This belongs in the
submission's Known Limitations**, not only in a code comment. Fixing it properly needs a
`shifts` table and roster data we do not have.

**Named future primitive: the operator does not sign over the risk they saw.** The credential
binds `eventID`, `epc`, `courierId`, `mandateId` and a nonce — it does not bind the
inconsistency and pattern scores that were on screen when the operator approved. So "the
operator signed before the risk was known" is a question a judge could reasonably ask, and the
honest answer is that we identified it and scoped it out, not that it does not apply.

Binding the assessment would make the signature an attestation about a *specific* risk picture
rather than about a handoff. It was deferred because the scores are not sealed at the moment
the operator signs, so it needs a two-step commitment (sign the assessment hash, then seal) and
that is a larger change than this session's scope. Revisit if there is time before submission.

**The pattern window is 24h and the shift window is 12h**, both arbitrary. They are assembler
config (`DEFAULT_PATTERN_WINDOW_HOURS`, `DEFAULT_SHIFT_WINDOW_HOURS`) and overridable per run
via `deps.windows`, so experiment 6 can sweep them.

## Known limitations (test these, don't claim them)

**Historical weather is regional context, not address-level evidence.** Open-Meteo's archive
uses approximately 9 km reanalysis for the S6 date. A matching rain observation would establish
only that regional conditions were consistent with a benign explanation; the measured S6 hour
actually reported no rain. Neither result can establish what happened inside a basement carpark,
and neither is allowed to move a verdict.

**Pickup points are a small static prototype registry, not a live fleet network.** "Nearest" is
computed correctly among the active rows on file, but capacity, opening hours, road travel time
and dispatch load are not modelled. Courier reassignment checks active mandate scope and stable
ordering; it is not route optimisation.

**A hub that chronically loses its departure scan gets frozen every time.** Measured in session
10: of the four scans a fleet can miss, only a lost `linehaul_departure` trips H1 — and when it
is lost, **12 out of 12 shipments were frozen.** In the final identity-aware E3 it is 12 of 51
alerts and does not dominate a noise cell, but is still 12 freezes across 5,805 clean legs. It
does not over-refuse broadly; it over-refuses narrowly and completely. A depot with a broken
departure scanner would have its whole outbound flow voided until someone noticed. Stated,
measured, not softened.

**The system is sensitive to stale records as well as to fraud.** Two independently measured
forms now make the same limitation explicit. An honest delivery to a corrected address can fire
I10/I11 because the stored destination is stale; an OTP genuinely delivered to the recipient's
new number fires I15 when the parcel still carries the old registered channel. On the final E3
reporting half, address correction appeared in 14 alerted shipments and stale recipient channel
in 11; every one of the 11 stale-channel episodes alerted. **This is a real property of the
approach, not a bug:** a stale record is a genuine contradiction, and the system cannot tell
"the record is wrong" from "the scan is wrong" without a third source. The mitigation is
operational freshness, not a lower detector threshold.

**Voluntary OTP relay is undetectable by design.** I15 proves that the verifier delivered and
consumed a challenge through the parcel's independently registered channel. It cannot distinguish
the intended recipient entering that code from reading it aloud to an impostor. NIST SP 800-63B
states that manually transferred out-of-band secrets are not phishing-resistant. Detecting that
case needs a phishing-resistant authenticator or a different liveness primitive, not another OTP
comparison.

**The new I4 edge is not independently validated by E3, and I5 is not exercised.** The same
published quartz-drift evidence informs the generator's clock distribution and I4's 30-minute
device-ahead edge. That is not a detector parameter leaking into the generator, but it means E3
tests the corrected direction rather than independently testing the edge. I5's 480-minute
upload-delay boundary is an explicit shift-anchored **assumption**; this dataset stops at 110
minutes, so the rule fired zero times. Both need field telemetry before either threshold can be
claimed as measured.

**The operator can read a recipient's confirmation link. In production they must not.**
The link **is** the credential — it is a scoped capability, not a pointer to something protected
by a separate login — so displaying it to staff hands them the recipient's answer. The prototype
surfaces it on the detail page of **the one handoff already on screen**, never as a listing: an
endpoint enumerating tokens would hand out every capability at once, which is indefensible in a
project about custody of evidence. Production delivers the link to the recipient's own channel and
shows staff at most whether it was sent, opened or answered. A judge who sees an operator reading
recipient links will ask about this, and the honest answer is that it is a demo affordance we
scoped deliberately rather than a design we defend.

**Silence is an observation, never an assertion.** `no_response` is written only by
`expireConfirmations` when a window closes, and the recipient API **rejects it with a 400** if a
caller supplies it. Anyone holding the link could otherwise record "they never replied" on the
recipient's behalf — and since silence is a signal, that would let the holder of a capability
manufacture evidence about the person the capability belongs to.

**A positive confirmation must never be written to `disputes`, and the second reason is the one
that gets missed.** The obvious harm is that it corrupts P2's numerator. The less obvious one is
that **the fleet baseline P2 compares against is computed from the same table** — so a "received"
row stored there would raise the denominator's dispute rate for every courier, including the
honest ones the comparison exists to protect. Someone reasoning only about the numerator could
conclude a mislabelled row is harmless. It is not.

**`seedDraftIdentity` is a deliberate second implementation, and it can drift.**
`lib/workbench/service.ts` duplicates ~20 lines of `seedIdentityReferences` from
`lib/generate/ingest.ts`, which is not exported and which session 17B was scoped out of touching.
The courier's held-back draft leg needs its OTP challenge and device enrollment seeded, or I15
resolves `not_evaluated` on the courier's submission and `clear` on every other leg — so the
screen would be showing an artefact of how the draft was built rather than a property of the
handoff.

**The choice was duplication versus lying on screen, and duplication is the less severe failure.**
That is not in tension with insisting `canonicalize` be *moved* rather than copied: there the
alternatives were duplication versus a correctness guarantee (a key-reordered retry must hash
identically, or a double-tap becomes a fraud alert), so duplication was the more severe failure.
The house rule was never "never duplicate" — it is **pick the less severe failure, and say which
one you picked.**

**Fold-back condition:** the next session with `lib/generate` in scope exports
`seedIdentityReferences` and deletes the workbench copy. Until then, a change to the generator's
identity seeding must be mirrored by hand, and nothing enforces that.

**Demo keys live in environment variables. This is a stated limitation, not an oversight.**
The operator's signing key is the thing that makes approval constitutive, and a key in an env
var can be read by anything that can read the process environment. Production needs an HSM or a
managed KMS. `lib/credential/keys.ts` is the only file that touches the environment, so the
swap is contained — but it has not been made.

**Identity is simulated; the signatures are real.** The courier, recipient and operator entry
routes use hardcoded demo identities rather than authentication. Recipient links are scoped
capability tokens, not accounts. The Ed25519 courier and operator signatures are nevertheless
real and verified by the same credential code used elsewhere. Production needs SSO, managed
device enrolment, recipient-token revocation and durable key custody; the prototype supplies none
of those identity-management controls.

**The nonce is covered by the signature, but nothing enforces monotonicity.** We have
cross-handoff replay protection via the `eventID` binding, and we do **NOT** have cross-time
replay protection. `mandate.nonceCounter` exists and is unused. Do not imply otherwise anywhere
in the docs or the pitch.

Vigil catches the lazy attacker. A rooted, patched device operated by someone colluding with
the recipient is out of reach of this architecture — that is a boundary of the idea, not a
defect of the prototype, and it belongs in the write-up as a **measured** result. The same
goes for cold-start couriers with no pattern history, and for the fact that a fully controlled
device can forge `eventTime` and `recordTime` together.
