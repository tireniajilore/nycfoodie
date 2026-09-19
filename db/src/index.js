// taste-db: SQLite access layer (better-sqlite3).
//
// Migration SQL is kept Postgres-compatible by convention (see
// db/migrations/README.md), so the storage backend can move to Postgres
// later without rewriting migrations.
import Database from "better-sqlite3";
let db = null;
export function openDb(path) {
    if (db)
        return db;
    db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
}
export function getDb() {
    if (!db)
        throw new Error("Database not open. Call openDb(path) first.");
    return db;
}
export function closeDb() {
    db?.close();
    db = null;
}
//# sourceMappingURL=index.js.map