// Shared types and politeness constants for the maps-only Eater crawler.
//
// Design (docs/eater-enrichment-spec.md §4.1, rev 3): the crawler targets
// Eater NY `/maps/` pages only. Map entries carry name, blurb, address,
// phone and website inline, so no venue-page crawl is needed. Entries are
// keyed by the existing `{guide-slug}/{venue-slug}` composite.

/** Source identifiers, matching the rows already in the dataset. */
export const EATER_SOURCE_SLUG = "eater";
export const EATER_SOURCE_NAME = "Eater";
export const EATER_BASE_URL = "https://ny.eater.com";

/**
 * Contact user agent. robots.txt on ny.eater.com restricts library-default
 * UAs (python-requests, Scrapy, ApifyBot, GPTBot et al.) to /sp/ only; an
 * honest custom UA with a project contact is allowed on /maps/.
 */
export const EATER_USER_AGENT =
  "nycfoodie-crawler/1.0 (+https://github.com/tireniajilore/nycfoodie)";

/** Polite crawl parameters: 1 request per second, 1 concurrent connection. */
export const EATER_MIN_INTERVAL_MS = 1000;
export const EATER_FETCH_TIMEOUT_MS = 30_000;
export const EATER_MAX_RETRIES = 5;
/** Upper bound on redirect hops followed for a single fetch. */
export const EATER_MAX_REDIRECTS = 5;

/** Upper bound on /maps index pagination while discovering guides. */
export const EATER_MAX_INDEX_PAGES = 25;

/** Paths the crawler must never fetch, whatever robots.txt says. */
export const EATER_FORBIDDEN_PATH_PREFIXES = ["/search"];

export interface EaterAddress {
  address_line1: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
}

/** One ranked entry on an Eater map page. */
export interface EaterMapEntry {
  /** 1-based rank within the guide, in document order. */
  position: number;
  name: string;
  /** Verbatim editorial blurb (plaintext), may be null. */
  blurb: string | null;
  phone: string | null;
  website: string | null;
  address_line1: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  /** Map pin coordinates from the page's location object, when present. */
  latitude: number | null;
  longitude: number | null;
  /**
   * Permalinks of other Eater maps featuring this venue ("Also featured
   * in") — a cheap guide-discovery signal.
   */
  alsoFeaturedIn: string[];
}

/** A parsed Eater map page. */
export interface EaterMapPage {
  /** Map slug, e.g. "bargain-sushi-new-york". */
  slug: string;
  title: string;
  url: string;
  /** Map-level timestamps from the page, when present. */
  publishedAt: string | null;
  updatedAt: string | null;
  entries: EaterMapEntry[];
}

export interface EaterCrawlStats {
  mapsDiscovered: number;
  mapsFetched: number;
  mapsNotModified: number;
  mapsFailed: number;
  entries: number;
  listingsUpserted: number;
  linked: number;
  unlinked: number;
  newCanonicals: number;
  flags: string[];
}

export function emptyStats(): EaterCrawlStats {
  return {
    mapsDiscovered: 0,
    mapsFetched: 0,
    mapsNotModified: 0,
    mapsFailed: 0,
    entries: 0,
    listingsUpserted: 0,
    linked: 0,
    unlinked: 0,
    newCanonicals: 0,
    flags: [],
  };
}
