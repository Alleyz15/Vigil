import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { osmUserAgent, PROJECT_URL } from "./agent.mjs";

const ROOT = join(__dirname, "..", "..");
const TREES = ["app", "components", "lib", "scripts"];
const HOST = /openstreetmap\.org|overpass-api\.de/;

/**
 * Files that name an OSM host and are allowed not to import the agent, each
 * with its reason. A stale entry fails below, so a file that stops naming a
 * host cannot keep an exemption for whatever later takes its name.
 */
const EXEMPT: Record<string, string> = {
  "components/operator/shipment-map-client.tsx":
    "the tile URL is handed to Leaflet, and the VIEWER'S BROWSER fetches it with its own agent and the page as referer; this repository's code sends no header there",
  "components/sender/service-area-map-client.tsx":
    "the tile URL is handed to Leaflet, and the VIEWER'S BROWSER fetches it with its own agent and the page as referer; this repository's code sends no header there",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

const named = TREES.flatMap((tree) => sources(join(ROOT, tree)))
  .map((path) => ({ file: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }))
  .filter(({ text }) => HOST.test(text));

describe("one identifying agent for every OpenStreetMap caller", () => {
  /**
   * ENUMERATED, NOT LISTED. Every file under app, components, lib and scripts
   * that names an OSM host is found by reading them, and each must import the
   * shared agent — so a fifth caller is covered the moment it exists, and
   * leaving one uncovered takes a written sentence in EXEMPT.
   */
  it("is imported by every file that names an OSM host", () => {
    const callers = named.filter(({ file }) => !(file in EXEMPT));
    expect(callers.map(({ file }) => file).sort()).toEqual([
      "lib/geocode/nominatim.ts",
      "scripts/fetch-addresses.mjs",
      "scripts/fetch-kl-boundary.mjs",
      "scripts/qa/stable-capture.mjs",
    ]);
    for (const { file, text } of callers) {
      expect(/from\s+["'][^"']*osm\/agent\.mjs["']/.test(text), `${file} names an OSM host but does not import lib/osm/agent.mjs`).toBe(true);
    }
  });

  it("has no stale exemptions", () => {
    const files = new Set(named.map(({ file }) => file));
    for (const file of Object.keys(EXEMPT)) expect(files.has(file), `EXEMPT names ${file}, which no longer names an OSM host`).toBe(true);
  });

  it("names the repository as the contact, and no person", () => {
    expect(osmUserAgent()).toBe("Vigil/0.1 (+https://github.com/Alleyz15/Vigil)");
    expect(osmUserAgent("QA screenshot capture")).toBe("Vigil/0.1 (+https://github.com/Alleyz15/Vigil; QA screenshot capture)");
    expect(PROJECT_URL).not.toMatch(/@/);
    for (const { file, text } of named) expect(text, `${file} carries an email address`).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});
