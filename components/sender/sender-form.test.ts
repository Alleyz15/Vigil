// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SenderForm, type SenderAddress } from "./sender-form";
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const addresses: SenderAddress[] = [
  { index: 0, label: "Pickup", latitude: 3.16, longitude: 101.73 },
  { index: 20, label: "Destination", latitude: 3.09, longitude: 101.54 },
  { index: 16, label: "Correction", latitude: 3.07, longitude: 101.58 },
];
const policy = { cosignOverSen: 40000, codCapSen: 20000, maxValueSen: 100000, courier: "Assigned courier" };
describe("Sender registered declaration", () => {
  it("limits the statement to the amount condition and reads thresholds from policy", () => {
    const view = render(createElement(SenderForm, { addresses, policy: { ...policy, cosignOverSen: 35000 } }));
    expect(view.getByText(/the amount condition does not require co-signing/).textContent).toContain("RM 350.00");
    expect(view.getByText(/Other risk or evidence conditions/)).toBeTruthy();
    fireEvent.change(view.getByLabelText("Declared value"), { target: { value: "350.01" } });
    expect(view.getByText(/amount condition requires/)).toBeTruthy();
  });
  it("does not invent a zero threshold when no amount condition exists", () => {
    const view = render(createElement(SenderForm, { addresses, policy: { ...policy, cosignOverSen: null } }));
    expect(view.getByText(/No amount-based co-sign condition/)).toBeTruthy();
  });
  it("explains why batch scanning cannot create a single shipment", () => {
    const view = render(createElement(SenderForm, { addresses, policy }));
    fireEvent.click(view.getByRole("button", { name: "Batch scanning" }));
    expect(view.getByText(/property of a set, not of one parcel/)).toBeTruthy();
    expect((view.getByRole("button", { name: "Create and dispatch" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("uses registered map selection and sends only the unchanged API declaration", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetcher);
    const view = render(createElement(SenderForm, { addresses, policy }));
    fireEvent.click(view.getByRole("button", { name: "Choose Correction" }));
    fireEvent.click(view.getByRole("button", { name: "Create and dispatch" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ originIndex: 0, destinationIndex: 16, declaredValueSen: 12000, recipientChannel: "+60119990001", fault: "none" });
  });
});
