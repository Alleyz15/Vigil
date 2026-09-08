import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { events, verdicts } from "@/lib/db/schema";
import { runAgent } from "./machine";
import {
  KL_AMPANG_DOORSTEP,
  KL_HUB,
  SHAH_ALAM,
  type World,
  makeAgentEvent,
  resetEventIds,
  seedWorld,
  signalsOf,
} from "./fixtures";
import type { AgentContext } from "./context";
import type { NodeDeps } from "./nodes";
import type { GeoPoint } from "@/lib/epcis";

/**
 * A whole shipment, end to end, through the real machine.
 *
 * "From normal activity to a meaningful exception" is the brief's own phrase,
 * and this is where the system is asked to do it: a parcel is collected,
 * sorted, line-hauled, taken out for delivery and delivered — and every leg has
 * to come out the other side accepted, with the ledger intact.
 */

type Leg = {
  name: string;
  bizStep: string;
  disposition: string;
  eventTime: string;
  point: GeoPoint;
  battery: number;
  /** Only a delivery carries proof of delivery. */
  delivery?: boolean;
};

const LEGS: Leg[] = [
  {
    name: "collection",
    bizStep: "urn:epcglobal:cbv:bizstep:receiving",
    disposition: "urn:epcglobal:cbv:disp:active",
    eventTime: "2026-09-07T14:30:00+08:00",
    point: KL_HUB,
    battery: 94,
  },
  {
    name: "sortation inbound",
    bizStep: "urn:epcglobal:cbv:bizstep:storing",
    disposition: "urn:epcglobal:cbv:disp:in_progress",
    eventTime: "2026-09-07T19:10:00+08:00",
    point: KL_HUB,
    battery: 71,
  },
  {
    name: "line-haul departure",
    bizStep: "urn:epcglobal:cbv:bizstep:departing",
    disposition: "urn:epcglobal:cbv:disp:in_transit",
    eventTime: "2026-09-07T21:40:00+08:00",
    point: KL_HUB,
    battery: 58,
  },
  {
    name: "line-haul arrival",
    bizStep: "urn:epcglobal:cbv:bizstep:arriving",
    disposition: "urn:epcglobal:cbv:disp:in_possession",
    eventTime: "2026-09-08T06:15:00+08:00",
    point: SHAH_ALAM,
    battery: 30,
  },
  {
    name: "out for delivery",
    bizStep: "urn:epcglobal:cbv:bizstep:transporting",
    disposition: "urn:epcglobal:cbv:disp:in_possession",
    eventTime: "2026-09-08T09:45:00+08:00",
    point: SHAH_ALAM,
    battery: 88,
  },
  {
    name: "delivery",
    bizStep: "urn:epcglobal:cbv:bizstep:delivering",
    disposition: "urn:epcglobal:cbv:disp:retail_sold",
    eventTime: "2026-09-08T10:15:00+08:00",
    point: KL_AMPANG_DOORSTEP,
    battery: 84,
    delivery: true,
  },
];

/** Build one leg's event, keeping every signal consistent with the leg. */
function legEvent(leg: Leg) {
  const event = makeAgentEvent({
    eventTime: leg.eventTime,
    // Ordinary upload latency: well inside the I5 band.
    recordTime: new Date(Date.parse(leg.eventTime) + 42_000).toISOString(),
    bizStep: leg.bizStep,
    disposition: leg.disposition,
  });

  const signals = signalsOf(event);
  (signals.gps as { point: GeoPoint }).point = { ...leg.point, accuracyMeters: 11 };
  (signals.battery as { levelPercent: number }).levelPercent = leg.battery;

  // Cell and WiFi are only registered around the delivery address, so away from
  // it there is no independently-located source and I1 is not_evaluated. That
  // is the honest state of a real network, not a gap in the fixture.
  if (leg.point !== KL_AMPANG_DOORSTEP) {
    delete signals.cell;
    delete signals.wifi;
  }

  // A depot scan has no proof of delivery, and I12 is gated so it is not asked for.
  if (!leg.delivery) delete signals.pod;

  return event;
}

let world: World;
let deps: NodeDeps;

beforeEach(() => {
  resetEventIds();
  world = seedWorld();
  deps = world.deps;
});
afterEach(() => rmSync(world.dir, { recursive: true, force: true }));

function runShipment(d: NodeDeps = deps): AgentContext[] {
  return LEGS.map((leg) => runAgent(legEvent(leg), d));
}

describe("a normal shipment, end to end", () => {
  it("accepts every leg", () => {
    const runs = runShipment();

    for (const [i, ctx] of runs.entries()) {
      expect(ctx.halted, `${LEGS[i].name} halted: ${ctx.halted?.reason}`).toBeUndefined();
      expect(ctx.decision, `${LEGS[i].name} was not accepted`).toBe("accept");
    }
  });

  it("scores zero on axis 1 at every leg", () => {
    const runs = runShipment();
    expect(runs.map((c) => c.verdict?.inconsistencyScore)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("raises no hard failure at any leg, so the custody chain holds", () => {
    const runs = runShipment();
    for (const [i, ctx] of runs.entries()) {
      expect(ctx.engineResult?.aborted, `${LEGS[i].name} aborted`).toBe(false);
      expect(ctx.verdict?.abortCode).toBeUndefined();
    }
  });

  it("leaves the ledger chain valid, one entry per leg", () => {
    runShipment();

    expect(deps.ledger.verifyChain()).toEqual({ valid: true, entries: LEGS.length });
    expect(deps.ledger.readRecords().every((r) => r.kind === "verdict")).toBe(true);
  });

  it("projects every leg into the console tables", () => {
    runShipment();

    expect(deps.db.select().from(events).all()).toHaveLength(LEGS.length);
    expect(deps.db.select().from(verdicts).all()).toHaveLength(LEGS.length);
  });

  it("seals a verdict whose ledger sequence matches its projection", () => {
    const runs = runShipment();

    for (const ctx of runs) {
      const seq = ctx.ledger?.status === "recorded" ? ctx.ledger.seq : -1;
      const row = deps.db
        .select()
        .from(verdicts)
        .where(eq(verdicts.eventId, ctx.event!.eventID))
        .get();

      expect(row?.ledgerSeq).toBe(seq);
      expect(row?.decision).toBe(ctx.decision);
      // Two separate columns, carried through unsummed.
      expect(row?.inconsistencyScore).toBe(ctx.verdict?.inconsistencyScore);
      expect(row?.patternScore).toBe(ctx.verdict?.patternScore);
      expect(row?.basis).toBe(ctx.verdict?.basis);
    }
  });

  /**
   * Each leg builds the history the next one reads. By the delivery, the parcel
   * has a five-event timeline behind it — which is what makes H1 and I3 mean
   * anything at all.
   */
  it("accumulates the timeline, so later legs are judged against earlier ones", () => {
    const runs = runShipment();

    const first = runs[0];
    const last = runs.at(-1)!;

    expect(first.resolution.missing.map((m) => m.reason).join(" ")).toMatch(
      /first in its timeline/,
    );
    // By the last leg there IS a previous event, and it was used.
    expect(last.resolution.resolved.some((r) => r.startsWith("previous event"))).toBe(true);
  });

  it("still reports cold start: six handoffs is not a pattern", () => {
    const runs = runShipment();
    const last = runs.at(-1)!;

    expect(last.patternColdStart).toBe(true);
    expect(last.verdict?.basis).toBe("single_event_only");
    // Unjudged, not innocent: the operator's signature is required instead.
    expect(last.requiresCosign).toBe(true);
  });
});

describe("from normal activity to a meaningful exception", () => {
  it("accepts five clean legs, then flags a spoofed delivery", () => {
    // The first five legs are ordinary work.
    const normal = LEGS.slice(0, 5).map((leg) => runAgent(legEvent(leg), deps));
    expect(normal.map((c) => c.decision)).toEqual(Array(5).fill("accept"));

    // The delivery scan claims a location from a fake location app.
    const exception = legEvent(LEGS[5]);
    const signals = signalsOf(exception);
    (signals.gps as { mockLocationProvider: boolean }).mockLocationProvider = true;

    const ctx = runAgent(exception, deps);

    expect(ctx.decision).toBe("flag");
    expect(ctx.verdict?.flags).toContain("I7");
    // Axis 1 is high; the courier's pattern is not, so the EVENT is questioned
    // and the COURIER is not accused. That is the matrix's first row.
    expect(ctx.gateResult?.matrixCell).toBe("high-single/cold-start");
    expect(deps.ledger.verifyChain()).toEqual({ valid: true, entries: 6 });
  });

  it("refuses a delivery scanned 23 km from the recipient", () => {
    LEGS.slice(0, 5).forEach((leg) => runAgent(legEvent(leg), deps));

    const wrongPlace = legEvent({ ...LEGS[5], point: SHAH_ALAM });
    const ctx = runAgent(wrongPlace, deps);

    expect(ctx.verdict?.flags).toContain("I10");
    expect(ctx.decision).not.toBe("accept");
  });
});

/**
 * THE PARITY CLAIM, over a whole shipment rather than one event.
 *
 * Same fixture, same expected verdicts, LLM on or off. This is the regression
 * that protects "remove the LLM and the verdicts are identical" once a real
 * model lands at `plan` and `explain`. See CLAUDE.md.
 */
describe("the whole shipment is unchanged by the LLM", () => {
  const fakeA = {
    planTools: () => ({ tools: ["check_traffic_weather"], rationale: "A" }),
    explain: () => "A: nothing to see here.",
  };
  const fakeB = {
    planTools: () => ({ tools: ["fetch_route_history"], rationale: "B" }),
    explain: () => "B: I have a bad feeling about this one.",
  };

  const shipmentVerdicts = (llm?: NodeDeps["llm"]) => {
    resetEventIds();
    const w = seedWorld();
    const sealed = runShipment({ ...w.deps, llm }).map((c) => c.verdict);
    rmSync(w.dir, { recursive: true, force: true });
    return JSON.stringify(sealed);
  };

  it("seals byte-identical verdicts with no LLM, with fake A and with fake B", () => {
    const none = shipmentVerdicts(undefined);
    expect(shipmentVerdicts(fakeA)).toBe(none);
    expect(shipmentVerdicts(fakeB)).toBe(none);
  });

  it("produces an identical ledger chain either way", () => {
    const chainOf = (llm?: NodeDeps["llm"]) => {
      resetEventIds();
      const w = seedWorld();
      runShipment({ ...w.deps, llm });
      const records = w.deps.ledger.readRecords().map((r) => r.payloadHash);
      rmSync(w.dir, { recursive: true, force: true });
      return records;
    };

    expect(chainOf(fakeA)).toEqual(chainOf(undefined));
  });
});
