// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CosignModel } from "@/lib/demo/cosign";
import { CosignActions } from "./cosign-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("does not describe a courier-only sealed credential as co-signed", () => {
  const model = {
    phase: "sealed",
    credential: {
      valid: true,
      courierValid: true,
      operatorValid: false,
      cosignRequired: false,
      problems: [],
    },
  } as unknown as CosignModel;

  const view = render(createElement(CosignActions, { model, side: "operator", onModelChange: vi.fn() }));

  expect(view.getByText(/No operator co-signature was required/)).toBeTruthy();
  expect(view.queryByText(/^Co-signed\./)).toBeNull();
});

it("uses the authoritative co-sign state returned by the mutation instead of refreshing", async () => {
  const nextModel = { phase: "sealed" } as CosignModel;
  const onModelChange = vi.fn();
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ cosignState: { model: nextModel } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  const model = {
    phase: "awaiting_cosignature",
    shared: { eventId: "event-1" },
    operator: { canCosign: true },
  } as CosignModel;

  const view = render(createElement(CosignActions, { model, side: "operator", onModelChange }));
  fireEvent.click(view.getByRole("button", { name: /approve and co-sign/i }));

  await waitFor(() => expect(onModelChange).toHaveBeenCalledWith(nextModel));
});
