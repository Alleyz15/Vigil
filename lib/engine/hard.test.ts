import { describe, expect, it } from "vitest";
import { h1CustodyContinuity, h2EpcInScope, h3MandateValid } from "./hard";
import { isPermittedTransition } from "./custody";
import { makeEvent, makeInput, makeMandate } from "./fixtures";

/**
 * H1-H3. These abort rather than score, so every test asserts on pass/fail,
 * never on points.
 */

describe("H1 - custody chain continuity", () => {
  it("fails when the previous state does not permit this step", () => {
    // Already handed to the recipient, now being loaded onto a vehicle again.
    const result = h1CustodyContinuity(
      makeInput({
        event: makeEvent({ bizStep: "urn:epcglobal:cbv:bizstep:loading" }),
        previous: {
          eventTime: "2026-09-08T09:45:00+08:00",
          disposition: "urn:epcglobal:cbv:disp:retail_sold",
        },
      }),
    );

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.id).toBe("H1");
    expect(result.flag.evidence).toContainEqual({
      field: "previous.disposition",
      value: "urn:epcglobal:cbv:disp:retail_sold",
    });
  });

  it("passes the near-miss: the same terminal state followed by a permitted step", () => {
    // retail_sold -> receiving IS allowed: a delivered parcel can be formally
    // taken back into the network as a return.
    const result = h1CustodyContinuity(
      makeInput({
        event: makeEvent({ bizStep: "urn:epcglobal:cbv:bizstep:receiving" }),
        previous: {
          eventTime: "2026-09-08T09:45:00+08:00",
          disposition: "urn:epcglobal:cbv:disp:retail_sold",
        },
      }),
    );

    expect(result.status).toBe("pass");
  });

  it("passes when there is no previous event, since a first scan contradicts nothing", () => {
    expect(h1CustodyContinuity(makeInput({ previous: undefined })).status).toBe("pass");
  });

  it("passes when the event carries no bizStep to check", () => {
    const input = makeInput({ event: makeEvent({ bizStep: undefined }) });
    expect(h1CustodyContinuity(input).status).toBe("pass");
  });

  it("passes when the previous event carries no disposition", () => {
    const input = makeInput({ previous: { eventTime: "2026-09-08T09:45:00+08:00" } });
    expect(h1CustodyContinuity(input).status).toBe("pass");
  });

  it("declines to judge a disposition it has no rule for, because H1 aborts handoffs", () => {
    expect(
      isPermittedTransition(
        "urn:epcglobal:cbv:disp:unknown",
        "urn:epcglobal:cbv:bizstep:delivering",
      ),
    ).toBe(true);
  });
});

describe("H2 - EPC in mandate scope", () => {
  it("fails when the parcel is not on the courier's route", () => {
    const result = h2EpcInScope(
      makeInput({ event: makeEvent({ epcList: ["urn:epc:id:sgtin:0699999.500000.1"] }) }),
    );

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.id).toBe("H2");
    expect(result.flag.label).toMatch(/not on the courier's assigned route/);
  });

  it("passes the near-miss: a different parcel under the same assigned prefix", () => {
    const result = h2EpcInScope(
      makeInput({ event: makeEvent({ epcList: ["urn:epc:id:sgtin:0614141.107346.9999"] }) }),
    );
    expect(result.status).toBe("pass");
  });

  it("fails a courier with no mandate at all - unscoped is not unlimited", () => {
    const result = h2EpcInScope(makeInput({ mandate: undefined }));

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.label).toMatch(/no active authorisation/);
  });

  it("reports a null courier id when neither courier nor mandate resolved", () => {
    const result = h2EpcInScope(makeInput({ mandate: undefined, courier: undefined }));

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.evidence).toContainEqual({ field: "courier.courierId", value: null });
  });

  it("fails when the scan happened at an unassigned location", () => {
    const result = h2EpcInScope(
      makeInput({
        event: makeEvent({ bizLocation: { id: "urn:epc:id:sgln:0614141.09999.0" } }),
        mandate: makeMandate({
          scope: {
            epcPrefixes: ["urn:epc:id:sgtin:0614141.107346."],
            bizLocations: ["urn:epc:id:sgln:0614141.00777.0"],
            bizSteps: [],
          },
        }),
      }),
    );

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.label).toMatch(/location the courier is not assigned to/);
  });

  it("fails when the courier is not authorised for this action", () => {
    const result = h2EpcInScope(
      makeInput({
        mandate: makeMandate({
          scope: {
            epcPrefixes: ["urn:epc:id:sgtin:0614141.107346."],
            bizLocations: [],
            bizSteps: ["urn:epcglobal:cbv:bizstep:transporting"],
          },
        }),
      }),
    );

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.label).toMatch(/not authorised to perform this action/);
  });

  it("treats an empty scope list as unrestricted on that dimension, not as deny-all", () => {
    const result = h2EpcInScope(
      makeInput({
        event: makeEvent({ bizLocation: { id: "urn:epc:id:sgln:0614141.09999.0" } }),
        mandate: makeMandate({
          scope: { epcPrefixes: [], bizLocations: [], bizSteps: [] },
        }),
      }),
    );
    expect(result.status).toBe("pass");
  });
});

describe("H3 - mandate active and in date", () => {
  it.each(["paused", "revoked"] as const)("fails a %s mandate", (status) => {
    const result = h3MandateValid(makeInput({ mandate: makeMandate({ status }) }));

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.id).toBe("H3");
    expect(result.flag.label).toContain(status);
  });

  it("fails a scan dated before the mandate begins", () => {
    const result = h3MandateValid(
      makeInput({ event: makeEvent({ eventTime: "2026-08-31T23:59:00+08:00" }) }),
    );
    expect(result.status).toBe("fail");
  });

  it("fails a scan dated after the mandate expires", () => {
    const result = h3MandateValid(
      makeInput({ event: makeEvent({ eventTime: "2027-01-01T00:00:01+08:00" }) }),
    );

    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.flag.label).toMatch(/already expired/);
  });

  it("passes the near-miss: one second inside the validity window", () => {
    const result = h3MandateValid(
      makeInput({ event: makeEvent({ eventTime: "2026-09-01T00:00:01+08:00" }) }),
    );
    expect(result.status).toBe("pass");
  });

  it("stays silent about a missing mandate, because H2 already reported it", () => {
    expect(h3MandateValid(makeInput({ mandate: undefined })).status).toBe("pass");
  });

  it("does not fail on an unparsable event time", () => {
    const input = makeInput();
    // Bypass the schema deliberately: H3 must not throw on malformed input.
    (input.event as { eventTime: string }).eventTime = "not-a-date";
    expect(h3MandateValid(input).status).toBe("pass");
  });
});
