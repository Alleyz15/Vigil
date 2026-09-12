"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import NumberFlow from "@number-flow/react";
import { ArrowRight, Monitor, Smartphone } from "lucide-react";
import { HERO, LIMITS, SECTIONS, type Stat } from "@/lib/landing/content";
import { cn } from "@/lib/utils";
import { ArchitectureDiagram } from "./architecture-diagram";

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
        <Section key={section.id} section={section}>
          {section.id === "ai" ? <ArchitectureDiagram /> : null}
        </Section>
      ))}

      <Limits />
      <Enter />
    </main>
  );
}

function Hero() {
  return (
    <header className="flex min-h-[78vh] flex-col justify-center py-20">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        Vigil · agentic handoff trust verifier
      </p>

      <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
        {HERO.title}
      </h1>

      <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">{HERO.standfirst}</p>

      <ol className="mt-8 max-w-2xl space-y-3">
        {HERO.questions.map((question, index) => (
          <li key={question} className="flex gap-4 text-lg leading-8">
            <span className="mt-1 font-mono text-sm text-muted-foreground">{index + 1}</span>
            <span className="font-medium">{question}</span>
          </li>
        ))}
      </ol>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/operator/inbox"
          className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Open the console
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
        <Link
          href="/demo/cosign"
          className="inline-flex h-11 items-center gap-2 rounded-md bg-muted px-5 text-sm font-medium transition-colors hover:bg-muted/70"
        >
          See the co-signature
        </Link>
      </div>
    </header>
  );
}

function Section({
  section,
  children,
}: {
  section: (typeof SECTIONS)[number];
  children?: React.ReactNode;
}) {
  return (
    <section id={section.id} className="scroll-mt-16 border-t py-20">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        {section.eyebrow}
      </p>

      <h2 className="mt-4 max-w-3xl text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
        {section.title}
      </h2>

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

      {children}

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

  return (
    <div ref={ref} className="rounded-lg bg-muted/50 p-5">
      <dt className="sr-only">{stat.label}</dt>
      <dd>
        <span className="text-3xl font-semibold tabular-nums">
          <NumberFlow
            value={seen ? stat.value : 0}
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
 * Disabled outright for a reduced-motion preference rather than shortened:
 * smoothed scrolling is the effect that setting most directly asks to be rid
 * of, and there is no degraded version of it worth shipping.
 */
function useSmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let lenis: { raf: (time: number) => void; destroy: () => void } | undefined;
    let frame = 0;
    let cancelled = false;

    void import("lenis").then(({ default: Lenis }) => {
      if (cancelled) return;
      lenis = new Lenis({ duration: 0.9 });
      const loop = (time: number) => {
        lenis?.raf(time);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
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
