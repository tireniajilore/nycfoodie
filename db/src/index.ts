// nycfoodie-db: SQLite access layer (better-sqlite3).
//
// Migration SQL is kept Postgres-compatible by convention (see
// db/migrations/README.md), so the storage backend can move to Postgres
// later without rewriting migrations.

import Database from "better-sqlite3";

export type Db = Database.Database;

let db: Db | null = null;

export function openDb(path: string): Db {
  if (db) return db;
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not open. Call openDb(path) first.");
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
