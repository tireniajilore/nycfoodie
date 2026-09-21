// Tests for the Eater crawler's database write path: idempotent upserts,
// composite keys, variant-tolerant linking, and the honesty rules (no
// ratings, no invented prices, no auto-merge on ambiguity).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "nycfoodie-db";
import {
  crawlEaterMap,
  initEaterStore,
  recordEaterCrawlState,
  upsertEaterGuide,
  VenueLinker,
} from "../dist/eater/store.js";
import { emptyStats } from "../dist/eater/types.js";

const CITY = "new-york";

function freshDb() {
  closeDb();
  const dbPath = join(mkdtempSync(join(tmpdir(), "eater-store-")), "test.db");
  initEaterStore(dbPath);
  getDb()
    .prepare(
      `INSERT INTO cities (slug, name, country_code, timezone, created_at)
       VALUES ('new-york', 'New York', 'US', 'America/New_York', '2026-01-01T00:00:00Z')`
    )
    .run();
  return dbPath;
}

function seedRestaurant(name, addressLine1) {
  const id = `r-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      `INSERT INTO restaurants (id, city_slug, name, address_line1, created_at, updated_at)
       VALUES (?, 'new-york', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(id, name, addressLine1);
  return id;
}

function entry(over = {}) {
  return {
    position: 1,
    name: "Test Venue",
    blurb: "A blurb.",
    phone: null,
    website: null,
    address_line1: "1 Main St",
    locality: "New York",
    region: "NY",
    postal_code: "10001",
    latitude: 40.7128,
    longitude: -74.006,
    alsoFeaturedIn: [],
    ...over,
  };
}

function page(over = {}) {
  return {
    slug: "test-map",
    title: "The Test Map",
    url: "https://ny.eater.com/maps/test-map",
    publishedAt: null,
    updatedAt: null,
    entries: [entry()],
    ...over,
  };
}

function crawl(p, stats = emptyStats()) {
  crawlEaterMap(CITY, p, new VenueLinker(CITY), stats);
  return stats;
}

const count = (table, where = "") =>
  getDb().prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get().c;

test("upsertEaterGuide is idempotent and refreshes title/url", () => {
  freshDb();
  const g = { sourceKey: "m", title: "Old", url: "https://ny.eater.com/maps/m", publishedAt: null, updatedAt: null };
  const id1 = upsertEaterGuide(CITY, g);
  const id2 = upsertEaterGuide(CITY, { ...g, title: "New" });
  assert.equal(id1, id2);
  assert.equal(count("guides"), 1);
  assert.equal(getDb().prepare(`SELECT title FROM guides WHERE id = ?`).get(id1).title, "New");
  assert.equal(getDb().prepare(`SELECT guide_type FROM guides WHERE id = ?`).get(id1).guide_type, "eater-map");
});

test("crawl creates guide + listing with composite key + ranked entry", () => {
  freshDb();
  const stats = crawl(page());
  assert.equal(count("guides"), 1);
  assert.equal(count("source_listings"), 1);
  assert.equal(count("guide_entries"), 1);
  const listing = getDb().prepare(`SELECT * FROM source_listings`).get();
  assert.equal(listing.source_key, "test-map/test-venue");
  assert.equal(listing.source_slug, "eater");
  assert.equal(getDb().prepare(`SELECT position, blurb FROM guide_entries`).get().position, 1);
  assert.equal(getDb().prepare(`SELECT blurb FROM guide_entries`).get().blurb, "A blurb.");
  assert.equal(stats.entries, 1);
});

test("coordinates and also-featured-in cross-refs are persisted with provenance", () => {
  freshDb();
  crawl(
    page({
      entries: [
        entry({
          name: "Cross Ref Venue",
          latitude: 40.815576,
          longitude: -73.90649,
          alsoFeaturedIn: ["https://ny.eater.com/maps/other-map"],
        }),
      ],
    })
  );
  const row = getDb()
    .prepare(
      `SELECT latitude, longitude, also_featured_in_json FROM source_listings WHERE source_key = ?`
    )
    .get("test-map/cross-ref-venue");
  assert.equal(row.latitude, 40.815576);
  assert.equal(row.longitude, -73.90649);
  assert.deepEqual(JSON.parse(row.also_featured_in_json), ["https://ny.eater.com/maps/other-map"]);

  // Recrawl with emptied cross-refs refreshes them (map crawl owns the column).
  crawl(page({ entries: [entry({ name: "Cross Ref Venue", alsoFeaturedIn: [] })] }));
  const row2 = getDb()
    .prepare(`SELECT also_featured_in_json FROM source_listings WHERE source_key = ?`)
    .get("test-map/cross-ref-venue");
  assert.equal(row2.also_featured_in_json, null);
});

test("links to an existing restaurant on exact name", () => {
  freshDb();
  const rid = seedRestaurant("Katz's Deli", "205 E Houston St, New York, NY 10002");
  const stats = crawl(page({ entries: [entry({ name: "Katz's Deli", address_line1: "205 E Houston St" })] }));
  const listing = getDb().prepare(`SELECT restaurant_id FROM source_listings`).get();
  assert.equal(listing.restaurant_id, rid);
  assert.equal(stats.linked, 1);
  assert.equal(stats.unlinked, 0);
});

test("variant-tolerant linking: diacritics and punctuation", () => {
  freshDb();
  const rid = seedRestaurant("La Piraña Lechonera", "226 7th Avenue, Brooklyn, NY 11215");
  crawl(page({ entries: [entry({ name: "La Pirana Lechonera", address_line1: "226 7th Avenue" })] }));
  const listing = getDb().prepare(`SELECT restaurant_id FROM source_listings`).get();
  assert.equal(listing.restaurant_id, rid);
});

test("new canonical created when name + address present, flagged when not", () => {
  freshDb();
  const stats = crawl(
    page({
      entries: [
        entry({ position: 1, name: "Brand New Spot", address_line1: "99 New St" }),
        entry({ position: 2, name: "Mystery Spot", address_line1: null }),
      ],
    })
  );
  assert.equal(count("restaurants"), 1);
  const created = getDb().prepare(`SELECT name, address_line1 FROM restaurants`).get();
  assert.equal(created.name, "Brand New Spot");
  const listings = getDb().prepare(`SELECT name, restaurant_id FROM source_listings ORDER BY name`).all();
  assert.equal(listings[0].restaurant_id !== null, true);
  assert.equal(listings[1].restaurant_id, null);
  assert.equal(stats.newCanonicals, 1);
  assert.equal(stats.unlinked, 1);
  assert.ok(stats.flags.some((f) => f.includes("unlinked-no-address") && f.includes("Mystery Spot")));
});

test("address match with a totally different name is flagged, never merged", () => {
  freshDb();
  seedRestaurant("Old Name", "10 Main St");
  const before = count("restaurants");
  const stats = crawl(
    page({ entries: [entry({ name: "Totally Different", address_line1: "10 Main St" })] })
  );
  assert.equal(count("restaurants"), before); // no duplicate created
  const listing = getDb().prepare(`SELECT restaurant_id FROM source_listings`).get();
  assert.equal(listing.restaurant_id, null);
  assert.ok(stats.flags.some((f) => f.includes("address-match-name-mismatch")));
});

test("ambiguous address match is flagged, never merged", () => {
  freshDb();
  seedRestaurant("Alpha", "10 Main St");
  seedRestaurant("Beta", "10 Main St");
  const stats = crawl(page({ entries: [entry({ name: "Gamma", address_line1: "10 Main St" })] }));
  assert.equal(count("restaurants"), 2);
  assert.ok(stats.flags.some((f) => f.includes("address-ambiguous")));
});

test("recrawl is idempotent: no duplicate guides, listings, or entries", () => {
  freshDb();
  crawl(page({ entries: [entry({ position: 1, name: "A" }), entry({ position: 2, name: "B" })] }));
  const stats = crawl(page({ entries: [entry({ position: 1, name: "A" }), entry({ position: 2, name: "B" })] }));
  assert.equal(count("guides"), 1);
  assert.equal(count("source_listings"), 2);
  assert.equal(count("guide_entries"), 2);
  assert.equal(stats.listingsUpserted, 2);
});

test("recrawl resolves a previously unlinked entry without duplicating", () => {
  freshDb();
  crawl(page({ entries: [entry({ name: "Late Bloomer", address_line1: null })] }));
  assert.equal(getDb().prepare(`SELECT restaurant_id FROM source_listings`).get().restaurant_id, null);
  const stats = crawl(
    page({ entries: [entry({ name: "Late Bloomer", address_line1: "5 Late St" })] })
  );
  assert.equal(count("source_listings"), 1);
  assert.notEqual(getDb().prepare(`SELECT restaurant_id FROM source_listings`).get().restaurant_id, null);
  assert.equal(stats.linked, 1);
});

test("Eater never writes ratings or prices; recrawls preserve other paths' values", () => {
  freshDb();
  crawl(page());
  const fresh = getDb().prepare(`SELECT rating, rating_scale, price_tier, price_label FROM source_listings`).get();
  assert.equal(fresh.rating, null);
  assert.equal(fresh.rating_scale, null);
  assert.equal(fresh.price_tier, null);
  assert.equal(fresh.price_label, null);
  // Simulate another path writing structured data onto the listing.
  getDb().prepare(`UPDATE source_listings SET price_tier = 2, rating = 8.5, rating_scale = 10`).run();
  crawl(page());
  const after = getDb().prepare(`SELECT rating, rating_scale, price_tier FROM source_listings`).get();
  assert.equal(after.price_tier, 2);
  assert.equal(after.rating, 8.5);
  assert.equal(after.rating_scale, 10);
});

test("recrawl refreshes name/address/phone but keeps first_seen_at", () => {
  freshDb();
  crawl(page({ entries: [entry({ name: "Old Name", phone: null })] }));
  const first = getDb().prepare(`SELECT id, first_seen_at FROM source_listings`).get();
  crawl(page({ entries: [entry({ name: "New Name", phone: "(212) 555-0000" })] }));
  const after = getDb().prepare(`SELECT * FROM source_listings`).get();
  assert.equal(after.id, first.id);
  assert.equal(after.name, "New Name");
  assert.equal(after.phone, "(212) 555-0000");
  assert.equal(after.first_seen_at, first.first_seen_at);
});

test("duplicate venue names in one map get #position-suffixed keys", () => {
  freshDb();
  crawl(
    page({
      entries: [
        entry({ position: 1, name: "Same Name", address_line1: null }),
        entry({ position: 2, name: "Same Name", address_line1: null }),
      ],
    })
  );
  const keys = getDb()
    .prepare(`SELECT source_key FROM source_listings ORDER BY source_key`)
    .all()
    .map((r) => r.source_key);
  assert.deepEqual(keys, ["test-map/same-name", "test-map/same-name#2"]);
  // Recrawl keeps both rows stable.
  crawl(
    page({
      entries: [
        entry({ position: 1, name: "Same Name", address_line1: null }),
        entry({ position: 2, name: "Same Name", address_line1: null }),
      ],
    })
  );
  assert.equal(count("source_listings"), 2);
});

test("recordEaterCrawlState writes a crawl watermark", () => {
  freshDb();
  recordEaterCrawlState(CITY, "maps", 12, null);
  const row = getDb().prepare(`SELECT * FROM crawl_state`).get();
  assert.equal(row.source_slug, "eater");
  assert.equal(row.city_slug, CITY);
  assert.equal(row.collection, "maps");
  assert.equal(row.item_count, 12);
  recordEaterCrawlState(CITY, "maps", 15, null);
  assert.equal(count("crawl_state"), 1);
  assert.equal(getDb().prepare(`SELECT item_count FROM crawl_state`).get().item_count, 15);
});

test("teardown closes the singleton", () => {
  closeDb();
});
