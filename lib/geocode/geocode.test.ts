import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { verifyResolution } from "./attach";
import { failureMessage, looksLikePhoneNumber, normaliseQuery } from "./messages";
import { createNominatimGeocoder, NOMINATIM_ORIGIN, NOMINATIM_USER_AGENT, searchUrl, type FetchLike } from "./nominatim";
import { createSerialQueue, QueueSaturated } from "./queue";
import { geocoder, MIN_REQUEST_INTERVAL_MS } from "./runtime";
import type { FailureReason } from "./types";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vigil-geocode-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => vi.unstubAllGlobals());
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A queue that never waits, for tests about the adapter rather than the spacing. */
const instantQueue = () => createSerialQueue({ minIntervalMs: 0, maxPending: 100 });

const PLACE = {
  osm_type: "way",
  osm_id: 123456,
  lat: "3.1579124567",
  lon: "101.7116123456",
  display_name: "Jalan Ampang, Kuala Lumpur, Malaysia",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("the one queue", () => {
  /**
   * SERIAL AND SPACED, MEASURED. Five callers arrive at once, each task takes a
   * different time; the fake clock records when each STARTS and how many are
   * in flight. No two overlap, and no two starts are closer than the interval.
   */
  it("runs one task at a time, starts at least the interval apart, under concurrent callers", async () => {
    let clock = 0;
    const queue = createSerialQueue({
      minIntervalMs: 1_000,
      maxPending: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const starts: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const task = (duration: number) => async () => {
      starts.push(clock);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      clock += duration;
      inFlight -= 1;
      return duration;
    };

    const results = await Promise.all([300, 2_500, 0, 900, 50].map((d) => queue.run(task(d))));
    expect(results).toEqual([300, 2_500, 0, 900, 50]);
    expect(maxInFlight).toBe(1);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1_000);
  });

  it("keeps going after a task fails: the next caller waits for it to END, not to succeed", async () => {
    const queue = instantQueue();
    await expect(queue.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run(async () => "after")).resolves.toBe("after");
  });

  it("refuses at once, without running, when the backlog is full", async () => {
    const queue = createSerialQueue({ minIntervalMs: 0, maxPending: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ran: string[] = [];
    const first = queue.run(async () => {
      ran.push("first");
      await gate;
    });
    const second = queue.run(async () => ran.push("second"));
    await expect(queue.run(async () => ran.push("third"))).rejects.toBeInstanceOf(QueueSaturated);
    release();
    await Promise.all([first, second]);
    expect(ran).toEqual(["first", "second"]);
  });

  /**
   * THE REAL RUNTIME, REAL CLOCK. Search and reverse through the application's
   * own geocoder at the same instant: they must share ONE queue, so their
   * requests start at least a second apart and never overlap. (5xx answers, so
   * nothing is cached and each lookup also spends its one retry — four requests.)
   */
  it("holds search and reverse to one request a second across the whole application", async () => {
    expect(MIN_REQUEST_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    const starts: number[] = [];
    let inFlight = 0;
    let overlapped = false;
    vi.stubGlobal("fetch", async () => {
      starts.push(performance.now());
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return new Response("busy", { status: 503 });
    });
    const [searched, reversed] = await Promise.all([
      geocoder().search({ q: `vigil queue probe ${Date.now()}` }),
      geocoder().reverse({ latitude: 1.000001, longitude: 100.000001 }),
    ]);
    expect(searched).toMatchObject({ status: "failed", reason: "unreachable" });
    expect(reversed).toMatchObject({ status: "failed", reason: "unreachable" });
    expect(starts).toHaveLength(4);
    expect(overlapped).toBe(false);
    for (let i = 1; i < starts.length; i += 1) {
      // 1 ms of slack for timer granularity; the interval itself carries 100 ms of margin.
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS - 1);
    }
  }, 15_000);
});

describe("what actually leaves the machine", () => {
  let server: Server;
  let origin: string;
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ url: request.url ?? "", headers: request.headers });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url?.startsWith("/reverse") ? PLACE : [PLACE]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /**
   * THE USER-AGENT IS READ OFF A REQUEST THAT CROSSED A SOCKET, not off the
   * source. Phase one's tile recorder looked configured and sent Node's default
   * agent; the only proof an agent is sent is a server that received it. The
   * real `fetch` sends; only the host is swapped, after asserting the adapter
   * asked for the fixed upstream.
   */
  it("sends the project's identifying agent, only the typed text, and nothing else identifying", async () => {
    const asked: string[] = [];
    const viaLocal: FetchLike = (url, init) => {
      asked.push(url);
      return globalThis.fetch(url.replace(NOMINATIM_ORIGIN, origin), init);
    };
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch: viaLocal });
    await geo.search({ q: "  Jalan   AMPANG " });
    await geo.reverse({ latitude: 3.157912, longitude: 101.711612 });

    expect(asked.every((url) => url.startsWith(`${NOMINATIM_ORIGIN}/`))).toBe(true);
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.headers["user-agent"]).toBe("Vigil/0.1 (+https://github.com/Alleyz15/Vigil)");
      expect(request.headers["user-agent"]).toBe(NOMINATIM_USER_AGENT);
      expect(request.headers["user-agent"]).not.toMatch(/@/);
      expect(request.headers.from).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
    const search = new URL(seen[0].url, origin);
    expect([...search.searchParams.keys()].sort()).toEqual(["accept-language", "countrycodes", "format", "limit", "q"]);
    expect(search.searchParams.get("q")).toBe("jalan ampang");
    const reverse = new URL(seen[1].url, origin);
    expect([...reverse.searchParams.keys()].sort()).toEqual(["accept-language", "format", "lat", "lon", "zoom"]);
  });
});

describe("the cache comes before the queue", () => {
  it("answers a repeat from disk with no request, whatever the case and spacing", async () => {
    const fetch = vi.fn<FetchLike>(async () => json([PLACE]));
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch });
    expect(await geo.search({ q: "Jalan Ampang" })).toMatchObject({ status: "found", source: "network" });
    expect(await geo.search({ q: "  jalan   ampang  " })).toMatchObject({ status: "found", source: "cache" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  /**
   * BY CONSTRUCTION, NOT BY BRANCH ORDER. A queue that throws on every use
   * cannot answer anything — so a hit that still comes back proves the queue
   * was never touched.
   */
  it("never touches the queue on a hit", async () => {
    const cacheDir = tempDir();
    await createNominatimGeocoder({ cacheDir, queue: instantQueue(), fetch: async () => json([PLACE]) }).search({
      q: "jalan ampang",
    });
    const brokenQueue = { run: () => Promise.reject(new Error("queue touched")), pending: () => 0 };
    const geo = createNominatimGeocoder({ cacheDir, queue: brokenQueue, fetch: async () => json([PLACE]) });
    expect(await geo.search({ q: "Jalan Ampang" })).toMatchObject({ status: "found", source: "cache" });
  });

  it("reads the committed demo set first, labels it, and never writes into it", async () => {
    const demo = tempDir();
    await createNominatimGeocoder({ cacheDir: demo, queue: instantQueue(), fetch: async () => json([PLACE]) }).search({
      q: "jalan ampang",
    });
    const before = readdirSync(demo);
    const runtime = tempDir();
    const fetch = vi.fn<FetchLike>(async () => json([PLACE]));
    const geo = createNominatimGeocoder({ cacheDir: runtime, demoCacheDir: demo, queue: instantQueue(), fetch });
    expect(await geo.search({ q: "Jalan Ampang" })).toMatchObject({ status: "found", source: "demo_cache" });
    await geo.search({ q: "somewhere else entirely" });
    expect(readdirSync(demo)).toEqual(before);
    expect(readdirSync(runtime)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing at all in cache-only mode", async () => {
    const fetch = vi.fn<FetchLike>();
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch, network: "cache-only" });
    expect(await geo.search({ q: "jalan ampang" })).toMatchObject({ status: "failed" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("six failures, six answers, and nothing invented", () => {
  const cases: Array<[FailureReason, FetchLike, number]> = [
    ["unreachable", async () => Promise.reject(new TypeError("fetch failed")), 2],
    ["timeout", (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))), 1],
    ["rate_limited", async () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }), 1],
    ["refused", async () => new Response("blocked", { status: 403 }), 1],
    ["no_results", async () => json([]), 1],
    ["malformed", async () => json({ unexpected: true }), 1],
  ];

  for (const [reason, fetch, attempts] of cases) {
    it(`reports ${reason} as itself, with no candidates, after ${attempts} request(s)`, async () => {
      const spy = vi.fn(fetch);
      const cacheDir = tempDir();
      const geo = createNominatimGeocoder({ cacheDir, queue: instantQueue(), fetch: spy, timeoutMs: 30 });
      const result = await geo.search({ q: "jalan ampang" });
      expect(result).toMatchObject({ status: "failed", reason });
      expect(result).not.toHaveProperty("candidates");
      expect(spy).toHaveBeenCalledTimes(attempts);
      // Only an ANSWER is cached. A failure written to disk would replay as the
      // truth long after the network came back.
      expect(readdirSync(cacheDir)).toHaveLength(reason === "no_results" ? 1 : 0);
    });
  }

  it("gives each reason its own sentence, and none of them offers a substitute", () => {
    const reasons: FailureReason[] = ["unreachable", "timeout", "rate_limited", "refused", "no_results", "malformed"];
    const said = reasons.map((reason) => failureMessage(reason, "search"));
    expect(new Set(said).size).toBe(6);
    expect(failureMessage("no_results", "reverse")).toMatch(/^Address not resolved/);
    expect(failureMessage("no_results", "reverse")).toMatch(/coordinate is unchanged/);
  });

  it("refuses a whole list that contains one unreadable place, rather than trimming it", async () => {
    const geo = createNominatimGeocoder({
      cacheDir: tempDir(),
      queue: instantQueue(),
      fetch: async () => json([PLACE, { ...PLACE, osm_id: 7, lat: "not a number" }]),
    });
    expect(await geo.search({ q: "jalan ampang" })).toMatchObject({ status: "failed", reason: "malformed" });
  });

  it("stops asking during Nominatim's pause after a 429, sending nothing", async () => {
    let clock = 1_000_000;
    const fetch = vi.fn<FetchLike>(async () => new Response("", { status: 429, headers: { "retry-after": "10" } }));
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch, now: () => clock });
    await geo.search({ q: "first query" });
    clock += 9_000;
    expect(await geo.search({ q: "second query" })).toMatchObject({ status: "failed", reason: "rate_limited" });
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += 2_000;
    await geo.search({ q: "third query" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("answers rate_limited, without a request, when the application's own queue is full", async () => {
    const fetch = vi.fn<FetchLike>();
    const full = { run: () => Promise.reject(new QueueSaturated(4)), pending: () => 4 };
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: full, fetch });
    expect(await geo.search({ q: "jalan ampang" })).toMatchObject({ status: "failed", reason: "rate_limited" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("candidates", () => {
  it("round each coordinate once, to the picker's six decimals", async () => {
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch: async () => json([PLACE]) });
    const result = await geo.search({ q: "jalan ampang" });
    expect(result).toMatchObject({ status: "found" });
    if (result.status !== "found") return;
    expect(result.candidates[0]).toEqual({
      ref: "way/123456",
      label: "Jalan Ampang, Kuala Lumpur, Malaysia",
      latitude: 3.157912,
      longitude: 101.711612,
    });
  });

  it("strips control characters from a label and caps its length", async () => {
    const noisy = { ...PLACE, display_name: `Jalan  Ampang\n‮ ${"x".repeat(400)}` };
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch: async () => json([noisy]) });
    const result = await geo.search({ q: "jalan ampang" });
    if (result.status !== "found") throw new Error("expected found");
    expect(result.candidates[0].label.startsWith("Jalan Ampang")).toBe(true);
    expect(result.candidates[0].label).not.toMatch(/[ -]/);
    expect(result.candidates[0].label.length).toBeLessThanOrEqual(300);
  });
});

describe("reverse lookup never moves the point", () => {
  /**
   * BIT-IDENTICAL, NOT CLOSE. The clicked coordinate goes in and comes back
   * under `at` as the same numbers; the found object's own position (here a
   * deliberately different one) appears nowhere in the result.
   */
  it("hands back the clicked coordinate exactly, and not the found object's", async () => {
    const clicked = { latitude: 3.139013, longitude: 101.686855 };
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch: async () => json(PLACE) });
    const result = await geo.reverse(clicked);
    if (result.status !== "found") throw new Error("expected found");
    expect(Object.is(result.at.latitude, clicked.latitude)).toBe(true);
    expect(Object.is(result.at.longitude, clicked.longitude)).toBe(true);
    expect(result.found).toEqual({ ref: "way/123456", label: PLACE.display_name });
    expect(JSON.stringify(result)).not.toContain("3.157912");
    expect(JSON.stringify(result)).not.toContain("101.711612");
  });

  it("caches 'no address here' as an answer, and says Address not resolved", async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ error: "Unable to geocode" }));
    const geo = createNominatimGeocoder({ cacheDir: tempDir(), queue: instantQueue(), fetch });
    const point = { latitude: 2.9, longitude: 101.6 };
    expect(await geo.reverse(point)).toMatchObject({ status: "failed", reason: "no_results", source: "network" });
    expect(await geo.reverse(point)).toMatchObject({ status: "failed", reason: "no_results", source: "cache" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("a label reaches the store only if the geocoder produced it", () => {
  async function seeded() {
    const cacheDir = tempDir();
    const network = createNominatimGeocoder({
      cacheDir,
      queue: instantQueue(),
      fetch: async (url) => json(url.includes("/reverse") ? PLACE : [PLACE]),
    });
    await network.search({ q: "Jalan Ampang" });
    await network.reverse({ latitude: 3.139013, longitude: 101.686855 });
    return createNominatimGeocoder({ cacheDir, queue: instantQueue(), network: "cache-only", fetch: vi.fn() });
  }

  it("verifies a search pick at the candidate's exact coordinate", async () => {
    const cached = await seeded();
    const point = { latitude: 3.157912, longitude: 101.711612 };
    expect(await verifyResolution(point, { kind: "search", query: "jalan ampang", ref: "way/123456" }, cached)).toEqual({
      ok: true,
      resolved: { label: PLACE.display_name, by: "search", ref: "way/123456" },
    });
  });

  /** A label describes where it was found. Attached to a moved point, it describes somewhere else. */
  it("refuses a search label on a coordinate that is not the candidate's", async () => {
    const cached = await seeded();
    const moved = { latitude: 3.157913, longitude: 101.711612 };
    const result = await verifyResolution(moved, { kind: "search", query: "jalan ampang", ref: "way/123456" }, cached);
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a ref the search did not return, and a search nobody made", async () => {
    const cached = await seeded();
    const point = { latitude: 3.157912, longitude: 101.711612 };
    expect(await verifyResolution(point, { kind: "search", query: "jalan ampang", ref: "way/1" }, cached)).toMatchObject({ ok: false });
    expect(await verifyResolution(point, { kind: "search", query: "never searched", ref: "way/123456" }, cached)).toMatchObject({ ok: false });
  });

  /**
   * THE ROUTE'S SHAPE, NOT A TIDY ONE. The create route hands over the whole
   * confirmed point — claim and resolution included. The first version passed
   * that straight into the strict reverse query and threw; a test that only
   * ever handed over `{latitude, longitude}` could not see it. Found by creating
   * a shipment in the browser.
   */
  it("accepts the confirmed point exactly as the route passes it", async () => {
    const cached = await seeded();
    const asRouted = {
      latitude: 3.139013,
      longitude: 101.686855,
      addressClaim: "Gate B",
      resolution: { kind: "reverse" as const },
    };
    expect(await verifyResolution(asRouted, asRouted.resolution, cached)).toMatchObject({ ok: true });
    const searched = {
      latitude: 3.157912,
      longitude: 101.711612,
      addressClaim: "Loading bay",
      resolution: { kind: "search" as const, query: "jalan ampang", ref: "way/123456" },
    };
    expect(await verifyResolution(searched, searched.resolution, cached)).toMatchObject({ ok: true });
  });

  it("verifies a reverse label only at the point it was looked up", async () => {
    const cached = await seeded();
    expect(await verifyResolution({ latitude: 3.139013, longitude: 101.686855 }, { kind: "reverse" }, cached)).toMatchObject({
      ok: true,
      resolved: { by: "reverse", ref: "way/123456" },
    });
    expect(await verifyResolution({ latitude: 3.139014, longitude: 101.686855 }, { kind: "reverse" }, cached)).toMatchObject({ ok: false });
  });
});

describe("the data boundary", () => {
  it("recognises a query that is only a phone number", () => {
    expect(looksLikePhoneNumber("+60 11-999 0007")).toBe(true);
    expect(looksLikePhoneNumber("0123456789")).toBe(true);
    expect(looksLikePhoneNumber("12 Jalan Ampang 50450")).toBe(false);
    expect(looksLikePhoneNumber("50450")).toBe(false);
  });

  it("sends the normal form it caches under", () => {
    expect(new URL(searchUrl("  Jalan\tAMPANG ")).searchParams.get("q")).toBe(normaliseQuery("jalan ampang"));
  });

  it("keeps the runtime cache out of the demo directory", async () => {
    const { GEOCODE_DEMO_CACHE_DIR, GEOCODE_RUNTIME_CACHE_DIR } = await import("./runtime");
    expect(GEOCODE_DEMO_CACHE_DIR).not.toBe(GEOCODE_RUNTIME_CACHE_DIR);
    expect(GEOCODE_DEMO_CACHE_DIR.startsWith(GEOCODE_RUNTIME_CACHE_DIR)).toBe(false);
    expect(GEOCODE_RUNTIME_CACHE_DIR.startsWith(GEOCODE_DEMO_CACHE_DIR)).toBe(false);
  });
});
