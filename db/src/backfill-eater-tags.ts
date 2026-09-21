// Eater enrichment tag backfill — spec docs/eater-enrichment-spec.md §4.3, §4.5, §5.
//
// One-off data script (not the crawler): applies the curated guide-theme →
// cuisine map and the canonical neighbourhood 1:1 matcher to the Eater
// listings of Eater-only restaurants, creating eater-scoped tags.
//
// Only Eater-only restaurants are tagged in v1: the spec's goal is making the
// 404 discoverable, and restricting the write keeps infatuation-primary
// venues' behaviour unchanged. Cross-source enrichment can follow later.
//
// Usage: node dist/backfill-eater-tags.js [--dry-run|--write] [db-path]
//   --dry-run (default)  compute and report, change nothing (DB opened read-only)
//   --write              idempotent insert; aborts before any write if a
//                        safety check fails
//   db-path defaults to ./nycfoodie.db
//
// Safety:
// - Never writes, modifies or deletes infatuation-scoped tags (asserted).
// - No rating, price_tier or occasion tag is created for any venue (asserted
//   in-script, inside the write transaction: a failure rolls everything back).
// - If Eater listings with no restaurant link exceed 5% of all Eater listings,
//   the run aborts before any write instead of guessing.
// - Idempotent: re-running inserts nothing new; first-write timestamps kept.
// - Reversible: DELETE FROM listing_tags
//                 WHERE assigned_by LIKE 'guide-theme-map:%'
//                    OR assigned_by LIKE 'backfill:neighborhood:%';
//   then delete eater-scoped tag rows left without links.
//
// Requires migration 015 (listing_tags.assigned_by / assigned_at) — run the
// db migrate script first. No LLMs, no network; pure SQLite.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { openDb, openReadDb, closeDb } from "./index.js";

const CITY = "new-york";
const CUISINE_RULE = "guide-theme-map:v1";
const NEIGHBOURHOOD_RULE = "backfill:neighborhood:v1";
const UNMATCHED_THRESHOLD = 0.05;

// Curated static map: exact Eater guide title → [cuisine label, cuisine slug].
// Conservative: only unambiguous cuisine-themed guides. Broad guides ("The 38
// Best Restaurants"), occasion guides (happy hour, date night, group dinner,
// late-night, kid-friendly, romantic, takeout), neighbourhood roundups
// (including Koreatown / Flushing's Chinatown / Little Italy — neighbourhood
// guides are never mapped, even when the cuisine looks obvious), dietary
// guides (halal, kosher, gluten-free), dish guides with no matching label
// (candy, chicken wings, pancakes, spice bags, Thanksgiving pies), and
// identity/format themes (queer bars, dine-at-the-bar, all-you-can-eat)
// are deliberately unmapped. Labels and slugs reuse the existing Infatuation
// cuisine vocabulary so filters match the same way.
const GUIDE_THEME_MAP: Array<[string, string, string]> = [
  ["13 Essential Manhattan Bakeries", "Bakery/Cafe", "bakery-cafe"],
  ["15 Places to Try Tea in NYC", "Tea", "tea"],
  ["15 Top Mexican Restaurants in the East Village", "Mexican", "mexican"],
  ["19 Crowd-Pleasing Dim Sum Parlors in NYC", "Dim Sum", "dim-sum"],
  ["23 Exemplary Chinese Soup Dumplings in NYC", "Chinese", "chinese"],
  ["30 Snappy, Standout Hot Dogs Around NYC", "Hot Dogs", "hot-dogs"],
  ["Best Affordable Sushi in NYC", "Sushi", "sushi"],
  ["Best Breakfast Sandwiches in NYC", "Sandwiches", "sandwiches"],
  ["Best Persian Restaurants in NYC", "Persian", "persian"],
  ["Essential Ice Cream Shops in New York City", "Ice Cream", "ice-cream"],
  ["The Best Bagels in New York City, According to Eater Editors", "Bagels", "bagels"],
  ["The Best Barbecue Restaurants in NYC", "BBQ", "bbq"],
  ["The Best Burgers in New York City, According to Eater Editors", "Burgers", "burgers"],
  ["The Best Cake Slices in NYC, According to Food Baby", "Dessert", "dessert"],
  ["The Best Chinese Restaurants Around NYC", "Chinese", "chinese"],
  ["The Best Cocktail Bars of New York City, According to Eater Editors", "Bar", "bar"],
  ["The Best Coffee Shops in New York City, According to Eater Editors", "Coffee", "coffee"],
  ["The Best Croissants in NYC, According to Eater Editors", "Bakery/Cafe", "bakery-cafe"],
  ["The Best Desserts in NYC, According to Eater Editors", "Dessert", "dessert"],
  ["The Best Diners in NYC", "Diner", "diner"],
  ["The Best Dive Bars in New York City", "Bar", "bar"],
  ["The Best Doughnuts Around NYC", "Donuts", "donuts"],
  ["The Best French Restaurants in NYC", "French", "french"],
  ["The Best Fried Chicken in New York City", "Fried Chicken", "fried-chicken"],
  ["The Best Gelato in New York", "Ice Cream", "ice-cream"],
  ["The Best Indian Restaurants in NYC", "Indian", "indian"],
  ["The Best Italian Restaurants in New York City", "Italian", "italian"],
  ["The Best Mexican Restaurants in NYC, According to Eater Editors", "Mexican", "mexican"],
  ["The Best New Bakeries in NYC", "Bakery/Cafe", "bakery-cafe"],
  ["The Best New Cocktail Bars in New York City, According to Eater Editors", "Bar", "bar"],
  ["The Best NYC Places to Drink Wine", "Wine Bar", "wine-bar"],
  ["The Best Pizza Slices in NYC, According to Eater Editors", "Pizza", "pizza"],
  ["The Best Places for Pasta in NYC and NJ", "Pasta", "pasta"],
  ["The Best Sandwiches in NYC", "Sandwiches", "sandwiches"],
  ["The Best Seafood Restaurants in NYC, According to Eater Editors", "Seafood", "seafood"],
  ["The Best Seafood Towers in New York City", "Seafood", "seafood"],
  ["The Best Smash Burgers in New York City", "Burgers", "burgers"],
  ["The Best Soft Serve in New York City", "Ice Cream", "ice-cream"],
  ["The Best Sports Bars in NYC", "Bar", "bar"],
  ["The Best Steakhouses in New York City", "Steakhouse", "steakhouse"],
  ["The Best Sushi Restaurants in Manhattan", "Sushi", "sushi"],
  ["The Best Tacos in NYC, According to Eater Editors", "Tacos", "tacos"],
  ["The Best Taiwanese Restaurants in NYC", "Taiwanese", "taiwanese"],
  ["The Best Thai Restaurants in NYC", "Thai", "thai"],
  ["The Best Vegetarian Restaurants in New York City", "Vegetarian", "vegetarian"],
  ["Where To Find the City’s Best Ramen", "Ramen", "ramen"],
];

// Locality normalisations to canonical neighbourhood labels. Explicit and
// tiny: 'Bronx' unambiguously means the canonical 'The Bronx'. Nothing else
// is aliased — 'New York' and 'Manhattan' have no canonical label and stay
// untagged rather than guessed. No labels are coined: every target label is
// verified against the existing neighbourhood vocabulary at runtime.
const LOCALITY_ALIASES: Record<string, string> = {
  bronx: "The Bronx",
};

export interface BackfillReport {
  mode: "dry-run" | "write";
  dbPath: string;
  eaterOnlyRestaurants: number;
  eaterListings: number;
  unmatchedListings: number;
  unmatchedRatio: number;
  cuisine: {
    guidesMapped: number;
    listingsTagged: number;
    venuesGained: number;
    listingsNew: number;
  };
  neighbourhood: {
    listingsTagged: number;
    venuesGained: number;
    listingsNew: number;
  };
  negativeControls: Record<string, number>;
  warnings: string[];
}

function fail(msg: string): never {
  throw new Error(`backfill aborted: ${msg}`);
}

export function runBackfill(dbPath: string, mode: "dry-run" | "write"): BackfillReport {
  const warnings: string[] = [];
  // Dry runs open read-only: the report is computed, nothing can be written.
  const db: Database.Database = mode === "dry-run" ? openReadDb(dbPath) : openDb(dbPath);
  try {
    // --- Pre-flight: migration 015 present? --------------------------------
    const cols = (
      db.prepare("PRAGMA table_info(listing_tags)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("assigned_by") || !cols.includes("assigned_at")) {
      fail("listing_tags is missing assigned_by/assigned_at — run the db migrate script first (migration 015).");
    }
    if (!db.prepare("SELECT 1 FROM cities WHERE slug = ?").get(CITY)) fail(`city '${CITY}' missing`);
    if (!db.prepare("SELECT 1 FROM sources WHERE slug = 'eater'").get()) fail("source 'eater' missing");

    // --- Pre-flight: curated labels reuse the existing vocabulary ----------- 
    const vocab = new Map<string, string>(); // label -> slug, infatuation cuisine
    for (const row of db
      .prepare("SELECT label, slug FROM tags WHERE kind = 'cuisine' AND source_slug = 'infatuation'")
      .all() as Array<{ label: string; slug: string }>) {
      vocab.set(row.label, row.slug);
    }
    for (const [, label, slug] of GUIDE_THEME_MAP) {
      const expected = vocab.get(label);
      if (expected === undefined) fail(`curated label '${label}' is not in the cuisine vocabulary`);
      if (expected !== slug) fail(`curated slug '${slug}' does not match vocabulary slug '${expected}' for '${label}'`);
    }

    // --- Pre-flight: every mapped guide title resolves to an Eater guide ---
    // A missing title means the dataset changed under the curated map: fail
    // loudly so a human reviews the map instead of silently skipping guides.
    const guideIdByTitle = new Map<string, string>();
    for (const [title] of GUIDE_THEME_MAP) {
      const row = db
        .prepare("SELECT id FROM guides WHERE source_slug = 'eater' AND title = ?")
        .get(title) as { id: string } | undefined;
      if (!row) fail(`mapped guide title not found in the dataset: '${title}'`);
      guideIdByTitle.set(title, row.id);
    }

    // --- Unmatched-listing guard -------------------------------------------
    const eaterListings = (
      db.prepare("SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater'").get() as {
        n: number;
      }
    ).n;
    const unmatchedListings = (
      db
        .prepare("SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater' AND restaurant_id IS NULL")
        .get() as { n: number }
    ).n;
    const unmatchedRatio = eaterListings === 0 ? 0 : unmatchedListings / eaterListings;
    if (unmatchedRatio > UNMATCHED_THRESHOLD) {
      fail(
        `${unmatchedListings}/${eaterListings} Eater listings have no restaurant link ` +
          `(${(unmatchedRatio * 100).toFixed(1)}% > 5%) — stopping for manual review instead of guessing.`
      );
    }

    // --- Eater-only restaurant set ------------------------------------------
    const eaterOnlyIds = (
      db
        .prepare(
          `SELECT r.id FROM restaurants r WHERE r.city_slug = ?
           AND EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug = 'eater')
           AND NOT EXISTS (SELECT 1 FROM source_listings sl WHERE sl.restaurant_id = r.id AND sl.source_slug <> 'eater')`
        )
        .all(CITY) as Array<{ id: string }>
    ).map((r) => r.id);
    const eaterOnlySet = new Set(eaterOnlyIds);

    const negativeControls = (): Record<string, number> => {
      const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      return {
        eater_occasion_tags: q("SELECT COUNT(*) AS n FROM tags WHERE source_slug = 'eater' AND kind = 'occasion'"),
        eater_unexpected_tag_kinds: q(
          "SELECT COUNT(*) AS n FROM tags WHERE source_slug = 'eater' AND kind NOT IN ('cuisine', 'neighborhood')"
        ),
        eater_listings_with_rating: q(
          "SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater' AND rating IS NOT NULL"
        ),
        eater_listings_with_price_tier: q(
          "SELECT COUNT(*) AS n FROM source_listings WHERE source_slug = 'eater' AND price_tier IS NOT NULL"
        ),
        infatuation_tags: q("SELECT COUNT(*) AS n FROM tags WHERE source_slug = 'infatuation'"),
        infatuation_tag_links: q(
          `SELECT COUNT(*) AS n FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
           WHERE t.source_slug = 'infatuation'`
        ),
      };
    };
    const controlsBefore = negativeControls();

    // --- Planned writes ------------------------------------------------------
    // Cuisine: eater listings of eater-only restaurants appearing in mapped guides.
    type Plan = { listingId: string; restaurantId: string; kind: string; label: string; slug: string; rule: string };
    const plans: Plan[] = [];
    const entriesStmt = db.prepare(
      `SELECT DISTINCT sl.id AS listing_id, sl.restaurant_id AS restaurant_id
       FROM guide_entries ge JOIN source_listings sl ON sl.id = ge.source_listing_id
       WHERE ge.guide_id = ? AND sl.source_slug = 'eater'`
    );
    for (const [title, label, slug] of GUIDE_THEME_MAP) {
      const guideId = guideIdByTitle.get(title)!;
      for (const row of entriesStmt.all(guideId) as Array<{ listing_id: string; restaurant_id: string }>) {
        if (row.restaurant_id && eaterOnlySet.has(row.restaurant_id)) {
          plans.push({ listingId: row.listing_id, restaurantId: row.restaurant_id, kind: "cuisine", label, slug, rule: CUISINE_RULE });
        }
      }
    }

    // Neighbourhood: 1:1 locality → canonical label matches on eater listings
    // of eater-only restaurants. Locality is the listing's own address field;
    // guide themes are never used for neighbourhoods.
    const neighbourhoodLabels = new Map<string, { label: string; slug: string }>(); // lower -> row
    for (const row of db
      .prepare("SELECT DISTINCT label, slug FROM tags WHERE kind = 'neighborhood'")
      .all() as Array<{ label: string; slug: string }>) {
      if (!neighbourhoodLabels.has(row.label.toLowerCase())) {
        neighbourhoodLabels.set(row.label.toLowerCase(), { label: row.label, slug: row.slug });
      }
    }
    for (const alias of Object.values(LOCALITY_ALIASES)) {
      if (!neighbourhoodLabels.has(alias.toLowerCase())) {
        fail(`locality alias target '${alias}' is not a canonical neighbourhood label`);
      }
    }
    const listingsStmt = db.prepare(
      "SELECT id, restaurant_id, locality FROM source_listings WHERE source_slug = 'eater' AND restaurant_id IS NOT NULL"
    );
    for (const row of listingsStmt.all() as Array<{ id: string; restaurant_id: string; locality: string | null }>) {
      if (!eaterOnlySet.has(row.restaurant_id)) continue;
      const loc = (row.locality ?? "").trim().toLowerCase();
      if (!loc) continue;
      const canonical = neighbourhoodLabels.get(loc) ?? neighbourhoodLabels.get((LOCALITY_ALIASES[loc] ?? "").toLowerCase());
      if (!canonical) continue;
      plans.push({ listingId: row.id, restaurantId: row.restaurant_id, kind: "neighborhood", label: canonical.label, slug: canonical.slug, rule: NEIGHBOURHOOD_RULE });
    }

    // --- Apply (write mode only) ---------------------------------------------
    const findTag = db.prepare(
      "SELECT id FROM tags WHERE city_slug = ? AND kind = ? AND slug = ? AND source_slug = 'eater'"
    );
    const insertTag = db.prepare(
      "INSERT INTO tags (id, city_slug, kind, slug, label, source_slug) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const linkExists = db.prepare(
      "SELECT 1 FROM listing_tags WHERE source_listing_id = ? AND tag_id = ?"
    );
    const insertLink = db.prepare(
      "INSERT INTO listing_tags (source_listing_id, tag_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)"
    );
    const tagIdCache = new Map<string, string>();
    const ensureTag = (kind: string, label: string, slug: string): string => {
      // tags has UNIQUE(city_slug, kind, slug) across sources, so eater-scoped
      // rows take an 'eater-' slug prefix. Labels are unchanged, and every
      // read path matches on kind + label, never slug.
      const eslug = `eater-${slug}`;
      const cached = tagIdCache.get(eslug);
      if (cached) return cached;
      const existing = findTag.get(CITY, kind, eslug) as { id: string } | undefined;
      if (existing) {
        tagIdCache.set(eslug, existing.id);
        return existing.id;
      }
      const id = randomUUID();
      insertTag.run(id, CITY, kind, eslug, label, "eater");
      tagIdCache.set(eslug, id);
      return id;
    };

    let listingsNewCuisine = 0;
    let listingsNewNeighbourhood = 0;
    if (mode === "write") {
      const now = new Date().toISOString();
      const apply = db.transaction(() => {
        for (const p of plans) {
          const tagId = ensureTag(p.kind, p.label, p.slug);
          if (!linkExists.get(p.listingId, tagId)) {
            insertLink.run(p.listingId, tagId, p.rule, now);
            if (p.kind === "cuisine") listingsNewCuisine++;
            else listingsNewNeighbourhood++;
          }
        }
        // Negative controls inside the transaction: any failure rolls back.
        const after = negativeControls();
        if (after.eater_occasion_tags !== 0) fail("negative control: eater occasion tag created");
        if (after.eater_unexpected_tag_kinds !== 0) fail("negative control: eater tag of unexpected kind created");
        if (after.eater_listings_with_rating !== controlsBefore.eater_listings_with_rating) {
          fail("negative control: eater listing rating changed");
        }
        if (after.eater_listings_with_price_tier !== controlsBefore.eater_listings_with_price_tier) {
          fail("negative control: eater listing price_tier changed");
        }
        if (after.infatuation_tags !== controlsBefore.infatuation_tags) fail("negative control: infatuation tags changed");
        if (after.infatuation_tag_links !== controlsBefore.infatuation_tag_links) {
          fail("negative control: infatuation tag links changed");
        }
      });
      apply();
    }

    // --- Coverage -------------------------------------------------------------
    const gained = (rule: string): { listings: number; venues: number } => {
      const rows = db
        .prepare(
          `SELECT COUNT(DISTINCT lt.source_listing_id) AS listings,
                  COUNT(DISTINCT sl.restaurant_id) AS venues
           FROM listing_tags lt JOIN source_listings sl ON sl.id = lt.source_listing_id
           WHERE lt.assigned_by = ? AND sl.restaurant_id IS NOT NULL`
        )
        .get(rule) as { listings: number; venues: number };
      return { listings: rows.listings, venues: rows.venues };
    };
    // In dry-run nothing was written, so measure against the plan instead.
    const planCoverage = (rule: string) => {
      const listings = new Set<string>();
      const venues = new Set<string>();
      for (const p of plans) {
        if (p.rule === rule) {
          listings.add(p.listingId);
          venues.add(p.restaurantId);
        }
      }
      return { listings: listings.size, venues: venues.size };
    };
    const cuisineCov = mode === "write" ? gained(CUISINE_RULE) : planCoverage(CUISINE_RULE);
    const neighbourhoodCov = mode === "write" ? gained(NEIGHBOURHOOD_RULE) : planCoverage(NEIGHBOURHOOD_RULE);

    const report: BackfillReport = {
      mode,
      dbPath,
      eaterOnlyRestaurants: eaterOnlyIds.length,
      eaterListings,
      unmatchedListings,
      unmatchedRatio,
      cuisine: {
        guidesMapped: GUIDE_THEME_MAP.length,
        listingsTagged: cuisineCov.listings,
        venuesGained: cuisineCov.venues,
        listingsNew: listingsNewCuisine,
      },
      neighbourhood: {
        listingsTagged: neighbourhoodCov.listings,
        venuesGained: neighbourhoodCov.venues,
        listingsNew: listingsNewNeighbourhood,
      },
      negativeControls: mode === "write" ? negativeControls() : controlsBefore,
      warnings,
    };
    return report;
  } finally {
    // Write mode uses the openDb singleton; dry-run opens its own read-only
    // handle, which closeDb() would not release.
    if (mode === "dry-run") db.close();
    else closeDb();
  }
}

export function printReport(r: BackfillReport): void {
  const pct = (n: number) => (n / Math.max(1, r.eaterOnlyRestaurants)) * 100;
  console.log(`Eater enrichment backfill — ${r.mode === "write" ? "WRITE" : "DRY RUN"}`);
  console.log(`Database: ${r.dbPath}`);
  console.log(`Eater-only restaurants: ${r.eaterOnlyRestaurants}`);
  console.log(
    `Unmatched eater listings: ${r.unmatchedListings}/${r.eaterListings} ` +
      `(${(r.unmatchedRatio * 100).toFixed(1)}%; abort threshold 5%)`
  );
  console.log(
    `Cuisine: ${r.cuisine.guidesMapped} guides mapped; ` +
      `${r.cuisine.listingsTagged} listings tagged; ` +
      `${r.cuisine.venuesGained} of ${r.eaterOnlyRestaurants} venues gained a cuisine tag ` +
      `(${pct(r.cuisine.venuesGained).toFixed(1)}%)` +
      (r.mode === "write" ? `; ${r.cuisine.listingsNew} new links this run` : "")
  );
  console.log(
    `Neighbourhood: ${r.neighbourhood.listingsTagged} listings tagged; ` +
      `${r.neighbourhood.venuesGained} of ${r.eaterOnlyRestaurants} venues gained a neighbourhood tag ` +
      `(${pct(r.neighbourhood.venuesGained).toFixed(1)}%)` +
      (r.mode === "write" ? `; ${r.neighbourhood.listingsNew} new links this run` : "")
  );
  console.log("Negative controls:");
  for (const [k, v] of Object.entries(r.negativeControls)) console.log(`  ${k}: ${v}`);
  for (const w of r.warnings) console.log(`WARNING: ${w}`);
  if (r.mode === "dry-run") console.log("Dry run: no rows written.");
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const mode: "dry-run" | "write" = args.includes("--write") ? "write" : "dry-run";
  const dbPath = args.find((a) => !a.startsWith("--")) ?? join(process.cwd(), "nycfoodie.db");
  try {
    const report = runBackfill(dbPath, mode);
    printReport(report);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
