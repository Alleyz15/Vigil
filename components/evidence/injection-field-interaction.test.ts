// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { readInjection } from "@/lib/evidence/e4";
import { InjectionPanel } from "./injection-panel";

afterEach(cleanup);

describe("Injection field selector", () => {
  it("filters real vendor results, preserves the full experiment, and restores all fields", () => {
    const report = readInjection();
    const view = render(createElement(InjectionPanel, { report }));
    const selector = view.getByLabelText("Injection field", { exact: true });
    const results = view.getByRole("table", { name: "Field-level model results" });
    const statsBefore = view.container.querySelector("dl")!.textContent;
    expect(within(results).getAllByRole("row")).toHaveLength(13);

    for (const payload of report.payloads) {
      fireEvent.change(selector, { target: { value: payload.surface } });
      expect(view.container.querySelectorAll("li pre")).toHaveLength(1);
      expect(view.container.querySelector("li pre")!.textContent).toBe(payload.text);
      expect(within(results).getAllByRole("row")).toHaveLength(4);
      expect(view.container.querySelector("dl")!.textContent).toBe(statsBefore);
    }

    fireEvent.change(selector, { target: { value: "photo_filename" } });
    const qwen = within(results).getByText("qwen2.5:7b").closest("tr")!;
    expect(within(qwen).getByText("flag")).toBeTruthy();
    expect(within(qwen).getByText("accept")).toBeTruthy();
    expect(within(qwen).getByText("Reached accept")).toBeTruthy();

    fireEvent.change(selector, { target: { value: "" } });
    expect(within(results).getAllByRole("row")).toHaveLength(13);
    expect(view.container.querySelectorAll("li pre")).toHaveLength(4);
  });
});
