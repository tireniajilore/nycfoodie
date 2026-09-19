#!/usr/bin/env node
// nycfoodie-crawler CLI.
//
//   nycfoodie-crawl reviews --city new-york [--dry-run] [--max-pages N]
//
// --dry-run (default) fetches live from the Infatuation GraphQL surface and
// prints a summary without writing to the database.

import { forEachSearchPage } from "./infatuation/graphql.js";
import { enrichReview } from "./infatuation/pagedata.js";
import { ensureCity, initStore, recordCrawlState, upsertReviewListing } from "./store.js";
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

  console.log(
    `Fetching Infatuation reviews for city=${city} (maxPages=${maxPages}, write=${write}, enrich=${enrich})…`
  );

  let sample = 0;
  let written = 0;
  let lastCursor: string | null = null;
  const { pages, nodes } = await forEachSearchPage(
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
    { maxPages }
  );

  if (write) {
    recordCrawlState(city, "reviews", nodes, lastCursor);
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
  case undefined:
  case "help":
  case "--help":
    console.log(`nycfoodie-crawler — crawl editorial sources into nycfoodie-db.

Usage:
  nycfoodie-crawl reviews --city new-york [--max-pages N] [--write] [--enrich] [--db PATH]

Options:
  --city       City slug (default: new-york)
  --max-pages  Cap on GraphQL pages fetched (default: 1)
  --write      Write to the database (default: dry run, no writes)
  --enrich     Also fetch page data for full prose/venue detail (implies slower run)
  --db         SQLite path (default: ./nycfoodie.db)`);
    break;
  default:
    console.error(`Unknown command: ${cmd}. Run \`nycfoodie-crawl help\`.`);
    process.exit(1);
}
