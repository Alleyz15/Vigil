import { vigilSignalsOf } from "@/lib/epcis";
import { buildScenario, buildWorld, makeRng } from "@/lib/generate";
import { openMeteoProvider } from "@/lib/weather";

const SEED = "vigil-2026";
const START_MS = Date.parse("2026-09-07T14:30:00+08:00");

async function main() {
  const world = buildWorld(SEED);
  const scenario = buildScenario("S6", { world, rng: makeRng(SEED), startMs: START_MS });
  const delivery = scenario.timeline.at(-1)?.event;
  if (!delivery) throw new Error("S6 has no delivery leg");

  const gps = vigilSignalsOf(delivery)?.gps?.point;
  if (!gps) throw new Error("S6 delivery has no GPS point for the weather query");

  const result = await openMeteoProvider().lookup({
    latitude: gps.latitude,
    longitude: gps.longitude,
    hour: delivery.eventTime,
  });
  process.stdout.write(`${JSON.stringify({ eventID: delivery.eventID, eventTime: delivery.eventTime, result }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

