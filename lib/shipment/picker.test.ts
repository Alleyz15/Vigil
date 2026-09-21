import { describe, expect, it } from "vitest";
import {
  addressLines,
  CLAIM_HEADING,
  RESOLVED_HEADING,
  boundaryStamp,
  confirmPoint,
  COORDINATE_DECIMALS,
  formatCoordinate,
  normaliseClaim,
  outsideMessage,
  roundCoordinate,
  serviceAreaSentence,
  shortMemberName,
} from "./picker";
import { loadServiceBoundary, placeholderBoundary } from "./service-area";

const boundary = loadServiceBoundary();

describe("the coordinate a person confirms", () => {
  /**
   * THE CLAIM THIS WHOLE SURFACE RESTS ON. A display that shows six decimals
   * while the store keeps fifteen is an interface stating a number that is not
   * the one on file — small, invisible, and exactly the kind of quiet difference
   * this project refuses elsewhere. So the rounding happens once, at the click.
   */
  it("shows exactly the value it stores", () => {
    const point = confirmPoint(3.1390125467891, 101.68685512349);
    expect(Number(formatCoordinate(point.latitude))).toBe(point.latitude);
    expect(Number(formatCoordinate(point.longitude))).toBe(point.longitude);
  });

  it("rounds once and then does not move", () => {
    const once = roundCoordinate(3.1390125467891);
    expect(roundCoordinate(once)).toBe(once);
    expect(formatCoordinate(once).split(".")[1]).toHaveLength(COORDINATE_DECIMALS);
  });

  /** No snapping: a point 1 m from a cached address stays 1 m from it. */
  it("does not move a click toward anything", () => {
    const point = confirmPoint(3.139009, 101.686851);
    expect(point).toEqual({ latitude: 3.139009, longitude: 101.686851 });
  });
});

describe("the service area, named by listing its members", () => {
  /**
   * The sentence the sender surface prints, asserted against the REAL committed
   * boundary. It is derived from `members`, so a district added to the file
   * lengthens this string and fails here — the name cannot silently widen.
   */
  it("reads the four members off the boundary", () => {
    expect(serviceAreaSentence(boundary)).toBe(
      "Service area: Kuala Lumpur, Petaling, Hulu Langat, Sepang",
    );
  });

  it("never calls itself Klang Valley or Greater Kuala Lumpur", () => {
    const said = `${serviceAreaSentence(boundary)} ${outsideMessage(boundary)}`;
    expect(said).not.toMatch(/Klang Valley|Greater Kuala Lumpur/i);
  });

  it("shortens a member label, and returns an unqualified one whole", () => {
    expect(shortMemberName("Kuala Lumpur (Federal Territory)")).toBe("Kuala Lumpur");
    expect(shortMemberName("Petaling, Selangor")).toBe("Petaling");
    expect(shortMemberName("Putrajaya")).toBe("Putrajaya");
  });

  /**
   * A REFUSAL THAT SAYS WHAT IS COVERED, not a greyed-out control. Rule 3g: a
   * correct message that leaves the person with nothing to do next has not done
   * its job, so the four units are named in the refusal itself.
   */
  it("answers an outside point with the reason and every member", () => {
    const message = outsideMessage(boundary);
    for (const member of ["Kuala Lumpur", "Petaling", "Hulu Langat", "Sepang"]) {
      expect(message).toContain(member);
    }
    expect(message).toMatch(/outside the service area/);
  });

  it("says placeholder rather than naming districts when the placeholder is in force", () => {
    const stand_in = placeholderBoundary();
    expect(serviceAreaSentence(stand_in)).toMatch(/placeholder radius around the depots/);
    expect(outsideMessage(stand_in)).toMatch(/pending confirmation/);
    expect(outsideMessage(stand_in)).not.toMatch(/Kuala Lumpur|Petaling|Sepang/);
  });
});

describe("what the map prints in its corner", () => {
  /** ODbL's credit rides with the geometry; this only decides the date format. */
  it("carries the boundary's own credit and its extraction date", () => {
    const stamp = boundaryStamp(boundary);
    expect(stamp.credit).toContain("© OpenStreetMap contributors");
    expect(stamp.credit).toContain("ODbL 1.0");
    expect(stamp.extracted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has no extraction date for the placeholder, and does not invent one", () => {
    const stamp = boundaryStamp(placeholderBoundary());
    expect(stamp.extracted).toBeNull();
    expect(stamp.showExtracted).toBe(false);
  });

  /**
   * The ODbL line the extractor writes already ends with the date, so printing
   * it again underneath is noise. Which of the two happens is derived from the
   * strings, not left to whoever edits the component next.
   */
  it("prints the date separately only when the credit does not already carry it", () => {
    expect(boundaryStamp(boundary).showExtracted).toBe(false);
    expect(boundary.attribution).toContain(boundaryStamp(boundary).extracted);

    const credited_without_a_date = boundaryStamp({
      attribution: "© OpenStreetMap contributors, ODbL 1.0.",
      extractedAt: "2026-09-20T07:02:22.336Z",
      version: "osm-service-area-v1",
    });
    expect(credited_without_a_date.showExtracted).toBe(true);
    expect(credited_without_a_date.extracted).toBe("2026-09-20");
  });
});

describe("the address of a confirmed point", () => {
  /**
   * An unresolved address is the observation, not a blank field (rule 4f): the
   * line says so, and nothing is guessed in its place.
   */
  it("is unresolved with or without a claim, and says which", () => {
    expect(addressLines({ claim: null, resolved: null })).toEqual({
      resolved: null,
      claim: null,
      unresolved: "Address not resolved — no address is guessed",
    });
    const claimed = addressLines({ claim: "Block B lobby", resolved: null });
    expect(claimed.claim).toEqual({ heading: CLAIM_HEADING, text: "Block B lobby" });
    expect(claimed.unresolved).toMatch(/sender's own description, not a lookup/);
  });

  /**
   * TWO SOURCES, TWO HEADINGS. The store keeps the geocoder's label and the
   * sender's words in separate columns; this is what stops a screen printing
   * them as one line — each arrives with a heading naming who said it.
   */
  it("keeps a resolved label and a claim apart, each under its own source", () => {
    const both = addressLines({
      claim: "Leave at the guardhouse",
      resolved: { label: "Jalan Tun Razak, Kuala Lumpur", by: "search" },
    });
    expect(both.resolved).toEqual({ heading: RESOLVED_HEADING, label: "Jalan Tun Razak, Kuala Lumpur", by: "search" });
    expect(both.claim).toEqual({ heading: CLAIM_HEADING, text: "Leave at the guardhouse" });
    expect(both.unresolved).toBeNull();
    expect(RESOLVED_HEADING).toMatch(/Nominatim/);
    expect(CLAIM_HEADING).not.toBe(RESOLVED_HEADING);
  });

  it("treats whitespace as no claim at all", () => {
    expect(normaliseClaim("   ")).toBeNull();
    expect(normaliseClaim("")).toBeNull();
    expect(normaliseClaim("  Lot 8  ")).toBe("Lot 8");
  });
});
