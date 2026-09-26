export function clampAnimationProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
}

export function initialViewport({
  routePointCount,
  evidencePointCount,
  revealOverlays,
}: {
  routePointCount: number;
  evidencePointCount: number;
  revealOverlays: boolean;
}): "evidence" | "route" | "active" {
  if (revealOverlays && evidencePointCount > 1) return "evidence";
  if (routePointCount > 1) return "route";
  return "active";
}
