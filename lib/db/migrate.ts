import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb, type VigilDb } from "./client";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply all pending migrations to an already-open database. */
export function applyMigrations(database: VigilDb): void {
  migrate(database, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Open a fresh, fully migrated database. Used by tests and by seed scripts.
 * The dev-facing entry point is `npm run db:migrate` (drizzle-kit).
 */
export function createMigratedDb(path: string): VigilDb {
  const database = createDb(path);
  applyMigrations(database);
  return database;
}
