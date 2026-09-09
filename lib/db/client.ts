import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

export type VigilDb = ReturnType<typeof createDb>;

/**
 * Open a Vigil database. Pass ":memory:" in tests.
 *
 * WAL is on for file-backed databases so the SSE reasoning stream can read while
 * ingest writes; without it, a reader would block the demo mid-frame.
 */
export function createDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  // Referential integrity is off by default in SQLite. The mandate -> courier
  // and verdict -> event links are load-bearing, so turn it on explicitly.
  sqlite.pragma("foreign_keys = ON");

  return drizzle(sqlite, { schema });
}

/** Close an owned database connection. Safe to call more than once. */
export function closeDb(database: VigilDb): void {
  if (database.$client.open) database.$client.close();
}

let singleton: VigilDb | undefined;

/** Process-wide database, created on first use. */
export function db(): VigilDb {
  singleton ??= createDb(process.env.VIGIL_DB_PATH ?? "./data/db/vigil.db");
  return singleton;
}

export { schema };
