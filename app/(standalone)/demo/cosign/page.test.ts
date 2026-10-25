import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { closeDb } from "@/lib/db/client";
import { createMigratedDb } from "@/lib/db/migrate";
import { resolveRuntimeLlm } from "@/lib/llm/runtime";
import { createWorkbench, type OperatorWorkbench } from "@/lib/workbench/service";
import { buildCosignPageState, type CosignPageState } from "@/lib/demo/cosign-state";
import CosignPage from "./page";

const { getWorkbench } = vi.hoisted(() => ({ getWorkbench: vi.fn() }));
vi.mock("@/lib/workbench", () => ({ getWorkbench }));

let workbench: OperatorWorkbench;
const store = createMigratedDb(":memory:");
let handoffId: string;
let eventId: string;

beforeAll(async () => {
  workbench = await createWorkbench({ scenarioIds: ["S0", "S1"], courierDrafts: true,
    runtimeLlm: resolveRuntimeLlm({ VIGIL_LLM_PROVIDER: "none" }) });
  workbench.configureOnline({ store, boundary: {
    version: "cosign-page-test", source: "test fixture", licence: "n/a",
    area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[101.6, 3.1], [101.76, 3.1], [101.76, 3.2], [101.6, 3.2], [101.6, 3.1]],
    ] } },
  } });
  const created = await workbench.createOnlineShipment({
    origin: { latitude: 3.13, longitude: 101.67 },
    destination: { latitude: 3.165, longitude: 101.73 },
    declaredValueSen: 90_000, recipientChannel: "+60110000000",
  }, "cosign-page-non-default", { awaitAssignment: true });
  if (created.status !== "created") throw new Error(created.status);
  handoffId = `online:${created.shipmentId}`;
  await workbench.assignDispatch(handoffId, "CR-1002");
  eventId = workbench.courierWorkspace("CR-1002").items.find((item) => item.handoffId === handoffId)!.eventId;
  getWorkbench.mockResolvedValue(workbench);
}, 60_000);

afterAll(() => { workbench?.close(); closeDb(store); });

it.each(["handoff", "event"])("loads a non-default courier's unsubmitted handoff by %s ID with the same fleet choices as the API", async (requestedKind) => {
  expect(workbench.courierWorkspace().identity.subject).not.toBe("CR-1002");
  expect(workbench.courierWorkspace().items.some((item) => item.handoffId === handoffId)).toBe(false);
  const requested = requestedKind === "handoff" ? handoffId : eventId;
  const api = buildCosignPageState(workbench, requested)!;
  const page = await CosignPage({ searchParams: Promise.resolve({ handoff: requested }) }) as ReactElement<CosignPageState>;

  expect(page.props.selectedHandoffId).toBe(handoffId);
  expect(page.props.choices.map((choice) => choice.handoffId)).toEqual(api.choices.map((choice) => choice.handoffId));
  expect(page.props.model.shared.eventId).toBe(eventId);
  expect(page.props.model.courier.identity.subject).toBe("CR-1002");
  expect(page.props.model.phase).toBe("unsubmitted");
  expect(page.props.model.operator.canCosign).toBe(false);
});

it("keeps page and API co-signing eligible after the assigned courier returns evidence", async () => {
  await workbench.submitCourierHandoff(handoffId, { signed: true, courierId: "CR-1002" });
  const requested = await workbench.resolveHandoff(eventId, { action: "request_evidence", note: "Explain the handoff." });
  await workbench.submitEvidence(requested.supportingEvidence![0].requestId, {
    courierId: "CR-1002", submissionId: "cosign-page-evidence", explanation: "The recipient met me at the lobby.", files: [],
  });
  expect(workbench.getHandoff(eventId)?.canApprove).toBe(true);
  const page = await CosignPage({ searchParams: Promise.resolve({ handoff: handoffId }) }) as ReactElement<CosignPageState>;
  expect(page.props.model.operator.canCosign).toBe(true);
  expect(buildCosignPageState(workbench, handoffId)?.model.operator.canCosign).toBe(true);
});
