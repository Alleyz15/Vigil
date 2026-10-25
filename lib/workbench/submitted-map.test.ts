import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedDb } from "@/lib/db/migrate";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { EpcisEvent, vigilSignalsOf } from "@/lib/epcis";
import { createWorkbench, type OperatorWorkbench } from "./service";

let wb: OperatorWorkbench;
const reference = { latitude: 3.165, longitude: 101.73 };
beforeAll(async () => {
  wb = await createWorkbench({ scenarioIds: ["S0"], runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
  wb.configureOnline({ store: createMigratedDb(":memory:"), boundary: {
    version: "map-test", source: "fixture", licence: "n/a",
    area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
    ] } },
  } });
}, 120_000);
afterAll(() => wb?.close());

async function shipment(key: string) {
  const created = await wb.createOnlineShipment({ origin: { latitude: 3.13, longitude: 101.67 },
    destination: { ...reference, addressClaim: "Original destination" }, declaredValueSen: 90_000,
    recipientChannel: "+60110000000" }, key, { awaitAssignment: true });
  if (created.status !== "created") throw new Error(created.status);
  const handoffId = `online:${created.shipmentId}`;
  await wb.assignDispatch(handoffId, "CR-1002");
  return { handoffId, shipmentId: created.shipmentId };
}

it("plots the submitted GPS separately from the reference and connects only emitted distance findings", async () => {
  const { handoffId } = await shipment("off-reference");
  const scan = { latitude: 3.12, longitude: 101.62 };
  const submitted = await wb.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1002", simulatedScan: scan });
  const detail = wb.getHandoff(submitted.item.eventId)!;
  expect(detail.flags.some((flag) => flag.id === "I10")).toBe(true);
  expect(detail.map.locations.find((location) => location.kind === "delivery")?.point).toEqual(reference);
  expect(detail.map.overlays.find((overlay) => overlay.id === "delivery-reported-scan")?.point).toMatchObject(scan);
  expect(detail.map.overlays.find((overlay) => overlay.id === "delivery-reference-I10")?.points).toEqual([expect.objectContaining(scan), reference]);
  const event = EpcisEvent.parse(detail.event);
  expect(detail.map.route.find((leg) => leg.eventId === event.eventID)?.point).toEqual(vigilSignalsOf(event)?.gps?.point);
});

it("keeps the original reference after an address correction and reports the corrected scan", async () => {
  const { handoffId, shipmentId } = await shipment("corrected-reference");
  const corrected = { latitude: 3.12, longitude: 101.62, addressClaim: "Corrected destination" };
  expect(wb.correctOnlineShipment(shipmentId, corrected).ok).toBe(true);
  const submitted = await wb.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1002" });
  const detail = wb.getHandoff(submitted.item.eventId)!;
  expect(detail.map.locations.find((location) => location.kind === "delivery")).toMatchObject({ point: reference, label: "Original destination" });
  expect(detail.map.overlays.find((overlay) => overlay.id === "delivery-reported-scan")?.point).toMatchObject({ latitude: corrected.latitude, longitude: corrected.longitude });
});

it("does not invent distance connectors for a matching clean scan", async () => {
  const { handoffId } = await shipment("matching-reference");
  const submitted = await wb.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1002", simulatedScan: reference });
  const detail = wb.getHandoff(submitted.item.eventId)!;
  expect(detail.map.overlays.filter((overlay) => overlay.kind === "line")).toEqual([]);
  expect(detail.map.overlays.find((overlay) => overlay.id === "delivery-reported-scan")).toBeUndefined();
});
