#!/usr/bin/env node
// nycfoodie-crawler CLI.
//
//   nycfoodie-crawl reviews --city new-york [--dry-run] [--max-pages N]
//
// --dry-run (default) fetches live from the Infatuation GraphQL surface and
// prints a summary without writing to the database.

import { forEachSearchPage, POLITE_DELAY_MS } from "./infatuation/graphql.js";
import {
  enrichReview,
  extractGuide,
  extractReview,
  fetchGuidePageData,
  fetchReviewPageData,
  listGuideSlugs,
} from "./infatuation/pagedata.js";
import { verifyPlace, sleep as googleSleep, RECHECK_DAYS } from "./google/places.js";
import {
  applyEnrichment,
  ensureCity,
  enrichmentCandidates,
  getCrawlCursor,
  googleVerifyCandidates,
  initStore,
  recordCrawlState,
  recordGoogleCheckedNoMatch,
  stampDatasetBuiltAt,
  recordGoogleVerification,
  upsertGuide,
  upsertGuideEntry,
  upsertReviewListing,
} from "./store.js";
import { closeDb } from "nycfoodie-db";
import type { RawPostReview } from "./infatuation/types.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1] ?? def;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function cmdReviews(): Promise<void> {
  const city = arg("city", "new-york")!;
  const maxPages = parseInt(arg("max-pages", "1")!, 10);
  const write = flag("write");
  const enrich = flag("enrich");
  const dbPath = arg("db", "./nycfoodie.db")!;

  if (write) {
    initStore(dbPath);
    ensureCity(city, city === "new-york" ? "New York" : city);
  }
  const resumeCursor = write ? getCrawlCursor(city, "reviews") : null;
  // A finished sweep is recorded with the "DONE" sentinel so reruns are a no-op.
  if (resumeCursor === "DONE") {
    console.log("Review sweep already complete — nothing to do.");
    if (write) closeDb();
    return;
  }
  if (resumeCursor) console.log("Resuming review sweep from saved cursor…");

  console.log(
    `Fetching Infatuation reviews for city=${city} (maxPages=${maxPages}, write=${write}, enrich=${enrich})…`
  );

  let sample = 0;
  let written = 0;
  let lastCursor: string | null = null;
  const { pages, nodes, completed } = await forEachSearchPage(
    {
      attributePathText: `/${city}`,
      postCategoryTypeText: ["POST_REVIEW"],
      sizeNumber: 25,
      includeUnratedSpots: true,
    },
    async (page) => {
      lastCursor = page.endCursor;
      for (const n of page.nodes) {
        const r = n as RawPostReview;
        if (!write) {
          if (sample < 5) {
            const rating =
              r.placeRatingNumber && r.placeRatingNumber > 0
                ? r.placeRatingNumber.toFixed(1)
                : "unrated";
            console.log(
              `  - ${r.placeName} | ${rating} | ${r.placePriceIndicatorCode ?? "?"} | ${(r.neighborhoods ?? []).map((x) => x.neighborhoodDisplayName).join(", ")} | ${(r.cuisines ?? []).map((x) => x.cuisineDisplayName || x.cuisineName).join(", ")}`
            );
            sample++;
          }
          continue;
        }
        try {
          let enriched = null;
          if (enrich && r.slugName) {
            try {
              enriched = await enrichReview(city, r.slugName);
            } catch (e) {
              console.error(`  ! enrichment failed for ${r.slugName}: ${String(e).slice(0, 120)}`);
            }
          }
          const res = upsertReviewListing(r, city, enriched);
          if (res) written++;
        } catch (e) {
          console.error(`  ! upsert failed for ${r.placeName}: ${String(e).slice(0, 160)}`);
        }
      }
      return true;
    },
    { maxPages, initialCursor: resumeCursor ?? undefined }
  );

  if (write) {
    recordCrawlState(city, "reviews", nodes, completed ? "DONE" : lastCursor);
    stampDatasetBuiltAt();
    closeDb();
  }
  console.log(`Done: ${pages} page(s), ${nodes} review node(s), ${written} written.`);
  if (!write) console.log("Dry run — nothing written to the database.");
}

const [cmd] = process.argv.slice(2);

switch (cmd) {
  case "reviews":
    await cmdReviews();
    break;
  case "google-verify":
    await cmdGoogleVerify();
    break;
  case "guides":
    await cmdGuides();
    break;
  case "enrich":
    await cmdEnrich();
    break;
  case undefined:
  case "help":
  case "--help":
    console.log(`nycfoodie-crawler — crawl editorial sources into nycfoodie-db.

Usage:
  nycfoodie-crawl reviews --city new-york [--max-pages N] [--write] [--enrich] [--db PATH]
  nycfoodie-crawl google-verify --city new-york --limit N --db PATH
  nycfoodie-crawl guides --city new-york [--limit N] [--write] [--db PATH]

Options (reviews):
  --city       City slug (default: new-york)
  --max-pages  Cap on GraphQL pages fetched (default: 1)
  --write      Write to the database (default: dry run, no writes)
  --enrich     Also fetch page data for full prose/venue detail (implies slower run)
  --db         SQLite path (default: ./nycfoodie.db)

Options (google-verify):
  --limit      Max venues to check (default: 20). Highest-rated first.
  --db         SQLite path (default: ./nycfoodie.db)
  Requires GOOGLE_PLACES_API_KEY in the environment.

Options (guides):
  --limit      Max guides to fetch (default: 3)
  --write      Write to the database (default: dry run, no writes)
  --db         SQLite path (default: ./nycfoodie.db)

Options (enrich):
  --limit       Max listings to enrich (default: 50). Highest-rated first.
  --concurrency Parallel fetch workers (default: 4)
  --write       Write to the database (default: dry run, no writes)
  --db          SQLite path (default: ./nycfoodie.db)`);
    break;
  default:
    console.error(`Unknown command: ${cmd}. Run \`nycfoodie-crawl help\`.`);
    process.exit(1);
}

/** Crawl guides: enumerate slugs, fetch each guide's ranked entries, link to listings. */
async function cmdGuides(): Promise<void> {
  const dbPath = arg("db", "./nycfoodie.db")!;
  const city = arg("city", "new-york")!;
  const limit = Number(arg("limit", "3")!);
  const write = process.argv.includes("--write");

  console.log(`Fetching Infatuation guides for city=${city} (limit=${limit}, write=${write})…`);
  const slugs = await listGuideSlugs(city);
  console.log(`${slugs.length} guide slug(s) enumerated from sitemaps.`);

  if (write) {
    initStore(dbPath);
    ensureCity(city, city === "new-york" ? "New York" : city);
  }
  const resumeSlug = write ? getCrawlCursor(city, "guides") : null;
  if (resumeSlug === "DONE") {
    console.log("Guide crawl already complete — nothing to do.");
    if (write) closeDb();
    return;
  }
  let startIdx = 0;
  if (resumeSlug) {
    const i = slugs.indexOf(resumeSlug);
    if (i >= 0) {
      startIdx = i + 1;
      console.log(`Resuming after ${resumeSlug}…`);
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let guides = 0;
  let entries = 0;
  let linked = 0;
  const queue = slugs.slice(startIdx, startIdx + limit);
  for (const slug of queue) {
    await sleep(POLITE_DELAY_MS);
    try {
      const state = await fetchGuidePageData(city, slug);
      const data = extractGuide(state, slug);
      if (!data) {
        console.error(`  ! ${slug}: no guide extracted`);
        continue;
      }
      if (write) {
        const guideId = upsertGuide(city, {
          sourceKey: data.sourceKey,
          title: data.title,
          url: `https://www.theinfatuation.com/${city}/guides/${slug}`,
          summary: data.description,
          publishedAt: data.publishedAt,
          updatedAt: data.updatedAt,
        });
        for (const e of data.entries) {
          const r = upsertGuideEntry(guideId, {
            position: e.rank,
            sourceKey: e.sourceKey,
            name: e.headline,
            blurb: [e.headline, e.blurb].filter(Boolean).join("\n\n"),
          });
          entries++;
          if (r.linked) linked++;
        }
        recordCrawlState(city, "guides", guides + 1, slug);
      }
      guides++;
      console.log(`  ✓ ${slug}: "${data.title}" — ${data.entries.length} entries`);
    } catch (e) {
      console.error(`  ! ${slug}: ${(e as Error).message}`);
    }
  }
  if (write) {
    const finishedAll = startIdx + queue.length >= slugs.length;
    recordCrawlState(city, "guides", guides, finishedAll ? "DONE" : (queue[queue.length - 1] ?? null));
    stampDatasetBuiltAt();
    closeDb();
  }
  console.log(`Done: ${guides} guide(s), ${entries} entries, ${linked} linked to listings.`);
  if (!write) console.log("Dry run — nothing written to the database.");
}

/**
 * Enrich rated listings with layer-B page data (prose, venue detail,
 * closure flags, dishes, perfect-for tags). Parallel workers, each polite.
 * Re-runs only pick up listings with no review prose yet.
 */
async function cmdEnrich(): Promise<void> {
  const dbPath = arg("db", "./nycfoodie.db")!;
  const city = arg("city", "new-york")!;
  const limit = Number(arg("limit", "50")!);
  const concurrency = Math.max(1, Number(arg("concurrency", "4")!));
  const write = flag("write");

  // Reads need the database even for a dry run; only enrichment writes are gated.
  initStore(dbPath);
  ensureCity(city, city === "new-york" ? "New York" : city);
  const candidates = enrichmentCandidates(city, limit);
  console.log(
    `Enriching ${candidates.length} rated listing(s) for city=${city} ` +
      `(concurrency=${concurrency}, write=${write})…`
  );
  if (candidates.length === 0) {
    closeDb();
    return;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const queue = candidates.slice();
  let done = 0;
  let ok = 0;
  let failed = 0;
  let dishes = 0;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const c = queue.shift()!;
      await sleep(2000); // per-worker politeness between requests
      try {
        const state = await fetchReviewPageData(city, c.source_key);
        const enriched = extractReview(state);
        if (!enriched) throw new Error("no review extracted from page data");
        if (write) applyEnrichment(city, c.id, c.source_url, enriched);
        dishes += enriched.dishes.length;
        ok++;
      } catch (e) {
        failed++;
        console.error(`  ! ${c.source_key}: ${String(e).slice(0, 140)}`);
      }
      done++;
      if (done % 50 === 0 || done === candidates.length) {
        console.log(`  … ${done}/${candidates.length} (ok=${ok}, failed=${failed})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  if (write) {
    recordCrawlState(city, "enrichment", ok, null);
    stampDatasetBuiltAt();
  }
  closeDb();
  console.log(`Done: ${ok} enriched, ${failed} failed, ${dishes} dishes.`);
  if (!write) console.log("Dry run — nothing written to the database.");
}

/** Cross-check venues against Google Places business_status. Paid API — bounded by --limit. */
async function cmdGoogleVerify(): Promise<void> {
  const apiKey = process.env["GOOGLE_PLACES_API_KEY"];
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY is not set. Aborting before spending anything.");
    process.exit(1);
  }
  const dbPath = arg("db", "./nycfoodie.db")!;
  const city = arg("city", "new-york")!;
  const limit = Number(arg("limit", "20")!);
  initStore(dbPath);
  ensureCity(city, city === "new-york" ? "New York" : city);

  const candidates = googleVerifyCandidates(city, limit, RECHECK_DAYS);
  console.log(`${candidates.length} venue(s) due for Google verification.`);
  let matched = 0;
  let closed = 0;
  for (const c of candidates) {
    let match;
    try {
      match = await verifyPlace(apiKey, c.name, c.lat, c.lng);
    } catch (e) {
      const status = (e as { status?: number }).status;
      console.error(`Places API error on "${c.name}" (HTTP ${status ?? "?"}). Stopping to avoid burn.`);
      break;
    }
    const checkedAt = new Date().toISOString();
    if (match) {
      recordGoogleVerification(c.id, match, checkedAt);
      matched++;
      if (match.businessStatus && match.businessStatus !== "OPERATIONAL") closed++;
      console.log(
        `  ✓ ${c.name} → ${match.businessStatus ?? "unknown"} (${match.confidence}, ${match.distanceM}m)`
      );
    } else {
      recordGoogleCheckedNoMatch(c.id, checkedAt);
      console.log(`  · ${c.name} → no safe match`);
    }
    await googleSleep(500);
  }
  closeDb();
  console.log(`Done: ${matched} matched, ${closed} non-operational flagged.`);
}
