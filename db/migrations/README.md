# Migrations

Numbered SQL files, applied once each in filename order: `NNN_short_name.sql`
(e.g. `001_initial_schema.sql`). The runner tracks applied versions in
`schema_migrations`; never edit a migration that has already been applied —
add a new one instead.

## Postgres-compatibility rules

Every migration must run unchanged on both SQLite and Postgres, so:

- Types: only `TEXT`, `INTEGER`, `REAL`. No `SERIAL`, `BOOLEAN`, `JSONB`, `TIMESTAMPTZ`.
- Primary keys: `TEXT` holding app-generated UUIDs. No `AUTOINCREMENT`, no `SERIAL`.
- Booleans: `INTEGER` with `0`/`1` and a `CHECK (col IN (0, 1))`.
- Timestamps: `TEXT` ISO-8601 UTC (`2026-09-19T12:00:00.000Z`) — lexicographically sortable in both dialects.
- JSON: `TEXT` holding a JSON document; parse in application code.
- Use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
- Foreign keys with `ON DELETE CASCADE` are fine (SQLite needs `PRAGMA foreign_keys = ON`, which the db layer sets).
- No partial DDL tricks, no `ALTER TABLE ... ALTER COLUMN`, no dialect-specific functions in defaults.
