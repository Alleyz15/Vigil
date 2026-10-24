// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ConfirmView } from "./confirm-view";

afterEach(cleanup);
it("renders a stored expiry without a success indicator or recipient actions", () => {
  const view = render(createElement(ConfirmView, {
    token: "expired-token",
    waybillNo: "WB-TEST",
    initial: { status: "answered", answer: "no_response", row: { tokenId: "expired-token", eventId: "event", epc: "epc", issuedAt: "2026-09-08T00:00:00Z", expiresAt: "2026-09-09T00:00:00Z", answeredAt: "2026-09-10T00:00:00Z", answer: "no_response" } },
  }));
  expect(view.getByRole("heading", { name: "The confirmation window has closed" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Yes, I received it" })).toBeNull();
  expect(view.container.querySelector("svg")?.classList.contains("text-muted-foreground")).toBe(true);
});
