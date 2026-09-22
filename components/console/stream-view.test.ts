// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StreamView } from "./stream-view";

const instances: FakeEventSource[] = [];

class FakeEventSource {
  listeners = new Map<string, (event: Event) => void>();
  close = vi.fn();
  constructor(readonly url: string) { instances.push(this); }
  addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener as (event: Event) => void); }
  emit(name: string, data: unknown) { this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) })); }
}

afterEach(() => { cleanup(); instances.length = 0; vi.unstubAllGlobals(); });

it("renders a terminal stream failure and creates only one EventSource per Run click", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const view = render(createElement(StreamView, { scenarioId: "B-missing", legCount: 6, defaultLeg: 5 }));
  fireEvent.click(view.getByRole("button", { name: "Run" }));
  expect(instances).toHaveLength(1);

  instances[0].emit("failure", { message: "That shipment cannot be replayed." });
  await waitFor(() => expect(view.getByRole("alert").textContent).toMatch(/cannot be replayed/i));
  expect(instances).toHaveLength(1);
  expect(instances[0].close).toHaveBeenCalledOnce();
});
it("names the exact model carried by a completed model node", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const view = render(createElement(StreamView, { scenarioId: "B-O-one", legCount: 6, defaultLeg: 5 }));
  fireEvent.click(view.getByRole("button", { name: "Run" }));
  instances[0].emit("tool_end", {
    node: "plan",
    durationMs: 12,
    summary: {
      detail: {
        model: {
          selection: "gemini",
          modelId: "gemini-3.5-flash-lite",
          mode: "active",
          reason: "Gemini is enabled for interactive runs.",
        },
      },
    },
  });

  await waitFor(() => expect(view.getByText("Model gemini-3.5-flash-lite ran at this node.")).toBeTruthy());
});
