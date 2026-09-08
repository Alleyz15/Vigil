import Link from "next/link";

const VIEWS = [
  {
    href: "/timeline",
    title: "Shipment timeline",
    body: "A whole shipment, leg by leg, from ordinary work to the exception. Press play and watch it arrive rather than reading the end state.",
  },
  {
    href: "/stream",
    title: "Reasoning stream",
    body: "The eight agent nodes executing live over SSE. The delays are the nodes running; nothing here is a recording.",
  },
  {
    href: "/gate",
    title: "Gate explorer",
    body: "Every event on two independent axes. Drag either threshold and watch the same events redistribute across four different actions.",
  },
];

export default function Home() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Handoff trust console</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Vigil does not try to prove a delivery happened — every individual signal can be forged.
        It asks whether a set of claims agree with each other, and whether a courier&apos;s
        behaviour is the right shape. The two questions are scored on separate axes and are never
        added together.
      </p>

      <div className="mt-8 grid gap-3">
        {VIEWS.map((view) => (
          <Link
            key={view.href}
            href={view.href}
            className="rounded-lg border border-border/60 bg-card/40 px-5 py-4 transition-colors hover:border-border hover:bg-card/70"
          >
            <div className="text-sm font-medium">{view.title}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{view.body}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
