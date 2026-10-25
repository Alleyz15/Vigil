import { expect, it } from "vitest";
import { buildWorld, buildScenario, makeRng } from "@/lib/generate";
import { SimulationRunJournal } from "./simulation-run";

const start = Date.parse("2026-09-07T06:30:00Z");
const world = buildWorld("journal-fixture");
const scenario = buildScenario("S0", { world, rng: makeRng("journal-fixture"), startMs: start });
function journal() { let serial = 0; return new SimulationRunJournal({ initialStartMs: start, createRunId: () => `run-${++serial}` }); }

it("rejects conflicting references within an incoming parcel batch atomically", () => {
  const runs = journal();
  runs.bootstrap("CR-1000", [], [], []);
  const parcel = scenario.parcels[0];
  expect(() => runs.registerParcels("CR-1000", [parcel, { ...parcel, recipientAddress: "Changed" }])).toThrow(/reference/i);
  expect(runs.snapshot("CR-1000")!.parcels).toEqual([]);
  runs.registerParcels("CR-1000", [parcel, parcel]);
  expect(runs.snapshot("CR-1000")!.parcels).toEqual([parcel]);
});

it("extends one courier history without replacing its past or leaking another courier", () => {
  const runs = journal();
  const first = runs.begin("CR-1000");
  expect(first.prior).toBeUndefined();
  runs.bootstrap("CR-1000", scenario.warmup, scenario.parcels, []);
  const before = runs.snapshot("CR-1000")!;
  runs.append("CR-1000", scenario.timeline[0], scenario.parcels);
  const after = runs.snapshot("CR-1000")!;
  expect(after.events.slice(0, before.events.length)).toEqual(before.events);
  expect(after.events).toHaveLength(before.events.length + 1);
  expect(runs.begin("CR-1000").runId).toBe(first.runId);
  expect(runs.begin("CR-1001").prior).toBeUndefined();
  expect(runs.begin("CR-1001").runId).not.toBe(first.runId);
});

it("returns independent snapshots, rejects event rebinding and appends a retry only once", () => {
  const runs = journal();
  runs.bootstrap("CR-1000", scenario.warmup, scenario.parcels, []);
  const before = runs.snapshot("CR-1000")!;
  const built = scenario.timeline[0];
  runs.append("CR-1000", built, scenario.parcels);
  runs.append("CR-1000", built, scenario.parcels);
  expect(runs.snapshot("CR-1000")!.events).toHaveLength(before.events.length + 1);
  before.events.length = 0;
  expect(runs.snapshot("CR-1000")!.events.length).toBeGreaterThan(0);
  expect(() => runs.append("CR-1000", { ...built, event: { ...built.event, eventTime: "2026-09-08T12:00:00Z" } }, scenario.parcels)).toThrow(/different|changed/i);
});

it("reserves chronological starts and serializes same-courier preparation", async () => {
  const runs = journal();
  const first = runs.begin("CR-1000");
  runs.reserve("CR-1000", scenario.timeline);
  const reservedStart = runs.begin("CR-1000").startMs;
  expect(reservedStart).toBeGreaterThan(Date.parse(scenario.timeline.at(-1)!.event.recordTime!));
  runs.reserve("CR-1000", scenario.timeline);
  expect(runs.begin("CR-1000").startMs).toBe(reservedStart);
  expect(runs.begin("CR-1001").startMs).toBe(first.startMs);
  const order: string[] = [];
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const a = runs.exclusive("CR-1000", async () => { order.push("a"); await paused; order.push("a-end"); });
  const b = runs.exclusive("CR-1000", async () => { order.push("b"); });
  await Promise.resolve();
  expect(order).toEqual(["a"]);
  release(); await Promise.all([a, b]);
  expect(order).toEqual(["a", "a-end", "b"]);
});
