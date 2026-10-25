// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { OnlineShipmentPanel } from "./online-shipment-panel";
import { SenderShipments } from "./sender-shipments";
import type { SenderShipmentView } from "@/lib/workbench/service";
import type { ServiceAreaView } from "./online-shipment-model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./service-area-map", () => ({ ServiceAreaMap: ({ onPick }: { onPick: (lat: number, lng: number) => void }) => createElement("div", null,
  createElement("button", { onClick: () => onPick(3.15, 101.7) }, "Pick origin"),
  createElement("button", { onClick: () => onPick(3.16, 101.71) }, "Pick destination"),
) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const policy = { cosignOverSen: 40000, codCapSen: 20000, maxValueSen: 100000, courier: "Assigned courier" };
const area: ServiceAreaView = {
  version: "test", source: "test", licence: "test", placeholder: false,
  members: ["Kuala Lumpur"], sentence: "Service area: Kuala Lumpur", outsideMessage: "Outside service area",
  label: "Kuala Lumpur", credit: "test", extracted: null, showExtracted: false,
  area: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.6, 3.1], [101.8, 3.1], [101.8, 3.2], [101.6, 3.2], [101.6, 3.1]]] } },
};
const queued: SenderShipmentView = {
  kind: "online", shipmentId: "online-pending", runId: "pending-online", waybillNo: "WB-ONLINE-PENDING",
  originLabel: "Pickup label", recordedAddress: "Actual geocoder destination", declaredValueSen: 18000,
  delivered: false, deliveryEventId: null, assignmentState: "awaiting_assignment", assignedCourier: null,
  recordedPoint: { latitude: 3.16, longitude: 101.71 },
};

it.each(["created", "replayed"])("shows a %s pending receipt and adopts its items before the reference GET finishes", async (status) => {
  let resolveReference!: (value: unknown) => void;
  const fetcher = vi.fn((url: string, options?: RequestInit) => {
    if (url === "/api/sender/online-shipments/online-pending") return new Promise((done) => { resolveReference = done; });
    const body = url.endsWith("service-area") ? area
      : url.endsWith("/reverse") ? { status: "found", label: "Actual geocoder destination", ref: "node/1" }
      : options?.method === "POST" ? { status, shipmentId: queued.shipmentId, running: false, awaitingAssignment: true, eventIds: [], boundary: { label: area.label }, items: [queued] }
      : { items: [] };
    return Promise.resolve({ ok: true, json: async () => body });
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement("div", null,
    createElement(OnlineShipmentPanel, { policy }),
    createElement(SenderShipments, { shipments: [], addresses: [] }),
  ));
  fireEvent.click(await view.findByRole("button", { name: "Pick origin" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm as collection point" }));
  fireEvent.click(view.getByRole("button", { name: "Pick destination" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm as delivery point" }));
  fireEvent.click(view.getByRole("button", { name: "Create shipment at these points" }));

  await view.findByText("WB-ONLINE-PENDING");
  expect(view.getByRole("status").textContent).toMatch(/awaiting operator assignment/i);
  expect(view.queryByText(/legs ran|out-for-delivery|run is not restartable/i)).toBeNull();
  expect(view.queryByRole("button", { name: "Courier delivers" })).toBeNull();
  expect(view.getByText("Actual geocoder destination", { selector: "dd" })).toBeTruthy();
  if (status === "replayed") expect(view.getByRole("status").textContent).toMatch(/already on file/i);
  await waitFor(() => expect(resolveReference).toBeTypeOf("function"));
  resolveReference({ ok: true, json: async () => ({ history: { originalReference: { latitude: 3.160123, longitude: 101.710456 } } }) });
  await view.findByText("3.160123, 101.710456");
  const request = fetcher.mock.calls.find(([url, options]) => url === "/api/sender/online-shipments" && options?.method === "POST");
  expect(JSON.parse(request![1]!.body as string).destination).toMatchObject({ latitude: 3.16, longitude: 101.71 });
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/sender/shipments")).toHaveLength(1);
});

type Creation = { key: string; body: string };

function creationServer(firstAnswer: "lost" | "unreadable" | "created" = "created") {
  const requests: Creation[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("service-area")) return { ok: true, json: async () => area };
    if (url.endsWith("/reverse")) return { ok: true, json: async () => ({ status: "not_found" }) };
    if (url === "/api/sender/online-shipments" && options?.method === "POST") {
      requests.push({ key: (options.headers as Record<string, string>)["idempotency-key"], body: options.body as string });
      if (requests.length === 1 && firstAnswer === "lost") throw new TypeError("Response lost after creation");
      if (requests.length === 1 && firstAnswer === "unreadable") return { ok: true, json: async () => { throw new SyntaxError("Truncated response"); } };
      return { ok: true, json: async () => ({
        status: requests.length > 1 && requests[0].key === requests.at(-1)!.key ? "replayed" : "created",
        shipmentId: "online-pending", awaitingAssignment: true, running: false, eventIds: [], items: [],
      }) };
    }
    return { ok: true, json: async () => ({ history: { originalReference: { latitude: 3.16, longitude: 101.71 } } }) };
  }));
  return requests;
}

async function confirmPoints(view: ReturnType<typeof render>) {
  fireEvent.click(await view.findByRole("button", { name: "Pick origin" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm as collection point" }));
  fireEvent.click(view.getByRole("button", { name: "Pick destination" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm as delivery point" }));
}

function createShipment(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole("button", { name: "Create shipment at these points" }));
}

function randomMode(view: ReturnType<typeof render>, seed = "demo_Seed-42") {
  fireEvent.click(view.getByRole("button", { name: "Randomized scenario" }));
  fireEvent.change(view.getByRole("textbox", { name: "Simulation seed" }), { target: { value: seed } });
}

it("defaults to the isolated Normal baseline, omits simulation, and keeps advanced controls collapsed", async () => {
  const requests = creationServer();
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  expect(view.getByRole("button", { name: "Normal scan" }).getAttribute("aria-pressed")).toBe("true");
  expect(view.getByRole("button", { name: "Randomized scenario" }).getAttribute("aria-pressed")).toBe("false");
  expect(view.getByText("Advanced demo controls").closest("details")!.open).toBe(false);
  expect(view.queryByRole("textbox", { name: "Simulation seed" })).toBeNull();
  expect(view.getByText(/normal.*isolated baseline/i)).toBeTruthy();
  expect(view.getByText(/normal.*does not guarantee.*seal/i)).toBeTruthy();
  await confirmPoints(view);
  createShipment(view);
  await view.findByText("Shipment created");
  expect(JSON.parse(requests[0].body)).toMatchObject({ demoCondition: "normal", declaredValueSen: 18000 });
  expect(JSON.parse(requests[0].body)).not.toHaveProperty("simulation");
});

it("keeps advanced mock location independent of the selected mode", async () => {
  const requests = creationServer();
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  const advanced = view.getByText("Advanced demo controls").closest("details")!;
  fireEvent.click(view.getByText("Advanced demo controls"));
  advanced.open = true;
  fireEvent.click(view.getByRole("checkbox", { name: "Mock location app" }));
  randomMode(view);
  await confirmPoints(view);
  createShipment(view);
  await view.findByText("Shipment created");
  expect(JSON.parse(requests[0].body)).toMatchObject({
    demoCondition: "mock_location", simulation: { mode: "randomized", seed: "demo_Seed-42", version: "signals-v1" },
  });
  fireEvent.click(view.getByRole("button", { name: "Normal scan" }));
  expect((view.getByRole("checkbox", { name: "Mock location app" }) as HTMLInputElement).checked).toBe(true);
  createShipment(view);
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(JSON.parse(requests[1].body).demoCondition).toBe("mock_location");
  expect(JSON.parse(requests[1].body)).not.toHaveProperty("simulation");
});

it("chooses a seed only on first random selection or explicit regeneration, and copies the visible seed", async () => {
  creationServer();
  const random = vi.spyOn(globalThis.crypto, "randomUUID")
    .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
    .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText } } }));
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  expect(random).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Randomized scenario" }));
  let seed = view.getByRole("textbox", { name: "Simulation seed" }) as HTMLInputElement;
  expect(seed.value).toBe("11111111-1111-4111-8111-111111111111");
  view.rerender(createElement(OnlineShipmentPanel, { policy: { ...policy, courier: "Another courier" } }));
  fireEvent.click(view.getByRole("button", { name: "Randomized scenario" }));
  fireEvent.click(view.getByRole("button", { name: "Normal scan" }));
  fireEvent.click(view.getByRole("button", { name: "Randomized scenario" }));
  seed = view.getByRole("textbox", { name: "Simulation seed" }) as HTMLInputElement;
  expect(random).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole("button", { name: "Generate new seed" }));
  expect(seed.value).toBe("22222222-2222-4222-8222-222222222222");
  expect(random).toHaveBeenCalledTimes(2);
  fireEvent.click(view.getByRole("button", { name: "Copy seed" }));
  await view.findByText("Seed copied.");
  expect(writeText).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  fireEvent.change(seed, { target: { value: "edited-seed" } });
  expect(view.queryByText("Seed copied.")).toBeNull();
});

it("reports a clipboard failure and leaves the seed available for manual copying", async () => {
  creationServer();
  vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } } }));
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  randomMode(view);
  fireEvent.click(view.getByRole("button", { name: "Copy seed" }));
  await view.findByText(/could not copy.*select.*seed.*copy/i);
  expect((view.getByRole("textbox", { name: "Simulation seed" }) as HTMLInputElement).value).toBe("demo_Seed-42");
});

it("does not sample a seed in Strict Mode render or replace an invalid edited seed when switching modes", () => {
  creationServer();
  const random = vi.spyOn(globalThis.crypto, "randomUUID");
  const view = render(createElement(StrictMode, null, createElement(OnlineShipmentPanel, { policy })));
  expect(random).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Randomized scenario" }));
  expect(random).toHaveBeenCalledTimes(1);
  fireEvent.change(view.getByRole("textbox", { name: "Simulation seed" }), { target: { value: "" } });
  fireEvent.click(view.getByRole("button", { name: "Normal scan" }));
  fireEvent.click(view.getByRole("button", { name: "Randomized scenario" }));
  expect(random).toHaveBeenCalledTimes(1);
  expect((view.getByRole("textbox", { name: "Simulation seed" }) as HTMLInputElement).value).toBe("");
});

it("does not announce a stale clipboard result after the seed is edited", async () => {
  creationServer();
  let finishCopy!: () => void;
  vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText: () => new Promise<void>((resolve) => { finishCopy = resolve; }) } } }));
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  randomMode(view);
  fireEvent.click(view.getByRole("button", { name: "Copy seed" }));
  fireEvent.change(view.getByRole("textbox", { name: "Simulation seed" }), { target: { value: "changed-before-copy-finished" } });
  await act(async () => finishCopy());
  expect(view.queryByText("Seed copied.")).toBeNull();
});

it.each(["", "has space", "has.dot", "a".repeat(81)])("refuses an invalid random seed (%s) before making a creation request", async (seed) => {
  const requests = creationServer();
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  await confirmPoints(view);
  randomMode(view, seed);
  expect(view.getByRole("textbox", { name: "Simulation seed" }).getAttribute("aria-invalid")).toBe("true");
  expect((view.getByRole("button", { name: "Create shipment at these points" }) as HTMLButtonElement).disabled).toBe(true);
  createShipment(view);
  expect(requests).toHaveLength(0);
  // Returning to the baseline does not require a seed.
  fireEvent.click(view.getByRole("button", { name: "Normal scan" }));
  createShipment(view);
  await view.findByText("Shipment created");
  expect(JSON.parse(requests[0].body)).not.toHaveProperty("simulation");
});

it.each(["A", "A_-" + "9".repeat(77)])("sends a valid seed unchanged with the pinned profile version (%s)", async (seed) => {
  const requests = creationServer();
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  await confirmPoints(view);
  randomMode(view, seed);
  createShipment(view);
  await view.findByText("Shipment created");
  expect(JSON.parse(requests[0].body).simulation).toEqual({ mode: "randomized", seed, version: "signals-v1" });
  expect(view.getByText(/accept.*flag.*insufficient evidence/i)).toBeTruthy();
  expect(view.getByText(/same.*inputs.*version.*courier context/i)).toBeTruthy();
  expect(view.getByText(/continuous.*simulated.*history/i)).toBeTruthy();
});

it.each(["lost", "unreadable"] as const)("retries the exact pending body/key after a %s response without resampling", async (failure) => {
  const requests = creationServer(failure);
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  await confirmPoints(view);
  randomMode(view);
  createShipment(view);
  await view.findByRole("alert");
  expect(view.getByRole("alert").textContent).toMatch(/retry/i);
  expect(view.getByRole("alert").textContent).not.toMatch(/reload/i);
  view.rerender(createElement(OnlineShipmentPanel, { policy }));
  // A disclosure and an unconfirmed draft point do not change creation inputs.
  fireEvent.click(view.getByText("Advanced demo controls"));
  fireEvent.click(view.getByRole("button", { name: "Pick origin" }));
  createShipment(view);
  await view.findByText(/already on file/i);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(JSON.parse(requests[1].body).simulation.seed).toBe("demo_Seed-42");
  // An acknowledged success ends this request; a deliberate new creation gets a new key.
  createShipment(view);
  await view.findByText("Shipment created");
  expect(requests[2].key).not.toBe(requests[0].key);
});

it.each(["name", "value", "channel", "mode", "seed", "mock", "regenerate", "confirmed point"])("starts a new request when the user edits %s after a lost response", async (field) => {
  const requests = creationServer("lost");
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  await confirmPoints(view);
  randomMode(view);
  createShipment(view);
  await view.findByRole("alert");
  if (field === "name") fireEvent.change(view.getByRole("textbox", { name: "Recipient name for the confirmed-point shipment" }), { target: { value: "New recipient" } });
  if (field === "value") fireEvent.change(view.getByRole("textbox", { name: "Declared value for the confirmed-point shipment" }), { target: { value: "200" } });
  if (field === "channel") fireEvent.change(view.getByRole("textbox", { name: "Recipient's registered number for the confirmed-point shipment" }), { target: { value: "+60123456789" } });
  if (field === "mode") fireEvent.click(view.getByRole("button", { name: "Normal scan" }));
  if (field === "seed") fireEvent.change(view.getByRole("textbox", { name: "Simulation seed" }), { target: { value: "new_seed" } });
  if (field === "mock") {
    view.getByText("Advanced demo controls").closest("details")!.open = true;
    fireEvent.click(view.getByRole("checkbox", { name: "Mock location app" }));
  }
  if (field === "regenerate") fireEvent.click(view.getByRole("button", { name: "Generate new seed" }));
  if (field === "confirmed point") {
    fireEvent.click(view.getByRole("button", { name: "Pick destination" }));
    fireEvent.change(view.getByRole("textbox", { name: "Address claim for the confirmed point" }), { target: { value: "An updated destination claim" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm as delivery point" }));
  }
  createShipment(view);
  await view.findByText("Shipment created");
  expect(requests).toHaveLength(2);
  expect(requests[1].key).not.toBe(requests[0].key);
  expect(requests[1].body).not.toBe(requests[0].body);
});

it("invalidates a pending request when an input is edited then restored", async () => {
  const requests = creationServer("lost");
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  await confirmPoints(view);
  createShipment(view);
  await view.findByRole("alert");
  const name = view.getByRole("textbox", { name: "Recipient name for the confirmed-point shipment" });
  fireEvent.change(name, { target: { value: "changed" } });
  fireEvent.change(name, { target: { value: "" } });
  createShipment(view);
  await view.findByText("Shipment created");
  expect(requests[1].body).toBe(requests[0].body);
  expect(requests[1].key).not.toBe(requests[0].key);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it.each([
  ["fetch", "created"], ["body", "created"],
  ["fetch", "replayed"], ["body", "replayed"],
] as const)("publishes a stale %s/%s creation to the list without attaching its receipt to the edited seed", async (stage, status) => {
  const pendingFetch = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
  const pendingBody = deferred<unknown>();
  const requests: Creation[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("service-area")) return { ok: true, json: async () => area };
    if (url.endsWith("/reverse")) return { ok: true, json: async () => ({ status: "not_found" }) };
    if (url === "/api/sender/online-shipments" && options?.method === "POST") {
      requests.push({ key: (options.headers as Record<string, string>)["idempotency-key"], body: options.body as string });
      if (requests.length === 1) return stage === "fetch" ? pendingFetch.promise : { ok: true, json: () => pendingBody.promise };
      return { ok: true, json: async () => ({ status: "created", shipmentId: "shipment-B", awaitingAssignment: true, items: [queued] }) };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(createElement("div", null,
    createElement(OnlineShipmentPanel, { policy }),
    createElement(SenderShipments, { shipments: [], addresses: [] }),
  ));
  await confirmPoints(view);
  randomMode(view, "seed-A");
  createShipment(view);
  if (stage === "body") await act(async () => {});
  fireEvent.change(view.getByRole("textbox", { name: "Simulation seed" }), { target: { value: "seed-B" } });
  expect((view.getByRole("button", { name: "Creating…" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Creating…" }));
  expect(requests).toHaveLength(1);

  const body = { status, shipmentId: queued.shipmentId, awaitingAssignment: true, running: false, eventIds: [], items: [queued] };
  await act(async () => {
    if (stage === "fetch") pendingFetch.resolve({ ok: true, json: async () => body });
    else pendingBody.resolve(body);
  });
  expect(view.getByText("WB-ONLINE-PENDING")).toBeTruthy();
  expect(view.queryByText("Shipment created")).toBeNull();
  expect(view.queryByText(/already on file/i)).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  expect((view.getByRole("textbox", { name: "Simulation seed" }) as HTMLInputElement).value).toBe("seed-B");
  createShipment(view);
  await view.findByText("shipment-B");
  expect(requests).toHaveLength(2);
  expect(requests[1].key).not.toBe(requests[0].key);
  expect(JSON.parse(requests[0].body).simulation.seed).toBe("seed-A");
  expect(JSON.parse(requests[1].body).simulation.seed).toBe("seed-B");
});

it.each(["refused", "unreadable", "network"] as const)("suppresses a stale %s outcome after the seed is edited in flight", async (answer) => {
  const pendingFetch = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
  const pendingBody = deferred<unknown>();
  const requests: Creation[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("service-area")) return { ok: true, json: async () => area };
    if (url.endsWith("/reverse")) return { ok: true, json: async () => ({ status: "not_found" }) };
    if (url === "/api/sender/online-shipments" && options?.method === "POST") {
      requests.push({ key: (options.headers as Record<string, string>)["idempotency-key"], body: options.body as string });
      if (requests.length === 1) return answer === "network" ? pendingFetch.promise : { ok: answer === "unreadable", json: () => pendingBody.promise };
      if (requests.length === 2) throw new TypeError("B response lost after creation");
      return { ok: true, json: async () => ({ status: "replayed", shipmentId: "shipment-B", awaitingAssignment: true, items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  const view = render(createElement(OnlineShipmentPanel, { policy }));
  await confirmPoints(view);
  randomMode(view, "seed-A");
  createShipment(view);
  if (answer !== "network") await act(async () => {});
  fireEvent.change(view.getByRole("textbox", { name: "Simulation seed" }), { target: { value: "seed-B" } });
  await act(async () => {
    if (answer === "network") pendingFetch.reject(new TypeError("A response lost"));
    else if (answer === "unreadable") pendingBody.reject(new SyntaxError("Truncated A response"));
    else pendingBody.resolve({ status: "rejected", reason: "A was refused", field: "destination" });
  });
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText("Shipment created")).toBeNull();
  expect((view.getByRole("textbox", { name: "Simulation seed" }) as HTMLInputElement).value).toBe("seed-B");
  createShipment(view);
  await view.findByRole("alert");
  createShipment(view);
  await view.findByText("shipment-B");
  expect(requests).toHaveLength(3);
  expect(requests[1].key).not.toBe(requests[0].key);
  expect(JSON.parse(requests[1].body).simulation.seed).toBe("seed-B");
  expect(requests[2]).toEqual(requests[1]);
});
