import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADDRESSES } from "@/lib/generate/world";
import { DEPOTS } from "@/lib/generate/route";
import { boundaryLabel, checkPoint } from "./boundary";
import {
  loadServiceBoundary,
  placeholderBoundary,
  serviceAreaMode,
  SERVICE_AREA_PATH,
} from "./service-area";

/**
 * The committed service area: Kuala Lumpur Federal Territory plus the Selangor
 * districts of Petaling, Hulu Langat and Sepang.
 *
 * The extraction script (`scripts/fetch-kl-boundary.mjs`) checks these too, but
 * it runs by hand and once. These run on every suite, so a boundary file swapped
 * for one that does not cover the network fails here rather than in a demo.
 */
const boundary = loadServiceBoundary();

/** North and south of the service area, on either side of it. */
const IPOH = { latitude: 4.5975, longitude: 101.0901 };
const SEREMBAN = { latitude: 2.7297, longitude: 101.9381 };

describe("the committed service area", () => {
  it("is the real boundary, not the placeholder", () => {
    expect(boundary.placeholder).toBeUndefined();
    expect(boundary.licence).toBe("ODbL 1.0");
    expect(boundary.version).toMatch(/^osm-service-area-v1 /);
  });

  /**
   * THE DEPOTS ARE IMPORTED, NOT LISTED. `DEPOTS` is derived from the address
   * set, so naming them here would be a copy that a future re-derivation could
   * leave behind — the hand-maintained list this project keeps finding.
   * SS15 Subang Jaya is the load-bearing one: it is in Selangor, so a
   * Kuala Lumpur-only boundary would put a sortation hub outside the area it
   * serves.
   */
  it("contains every depot, including the one outside Kuala Lumpur", () => {
    for (const depot of DEPOTS) {
      expect(checkPoint(depot, boundary).ok, `${depot.label} is outside the service area`).toBe(true);
    }
    expect(DEPOTS.some((depot) => /Subang Jaya/.test(depot.label))).toBe(true);
  });

  it("contains all 24 cached addresses", () => {
    const outside = ADDRESSES.filter((address) => !checkPoint(address, boundary).ok);
    expect(outside.map((address) => address.label)).toEqual([]);
  });

  it("refuses points beyond it, north and south", () => {
    expect(checkPoint(IPOH, boundary)).toMatchObject({ ok: false, code: "outside" });
    expect(checkPoint(SEREMBAN, boundary)).toMatchObject({ ok: false, code: "outside" });
  });

  /**
   * ODbL's credit is a licence condition, so it travels with the geometry and
   * is what a surface shows — rather than a sentence each page has to remember.
   */
  it("carries the ODbL attribution, naming every relation and version", () => {
    const label = boundaryLabel(boundary);
    expect(label).toContain("© OpenStreetMap contributors");
    expect(label).toContain("ODbL 1.0");
    for (const relation of [2939672, 12391134, 12438351, 10743315]) {
      expect(label).toContain(String(relation));
    }
    expect(label).toMatch(/extracted \d{4}-\d{2}-\d{2}/);
    expect(boundary.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /** The name IS the list, so a district added without updating it is loud. */
  it("names its four members rather than calling itself Klang Valley", () => {
    for (const member of ["Kuala Lumpur", "Petaling", "Hulu Langat", "Sepang"]) {
      expect(boundary.source).toContain(member);
    }
    expect(`${boundary.source} ${boundary.version}`).not.toMatch(/Klang Valley|Greater Kuala Lumpur/i);
  });
});

describe("the placeholder, kept behind a switch", () => {
  it("is what VIGIL_SERVICE_AREA=placeholder selects, without deleting the real one", () => {
    expect(serviceAreaMode({})).toBe("file");
    expect(serviceAreaMode({ VIGIL_SERVICE_AREA: "placeholder" })).toBe("placeholder");

    const stepped = loadServiceBoundary(SERVICE_AREA_PATH, { VIGIL_SERVICE_AREA: "placeholder" });
    expect(stepped.placeholder).toBe(true);
    expect(boundaryLabel(stepped)).toMatch(/^Boundary data pending confirmation/);
  });

  it("is also what loads when the file is absent", () => {
    const absent = loadServiceBoundary(join(tmpdir(), "vigil-no-such-boundary.json"), {});
    expect(absent.version).toBe(placeholderBoundary().version);
  });

  /**
   * The two differ where it matters, which is the point of keeping both: the
   * placeholder was a radius around the depots and admits Cyberjaya's
   * neighbourhood by construction, while the real boundary is administrative.
   * Side by side, not one replacing the other silently.
   */
  it("differs from the real boundary in BOTH directions, on measured points", () => {
    const placeholder = placeholderBoundary();
    // Found by sampling a 0.02° grid over the region, not by guessing: the two
    // disagree on 95 grid points one way and 152 the other.
    const onlyInPlaceholder = { latitude: 2.93, longitude: 101.55 }; // inside the depot radius, outside every district
    const onlyInReal = { latitude: 2.85, longitude: 101.65 }; // southern Sepang, beyond the radius

    expect(checkPoint(onlyInPlaceholder, placeholder).ok).toBe(true);
    expect(checkPoint(onlyInPlaceholder, boundary).ok).toBe(false);
    expect(checkPoint(onlyInReal, placeholder).ok).toBe(false);
    expect(checkPoint(onlyInReal, boundary).ok).toBe(true);
  });
});
