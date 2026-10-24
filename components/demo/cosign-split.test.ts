import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CosignChoice } from "@/lib/demo/cosign";
import { HandoffRail } from "./cosign-split";

it("keeps the point-to-point category visible when this process has no active online handoff", () => {
  const seeded = {
    handoffId: "seeded:DRAFT-S0-5",
    eventId: "event-s0",
    source: "seeded",
    scenarioId: "S0",
    waybillNo: "WB-2026-000000",
    title: "Delivery scan",
    eventTime: "2026-09-08T10:15:00+08:00",
    state: "prepared",
    queueItem: null,
    draft: null,
  } as CosignChoice;

  const html = renderToStaticMarkup(
    createElement(HandoffRail, {
      choices: [seeded],
      selectedHandoffId: seeded.handoffId,
    }),
  );

  expect(html).toContain("Point-to-point dispatch");
  expect(html).toContain("No active point-to-point handoff in this server process");
  expect(html).toContain('href="/sender"');
  expect(html).toContain("Seeded scenarios");
});
