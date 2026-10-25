import type { BuiltEvent, GeneratedParcel } from "@/lib/generate";
import { canonicalHash } from "@/lib/ledger";

export type SimulationHistorySnapshot = {
  runId: string;
  events: BuiltEvent[];
  parcels: GeneratedParcel[];
  disputedEventIds: string[];
};
type CourierRun = {
  runId: string;
  cursorMs: number;
  initialized: boolean;
  events: Map<string, BuiltEvent>;
  parcels: Map<string, GeneratedParcel>;
  disputed: Set<string>;
  reservations: Set<string>;
};

/** Continuous simulated facts; every evaluation receives its own immutable copy. */
export class SimulationRunJournal {
  private readonly runs = new Map<string, CourierRun>();
  private readonly preparing = new Map<string, Promise<void>>();
  constructor(private readonly options: { initialStartMs: number; createRunId: () => string }) {}

  private run(courierId: string): CourierRun {
    let run = this.runs.get(courierId);
    if (!run) {
      run = { runId: this.options.createRunId(), cursorMs: this.options.initialStartMs,
        initialized: false, events: new Map(), parcels: new Map(), disputed: new Set(), reservations: new Set() };
      this.runs.set(courierId, run);
    }
    return run;
  }

  begin(courierId: string) {
    const run = this.run(courierId);
    return { runId: run.runId, startMs: run.cursorMs, prior: this.snapshot(courierId) };
  }

  snapshot(courierId: string): SimulationHistorySnapshot | undefined {
    const run = this.runs.get(courierId);
    if (!run?.initialized) return undefined;
    return structuredClone({ runId: run.runId,
      events: [...run.events.values()].sort((a, b) => Date.parse(a.event.eventTime) - Date.parse(b.event.eventTime)),
      parcels: [...run.parcels.values()], disputedEventIds: [...run.disputed] });
  }

  bootstrap(courierId: string, events: BuiltEvent[], parcels: GeneratedParcel[], disputes: string[]): void {
    const run = this.run(courierId);
    if (run.initialized) return;
    for (const built of events) this.append(courierId, built, parcels, disputes.includes(built.event.eventID));
    run.initialized = true;
  }

  append(courierId: string, built: BuiltEvent, parcels: GeneratedParcel[], disputed = false): void {
    const run = this.run(courierId);
    const previous = run.events.get(built.event.eventID);
    if (previous && canonicalHash(previous) !== canonicalHash(built)) throw new Error("A simulation event ID cannot be rebound to changed facts.");
    this.registerParcels(courierId, parcels);
    if (!previous) run.events.set(built.event.eventID, structuredClone(built));
    if (disputed) run.disputed.add(built.event.eventID);
  }

  registerParcels(courierId: string, parcels: GeneratedParcel[]): void {
    const run = this.run(courierId);
    const staged = new Map<string, GeneratedParcel>();
    for (const parcel of parcels) {
      const existing = staged.get(parcel.epc) ?? run.parcels.get(parcel.epc);
      if (existing && canonicalHash(existing) !== canonicalHash(parcel)) throw new Error("A simulated parcel reference cannot be changed in its history.");
      staged.set(parcel.epc, parcel);
    }
    for (const parcel of staged.values()) run.parcels.set(parcel.epc, structuredClone(parcel));
  }

  markDisputed(courierId: string, eventId: string): void {
    const run = this.runs.get(courierId);
    if (run?.events.has(eventId)) run.disputed.add(eventId);
  }

  reserve(courierId: string, timeline: BuiltEvent[]): void {
    const run = this.run(courierId);
    const reservation = timeline.at(-1)?.event.eventID;
    if (!reservation || run.reservations.has(reservation)) return;
    run.reservations.add(reservation);
    // Schedule facts, not a detector-derived risk boundary. Five minutes is an
    // ASSUMPTION for the gap between independent demo shipment preparations.
    run.cursorMs = Math.max(run.cursorMs, ...timeline.map((built) => Math.max(
      Date.parse(built.event.eventTime), Date.parse(built.event.recordTime ?? built.event.eventTime),
    ))) + 5 * 60_000;
  }

  async exclusive<T>(courierId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.preparing.get(courierId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.preparing.set(courierId, current);
    try { if (previous) await previous; return await action(); }
    finally { release(); if (this.preparing.get(courierId) === current) this.preparing.delete(courierId); }
  }
}
