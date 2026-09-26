import { ProvenanceLabel } from "./provenance-label";

function anchorDate(anchorIso: string): string {
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date(anchorIso));
}

/** Provenance for timestamps from the fixed demo world, never the browser clock. */
export function SimulatedClockLabel({ anchorIso }: { anchorIso?: string }) {
  if (!anchorIso) return null;
  return (
    <ProvenanceLabel>
      Simulated clock · anchored {anchorDate(anchorIso)} · keeps rolling history coherent
    </ProvenanceLabel>
  );
}
