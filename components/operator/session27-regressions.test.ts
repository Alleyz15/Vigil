import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("operator detail truthfulness regressions", () => {
  it("renders a ledger abort as evidence instead of an empty-looking result", () => {
    const detail = source("components/operator/handoff-detail.tsx");
    expect(detail).toContain("AbortEvidenceNotice");
    expect(detail).toContain("Event ID reused with a different payload");
  });

  it("never hardcodes one rule's subtitle onto every evidence card", () => {
    const detail = source("components/operator/handoff-detail.tsx");
    expect(
      detail,
      "I4, H2, P1 and I1 currently all claim that a stored address disagrees",
    ).not.toContain('detail="stored address disagrees"');
  });

  it("takes a status card's id and title from one selected flag", () => {
    const detail = source("components/operator/handoff-detail.tsx");
    expect(
      detail,
      "the card combines detail.flags[0].id with a separately selected summary.shortReason",
    ).not.toContain("title={detail.summary.shortReason}");
  });

  it("uses the successful action response instead of discarding it for router.refresh", () => {
    const actions = source("components/operator/operator-actions.tsx");
    expect(actions).toMatch(/await response\.json/);
    expect(actions).toMatch(/onDetailChange/);
    expect(
      actions,
      "router.refresh crosses a Next bundle boundary and cannot carry correctness",
    ).not.toContain("router.refresh()");
  });

  it("renders every gate-produced co-sign reason beside mandate inputs", () => {
    const detail = source("components/operator/handoff-detail.tsx");
    expect(detail).toContain("Why a co-signature is required");
    expect(detail).toContain("detail.gate.cosignReasons.map");
    expect(detail).toContain("detail.cosignPolicyEvidence.map");
  });

  it("does not assert that every resolved item has a sealed verdict", () => {
    const actions = source("components/operator/operator-actions.tsx");
    expect(
      actions,
      "a rejected pending handoff is resolved without ever sealing a verdict",
    ).not.toContain("Its sealed verdict remains unchanged.");
  });

  it("distinguishes a flag verdict from another verdict that needs review", () => {
    const badge = source("components/operator/status-badge.tsx");
    expect(badge).toContain("Needs review");
    expect(badge).toMatch(/decision/);

    for (const consumer of [
      "components/operator/handoff-detail.tsx",
      "components/operator/handoff-table.tsx",
      "components/operator/inbox-table.tsx",
      "components/operator/handoffs-workspace.tsx",
    ]) {
      expect(source(consumer), `${consumer} must pass the decision into the badge`).toMatch(
        /HandoffStateBadge[\s\S]{0,180}decision=/,
      );
    }
  });

  it("does not promote one scenario's rejected reroute into a dataset-wide provenance claim", () => {
    const alternatives = source("components/operator/rejected-alternatives.tsx");
    expect(
      alternatives,
      "S2 and a sealed S1 already exercise the proposal path",
    ).not.toContain("proposal path unexercised by the current dataset");
  });
});
