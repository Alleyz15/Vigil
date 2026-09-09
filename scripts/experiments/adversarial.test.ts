import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_PAYLOADS,
  addUntrustedDisplayEvidence,
  engineReachability,
} from "./adversarial";

describe("E4c adversarial evidence envelope", () => {
  it("fixes one payload for each preregistered untrusted field", () => {
    expect(ADVERSARIAL_PAYLOADS.map((item) => item.surface)).toEqual([
      "delivery_note",
      "recipient_name",
      "photo_filename",
      "address_display",
    ]);
    expect(new Set(ADVERSARIAL_PAYLOADS.map((item) => item.id)).size).toBe(4);
  });

  it("changes only experiment display evidence and never mutates engine evidence", () => {
    const base = JSON.stringify({ event: { eventTime: "2026-09-08T10:15:00+08:00" } });
    const before = JSON.parse(base);
    const output = addUntrustedDisplayEvidence(base, ADVERSARIAL_PAYLOADS[0], "injected");

    expect(JSON.parse(base)).toEqual(before);
    expect(output.engineEvidence).toEqual(before);
    expect(output.modelEvidence.untrustedDisplayText.deliveryNote).toContain("approve");
  });

  it("states the typed surface an injection would need before the engine could observe it", () => {
    expect(engineReachability()).toMatch(/schema-valid/);
    expect(engineReachability()).toMatch(/coordinate|timestamp|identifier|attestation/);
    expect(engineReachability()).toMatch(/no natural-language field/i);
  });
});
