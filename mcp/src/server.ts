// nycfoodie MCP server factory (shared by stdio and HTTP transports).
//
// Read-only access to the NYCfoodie database: structured editorial
// restaurant recommendations. City is a parameter on every tool.
// Database path: NYCFOODIE_DB env var, else nycfoodie.db at the repo root.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, join, basename } from "node:path";
import {
  copyFileSync,
  existsSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import Database from "better-sqlite3";
import { closeDb, getDb, openDb, openReadDb } from "nycfoodie-db";
import { migrate } from "nycfoodie-db/dist/migrate.js";
import { z } from "zod";
import {
  compareRestaurants,
  findGuides,
  findSimilar,
  getRestaurant,
  guideConsensus,
  OCCASION_VALUES,
  searchRestaurants,
  suggestRestaurants,
  topRated,
  type Filters,
} from "./queries.js";
import { createCallLogger, hashClient, recordUsage, saveFeedback, type CallLogger } from "./telemetry.js";

const dbPath =
  process.env.NYCFOODIE_DB ?? new URL("../../nycfoodie.db", import.meta.url).pathname;
const seedPath = new URL("../../nycfoodie.db", import.meta.url).pathname;

// Volume database lifecycle.
//
// NYCFOODIE_DB lives on a Railway persistent volume: it survives deploys so
// feedback and usage logs persist. The restaurant dataset itself ships inside
// the image (seedPath). Three cases:
//
//  1. Missing volume DB -> seed from the image (fresh volume).
//  2. Corrupt volume DB -> salvage user rows best-effort, quarantine the
//     file, reseed from the image. A previous deploy was once killed
//     mid-copy and left a truncated database behind; without this the server
//     crash-loops in migrate() with SQLITE_CORRUPT.
//  3. Image carries a newer dataset (dataset_meta.built_at) than the volume ->
//     swap it in, preserving user rows.
//
// The swap is staged, never in place:
//   a. The seed is integrity-checked BEFORE the live file is touched; a
//      corrupt image aborts the swap and the live file is left alone.
//   b. The replacement is fully built in a temp file on the same filesystem:
//      copy the seed, run migrations, restore user rows, integrity-check,
//      fsync. Only then is it renamed over the live file.
//   c. Stale -wal/-shm sidecars from the old database generation are removed
//      before the rename, so they can never be replayed against the new file.
//   d. The directory is fsynced after the rename so the new entry is durable.
// rename(2) is atomic, so a process killed at any point can never leave a
// half-written database behind. (The earlier non-atomic in-place copy is what
// corrupted the volume.)
// Assumes a single server instance; concurrent boots could interleave swaps.
const USER_TABLES = ["feedback", "usage_log"] as const;

interface PreservedTable {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Best-effort read of user-generated rows. Never throws. */
function salvageUserRows(path: string): PreservedTable[] {
  const out: PreservedTable[] = [];
  try {
    const db = new Database(path, { readonly: true });
    try {
      for (const table of USER_TABLES) {
        try {
          const exists = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) as { name: string } | undefined;
          if (!exists) continue;
          const columns = (
            db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
          ).map((c) => c.name);
          const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
          out.push({ table, columns, rows });
        } catch {
          // Unreadable table: skip it, keep the service bootable.
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // Unopenable database: nothing to salvage.
  }
  return out;
}

/** Restore salvaged user rows into a fresh database. Never throws. */
function restoreUserRows(path: string, preserved: PreservedTable[]): void {
  if (preserved.length === 0) return;
  try {
    const db = new Database(path);
    try {
      for (const { table, columns, rows } of preserved) {
        try {
          const exists = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) as { name: string } | undefined;
          if (!exists || rows.length === 0) continue;
          // Drop the autoincrement key so restored usage_log rows never
          // collide with the seed copy's ids; natural keys (feedback.id)
          // are kept as-is with INSERT OR IGNORE.
          const insertCols = columns.filter((c) => !(table === "usage_log" && c === "id"));
          const stmt = db.prepare(
            `INSERT OR IGNORE INTO ${table} (${insertCols.join(", ")}) VALUES (${insertCols
              .map(() => "?")
              .join(", ")})`
          );
          const insertMany = db.transaction((rs: Record<string, unknown>[]) => {
            for (const r of rs) stmt.run(...insertCols.map((c) => r[c]));
          });
          insertMany(rows);
        } catch {
          // One bad table must not block the boot.
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // Unwritable fresh database: boot continues; migrate() will surface it.
  }
}

/**
 * Probe that the database is usable, replicating exactly what openDb() does
 * at startup (open + journal_mode=WAL pragma). Returns false for a corrupt
 * or otherwise unusable file instead of crashing the boot.
 */
function probeDb(path: string): boolean {
  try {
    const db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function readBuiltAt(path: string): string {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .prepare("SELECT value FROM dataset_meta WHERE key = 'built_at'")
        .get() as { value: string } | undefined;
      return row?.value ?? "";
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

/**
 * PRAGMA integrity_check on a database file. Never throws.
 */
function integrityOk(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare("PRAGMA integrity_check").get() as
        | { integrity_check: string }
        | undefined;
      return row?.integrity_check === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Force any WAL content into the main database file. Never throws. */
function checkpointDb(path: string): void {
  try {
    const db = new Database(path);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch {
    // Best effort: boot continues; the next opener replays the WAL.
  }
}

/** fsync a directory so a rename inside it is durable. Never throws. */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort: the rename itself is already atomic.
  }
}

/** Remove -wal/-shm sidecars for a database path. Never throws. */
function unlinkSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // Absent: nothing to do.
    }
  }
}

/**
 * Remove temp replacement files left behind by a killed boot, so a stale
 * half-built file can never be mistaken for anything. Never throws.
 */
function cleanStaleTempDbs(): void {
  try {
    const dir = dirname(dbPath);
    const prefix = `${basename(dbPath)}.new-`;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // Gone already: fine.
        }
      }
    }
  } catch {
    // Unlistable directory: boot continues; tmp names are unique per boot.
  }
}

/**
 * Build a fully validated replacement database in a temp file on the same
 * filesystem: copy the seed, run migrations, restore user rows,
 * integrity-check, fsync. Returns the temp path, or null when the
 * replacement cannot be built — the live file is then left untouched.
 */
function buildReplacementDb(preserved: PreservedTable[]): string | null {
  if (!integrityOk(seedPath)) {
    console.log(JSON.stringify({ event: "db_replace_aborted", reason: "seed_corrupt" }));
    return null;
  }
  const tmp = `${dbPath}.new-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(seedPath, tmp);
    try {
      migrate(tmp); // idempotent; keeps a stale image forward-compatible
    } finally {
      // migrate() leaves its singleton handle open on tmp: release it, or a
      // later openDb(dbPath) would return this stale handle and the restore
      // below would never checkpoint into the main file.
      closeDb();
    }
    restoreUserRows(tmp, preserved); // user rows land BEFORE validation
    // Force restored rows out of the WAL into the main file: the temp
    // sidecars are deleted below, and must not take committed rows with them.
    checkpointDb(tmp);
    if (!integrityOk(tmp)) {
      console.log(
        JSON.stringify({ event: "db_replace_aborted", reason: "replacement_corrupt" })
      );
      try {
        unlinkSync(tmp);
      } catch {
        // Best effort.
      }
      return null;
    }
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Sidecars of the temp file must not be left behind: only the renamed
    // main file becomes the live database.
    unlinkSidecars(tmp);
    return tmp;
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "db_replace_aborted",
        reason: "build_failed",
        error: String(err),
      })
    );
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort.
    }
    return null;
  }
}

/**
 * Best-effort inter-process boot lock so two server instances sharing a
 * volume can never interleave replacements (e.g. during a deploy overlap).
 * Uses O_CREAT|O_EXCL as an atomic mutex with stale-holder detection via
 * the recorded pid. Returns a release function, or null when another live
 * boot holds the lock — the caller must then skip the replacement and
 * serve the live database as-is (fail safe). Never throws.
 */
function acquireBootLock(): (() => void) | null {
  const lockPath = `${dbPath}.replace.lock`;
  const release = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone: fine.
    }
  };
  const claim = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx", 0o644);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (claim()) return release;
  // A lock file exists: yield to a live holder, steal from a dead one.
  try {
    const holderPid = parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isFinite(holderPid)) {
      try {
        process.kill(holderPid, 0); // throws ESRCH when the holder is dead
        console.log(
          JSON.stringify({ event: "db_replace_skipped", reason: "lock_held" })
        );
        return null;
      } catch {
        // Holder is dead: steal the stale lock below.
      }
    }
  } catch {
    // Unreadable lock file: try to steal it below.
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Gone already: fine.
  }
  if (claim()) return release;
  // Lost the race to another boot: yield, fail safe.
  console.log(JSON.stringify({ event: "db_replace_skipped", reason: "lock_held" }));
  return null;
}

/**
 * Atomically replace the volume database with the image copy, preserving
 * user-generated rows. The live file is never touched before the
 * replacement is fully built and validated. On `reason: "corrupt"` the old
 * file is quarantined first for forensics.
 */
function atomicReplaceFromSeed(reason: "seed" | "corrupt" | "refresh"): void {
  const preserved = salvageUserRows(dbPath);
  const preservedCounts = Object.fromEntries(
    preserved.map((t) => [t.table, t.rows.length])
  );
  const tmp = buildReplacementDb(preserved);
  if (!tmp) return; // live file untouched; boot proceeds on the old database
  if (reason === "corrupt") {
    try {
      renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}.bak`);
    } catch {
      // Already gone (e.g. a concurrent boot); continue with the reseed.
    }
  }
  // A -wal/-shm from the old database generation must never be replayed
  // against the replacement file.
  unlinkSidecars(dbPath);
  try {
    renameSync(tmp, dbPath);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "db_replace_failed",
        reason,
        error: String(err),
      })
    );
    return;
  }
  fsyncDir(dirname(dbPath));
  console.log(
    JSON.stringify({
      event: "db_replace",
      reason,
      preserved: preservedCounts,
    })
  );
}

// Volume replacement is single-writer: the lock also guards
// cleanStaleTempDbs(), which must never delete another boot's temp file.
const releaseBootLock = acquireBootLock();
if (releaseBootLock) {
  try {
    cleanStaleTempDbs();
    if (seedPath !== dbPath && existsSync(seedPath)) {
      if (!existsSync(dbPath)) {
        atomicReplaceFromSeed("seed");
      } else if (!probeDb(dbPath)) {
        atomicReplaceFromSeed("corrupt");
      } else {
        // Data release: the image carries a newer dataset than the volume.
        // The image DB is stamped with dataset_meta.built_at at release time.
        const seedBuiltAt = readBuiltAt(seedPath);
        const liveBuiltAt = readBuiltAt(dbPath);
        if (seedBuiltAt && seedBuiltAt > liveBuiltAt) {
          atomicReplaceFromSeed("refresh");
        } else if (!seedBuiltAt && !integrityOk(seedPath)) {
          // Corrupt image, healthy volume: serve the volume, but say so loudly
          // so the bad image gets noticed instead of silently pinning stale data.
          console.log(JSON.stringify({ event: "db_seed_unreadable" }));
        }
      }
    }
  } finally {
    releaseBootLock();
  }
}
// else: another live boot holds the replacement lock; serve the live
// database as-is. The refresh is re-evaluated on the next boot.
const logPath =
  process.env.NYCFOODIE_LOG ?? join(dirname(dbPath), "nycfoodie-mcp-calls.jsonl");

// The server migrates on startup (feedback table lives here), queries
// read-only, and feedback writes go through a separate writable handle.
migrate(dbPath);
openDb(dbPath);
const writeDb = getDb();
const db = openReadDb(dbPath);

/** Dataset vintage, exposed as data_as_of on every tool response so agents
 *  can caveat stale claims (closures especially). Written by the crawler on
 *  each build; backfilled from crawl timestamps by migration 013. */
function readDataAsOf(): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM dataset_meta WHERE key = 'built_at'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}
const DATA_AS_OF = readDataAsOf();

// Bounded retention for usage analytics: keep 180 days.
try {
  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  writeDb.prepare("DELETE FROM usage_log WHERE ts < ?").run(cutoff);
} catch {
  // Table may not exist on very old databases before migration runs; migrate()
  // already ran above, so this is just defensive.
}

const log: CallLogger = createCallLogger(logPath);
log({
  ts: new Date().toISOString(),
  tool: "<server_start>",
  args: { dbPath },
  duration_ms: 0,
  ok: true,
});

/** Request-scoped context for the MCP server (HTTP transport). */
export interface McpServerOptions {
  /** Client IP as seen by the HTTP layer (never stored raw). */
  clientIp?: string;
  /** Client user-agent as seen by the HTTP layer (never stored raw). */
  userAgent?: string;
}

/** Build a fully-registered MCP server. One instance per transport. */
export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "nycfoodie", version: "0.1.0" });
  const clientHash =
    opts.clientIp != null ? hashClient(opts.clientIp, opts.userAgent ?? "") : null;

  function json(data: unknown) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(stampDataAsOf(data), null, 2) },
      ],
    };
  }

  /** Tool-level error (isError) for input the schema can't express, e.g.
   *  "at least one of id/name is required". A real tool error, not a
   *  successful payload that happens to contain an error key. */
  function toolError(message: string) {
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true as const,
    };
  }

  /** Not-found payload shared by get_restaurant and find_similar. */
  function notFound(query: string, city: string) {
    return json({
      found: false,
      query,
      suggestions: suggestRestaurants(db, city, query).map((s) => s.name),
    });
  }

  /** Stamp the dataset vintage onto every response: top-level for objects,
   *  per record for arrays so existing shapes stay backward-compatible. */
  function stampDataAsOf(data: unknown): unknown {
    if (DATA_AS_OF == null) return data;
    if (Array.isArray(data))
      return data.map((el) =>
        el && typeof el === "object" ? { data_as_of: DATA_AS_OF, ...el } : el
      );
    if (data && typeof data === "object")
      return { data_as_of: DATA_AS_OF, ...(data as Record<string, unknown>) };
    return data;
  }

  /** Wrap a tool handler with call logging (timing, args, errors) plus a
   *  privacy-respecting usage row (tool, city, client fingerprint — no args). */
  function logged<TArgs extends Record<string, unknown>, TResult>(
    name: string,
    fn: (args: TArgs) => Promise<TResult>
  ): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs) => {
      const start = Date.now();
      const city = typeof args.city === "string" ? args.city : null;
      const usage = (ok: boolean) =>
        recordUsage(writeDb, {
          ts: new Date().toISOString(),
          tool: name,
          city,
          clientHash,
          latencyMs: Date.now() - start,
          ok,
        });
      try {
        const result = await fn(args);
        log({
          ts: new Date().toISOString(),
          tool: name,
          args,
          duration_ms: Date.now() - start,
          ok: true,
          result_bytes: JSON.stringify(result).length,
        });
        usage(true);
        return result;
      } catch (e) {
        log({
          ts: new Date().toISOString(),
          tool: name,
          args,
          duration_ms: Date.now() - start,
          ok: false,
          error: String(e).slice(0, 500),
        });
        usage(false);
        throw e;
      }
    };
  }

  const cityParam = z
    .string()
    .describe(
      "City slug, always required. Currently 'new-york', covering the five boroughs plus the immediate metro (within 30 km of Manhattan)."
    );

  const READ_ONLY = { readOnlyHint: true } as const;
  const limitParam = z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max results (default 10)");

  function filtersFrom(args: {
    city: string;
    query?: string;
    cuisine?: string;
    neighborhood?: string;
    occasion?: string;
    min_rating?: number;
    price_tier?: number;
    include_closed?: boolean;
    lat?: number;
    lng?: number;
    radius_km?: number;
  }): Filters {
    return {
      city: args.city,
      query: args.query,
      cuisine: args.cuisine,
      neighborhood: args.neighborhood,
      occasion: args.occasion,
      minRating: args.min_rating,
      priceTier: args.price_tier,
      includeClosed: args.include_closed,
      lat: args.lat,
      lng: args.lng,
      radiusKm: args.radius_km,
    };
  }

  const filterShape = {
    cuisine: z.string().optional().describe("e.g. 'Italian', 'ramen'"),
    neighborhood: z.string().optional().describe("e.g. 'West Village', or a borough like 'Brooklyn'"),
    occasion: z
      .string()
      .optional()
      .describe(
        `Occasion tag. Allowed: ${OCCASION_VALUES.map((v) => `'${v}'`).join(", ")}. ` +
          "Hyphens, spaces and underscores are flexible ('date-night' works); unambiguous prefixes resolve to the full value. Unknown or ambiguous values are rejected with an error."
      ),
    min_rating: z.number().min(0).max(10).optional().describe("Minimum Infatuation rating"),
    price_tier: z.number().int().min(1).max(4).optional().describe("1 ($) to 4 ($$$$)"),
    include_closed: z
      .boolean()
      .optional()
      .describe("Include known-closed venues (default false)"),
    lat: z
      .number()
      .optional()
      .describe(
        "Latitude for proximity search. Must be given together with lng; " +
          "radius_km defaults to 5 km when omitted. A location outside the " +
          "NYC coverage area is rejected with an error."
      ),
    lng: z
      .number()
      .optional()
      .describe(
        "Longitude for proximity search. Must be given together with lat; " +
          "radius_km defaults to 5 km when omitted."
      ),
    radius_km: z
      .number()
      .positive()
      .optional()
      .describe(
        "Search radius in kilometres (default 5 when lat/lng are given without it). Requires lat and lng."
      ),
  };

  server.registerTool(
    "search_restaurants",
    {
      description:
        "Search restaurants by free text, cuisine, neighbourhood, occasion or price, optionally near a point. Use when the user describes what they want (e.g. 'Italian date night in the West Village', 'ramen near me') rather than naming a specific restaurant. Free text matches names, tags, review prose and guide blurbs (e.g. 'cacio e pepe'). Returns compact matches with Infatuation rating (0–10), price tier, address_line and tags. Cards carry guide_appearance_count (a number); get_restaurant's guide_appearances is the full entry list. Known-closed venues are excluded by default. Coverage for city='new-york' is the five boroughs plus the immediate metro (within 30 km of Manhattan). With no query or filters, returns the highest-rated venues.",
      annotations: READ_ONLY,
      inputSchema: {
        query: z.string().optional().describe("Free text, e.g. 'date-night Italian'"),
        city: cityParam,
        ...filterShape,
        sort: z
          .enum(["rating", "guides"])
          .optional()
          .describe("Sort by rating (default) or guide appearances"),
        limit: limitParam,
      },
    },
    logged("search_restaurants", async (args) =>
      json(
        searchRestaurants(
          db,
          filtersFrom(args),
          args.limit ?? 10,
          args.sort ?? "rating"
        )
      )
    )
  );

  server.registerTool(
    "get_restaurant",
    {
      description:
        "Get the full picture for one restaurant in one call: Infatuation rating (0–10), price tier, address, reservation link, booking intel, review summary, tags and every guide it appears in. Use when the user names a specific restaurant. editorial_blurbs carries verbatim Eater guide excerpts (guide title, URL, position, blurb, captured_at) for any venue with Eater guide entries — Eater-only venues have no rating or price, only this prose plus tags. Full review prose is opt-in via include_prose (default: headline and summary only). review.headline is the source's actual headline when one exists, otherwise null — use review.summary for the descriptive text. match_type is 'exact' when the id or name matched verbatim, 'fuzzy' when it was resolved from a partial/typo'd name — never present a fuzzy match as the venue the user named without saying so. booking is null when the source has no booking intel (not the same as walk-in-only); a reservation link alone never implies a booking policy. data_as_of is the dataset vintage and crawled_at is when this venue was last crawled — caveat fast-decaying claims (closures especially) when these are old.",
      annotations: READ_ONLY,
      inputSchema: {
        id: z.string().optional().describe("Canonical restaurant id, or a name to resolve"),
        name: z.string().optional().describe("Alias for id: the restaurant's exact name"),
        city: cityParam,
        include_prose: z
          .boolean()
          .optional()
          .describe("Include the full review text (default false: headline + summary only)"),
      },
    },
    logged("get_restaurant", async ({ id, name, city, include_prose }) => {
      const key = id ?? name;
      if (!key)
        return toolError("get_restaurant needs 'id' (a UUID or exact name); 'name' works as an alias.");
      const r = getRestaurant(db, city, key, include_prose ?? false);
      if (r) return json(r);
      return notFound(key, city);
    })
  );

  server.registerTool(
    "compare_restaurants",
    {
      description:
        "Compare 2–5 named restaurants head-to-head as structured data (rating, price, tags, review summary). Use when the user asks to choose between specific places, e.g. 'should I go to X or Y?' or to compare four options on a budget.",
      annotations: READ_ONLY,
      inputSchema: {
        restaurants: z
          .array(z.string())
          .min(2)
          .max(5)
          .optional()
          .describe("Restaurant ids or names to compare"),
        ids: z
          .array(z.string())
          .min(2)
          .max(5)
          .optional()
          .describe("Alias for restaurants"),
        city: cityParam,
      },
    },
    logged("compare_restaurants", async ({ restaurants, ids, city }) => {
      const list = restaurants ?? ids;
      if (!list)
        return toolError("compare_restaurants needs 'restaurants' (2–5 ids or names); 'ids' works as an alias.");
      return json(compareRestaurants(db, city, list));
    })
  );

  server.registerTool(
    "find_guides",
    {
      description:
        "Find curated editorial guides (ranked lists) matching a theme, e.g. 'best ramen'. Returns each guide with its ranked entries, blurbs and linked restaurants. Use when the user wants the editorial lists themselves rather than individual restaurant picks. Set include_entries=false to list guide titles and metadata without pulling every entry blurb.",
      annotations: READ_ONLY,
      inputSchema: {
        city: cityParam,
        query: z.string().optional().describe("Theme, e.g. 'best ramen', 'date night'"),
        limit: limitParam,
        include_entries: z
          .boolean()
          .optional()
          .describe("Set false to return guide metadata without the ranked entry blurbs (default true)"),
      },
    },
    logged("find_guides", async ({ city, query, limit, include_entries }) =>
      json(findGuides(db, city, query, limit ?? 5, include_entries ?? true))
    )
  );

  server.registerTool(
    "find_similar",
    {
      description:
        "Find restaurants similar to a named one, scored by shared cuisine, occasion and neighbourhood tags, price-tier proximity and guide co-occurrence. Use for 'like X' or 'alternatives to X' requests.",
      annotations: READ_ONLY,
      inputSchema: {
        id: z.string().optional().describe("Canonical restaurant id, or a name to resolve"),
        name: z.string().optional().describe("Alias for id: the restaurant's exact name"),
        city: cityParam,
        limit: limitParam,
      },
    },
    logged("find_similar", async ({ id, name, city, limit }) => {
      const key = id ?? name;
      if (!key)
        return toolError("find_similar needs 'id' (a UUID or exact name); 'name' works as an alias.");
      const r = findSimilar(db, city, key, limit ?? 10);
      if (r) return json(r);
      return notFound(key, city);
    })
  );

  server.registerTool(
    "guide_consensus",
    {
      description:
        "Rank restaurants by how many distinct guides feature them, optionally filtered by theme. Use for 'where can't I go wrong' or safest-bet picks. Differs from find_guides: this returns ranked restaurants, not the guides themselves. Each row carries guide_appearance_count (a number); get_restaurant's guide_appearances is the full entry list.",
      annotations: READ_ONLY,
      inputSchema: {
        city: cityParam,
        theme: z.string().optional().describe("Guide theme, e.g. 'ramen', 'brunch'"),
        limit: limitParam,
      },
    },
    logged("guide_consensus", async ({ city, theme, limit }) => json(guideConsensus(db, city, theme, limit ?? 10)))
  );

  server.registerTool(
    "top_rated",
    {
      description:
        "List the highest-rated restaurants (Infatuation 0–10 scale), with optional cuisine, neighbourhood and price filters. Use for 'best in the city' requests. Differs from search_restaurants: no free-text query, strictly rating-ordered.",
      annotations: READ_ONLY,
      inputSchema: { city: cityParam, ...filterShape, limit: limitParam },
    },
    logged("top_rated", async (args) => json(topRated(db, filtersFrom(args), args.limit ?? 10)))
  );

  server.registerTool(
    "submit_feedback",
    {
      description:
        "Record feedback on a tool result: a 1–5 rating, a comment, or both (at least one is required). Use after showing the user a recommendation to log what was good or wrong. Each call stores a new feedback entry; it changes nothing the user sees.",
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        tool: z
          .string()
          .optional()
          .describe("Which tool the feedback is about, e.g. 'search_restaurants'"),
        rating: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("1 (poor) to 5 (excellent)"),
        comment: z.string().optional().describe("What was good or wrong"),
      },
    },
    logged("submit_feedback", async ({ tool, rating, comment }) => {
      try {
        const id = saveFeedback(writeDb, { tool_name: tool, rating, comment });
        return json({ received: true, id });
      } catch (e) {
        return json({ received: false, error: String(e).slice(0, 200) });
      }
    })
  );
  return server;
}

/**
 * Admin-only read-back of submitted feedback. Deliberately NOT an MCP tool:
 * feedback must not be visible to every agent using the server. Served over
 * HTTP at GET /admin/feedback, behind FEEDBACK_ADMIN_TOKEN.
 */
export function readFeedback(limit = 50, since?: string): Record<string, unknown>[] {
  const lim = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  // One query shape: the optional since-bound becomes a no-op predicate
  // (created_at > '' is always true) instead of a second query.
  const rows = db
    .prepare(
      `SELECT id, created_at, tool_name, rating, comment FROM feedback
       WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(since ?? "", lim);
  return rows as Record<string, unknown>[];
}

export interface UsageStats {
  days: number;
  since: string;
  total_calls: number;
  distinct_clients: number;
  calls_today: number;
  per_day: { day: string; calls: number; clients: number }[];
  per_tool: { tool: string; calls: number }[];
  recent: { ts: string; tool: string; city: string | null; latency_ms: number | null; ok: number }[];
}

/**
 * Admin-only usage analytics. Deliberately NOT an MCP tool: usage data must
 * not be visible to every agent using the server. Served over HTTP at
 * GET /admin/usage(.json), behind FEEDBACK_ADMIN_TOKEN.
 *
 * "Distinct clients" counts distinct anonymised client fingerprints — an
 * approximation of people, not an exact headcount (MCP clients don't
 * identify users).
 */
export function readUsageStats(days = 30): UsageStats {
  const d = Math.min(Math.max(Math.floor(days) || 30, 1), 180);
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const total = db
    .prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT client_hash) AS u FROM usage_log WHERE ts >= ?")
    .get(since) as { c: number; u: number };
  const callsToday = (
    db.prepare("SELECT COUNT(*) AS c FROM usage_log WHERE substr(ts, 1, 10) = ?").get(today) as {
      c: number;
    }
  ).c;
  const perDay = db
    .prepare(
      `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS calls, COUNT(DISTINCT client_hash) AS clients
       FROM usage_log WHERE ts >= ? GROUP BY day ORDER BY day`
    )
    .all(since) as { day: string; calls: number; clients: number }[];
  const perTool = db
    .prepare(
      `SELECT tool, COUNT(*) AS calls FROM usage_log WHERE ts >= ?
       GROUP BY tool ORDER BY calls DESC`
    )
    .all(since) as { tool: string; calls: number }[];
  const recent = db
    .prepare(
      `SELECT ts, tool, city, latency_ms, ok FROM usage_log
       ORDER BY id DESC LIMIT 50`
    )
    .all() as UsageStats["recent"];
  return {
    days: d,
    since,
    total_calls: total.c,
    distinct_clients: total.u,
    calls_today: callsToday,
    per_day: perDay,
    per_tool: perTool,
    recent,
  };
}
