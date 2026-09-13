"use client";

import { useRef, useState } from "react";
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
  type Transition,
} from "motion/react";
import { Lock } from "lucide-react";
import {
  MODEL_NODE_LABEL,
  PIPELINE,
  PIPELINE_REVEAL,
  type PipelineRole,
  type PipelineStep,
} from "@/lib/landing/content";
import { cn } from "@/lib/utils";
import { ArchitectureDiagram } from "./architecture-diagram";

/**
 * The eight nodes, told by scrolling.
 *
 * A pattern taken from sui.io's step section, rebuilt rather than copied: their
 * site is Webflow and there is no source to read, so the structure — a tall
 * outer container, a sticky full-height frame, cards either side of a central
 * track with a marker that travels down it — is inferred from their markup. It
 * is the same FORM, not a claim of the same implementation.
 *
 * The content suits the form better than theirs does. The order is real (these
 * nodes run in this sequence on every handoff), and it has a turn in the middle:
 * the model appears at 3, the verdict is made at 7, the model appears again at
 * 8 — after there is nothing left for it to decide.
 */

/**
 * TWO KINDS OF MOTION, AND THEIR RULES ARE OPPOSITE.
 *
 * Continuous and scroll-linked — which step is current, and where the marker
 * sits on the track: LINEAR, no easing, no spring. Both follow the viewer's
 * wheel, and any smoothing between the wheel and the position reads as "I
 * scrolled and it lagged". Lenis already smooths the scroll itself; adding a
 * second smoothing on top would be lag, not physics.
 *
 * Discrete, triggered by a step change — a card coming into focus, the reveal
 * arriving: this curve. The lag belongs after the state has changed, never
 * between the wheel and the state.
 */
const EASE = [0.16, 1, 0.3, 1] as const;
const STATE_CHANGE: Transition = { duration: 0.6, ease: EASE };

/**
 * Colour changes, which motion cannot interpolate through CSS variables: the
 * same curve and duration as STATE_CHANGE, as CSS.
 *
 * A CLASS, NOT AN INLINE STYLE CHOSEN BY useReducedMotion. That hook reads the
 * preference on the client's first render and returns null on the server, so a
 * style branched on it rendered differently on each side and React reported a
 * hydration mismatch — only for reduced-motion viewers. `motion-safe:` lets the
 * browser decide, with identical markup everywhere. Tailwind needs the literal,
 * so the numbers are repeated: keep them equal to EASE and STATE_CHANGE.
 */
const COLOUR_CHANGE =
  "motion-safe:transition-[color,background-color,border-color,opacity] motion-safe:duration-[600ms] motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]";

/**
 * How far an out-of-focus card steps back. SET FROM A MEASUREMENT, not taste.
 *
 * Opacity on a dark card over a light page pulls text and surface toward the
 * same page colour, so legibility falls fast. Least readable card, glyph core
 * against its own surface, at 1920x1080:
 *
 *   0.3  1.96:1    0.5  3.37:1    0.7  6.42:1
 *   outline + muted text (surface fades, text does not)  5.80:1
 *
 * 0.7 keeps every card readable ahead of the viewer, above 4.5:1, and keeps
 * the cards ink rather than turning seven of eight into outlines. Focus is
 * still carried by full ink and full size on the one current card.
 * `npm run qa:capture:landing` fails if an out-of-focus card drops below 4.5:1.
 */
const OUT_OF_FOCUS = { opacity: 0.7, scale: 0.96 } as const;

/**
 * Half-steps, so the last step can hand over to the reveal without a ninth
 * screen of scroll: phases 0–15, step = phase ÷ 2, and the second half of the
 * final step is the reveal.
 */
const PHASES = PIPELINE.length * 2;

export function PipelineSteps() {
  return (
    <>
      {/*
        The sticky sequence, for a wide screen with motion allowed. The switch
        is CSS, not JS, so the server and the client render the same markup and
        a reduced-motion viewer never sees one frame of the other version.
      */}
      <div className="hidden lg:motion-safe:block">
        <ScrollSequence />
      </div>

      {/*
        The static argument: every step, the reveal, and the diagram. Shown for
        reduced motion AND below lg — 800vh of sticky two-column layout on a
        phone is not a smaller version of this section, it is a broken one. With
        the animation gone the argument has to stand on its own, so nothing
        here depends on having scrolled.
      */}
      <div className="lg:motion-safe:hidden">
        <StaticSequence />
      </div>
    </>
  );
}

function ScrollSequence() {
  const container = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(0);
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : STATE_CHANGE;

  const { scrollYProgress } = useScroll({
    target: container,
    offset: ["start start", "end end"],
  });

  // Linear by construction: a floor of the progress, nothing interpolated.
  useMotionValueEvent(scrollYProgress, "change", (progress) => {
    setPhase(Math.min(PHASES - 1, Math.max(0, Math.floor(progress * PHASES))));
  });

  const step = Math.floor(phase / 2);
  const revealed = phase === PHASES - 1;

  return (
    <div
      ref={container}
      data-pipeline-phase={phase}
      className="relative mt-8"
      /*
        A LAYOUT DIMENSION DERIVED FROM THE STEP COUNT, not a spacing token: one
        viewport of scroll per node. The 4/8/12/16/24/32 scale governs space
        inside components; this is how long the section is pinned for.
      */
      style={{ height: `${PIPELINE.length * 100}vh` }}
    >
      <div className="sticky top-0 flex h-screen flex-col justify-center">
        {/*
          Cards alternate either side of the track, each spanning two of nine
          half-rows, so a left card and the right card after it overlap by half
          and eight cards fit one viewport without shrinking the type.
        */}
        <ol className="relative grid grid-cols-[minmax(0,1fr)_32px_minmax(0,1fr)] grid-rows-[repeat(9,auto)] gap-x-6 gap-y-2">
          <Track progress={scrollYProgress} />
          {PIPELINE.map((item, index) => (
            <PipelineCard
              key={item.node}
              item={item}
              index={index}
              state={cardState(item, index, step, revealed)}
              transition={transition}
              style={{ gridColumn: index % 2 === 0 ? 1 : 3, gridRow: `${index + 1} / span 2` }}
            />
          ))}
        </ol>

        <motion.div
          className="mt-8 text-center"
          initial={false}
          animate={{ opacity: revealed ? 1 : 0, y: revealed ? 0 : 16 }}
          transition={transition}
          aria-hidden={!revealed}
        >
          <p className="text-2xl font-semibold leading-8 tracking-tight">{PIPELINE_REVEAL.claim}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Asserted by {PIPELINE_REVEAL.source} — a test that runs, not a promise
          </p>
        </motion.div>
      </div>
    </div>
  );
}

type CardState = "focus" | "out-of-focus" | "removed";

/**
 * At the reveal nothing is "current": the model nodes are taken out and every
 * other node — the gate above all — stays exactly as it was. That picture IS
 * the claim underneath it.
 */
function cardState(item: PipelineStep, index: number, step: number, revealed: boolean): CardState {
  if (revealed) return item.role === "model" ? "removed" : "focus";
  return index === step ? "focus" : "out-of-focus";
}

/**
 * The central track: a dashed line, a solid fill down to the marker, and the
 * marker itself. Position is the scroll progress, directly — `useTransform` on
 * the MotionValue, so it is written in the same frame the progress changes and
 * never passes through React state or an easing curve.
 */
function Track({ progress }: { progress: MotionValue<number> }) {
  const top = useTransform(progress, (value) => `${value * 100}%`);
  return (
    <li aria-hidden="true" className="relative" style={{ gridColumn: 2, gridRow: "1 / -1" }}>
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 border-l-2 border-dashed border-foreground/25" />
      <motion.div
        className="absolute inset-x-0 top-0 mx-auto w-0.5 origin-top bg-foreground"
        style={{ height: top }}
      />
      <motion.div
        data-track-marker
        className="absolute left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-foreground"
        style={{ top }}
      />
    </li>
  );
}

/**
 * One node. STRUCTURE carries role (rule 1k), and so does DIRECTION:
 *
 *   deterministic  dark ink card, hairline light edge
 *   model          dark ink card, DASHED edge
 *   gate           the one LIGHT card, heavy solid edge
 *
 * With every other card dark, the gate's inversion can only go toward light —
 * inverting it to dark as well would make it one more dark card, and the one
 * place a verdict is made would stop being the one thing that looks different.
 */
function PipelineCard({
  item,
  index,
  state,
  transition,
  style,
}: {
  item: PipelineStep;
  index: number;
  state: CardState;
  transition: Transition;
  style?: React.CSSProperties;
}) {
  const target =
    state === "focus"
      ? { opacity: 1, scale: 1 }
      : state === "removed"
        ? { opacity: 0.15, scale: 0.92 }
        : OUT_OF_FOCUS;

  return (
    <motion.li
      data-card-state={state}
      data-role={item.role}
      className={cn("self-center rounded-lg p-4", COLOUR_CHANGE, CARD_SKIN[item.role])}
      style={style}
      initial={false}
      animate={target}
      transition={transition}
    >
      <CardBody item={item} index={index} />
    </motion.li>
  );
}

const CARD_SKIN: Record<PipelineRole, string> = {
  deterministic: "border border-background/15 bg-foreground text-background",
  model: "border-2 border-dashed border-background/60 bg-foreground text-background",
  decides: "border-2 border-foreground bg-background text-foreground",
};

function CardBody({ item, index }: { item: PipelineStep; index: number }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm tabular-nums opacity-80">{index + 1}</span>
        <span className="font-mono text-base font-semibold">{item.node}</span>
        <RoleTag role={item.role} />
      </span>
      <span className="mt-1 block text-sm leading-5">{item.line}</span>
    </>
  );
}

function RoleTag({ role }: { role: PipelineRole }) {
  if (role === "model") {
    return (
      <span className="inline-flex items-center rounded-md border border-dashed border-current px-2 py-1 text-xs font-medium">
        {MODEL_NODE_LABEL}
      </span>
    );
  }
  if (role === "decides") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-current px-2 py-1 text-xs font-medium">
        <Lock aria-hidden="true" className="size-3" />
        The verdict is made here
      </span>
    );
  }
  return null;
}

function StaticSequence() {
  return (
    <div className="mt-8">
      <ol className="grid gap-3">
        {PIPELINE.map((item, index) => (
          <li key={item.node} className={cn("rounded-lg p-4", CARD_SKIN[item.role])}>
            <CardBody item={item} index={index} />
          </li>
        ))}
      </ol>

      <p className="mt-8 max-w-2xl text-lg font-semibold leading-8">{PIPELINE_REVEAL.claim}</p>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        Asserted by {PIPELINE_REVEAL.source} — a test that runs, not a promise
      </p>

      <ArchitectureDiagram />
    </div>
  );
}
