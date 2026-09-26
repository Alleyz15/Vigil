// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GateExplorer } from "./gate-explorer";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams("single=60&pattern=60&scenario=S2"),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/demo/gate",
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.params,
}));
vi.mock("echarts-for-react", () => ({ default: () => createElement("div", { "data-testid": "chart" }) }));

afterEach(() => {
  cleanup();
  navigation.params = new URLSearchParams("single=60&pattern=60&scenario=S2");
  navigation.replace.mockReset();
});

it("loads shareable hypothetical thresholds from the URL and labels them", () => {
  const view = render(createElement(GateExplorer, {
    points: [],
    counts: { total: 0, bothEvaluated: 0, patternUnknown: 0, inconsistencyUnknown: 0 },
  }));
  const sliders = view.getAllByRole("slider") as HTMLInputElement[];
  expect(sliders.map((slider) => slider.value)).toEqual(["60", "60"]);
  expect(view.getByText(/Hypothetical view/).textContent).toMatch(/system uses 30.*40/i);
});

it("replaces the URL, preserves unrelated parameters, and removes real defaults", () => {
  const view = render(createElement(GateExplorer, {
    points: [],
    counts: { total: 0, bothEvaluated: 0, patternUnknown: 0, inconsistencyUnknown: 0 },
  }));
  const sliders = view.getAllByRole("slider") as HTMLInputElement[];
  fireEvent.change(sliders[0], { target: { value: "30" } });
  expect(navigation.replace).toHaveBeenCalledWith("/demo/gate?pattern=60&scenario=S2", { scroll: false });
});
