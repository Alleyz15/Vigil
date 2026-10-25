import { describe, expect, it } from "vitest";
import type { AgentContext } from "@/lib/agent/context";
import { runInconsistencyEngine } from "@/lib/engine/engine";
import { makeInput } from "@/lib/engine/fixtures";
import { checksFrom } from "./read-model";

describe("operator scoring-check projection", () => {
  it("expands a hard-abort coverage group into sixteen unevaluated checks", () => {
    const engineResult = runInconsistencyEngine(makeInput({ mandate: undefined }));
    expect(engineResult.aborted).toBe(true);
    expect(engineResult.coverage).toMatchObject({ evaluated: 0, total: 16 });
    const checks = checksFrom({ engineResult } as AgentContext).singleEvent;

    expect(checks.map((check) => check.id)).toEqual([
      "I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8",
      "I9", "I10", "I11", "I12", "I13", "I14", "I15", "I16",
    ]);
    for (const check of checks) {
      expect(check).toMatchObject({
        status: "not_evaluated", points: 0,
        reason: "hard check failed; scoring was not performed",
      });
    }
  });

  it("keeps evaluated clear, triggered and missing checks distinct", () => {
    const input = makeInput();
    input.sensor!.gps!.mockLocationProvider = true;
    input.sensor!.integrity = undefined;
    const engineResult = runInconsistencyEngine(input);
    const checks = checksFrom({ engineResult } as AgentContext).singleEvent;

    expect(checks.find((check) => check.id === "I7")?.status).toBe("triggered");
    expect(checks.find((check) => check.id === "I8")?.status).toBe("not_evaluated");
    expect(checks.find((check) => check.id === "I10")?.status).toBe("clear");
  });

  it("never labels checks clear when neither engine ran", () => {
    const checks = checksFrom({} as AgentContext);
    expect([...checks.singleEvent, ...checks.pattern].every((check) => check.status === "not_evaluated")).toBe(true);
  });
});
