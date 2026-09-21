// Crawl orchestration for the maps-only Eater crawler.
//
// One run:
//   1. Fetch robots.txt and refuse to run if /maps/ is disallowed for our UA.
//   2. Discover map URLs via the /maps index (or crawl a single --map slug).
//   3. For each map: polite fetch → raw HTML snapshot → parse → store.
// A map that fails to fetch or parse is logged and counted; it never aborts
// the rest of the crawl.

import { closeDb } from "nycfoodie-db";
import { resolve } from "node:path";
import { ensureCity } from "../store.js";
import { discoverMaps } from "./maps.js";
import { EaterParseError, parseMapPage } from "./parse.js";
import { FetchError, PoliteFetcher, type FetchResult } from "./fetcher.js";
import {
  fetchRobotsTxt,
  groupsForAgent,
  parseRobotsTxt,
  robotsAllows,
  robotsCrawlDelayMs,
  type RobotsGroup,
} from "./robots.js";
import {
  crawlEaterMap,
  hasEaterCrawlState,
  initEaterStore,
  recordEaterCrawlState,
  VenueLinker,
} from "./store.js";
import {
  EATER_BASE_URL,
  EATER_MIN_INTERVAL_MS,
  EATER_USER_AGENT,
  emptyStats,
  type EaterCrawlStats,
} from "./types.js";

export interface CrawlEaterMapsOptions {
  city?: string;
  dbPath?: string;
  baseUrl?: string;
  /** Crawl exactly one map slug instead of discovering via the index. */
  map?: string;
  /** Cap on maps fetched (safety bound for manual runs). */
  maxMaps?: number;
  /** Write to the database. Default false: dry run, fetch+parse only. */
  write?: boolean;
  /** Directory for raw HTML snapshots + fetch cache. Default: no snapshots. */
  snapshotDir?: string | null;
  userAgent?: string;
}

function mapSlugFromUrl(url: string): string {
  const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  return seg || "map";
}

export async function assertMapsCrawlable(
  baseUrl: string,
  userAgent: string,
  fetchRobots: () => Promise<string> = () => fetchRobotsTxt(baseUrl, userAgent)
): Promise<{ crawlDelayMs: number | null; groups: RobotsGroup[] }> {
  const text = await fetchRobots();
  const groups = parseRobotsTxt(text);
  const root = baseUrl.replace(/\/+$/, "");
  // Probe both the real discovery start URL and a representative map URL: a
  // rule like `Disallow: /maps$` blocks the index without blocking map
  // pages, and must fail here with the clear message, not mid-discovery.
  for (const probe of [`${root}/maps`, `${root}/maps/probe`]) {
    if (!robotsAllows(groups, userAgent, probe)) {
      const applicable = groupsForAgent(groups, userAgent).map((g) => g.agents.join(",")).join(" | ");
      throw new Error(
        `robots.txt disallows ${probe} for this user agent (matched groups: ${applicable || "none"}). Aborting.`
      );
    }
  }
  return { crawlDelayMs: robotsCrawlDelayMs(groups, userAgent), groups };
}

export async function crawlEaterMaps(opts: CrawlEaterMapsOptions = {}): Promise<EaterCrawlStats> {
  const city = opts.city ?? "new-york";
  const baseUrl = (opts.baseUrl ?? EATER_BASE_URL).replace(/\/+$/, "");
  const userAgent = opts.userAgent ?? EATER_USER_AGENT;
  const write = opts.write ?? false;
  const stats = emptyStats();

  // --base-url is operator input: refuse anything fetch() cannot safely
  // handle before it touches the network (or robots.txt handling).
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new Error(`invalid --base-url: ${opts.baseUrl}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`--base-url must be http(s), got: ${baseUrl}`);
  }

  // --map is operator input: validate it as a single slug before it is
  // concatenated into a URL. Plain traversal ("../about") and encoded
  // traversal ("%2e%2e/about") would otherwise escape /maps/ and let the
  // crawler fetch arbitrary same-origin pages the redirect guard never sees
  // (it only protects redirect targets, not the initial request).
  let mapSlug: string | null = null;
  if (opts.map !== undefined) {
    mapSlug = opts.map.replace(/^\/+/, "");
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(mapSlug)) {
      throw new Error(`--map must be a single map slug (letters, digits, "-" and "_"), got: ${opts.map}`);
    }
  }

  const { crawlDelayMs, groups } = await assertMapsCrawlable(baseUrl, userAgent);

  let linker: VenueLinker | null = null;
  let ignoreCache = false;
  if (write) {
    if (!opts.dbPath) throw new Error("--db is required with --write");
    initEaterStore(opts.dbPath);
    ensureCity(city, city === "new-york" ? "New York" : city);
    linker = new VenueLinker(city);
    // The fetch cache belongs to the database that produced it. On a fresh
    // DB (no prior Eater crawl state) it is ignored outright, so "not
    // modified" can never skip ingestion that never happened.
    ignoreCache = !hasEaterCrawlState(city);
  }

  // The try/finally covers everything after DB initialisation: if index
  // discovery (or anything else) throws, the connection is still closed.
  try {
    const fetcher = new PoliteFetcher({
      userAgent,
      // Honour a robots crawl-delay on top of our own 1 req/s floor.
      minIntervalMs: Math.max(EATER_MIN_INTERVAL_MS, crawlDelayMs ?? 0),
      snapshotDir: opts.snapshotDir ?? null,
      // Scope the cache file to the database path: two databases sharing one
      // snapshot directory must never share change-detection state.
      cacheScope: resolve(opts.dbPath ?? "./nycfoodie.db"),
      ignoreCache,
      // Per-request robots enforcement: the initial /maps/ probe is not enough —
      // a rule could disallow a specific map path the index links to.
      urlAllowed: (url) => robotsAllows(groups, userAgent, url),
      urlBlockedMessage: (url) => `robots.txt disallows ${url} for this user agent`,
    });

    let mapUrls: string[];
    if (mapSlug !== null) {
      mapUrls = [`${baseUrl}/maps/${mapSlug}`];
    } else {
      mapUrls = await discoverMaps(fetcher, { baseUrl });
    }
    stats.mapsDiscovered = mapUrls.length;
    if (opts.maxMaps !== undefined) mapUrls = mapUrls.slice(0, Math.max(0, opts.maxMaps));

    // Tracks whether this run actually ingested anything. Crawl state is
    // only recorded when true (see below): a zero-store run must not mark
    // the DB as crawled, or the next run would trust the fetch cache for
    // maps this database never ingested.
    let anyStored = false;

    for (const url of mapUrls) {
      const slug = mapSlugFromUrl(url);
      let result: FetchResult;
      try {
        result = await fetcher.fetch(url, slug, {
          // Dry runs validate fetching + parsing: never 304-skip, so parser
          // changes can be checked against currently unchanged pages.
          conditional: write,
        });
      } catch (e) {
        const reason = e instanceof FetchError ? `${e.message}` : (e as Error).message;
        console.log(`  ✗ ${slug}: fetch failed: ${reason}`);
        stats.mapsFailed++;
        continue;
      }
      if (result.status === 404) {
        console.log(`  ✗ ${slug}: gone (HTTP 404)`);
        stats.mapsFailed++;
        continue;
      }
      if (result.status === "not-modified" || result.unchanged || result.body === null) {
        // Hash-unchanged 200s carry a refreshed cache state (new
        // ETag/Last-Modified, same body): commit it in write mode so the
        // cache learns the rotated validators and stays 304-eligible. Safe
        // because this body was already parsed and stored on the run that
        // created the cache entry. Dry runs never commit cache state, and
        // commitCache is a no-op for 304s (no cacheState), so both skip
        // kinds flow through this safely.
        if (write) fetcher.commitCache(result);
        console.log(`  = ${slug}: not modified, skipping`);
        stats.mapsNotModified++;
        continue;
      }
      stats.mapsFetched++;

      let page;
      try {
        page = parseMapPage(result.body, url);
      } catch (e) {
        const reason = e instanceof EaterParseError ? e.message : (e as Error).message;
        console.log(`  ✗ ${slug}: parse failed: ${reason}`);
        stats.mapsFailed++;
        continue;
      }

      if (write) {
        try {
          crawlEaterMap(city, page, linker!, stats);
        } catch (e) {
          console.log(`  ✗ ${slug}: store failed: ${(e as Error).message}`);
          stats.mapsFailed++;
          // The map's transaction rolled back, but the in-memory linker may
          // still reference canonicals created inside it. Rebuild it so a
          // later map can never link to a phantom restaurant id.
          linker = new VenueLinker(city);
          continue;
        }
        // Commit the fetch cache only after the store succeeded: a map that
        // failed to store must be refetched — never 304-skipped — on the
        // next run. Dry runs never commit, so a dry run can never poison a
        // later --write run's change detection.
        anyStored = true;
        fetcher.commitCache(result);
        console.log(`  ✓ ${slug}: "${page.title}" — ${page.entries.length} entries`);
      } else {
        stats.entries += page.entries.length;
        console.log(`  · ${slug}: "${page.title}" — ${page.entries.length} entries (dry run)`);
      }
    }

    // Record crawl state only when this run ingested at least one map. A
    // zero-store run (fresh DB, every map failed, or --maxMaps 0) must not
    // mark the database as crawled: hasEaterCrawlState gates whether the
    // fetch cache is trusted, and "not modified" must mean "ingested by
    // this database", never "ingested by nobody".
    if (write && anyStored) {
      recordEaterCrawlState(city, "maps", stats.mapsFetched, null);
    }
  } finally {
    if (write) closeDb();
  }
  return stats;
}

export function printStats(stats: EaterCrawlStats): void {
  console.log(
    `\nDone: ${stats.mapsDiscovered} discovered, ${stats.mapsFetched} fetched, ` +
      `${stats.mapsNotModified} unchanged, ${stats.mapsFailed} failed.`
  );
  console.log(
    `Entries: ${stats.entries}, listings upserted: ${stats.listingsUpserted} ` +
      `(${stats.linked} linked, ${stats.unlinked} unlinked, ${stats.newCanonicals} new canonicals).`
  );
  // Loud, not fatal: addressless Eater entries are legitimate, so a high
  // unlinked ratio is a review signal, not a crawl failure. But a sudden
  // spike usually means the linker or the page structure broke — look.
  const total = stats.linked + stats.unlinked;
  if (total > 0 && stats.unlinked / total > 0.25) {
    console.log(
      `WARNING: ${stats.unlinked}/${total} entries unlinked (${Math.round(
        (stats.unlinked / total) * 100
      )}%) — above the 25% review threshold. Inspect flags before trusting this crawl.`
    );
  }
  for (const f of stats.flags.slice(0, 20)) console.log(`  flag: ${f}`);
  if (stats.flags.length > 20) console.log(`  … and ${stats.flags.length - 20} more flags`);
}
