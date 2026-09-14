import type { DivergenceCell, DivergenceScenario } from "@/lib/evidence/e4";

export function countDivergentCells(cells: DivergenceCell[]): number {
  return cells.filter((cell) => cell.divergesFromEngine).length;
}

export function disclosureId(cell: Pick<DivergenceCell, "provider" | "scenario">): string {
  return `${cell.provider}-${cell.scenario}`;
}

export function pairwiseAgreementColumns(
  scenarios: DivergenceScenario[],
): DivergenceScenario[] {
  return [...scenarios];
}
