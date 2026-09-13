"use client";

import { useRef, useState } from "react";
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  type Transition,
  type Variants,
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
 * outer container, a sticky full-height frame, a numbered list on the left and
 * a graphic that fills on the right — is inferred from their markup. It is the
 * same FORM, not a claim of the same implementation.
 *
 * The content suits the form better than theirs does. The order is real (these
 * nodes run in this sequence on every handoff), and it has a turn in the middle:
 * the model appears at 3, the verdict is made at 7, the model appears again at
 * 8 — after there is nothing left for it to decide.
 */

/**
 * TWO KINDS OF MOTION, AND THEIR RULES ARE OPPOSITE.
 *
 * Scroll position → which step is current: LINEAR, no easing at all. It follows
 * the viewer's wheel, and easing there reads as "I scrolled and it lagged",
 * which is stutter rather than polish.
 *
 * A step change → elements entering, the rail filling, the panel inverting:
 * this curve. The lag belongs here, after the state has changed, never between
 * the wheel and the state.
 */
const EASE = [0.16, 1, 0.3, 1] as const;
const STATE_CHANGE: Transition = { duration: 0.6, ease: EASE };
const STAGGER = 0.06;

/**
 * Colour changes, which motion cannot interpolate through CSS variables: the
 * same curve and duration as STATE_CHANGE, as CSS.
 *
 * A CLASS, NOT AN INLINE STYLE CHOSEN BY useReducedMotion. That hook reads the
 * preference on the client's first render and returns null on the server, so a
 * style branched on it rendered differently on each side and React reported a
 * hydration mismatch — only for reduced-motion viewers, the one audience this
 * section is hidden from, which is why no motion-allowed frame showed it.
 * `motion-safe:` lets the browser decide, with identical markup everywhere.
 * Tailwind needs the literal, so the numbers are repeated: keep them equal to
 * EASE and STATE_CHANGE.
 */
const COLOUR_CHANGE =
  "motion-safe:transition-[color,background-color,border-color,opacity] motion-safe:duration-[600ms] motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]";

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
      <div className="sticky top-0 flex h-screen items-center">
        <div className="grid w-full grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-center gap-8">
          <StepList current={step} />
          <Stage step={step} revealed={revealed} />
        </div>
      </div>
    </div>
  );
}

function StepList({ current }: { current: number }) {
  const reduced = useReducedMotion();

  return (
    <ol>
      {PIPELINE.map((item, index) => {
        const active = index === current;
        return (
          <li
            key={item.node}
            className={cn(
              "relative grid grid-cols-[32px_minmax(0,1fr)] gap-3 py-2 pl-4",
              COLOUR_CHANGE,
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="pipeline-current"
                aria-hidden="true"
                className="absolute inset-y-2 left-0 w-1 rounded-full bg-foreground"
                transition={reduced ? { duration: 0 } : STATE_CHANGE}
              />
            )}
            <span className="pt-px font-mono text-sm tabular-nums">{index + 1}</span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className={cn("font-mono text-base", active && "font-semibold")}>{item.node}</span>
                <RoleTag role={item.role} compact />
              </span>
              <span className="mt-1 block text-sm leading-5">{item.line}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The graphic. Fills as the pipeline advances, inverts at the gate, and at the
 * end takes the model nodes out while the gate stays exactly where it was.
 */
function Stage({ step, revealed }: { step: number; revealed: boolean }) {
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : STATE_CHANGE;
  const inverted = PIPELINE[step]?.role === "decides" && !revealed;

  return (
    <div
      className={cn(
        "relative aspect-[4/3] overflow-hidden rounded-lg bg-muted/50",
        COLOUR_CHANGE,
        inverted ? "text-background" : "text-foreground",
      )}
    >
      {/*
        THE INVERSION IS THE TURN. Six steps gather and compare; this one
        decides. The whole panel changes state rather than one node changing
        colour, so the viewer registers that something different just happened
        without having to find where.
      */}
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-foreground"
        initial={false}
        animate={{ opacity: inverted ? 1 : 0 }}
        transition={transition}
      />

      <div className="relative flex h-full flex-col p-8">
        <Rail step={step} revealed={revealed} inverted={inverted} />

        {/*
          A fixed-height slot anchored at the top, so "3 / 8" sits in the same
          place on every step. Bottom-anchored, the block's top edge moved with
          the length of each line — 31px between plan and gate.
        */}
        <motion.div
          key={revealed ? "reveal" : step}
          className="mt-auto h-3/5"
          initial="hidden"
          animate="shown"
          variants={{ shown: { transition: { staggerChildren: reduced ? 0 : STAGGER } } }}
        >
          {revealed ? <Reveal transition={transition} /> : <StepCopy item={PIPELINE[step]} index={step} transition={transition} />}
        </motion.div>
      </div>
    </div>
  );
}

function StepCopy({
  item,
  index,
  transition,
}: {
  item: PipelineStep;
  index: number;
  transition: Transition;
}) {
  const enter = entering(transition);
  return (
    <>
      <motion.p variants={enter} className="font-mono text-sm tabular-nums opacity-70">
        {index + 1} / {PIPELINE.length}
      </motion.p>
      <motion.h3 variants={enter} className="mt-3 font-mono text-4xl font-semibold tracking-tight">
        {item.node}
      </motion.h3>
      <motion.p variants={enter} className="mt-4 max-w-md text-lg leading-7">
        {item.line}
      </motion.p>
      <motion.div variants={enter} className="mt-6">
        <RoleTag role={item.role} />
      </motion.div>
    </>
  );
}

function Reveal({ transition }: { transition: Transition }) {
  const enter = entering(transition);
  return (
    <>
      <motion.p variants={enter} className="max-w-md text-2xl font-semibold leading-8 tracking-tight">
        {PIPELINE_REVEAL.claim}
      </motion.p>
      <motion.p variants={enter} className="mt-4 font-mono text-xs text-muted-foreground">
        Asserted by {PIPELINE_REVEAL.source} — a test that runs, not a promise
      </motion.p>
    </>
  );
}

/**
 * Eight nodes on a track. Shape carries role (rule 1k): a model node is a
 * dashed ring, the deciding node is a square, everything else is a circle.
 * Hue carries nothing, so the distinction survives video compression and a
 * viewer who does not see colour.
 */
function Rail({ step, revealed, inverted }: { step: number; revealed: boolean; inverted: boolean }) {
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : STATE_CHANGE;
  const last = PIPELINE.length - 1;

  return (
    <div>
      <div className="relative flex items-center justify-between">
        <div aria-hidden="true" className="absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-current opacity-20" />
        <motion.div
          aria-hidden="true"
          className="absolute inset-x-3 top-1/2 h-0.5 origin-left -translate-y-1/2 bg-current"
          initial={false}
          animate={{ scaleX: step / last }}
          transition={transition}
        />
        {PIPELINE.map((item, index) => {
          const reached = index <= step;
          // At the reveal the model is taken out; the gate does not move.
          const removed = revealed && item.role === "model";
          return (
            <motion.span
              key={item.node}
              aria-hidden="true"
              className={cn(
                "relative size-6 border-2 border-current",
                item.role === "decides" ? "rounded-sm" : "rounded-full",
                item.role === "model" && "border-dashed",
                // A model node is never filled: it contributes, it does not hold
                // state. An unfilled node is painted in the PANEL's colour so the
                // track does not show through — bg-muted was a light disc on the
                // inverted gate panel, and the dashed model rings read as filled
                // on exactly the frame that most needs them to read as model.
                reached && item.role !== "model"
                  ? "bg-current"
                  : inverted
                    ? "bg-foreground"
                    : "bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-background))]",
                COLOUR_CHANGE,
              )}
              initial={false}
              animate={{
                scale: index === step && !revealed ? 1.25 : removed ? 0.75 : 1,
                opacity: removed ? 0.2 : 1,
              }}
              transition={transition}
            />
          );
        })}
      </div>
      <div className="mt-3 flex justify-between font-mono text-xs tabular-nums opacity-70">
        {PIPELINE.map((item, index) => (
          <span key={item.node} className="w-6 text-center">
            {index + 1}
          </span>
        ))}
      </div>
    </div>
  );
}

function RoleTag({ role, compact = false }: { role: PipelineRole; compact?: boolean }) {
  if (role === "model") {
    return (
      <span className="inline-flex items-center rounded-md border border-dashed border-current px-2 py-1 text-xs font-medium">
        {MODEL_NODE_LABEL}
      </span>
    );
  }
  if (role === "decides") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
          compact ? "border border-current" : "bg-background text-foreground",
        )}
      >
        <Lock aria-hidden="true" className="size-3" />
        The verdict is made here
      </span>
    );
  }
  return compact ? null : (
    <span className="inline-flex items-center rounded-md border border-current px-2 py-1 text-xs opacity-70">
      Deterministic
    </span>
  );
}

function StaticSequence() {
  return (
    <div className="mt-8">
      <ol className="space-y-4">
        {PIPELINE.map((item, index) => (
          <li key={item.node} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3">
            <span className="pt-px font-mono text-sm tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-base font-semibold">{item.node}</span>
                <RoleTag role={item.role} compact />
              </span>
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">{item.line}</span>
            </span>
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

function entering(transition: Transition): Variants {
  return {
    hidden: { opacity: 0, y: 16 },
    shown: { opacity: 1, y: 0, transition },
  };
}
