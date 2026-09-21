// Tests for migration 015 (listing_tags provenance) and the Eater enrichment
// tag backfill. Runs against a scratch copy of the dataset DB — never the
// working copy. No test framework: node:test only, following mcp/test/smoke.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    const nullProbe = new Database(db, { readonly: true });
    const nulls = nullProbe
      .prepare("SELECT COUNT(*) AS n FROM listing_tags WHERE assigned_by IS NULL")
      .get().n;
    nullProbe.close();
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
    // DB-derived, not hard-coded: the count must match the backfill's own
    // eater-only definition so the test survives dataset refreshes.
    const eaterOnlyProbe = new Database(db, { readonly: true });
    const eaterOnlyDerived = eaterOnlyProbe
      .prepare(
        `SELECT COUNT(*) AS n FROM restaurants r WHERE r.city_slug = 'new-york'
         AND EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug = 'eater')
         AND NOT EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug <> 'eater')`
      )
      .get().n;
    eaterOnlyProbe.close();
    assert.ok(eaterOnlyDerived > 0, "dataset has eater-only restaurants");
    assert.equal(report.eaterOnlyRestaurants, eaterOnlyDerived, "report count matches the dataset");
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

test("pre-flight fails loudly when migration 015 has not been applied", () => {
  const { dir, db } = scratchDb();
  try {
    // No migrate(): the dataset copy lacks assigned_by/assigned_at.
    // counts() itself needs the 015 columns, so snapshot raw totals instead.
    const snap = () => {
      const p = new Database(db, { readonly: true });
      try {
        return {
          tags: p.prepare("SELECT COUNT(*) AS n FROM tags").get().n,
          listingTags: p.prepare("SELECT COUNT(*) AS n FROM listing_tags").get().n,
        };
      } finally {
        p.close();
      }
    };
    const before = snap();
    assert.throws(() => runBackfill(db, "write"), /assigned_by\/assigned_at/, "write aborts without migration 015");
    assert.throws(
      () => runBackfill(db, "dry-run"),
      /assigned_by\/assigned_at/,
      "dry run aborts without migration 015"
    );
    assert.deepEqual(snap(), before, "aborted run changes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unmatched-listing guard aborts the write before changing anything", () => {
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    const probe0 = new Database(db, { readonly: true });
    const total = probe0.prepare("SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater'").get().n;
    const unmatched = probe0
      .prepare("SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater' AND restaurant_id IS NULL")
      .get().n;
    probe0.close();
    const need = Math.floor(total * 0.05) + 1 - unmatched;
    assert.ok(need > 0 && need < total, "test needs headroom under the 5% threshold");
    const rw = new Database(db);
    rw.prepare(
      `UPDATE source_listings SET restaurant_id = NULL WHERE id IN (
         SELECT id FROM source_listings
         WHERE source_slug = 'eater' AND restaurant_id IS NOT NULL LIMIT ${need}
       )`
    ).run();
    rw.close();
    const before = counts(db);
    assert.throws(() => runBackfill(db, "write"), /backfill aborted/, "aborts over the 5% threshold");
    assert.deepEqual(counts(db), before, "aborted run changes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects conflicting or unknown flags without touching the DB", () => {
  // Regression: the entrypoint once resolved `--dry-run --write` to a write.
  // Conflicting mode flags and unknown flags must abort before runBackfill.
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    const before = counts(db);
    const script = join(root, "dist", "backfill-eater-tags.js");
    for (const args of [
      ["--dry-run", "--write", db],
      ["--write", "--dry-run", db],
      ["--bogus", db],
    ]) {
      let failed = false;
      try {
        execFileSync(process.execPath, [script, ...args], { stdio: "pipe" });
      } catch {
        failed = true;
      }
      assert.ok(failed, `CLI aborts for: ${args.join(" ")}`);
    }
    assert.deepEqual(counts(db), before, "aborted CLI invocations change nothing");
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

test("eater-scoped rows never feed the neighbourhood vocabulary", () => {
  // Regression: the vocabulary lookup once read every neighbourhood tag row,
  // so an eater-scoped 'eater-*' slug could be mistaken for the canonical
  // slug and ensureTag() would mint 'eater-eater-*' duplicates. The failure
  // was order-dependent (whichever row SQLite returned first won the Map),
  // so simulate the eater row winning by removing the infatuation canonical
  // row for one label - then the eater row is the only vocabulary candidate
  // and the old code deterministically double-prefixes.
  const { dir, db } = scratchDb();
  try {
    migrate(db);
    closeDb();
    const rw = new Database(db);
    // A label the backfill would genuinely tag: an eater-only listing whose
    // locality matches a canonical infatuation neighbourhood label.
    const seed = rw
      .prepare(
        `SELECT t.label AS label, t.slug AS slug
         FROM source_listings sl
         JOIN tags t ON t.kind = 'neighborhood' AND t.source_slug = 'infatuation'
           AND lower(t.label) = lower(trim(sl.locality))
         WHERE sl.source_slug = 'eater' AND sl.locality IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM source_listings s2
                           WHERE s2.restaurant_id = sl.restaurant_id AND s2.source_slug <> 'eater')
         LIMIT 1`
      )
      .get();
    assert.ok(seed, "seed fixture: eater-only listing with a canonical locality");
    // Seed a prior-run-shaped eater tag row for the label...
    rw.prepare(
      "INSERT INTO tags (id, city_slug, kind, slug, label, source_slug) VALUES ('00000000-0000-4000-8000-000000000001', 'new-york', 'neighborhood', ?, ?, 'eater')"
    ).run(`eater-${seed.slug}`, seed.label);
    // ...and remove the infatuation canonical row, so the eater row is the only
    // vocabulary candidate - the adversarial condition the old code mishandled.
    rw.prepare(
      "DELETE FROM tags WHERE kind = 'neighborhood' AND source_slug = 'infatuation' AND label = ?"
    ).run(seed.label);
    rw.close();
    runBackfill(db, "write");
    const probe = new Database(db, { readonly: true });
    try {
      const doublePrefixed = probe.prepare("SELECT COUNT(*) AS n FROM tags WHERE slug LIKE 'eater-eater-%'").get()
        .n;
      assert.equal(doublePrefixed, 0, "no eater-eater-* slugs created");
    } finally {
      probe.close();
    }
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
