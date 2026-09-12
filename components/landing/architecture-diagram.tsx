"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Where the model sits, drawn rather than described.
 *
 * DYNAMIC IMPORT ONLY. Mermaid is large and this is the only page allowed to
 * use it; a static import would put it in a shared chunk and charge the
 * operator console for a diagram it never renders. `lib/purity.test.ts` fails
 * if a console tree imports it at all — the eighth constraint.
 *
 * The diagram states the claim the architecture is built on: eight nodes run in
 * order, the model touches two of them, and neither is the one that decides.
 */

const GRAPH = `
flowchart LR
  parse[parse] --> lookup[lookup]
  lookup --> plan[plan]
  plan --> verify[verify]
  verify --> history[fetch_history]
  history --> context[external_context]
  context --> gate[gate]
  gate --> explain[explain]

  classDef model fill:#e0f2fe,stroke:#0369a1,stroke-width:2px,color:#0c4a6e;
  classDef decide fill:#052e29,stroke:#052e29,color:#ffffff;
  class plan,explain model;
  class gate decide;
`;

export function ArchitectureDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          fontFamily: "var(--font-inter), system-ui, sans-serif",
        });
        const { svg } = await mermaid.render("vigil-agent-graph", GRAPH);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch(() => {
        // A diagram that will not render must not take the argument with it.
        // The prose beside it already carries the claim; the fallback below
        // states the same thing in text.
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <figure className="mt-10 rounded-lg bg-muted/50 p-6">
      {failed ? (
        <p className="text-sm leading-6 text-muted-foreground">
          parse → lookup → <strong className="text-foreground">plan</strong> → verify →
          fetch_history → external_context → <strong className="text-foreground">gate</strong> →{" "}
          <strong className="text-foreground">explain</strong>
        </p>
      ) : (
        <div ref={ref} className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" />
      )}

      <figcaption className="mt-4 text-sm leading-6 text-muted-foreground">
        Eight nodes, in order. The model writes at{" "}
        <span className="font-mono text-foreground">plan</span> and{" "}
        <span className="font-mono text-foreground">explain</span> only — it picks which evidence to
        gather, and it writes prose after the fact. The decision is taken at{" "}
        <span className="font-mono text-foreground">gate</span>, which no model can reach.
      </figcaption>
    </figure>
  );
}
