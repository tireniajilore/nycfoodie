// Numbered-migration runner. Applies db/migrations/*.sql in filename order,
// once each, tracked in schema_migrations. Each migration runs in a transaction.
//
// CLI: node dist/migrate.js [db-path]   (defaults to ./nycfoodie.db)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb, closeDb } from "./index.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function migrate(dbPath: string): string[] {
  const db = openDb(dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map(
      (row) => row.version
    )
  );
  const files = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    : [];
  const insert = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  const newlyApplied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      insert.run(version, new Date().toISOString());
    })();
    newlyApplied.push(version);
  }
  return newlyApplied;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const dbPath = process.argv[2] ?? join(process.cwd(), "nycfoodie.db");
  const applied = migrate(dbPath);
  console.log(applied.length === 0 ? "Database is up to date." : `Applied: ${applied.join(", ")}`);
  closeDb();
}
