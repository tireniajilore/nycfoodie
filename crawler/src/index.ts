#!/usr/bin/env node
// nycfoodie-crawler CLI.
//
//   nycfoodie-crawl reviews --city new-york [--dry-run] [--max-pages N]
//
// --dry-run (default) fetches live from the Infatuation GraphQL surface and
// prints a summary without writing to the database.

import { forEachSearchPage } from "./infatuation/graphql.js";
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
  const dryRun = !flag("write");

  console.log(
    `Fetching Infatuation reviews for city=${city} (maxPages=${maxPages}, dryRun=${dryRun})…`
  );

  let sample = 0;
  const { pages, nodes } = await forEachSearchPage(
    {
      attributePathText: `/${city}`,
      postCategoryTypeText: ["POST_REVIEW"],
      sizeNumber: 25,
      includeUnratedSpots: true,
    },
    (page) => {
      for (const n of page.nodes) {
        const r = n as RawPostReview;
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
      }
      return true;
    },
    { maxPages }
  );

  console.log(`Done: ${pages} page(s), ${nodes} review node(s).`);
  if (dryRun) console.log("Dry run — nothing written to the database.");
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
  nycfoodie-crawl reviews --city new-york [--max-pages N] [--write]

Options:
  --city       City slug (default: new-york)
  --max-pages  Cap on GraphQL pages fetched (default: 1)
  --write      Actually write to the database (default: dry run, no writes)`);
    break;
  default:
    console.error(`Unknown command: ${cmd}. Run \`nycfoodie-crawl help\`.`);
    process.exit(1);
}
