"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import NumberFlow from "@number-flow/react";
import { ArrowRight, Monitor, Smartphone } from "lucide-react";
import { HERO, LIMITS, SECTIONS, type Stat } from "@/lib/landing/content";
import { HERO_MEDIA, planHeroBackdrop } from "@/lib/landing/hero-media";
import { cn } from "@/lib/utils";
import { cancelFrame, frame, type FrameData } from "motion/react";
import { PipelineSteps } from "./pipeline-steps";

/**
 * The narrative surface. One judge, once, for ninety seconds.
 *
 * This page plays by the OTHER set of rules — see "Two surfaces, two rules" in
 * CLAUDE.md. Inertial scroll and a rendered diagram are the point here and are
 * banned in the console, where the same effects would add latency to work an
 * operator repeats dozens of times a shift.
 *
 * WHAT IT MUST NOT DO: assert. Every section ends at a route where the claim
 * can be checked, because "go and look" is the whole argument. A narrative that
 * only tells is a brochure for a system nobody can audit.
 */
export function LandingView() {
  useSmoothScroll();

  return (
    <main className="mx-auto max-w-5xl px-6 pb-24">
      <Hero />

      {SECTIONS.map((section) => (
        <Section
          key={section.id}
          section={section}
          lead={section.id === "ai" ? <PipelineSteps /> : undefined}
        />
      ))}

      <Limits />
      <Enter />
    </main>
  );
}

function Hero() {
  return (
    <header className="relative isolate flex min-h-[82vh] flex-col justify-center py-20">
      <HeroBackdrop />

      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        Vigil · agentic handoff trust verifier
      </p>

      {/*
        THE SIZE CONTRAST IS THE POINT. One sentence gets the whole viewport and
        everything else is support — a judge reads the claim before they decide
        whether to read the page. The previous 48/18 pairing was a heading above
        a paragraph; this is a statement with a caption under it.
      */}
      <h1 className="mt-5 max-w-[16ch] text-5xl font-semibold leading-[0.95] tracking-[-0.03em] sm:text-7xl lg:text-[7.5rem]">
        {HERO.title}
      </h1>

      <p className="mt-7 max-w-xl text-base leading-7 text-muted-foreground">{HERO.standfirst}</p>

      <ol className="mt-6 max-w-xl space-y-2">
        {HERO.questions.map((question, index) => (
          <li key={question} className="flex gap-3 text-base leading-7">
            <span className="mt-px font-mono text-sm text-muted-foreground">{index + 1}</span>
            <span className="font-medium">{question}</span>
          </li>
        ))}
      </ol>

      {/*
        Joined, not spaced. Two buttons sharing an edge read as one control with
        a default and an alternative; two buttons with a gap read as two equal
        options, which is not what is being offered. The filled one is where a
        judge should start.
      */}
      <div className="mt-9 flex w-fit flex-wrap">
        <Link
          href="/operator/inbox"
          className="inline-flex h-12 items-center gap-2 rounded-l-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Open the console
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
        <Link
          href="/demo/cosign"
          className="-ml-px inline-flex h-12 items-center rounded-r-md border border-foreground/20 px-6 text-sm font-medium transition-colors hover:bg-muted"
        >
          See the co-signature
        </Link>
      </div>
    </header>
  );
}

/**
 * The reserved media slot.
 *
 * Everything here is painted today. The gradient is the design; the scrim is
 * the legibility guarantee; the video is the only missing piece, and it arrives
 * by setting `HERO_MEDIA.src` in `lib/landing/hero-media.ts` and nothing else.
 *
 * STACKING ORDER IS OWNED HERE, not by a caller: static ground, then media,
 * then scrim, then the page content above all of it. A future session cannot
 * accidentally put footage over the top of the text, because there is no JSX
 * for them to write.
 */
function HeroBackdrop() {
  const reducedMotion = usePrefersReducedMotion();
  const plan = planHeroBackdrop(HERO_MEDIA, { reducedMotion });
  const bleed = useDocumentWidth();

  return (
    /*
      FULL-BLEED, and sized from inside this component. The hero sits in the
      page's max-w-5xl column, so `inset-0` made the footage a 976px box with a
      hard vertical edge at each side of a 1920 frame. The session-20 probe
      could not see that: it measured legibility, and a box edge does not
      change the contrast behind a single glyph.

      Sized to `clientWidth` rather than `100vw`, because 100vw includes a
      classic scrollbar and would push the page into horizontal scroll. Before
      hydration the width is the column (`null` → 100%), which is the old,
      correct-if-boxed layout rather than an overflowing one.
    */
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-full -translate-x-1/2 overflow-hidden"
      style={bleed ? { width: bleed } : undefined}
    >
      {/* 1. The static ground. A finished treatment, not a placeholder. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_78%_15%,var(--color-muted)_0%,transparent_60%)]" />

      {/* 2. The media, when there is any. */}
      {plan.kind === "video" && (
        <video
          className="absolute inset-0 size-full object-cover"
          src={plan.src}
          poster={plan.poster ?? undefined}
          autoPlay
          muted
          loop
          playsInline
        />
      )}
      {plan.kind === "poster" && (
        /* A decorative backdrop sized entirely by CSS. next/image would add a
           layout pass and an optimisation pipeline for an image that is always
           object-cover over a fixed box. */
        // eslint-disable-next-line @next/next/no-img-element
        <img className="absolute inset-0 size-full object-cover" src={plan.poster} alt="" />
      )}

      {/*
        3. The scrim, ALWAYS, and in TWO layers. It sat over this headline
        before any footage existed, so the day the video landed was a
        measurement rather than a redesign: see lib/landing/hero-media.ts for
        the worst-case figures over the real loop.

        TWO LAYERS BECAUSE ONE WAS NOT ENOUGH, and a probe found that rather
        than a review. Painting a real screenshot into the media slot showed the
        image still plainly readable on the right at a single horizontal
        gradient — and at this type size the headline runs most of the way
        across, so its right-hand half sat over visible imagery. A lighter video
        would have survived that; a darker one would not.

        The flat wash knocks any media back to texture everywhere. The gradient
        then adds opacity on the left, where the text actually lives. A
        background video here is meant to be felt, not watched.
      */}
      <div className="absolute inset-0 bg-background/88" />
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-transparent" />
      {/*
        The foot of the hero. Full-bleed footage ends in a hard horizontal line
        that runs wider than the section rule beneath it; fading the last
        quarter lets the hero dissolve into the page instead of stopping.
      */}
      <div className="absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-background to-transparent" />
    </div>
  );
}

/** The document's width without its scrollbar, kept current. Null on the server. */
function useDocumentWidth(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new ResizeObserver(onChange);
      observer.observe(document.documentElement);
      return () => observer.disconnect();
    },
    () => document.documentElement.clientWidth,
    () => null,
  );
}

/**
 * Subscribed rather than read in an effect.
 *
 * `useSyncExternalStore` is the idiomatic way to read a media query: it avoids
 * a state write in an effect body, keeps the server snapshot explicit, and
 * updates if the viewer changes the setting while the page is open.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

function Section({
  section,
  lead,
}: {
  section: (typeof SECTIONS)[number];
  /** Rendered straight under the title, before the body: the thing the prose then comments on. */
  lead?: React.ReactNode;
}) {
  return (
    <section id={section.id} className="scroll-mt-16 border-t py-20">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        {section.eyebrow}
      </p>

      <h2 className="mt-4 max-w-3xl text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
        {section.title}
      </h2>

      {lead}

      <div className="mt-6 max-w-2xl space-y-5">
        {section.body.map((paragraph) => (
          <p key={paragraph.slice(0, 32)} className="text-base leading-7 text-muted-foreground">
            {paragraph}
          </p>
        ))}
      </div>

      {section.pull && (
        <blockquote className="mt-8 max-w-2xl border-l-2 border-foreground/20 pl-5 text-lg font-medium leading-8">
          {section.pull}
        </blockquote>
      )}

      {section.stats && (
        <dl
          className={cn(
            "mt-10 grid gap-4",
            section.stats.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3",
          )}
        >
          {section.stats.map((stat) => (
            <StatCard key={stat.label} stat={stat} />
          ))}
        </dl>
      )}

      {section.link && (
        <Link
          href={section.link.href}
          className="group mt-8 inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
        >
          {section.link.label}
          <ArrowRight
            aria-hidden="true"
            className="size-4 transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      )}
    </section>
  );
}

/**
 * A measured figure, counting up when it first reaches the viewport.
 *
 * The source is printed under every one. A number on a landing page with no
 * provenance is the easiest thing in a submission to disbelieve, and the
 * cheapest to make credible.
 */
function StatCard({ stat }: { stat: Stat }) {
  const [ref, seen] = useOnScreen<HTMLDivElement>();
  // The count-up is animation; the figure is content. A viewer who asked for
  // less motion gets the figure at once, not a zero until it scrolls into view
  // — a capture of that path showed "0.0%" where the measurement is 33.3%.
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div ref={ref} className="rounded-lg bg-muted/50 p-5">
      <dt className="sr-only">{stat.label}</dt>
      <dd>
        <span className="text-3xl font-semibold tabular-nums">
          <NumberFlow
            value={seen || reducedMotion ? stat.value : 0}
            format={{
              minimumFractionDigits: stat.decimals ?? 0,
              maximumFractionDigits: stat.decimals ?? 0,
            }}
          />
          {stat.suffix}
        </span>
        <span className="mt-2 block text-sm leading-6">{stat.label}</span>
        <span className="mt-1 block font-mono text-xs text-muted-foreground">{stat.source}</span>
      </dd>
    </div>
  );
}

function Limits() {
  return (
    <section className="scroll-mt-16 border-t py-20">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        What it does not do
      </p>
      <h2 className="mt-4 max-w-3xl text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
        The boundaries are measured, not omitted
      </h2>

      <ul className="mt-6 max-w-2xl space-y-4">
        {LIMITS.map((limit) => (
          <li key={limit.slice(0, 24)} className="flex gap-3 text-base leading-7 text-muted-foreground">
            <span aria-hidden="true" className="mt-3 size-1.5 shrink-0 rounded-full bg-foreground/30" />
            {limit}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The three surfaces, as three doors. */
function Enter() {
  return (
    <section className="scroll-mt-16 border-t py-20">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Enter</p>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
        Three people, three surfaces
      </h2>
      <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
        The courier signs, the operator co-signs, and the recipient answers one question through a
        link scoped to their own parcel. They are different people with different authority, and
        the product is built that way rather than as one screen with three modes.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Door
          href="/operator/inbox"
          icon={<Monitor aria-hidden="true" className="size-5" />}
          title="Operator console"
          detail="The work queue, the evidence, and the decision. Start here."
        />
        <Door
          href="/courier"
          icon={<Smartphone aria-hidden="true" className="size-5" />}
          title="Courier handset"
          detail="Sign a scan and watch what the system does with it."
        />
      </div>
    </section>
  );
}

function Door({
  href,
  icon,
  title,
  detail,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group flex gap-4 rounded-lg bg-muted/50 p-5 transition-colors hover:bg-muted"
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-medium">
          {title}
          <ArrowRight
            aria-hidden="true"
            className="size-4 transition-transform group-hover:translate-x-0.5"
          />
        </span>
        <span className="mt-1 block text-sm leading-6 text-muted-foreground">{detail}</span>
      </span>
    </Link>
  );
}

/**
 * Inertial scrolling, and only here.
 *
 * ONE ANIMATION LOOP, NOT TWO. Lenis is driven from motion's frame loop
 * (`autoRaf: false`, `frame.update`) rather than its own requestAnimationFrame,
 * so the scroll write and the `useScroll` read happen in one scheduler with one
 * order, whatever order the two libraries happened to register in.
 *
 * WHAT WAS MEASURED, because the reason this was asked for did not reproduce.
 * The expected failure of two loops was jitter: a phase lagging the wheel by a
 * varying number of frames. Session 21 measured both arrangements in headless
 * Chrome at 1920x1080, six runs each, 90 step boundaries each:
 *
 *   Lenis on its own rAF      1 frame behind; 1 boundary of 90 at 2
 *   Lenis on motion's loop    2 frames behind; 3 of 90 at 3, 4 and 10 (the 10
 *                             seconds after a recompile)
 *
 * Neither shows systematic jitter, and the shared loop did not reduce what
 * variation there was. Browsers run rAF callbacks in registration order, so two
 * loops that register once keep a stable order anyway. The base lags are not
 * directly comparable — the sampler is itself a rAF callback. This arrangement
 * is kept because it was specified, NOT because a jitter was observed and
 * removed; revisit it with a real browser and a real wheel if it is questioned.
 *
 * Disabled outright for a reduced-motion preference rather than shortened:
 * smoothed scrolling is the effect that setting most directly asks to be rid
 * of, and there is no degraded version of it worth shipping.
 */
function useSmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let lenis: { raf: (time: number) => void; destroy: () => void } | undefined;
    let cancelled = false;
    const tick = ({ timestamp }: FrameData) => lenis?.raf(timestamp);

    void import("lenis").then(({ default: Lenis }) => {
      if (cancelled) return;
      lenis = new Lenis({ duration: 0.9, autoRaf: false });
      // keepAlive: runs every frame until cancelled, in motion's update step.
      frame.update(tick, true);
    });

    return () => {
      cancelled = true;
      cancelFrame(tick);
      lenis?.destroy();
    };
  }, []);
}

/** Fires once, the first time the element is visible. Never resets. */
function useOnScreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;

    // No IntersectionObserver (or a headless capture that never scrolls) must
    // not mean a permanent zero on screen: the number is the content, and the
    // animation is decoration on top of it.
    if (typeof IntersectionObserver === "undefined") {
      // Deferred a frame rather than set synchronously: a state write in the
      // effect body is the render-loop hazard the lint rule guards, and this
      // path still has to run, because a permanent zero on screen would be a
      // wrong number rather than a missing animation.
      const id = requestAnimationFrame(() => setSeen(true));
      return () => cancelAnimationFrame(id);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: "-10% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  return [ref, seen] as const;
}
