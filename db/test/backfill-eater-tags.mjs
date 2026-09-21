// Tests for migration 015 (listing_tags provenance) and the Eater enrichment
// tag backfill. Runs against a scratch copy of the dataset DB — never the
// working copy. No test framework: node:test only, following mcp/test/smoke.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrate } from "../dist/migrate.js";
import { closeDb } from "../dist/index.js";
import { runBackfill } from "../dist/backfill-eater-tags.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbSrc = join(root, "..", "nycfoodie.db");

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "nycfoodie-backfill-"));
  const db = join(dir, "test.db");
  copyFileSync(dbSrc, db);
  return { dir, db };
}

function counts(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const q = (sql) => db.prepare(sql).get().n;
    return {
      tags: q("SELECT COUNT(*) AS n FROM tags"),
      listingTags: q("SELECT COUNT(*) AS n FROM listing_tags"),
      eaterTags: q("SELECT COUNT(*) AS n FROM tags WHERE source_slug = 'eater'"),
      eaterLinks: q(
        "SELECT COUNT(*) AS n FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id WHERE t.source_slug = 'eater'"
      ),
      infatuationTags: q("SELECT COUNT(*) AS n FROM tags WHERE source_slug = 'infatuation'"),
      infatuationLinks: q(
        "SELECT COUNT(*) AS n FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id WHERE t.source_slug = 'infatuation'"
      ),
      occasionTags: q("SELECT COUNT(*) AS n FROM tags WHERE kind = 'occasion'"),
      eaterRatings: q("SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater' AND rating IS NOT NULL"),
      eaterPrices: q("SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater' AND price_tier IS NOT NULL"),
      provenanceRows: q("SELECT COUNT(*) AS n FROM listing_tags WHERE assigned_by IS NOT NULL"),
    };
  } finally {
    db.close();
  }
}

test("migration 015 applies cleanly and adds provenance columns", () => {
  const { dir, db } = scratchDb();
  try {
    const applied = migrate(db);
    closeDb();
    assert.ok(applied.includes("015_listing_tag_provenance"), `expected 015 applied, got: ${applied}`);
    const probe = new Database(db, { readonly: true });
    const cols = probe.prepare("PRAGMA table_info(listing_tags)").all().map((c) => c.name);
    probe.close();
    assert.ok(cols.includes("assigned_by"), "assigned_by column present");
    assert.ok(cols.includes("assigned_at"), "assigned_at column present");
    // Pre-existing rows keep NULL provenance.
    const nulls = new Database(db, { readonly: true })
      .prepare("SELECT COUNT(*) AS n FROM listing_tags WHERE assigned_by IS NULL")
      .get().n;
    assert.ok(nulls > 0, "existing rows keep NULL provenance");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry run changes nothing and reports honest coverage", () => {
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    const before = counts(db);
    const report = runBackfill(db, "dry-run");
    const after = counts(db);
    assert.deepEqual(after, before, "dry run must not change any counts");
    assert.equal(report.mode, "dry-run");
    assert.equal(report.eaterOnlyRestaurants, 404);
    assert.ok(report.cuisine.venuesGained > 0, "some venues gain cuisine tags");
    assert.ok(report.neighbourhood.venuesGained > 0, "some venues gain neighbourhood tags");
    assert.ok(
      report.cuisine.venuesGained < report.eaterOnlyRestaurants,
      "coverage is partial by design, not 100%"
    );
    assert.equal(report.negativeControls.eater_occasion_tags, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write run is idempotent: two runs, identical result", () => {
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    const r1 = runBackfill(db, "write");
    const afterFirst = counts(db);
    assert.ok(afterFirst.eaterTags > 0, "eater-scoped tags created");
    assert.ok(afterFirst.provenanceRows > 0, "provenance recorded");
    assert.ok(r1.cuisine.listingsNew > 0 && r1.neighbourhood.listingsNew > 0, "first run writes links");
    // assigned_at of the first write, for the preservation check below.
    const probe = new Database(db, { readonly: true });
    const firstTimestamps = new Map(
      probe
        .prepare("SELECT source_listing_id, tag_id, assigned_at FROM listing_tags WHERE assigned_by IS NOT NULL")
        .all()
        .map((r) => [`${r.source_listing_id}|${r.tag_id}`, r.assigned_at])
    );
    probe.close();
    const r2 = runBackfill(db, "write");
    const afterSecond = counts(db);
    assert.deepEqual(afterSecond, afterFirst, "second write run changes nothing");
    assert.equal(r2.cuisine.listingsNew, 0, "no new cuisine links on re-run");
    assert.equal(r2.neighbourhood.listingsNew, 0, "no new neighbourhood links on re-run");
    const probe2 = new Database(db, { readonly: true });
    for (const r of probe2
      .prepare("SELECT source_listing_id, tag_id, assigned_at FROM listing_tags WHERE assigned_by IS NOT NULL")
      .all()) {
      assert.equal(
        r.assigned_at,
        firstTimestamps.get(`${r.source_listing_id}|${r.tag_id}`),
        "re-run preserves first-write timestamps"
      );
    }
    probe2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative controls hold and infatuation tags are untouched", () => {
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    const before = counts(db);
    runBackfill(db, "write");
    const after = counts(db);
    // No occasion tags anywhere, no eater ratings, prices unchanged.
    assert.equal(after.occasionTags, before.occasionTags, "no occasion tags created");
    assert.equal(after.eaterRatings, 0, "no eater rating created");
    assert.equal(after.eaterPrices, before.eaterPrices, "eater price_tier count unchanged");
    // Infatuation scope untouched.
    assert.equal(after.infatuationTags, before.infatuationTags, "infatuation tag rows unchanged");
    assert.equal(after.infatuationLinks, before.infatuationLinks, "infatuation tag links unchanged");
    // Every new link carries provenance; every eater tag is cuisine/neighbourhood.
    const probe = new Database(db, { readonly: true });
    const unprovenanced = probe
      .prepare(
        `SELECT COUNT(*) AS n FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
         WHERE t.source_slug = 'eater' AND lt.assigned_by IS NULL`
      )
      .get().n;
    assert.equal(unprovenanced, 0, "all eater links carry assigned_by");
    const badKinds = probe
      .prepare("SELECT COUNT(*) AS n FROM tags WHERE source_slug = 'eater' AND kind NOT IN ('cuisine', 'neighborhood')")
      .get().n;
    assert.equal(badKinds, 0, "eater tags are only cuisine/neighbourhood");
    // assigned_by values are the documented rule ids.
    const rules = probe
      .prepare("SELECT DISTINCT assigned_by AS r FROM listing_tags WHERE assigned_by IS NOT NULL")
      .all()
      .map((r) => r.r);
    assert.deepEqual(
      rules.sort(),
      ["backfill:neighborhood:v1", "guide-theme-map:v1"],
      "only the two documented rules"
    );
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("primary-listing coverage: every cuisine-tagged venue's primary listing carries the tag", () => {
  // The cuisine filter and search-card cuisines are primary-listing scoped.
  // A venue tagged only on a non-primary listing would be tagged yet
  // invisible to cuisine filters — the backfill must tag the primary too.
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    runBackfill(db, "write");
    const probe = new Database(db, { readonly: true });
    try {
      const missing = probe
        .prepare(
          `WITH prim AS (
             SELECT restaurant_id, id AS prim_id FROM (
               SELECT sl.restaurant_id, sl.id,
                 ROW_NUMBER() OVER (
                   PARTITION BY sl.restaurant_id
                   ORDER BY (rv.id IS NOT NULL) DESC,
                            sl.rating DESC,
                            (sl.name = r.name) DESC
                 ) AS rn
               FROM source_listings sl
               JOIN restaurants r ON r.id = sl.restaurant_id
               LEFT JOIN reviews rv ON rv.source_listing_id = sl.id
               WHERE sl.source_slug = 'eater'
             ) WHERE rn = 1
           )
           SELECT COUNT(DISTINCT r.id) AS n
           FROM restaurants r
           JOIN prim p ON p.restaurant_id = r.id
           WHERE EXISTS (
             SELECT 1 FROM source_listings sl
             JOIN listing_tags lt ON lt.source_listing_id = sl.id
             JOIN tags t ON t.id = lt.tag_id
             WHERE sl.restaurant_id = r.id AND sl.source_slug = 'eater'
               AND lt.assigned_by = 'guide-theme-map:v1' AND t.kind = 'cuisine'
           )
           AND NOT EXISTS (
             SELECT 1 FROM listing_tags lt
             JOIN tags t ON t.id = lt.tag_id
             WHERE lt.source_listing_id = p.prim_id
               AND lt.assigned_by = 'guide-theme-map:v1' AND t.kind = 'cuisine'
           )`
        )
        .get().n;
      assert.equal(missing, 0, "every cuisine-tagged venue has the tag on its primary listing");
    } finally {
      probe.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reversibility: deleting by assigned_by prefix removes the backfill", () => {
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    const before = counts(db);
    runBackfill(db, "write");
    const mid = counts(db);
    assert.ok(mid.eaterLinks > 0);
    const rw = new Database(db);
    rw.prepare(
      "DELETE FROM listing_tags WHERE assigned_by LIKE 'guide-theme-map:%' OR assigned_by LIKE 'backfill:neighborhood:%'"
    ).run();
    rw.prepare(
      `DELETE FROM tags WHERE source_slug = 'eater'
       AND NOT EXISTS (SELECT 1 FROM listing_tags lt WHERE lt.tag_id = tags.id)`
    ).run();
    rw.close();
    const after = counts(db);
    assert.equal(after.eaterLinks, 0, "all backfill links removed");
    assert.equal(after.eaterTags, 0, "orphaned eater tag rows removed");
    assert.equal(after.infatuationTags, before.infatuationTags, "infatuation tags intact after reversal");
    assert.equal(after.infatuationLinks, before.infatuationLinks, "infatuation links intact after reversal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
