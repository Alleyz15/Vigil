/**
 * THE ONE IDENTIFYING AGENT FOR EVERY OPENSTREETMAP SERVICE THIS PROJECT CALLS.
 *
 * Nominatim, Overpass and the tile servers each require a User-Agent that
 * identifies the application and lets its operators reach it; a default agent
 * is refused. Phase one found the rule satisfied by each caller separately —
 * two wrote it down, the third missed it, and the note that would have saved it
 * sat in a comment one directory away. It recorded a threshold: past three
 * callers, bind the agent to one place so a new caller inherits it instead of
 * remembering it. Phase two's runtime geocoder is the fourth.
 *
 * `.mjs`, so the node scripts and the TypeScript app import the same file.
 * `lib/osm/agent.test.ts` enumerates every file that names an OSM host and
 * fails if one does not import this module.
 *
 * THE CONTACT IS THE REPOSITORY, never a person's address. A runtime caller
 * sends this on every request anyone makes, and it lands in upstream logs, in
 * captures and in every fork's traffic; the repository's issue tracker is the
 * contact the policy asks for.
 */
export const PROJECT_URL = "https://github.com/Alleyz15/Vigil";

/**
 * @param {string} [purpose] what this caller is, for an operator reading logs
 * @returns {string}
 */
export function osmUserAgent(purpose) {
  return `Vigil/0.1 (+${PROJECT_URL}${purpose ? `; ${purpose}` : ""})`;
}
