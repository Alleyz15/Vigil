/**
 * What the landing page says, and where each claim can be checked.
 *
 * EVERY NUMBER HERE IS MEASURED AND CITED. `source` names the experiment and
 * the file it was written to, because a landing page is the one surface where
 * a made-up figure is both most tempting and most damaging — a judge who finds
 * one unsupported number has grounds to discount every other number in the
 * submission (rule 8's reasoning, applied to prose).
 *
 * `href` is a route that actually exists and shows the thing. A narrative
 * section that asserts something without offering the page where it can be
 * checked is a brochure; this project's whole argument is "go and look".
 */

export type Stat = {
  value: number;
  /** Rendered after the animated value. */
  suffix?: string;
  decimals?: number;
  label: string;
  /** Which experiment produced it, named on screen. */
  source: string;
};

export type Section = {
  id: string;
  eyebrow: string;
  title: string;
  body: string[];
  stats?: Stat[];
  link?: { href: string; label: string };
  /** A claim shown as a quoted line rather than body copy. */
  pull?: string;
};

export const HERO = {
  title: "A handoff is a claim, not a fact.",
  standfirst:
    "Vigil does not try to prove a delivery happened. Every single signal — photo, GPS, OTP, signature — can be forged, and a system claiming otherwise is lying. It asks two questions that can be answered instead.",
  questions: [
    "Do these claims agree with each other?",
    "How many times can someone do this before the shape of their behaviour gives them away?",
  ],
};

export const SECTIONS: Section[] = [
  {
    id: "problem",
    eyebrow: "The problem",
    title: "Forging one signal is easy. Forging all of them, repeatedly, is not.",
    body: [
      "A courier marks a parcel delivered from a car park two streets away. The photo is real, the GPS says the right place, the OTP was entered. Every field a normal system checks is present and plausible.",
      "So Vigil stops asking whether any one signal is true, and asks whether the signals agree. GPS against the serving cell tower. Device clock against server receipt. Scan location against the recipient's address. A fraudster can fake where. They cannot easily make six independent sources tell the same false story, dozens of times, without leaving a shape.",
    ],
    pull: "A fraudster can fake WHERE. They cannot fake HOW FAST, or WHETHER THE CUSTOMER GOT IT.",
  },
  {
    id: "argument",
    eyebrow: "Cross-signal consistency",
    title: "Sixteen checks, and an honest answer when a check cannot run",
    body: [
      "Every rule returns one of three states, never a boolean: it triggered, it was clear, or it could not be evaluated. Clear means two independent signals were compared and agreed. Not evaluated means there was nothing to compare.",
      "That third state is load-bearing. A courier in a tunnel loses GPS precision, cell service and WiFi. Score that absence as clean and a tunnel becomes arithmetically identical to a spoof — both score zero on the location rules, for opposite reasons. The console therefore always shows how many checks could be evaluated alongside the score.",
    ],
    stats: [
      { value: 16, label: "single-event checks", source: "lib/engine" },
      { value: 5, label: "pattern rules", source: "lib/pattern" },
      { value: 3, label: "states per rule, never two", source: "rule 4" },
    ],
    link: { href: "/operator/inbox", label: "Open the operator console" },
  },
  {
    id: "gate",
    eyebrow: "The orthogonal gate",
    title: "Two axes that are never added together",
    body: [
      "Single-event contradiction and cumulative pattern are separate numbers, and they meet in exactly one place. The reason is a case no combined score can express: every event passes on its own, and the distribution is still wrong.",
      "Three couriers whose scores sum to eighty need three different actions. 0 and 80 means investigate the courier. 80 and 0 means re-check the event. 40 and 40 means stop the scope. Summing them discards which axis the risk came from — and that is precisely what decides what an operator should do next.",
    ],
    pull: "Row two is the whole project. A careful fraudster can keep every event under the threshold. They cannot change their own distribution.",
    link: { href: "/demo/gate", label: "Drag the thresholds yourself" },
  },
  {
    id: "cosign",
    eyebrow: "Constitutive approval",
    title: "Without the operator's signature, the credential does not verify",
    body: [
      "Approval is not a boolean in a table. A high-risk handoff needs a token co-signed by the courier's key and the operator's key. The courier's half alone is cryptographically valid and still not a credential — so nothing seals, and nothing is recorded.",
      "If a judge asks whether the approval button is real, the answer is that removing it does not leave an unapproved handoff. It leaves a signature that fails verification.",
    ],
    link: { href: "/demo/cosign", label: "Watch both signatures, side by side" },
  },
  {
    id: "ai",
    eyebrow: "Where the AI sits",
    title: "The model chooses what to look up. It never decides.",
    body: [
      "A language model appears in exactly two places: selecting up to two evidence tools from a closed list, and writing the explanation after the verdict is already sealed. Remove it entirely and the verdicts are byte-identical — that is not a promise, it is a test that runs on every commit.",
      "We measured what happens when a model does decide. Asked to judge an obvious GPS spoof, three model families disagreed: two flagged it, one accepted it five times out of five and offered no reasoning at all. Which model you ask changes the answer.",
    ],
    stats: [
      { value: 33.3, decimals: 1, suffix: "%", label: "cross-vendor agreement on an obvious spoof", source: "E4a" },
      { value: 0, label: "verdicts a model can move", source: "parity tests" },
    ],
    link: { href: "/demo/models", label: "See where the models diverge" },
  },
  {
    id: "evidence",
    eyebrow: "Measured, not asserted",
    title: "Every number here came from a run we committed predictions against",
    body: [
      "Detection is measured on a deterministic holdout, with the reporting half untouched until the implementation is frozen. False positives are measured against synthetic fleets carrying real environmental noise — degraded GPS, queued uploads, missed scans, clock drift — with every noise parameter carrying a citation or the word assumption.",
      "The ledger is a hash-chained file, not a table, and you can verify it in your own browser. Tamper with a record and it names the index where the chain breaks.",
    ],
    stats: [
      { value: 7, label: "attack classes detected 12 of 12", source: "E2" },
      { value: 2.2, decimals: 1, suffix: "%", label: "false positives per leg, adverse conditions", source: "E3 level 3" },
      { value: 9, label: "architectural rules the test suite enforces", source: "lib/purity.test.ts" },
    ],
    link: { href: "/verify", label: "Verify the ledger in your browser" },
  },
];

export const LIMITS = [
  "A rooted device operated by someone colluding with the recipient is out of reach. That is a boundary of the idea, and it is measured rather than hidden.",
  "A hub that chronically loses its departure scan is frozen every time — narrow over-refusal, stated and not softened.",
  "Identity is simulated; the signatures are real Ed25519 and verified by the same code used everywhere else.",
];
