import { describe, expect, it } from "vitest";
import { GET as getInbox } from "./inbox/route";
import { GET as getHandoffs } from "./handoffs/route";
import { GET as getHandoff } from "./handoffs/[eventId]/route";
import { POST as postAction } from "./handoffs/[eventId]/actions/route";

describe("operator workbench routes", () => {
  it("serves the priority inbox and all-handoff summary", async () => {
    const inbox = await getInbox();
    const all = await getHandoffs();
    const inboxBody = await inbox.json();
    const allBody = await all.json();

    expect(inbox.status).toBe(200);
    expect(inboxBody.items.length).toBeGreaterThan(0);
    expect(all.status).toBe(200);
    expect(allBody.summary).toMatchObject({
      automaticallyAccepted: expect.any(Number),
      total: expect.any(Number),
      timeframe: expect.any(String),
    });
  }, 30_000);

  it("returns one correlated handoff and a 404 for an unknown id", async () => {
    const inbox = await (await getInbox()).json();
    const eventId = inbox.items[0].eventId;
    const found = await getHandoff(new Request(`http://localhost/${eventId}`), {
      params: Promise.resolve({ eventId }),
    });
    const missing = await getHandoff(new Request("http://localhost/missing"), {
      params: Promise.resolve({ eventId: "missing" }),
    });

    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      summary: { eventId },
      runs: expect.any(Array),
      ledger: { chainValid: true },
    });
    expect(missing.status).toBe(404);
  }, 30_000);

  it("rejects malformed and invalid operator actions", async () => {
    const inbox = await (await getInbox()).json();
    const eventId = inbox.items.find((item: { state: string }) => item.state === "flagged").eventId;
    const malformed = await postAction(
      new Request(`http://localhost/${eventId}`, { method: "POST", body: "{" }),
      { params: Promise.resolve({ eventId }) },
    );
    const invented = await postAction(
      new Request(`http://localhost/${eventId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "change_verdict" }),
      }),
      { params: Promise.resolve({ eventId }) },
    );

    expect(malformed.status).toBe(400);
    expect(invented.status).toBe(400);
  }, 30_000);
});
