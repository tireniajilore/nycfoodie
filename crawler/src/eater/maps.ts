// Eater NY map-guide discovery.
//
// Guide discovery walks the /maps index, following `rel="next"` pagination
// links, and collects every /maps/<slug> link. Pagination is bounded so a
// runaway index cannot turn the crawler into a site spider.

import type { FetchResult, PoliteFetcher } from "./fetcher.js";
import { EATER_BASE_URL, EATER_MAX_INDEX_PAGES } from "./types.js";

/** Minimal surface discoverMaps needs — lets tests inject a stub. */
export interface MapPageSource {
  fetch(url: string, label: string, opts?: { conditional?: boolean }): Promise<FetchResult>;
}

export interface MapIndex {
  /** Absolute map page URLs, deduplicated, in index order. */
  mapUrls: string[];
  /** Absolute URL of the next index page, if the index links one. */
  nextPageUrl: string | null;
}

function absolutize(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Extract map links and the next-page link from a /maps index page.
 * Pure function of the HTML — no fetching, fully testable.
 */
export function parseMapIndex(html: string, pageUrl: string): MapIndex {
  const mapUrls: string[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const abs = absolutize(pageUrl, m[1]);
    if (!abs) continue;
    let canonical: string;
    let path: string;
    try {
      const u = new URL(abs);
      path = u.pathname;
      // Canonicalise: tracking queries and fragments do not identify a
      // distinct map. Without this, /maps/x?utm=1 and /maps/x are crawled
      // (and cached) as two maps and fight over the same listings.
      u.search = "";
      u.hash = "";
      canonical = u.href;
    } catch {
      continue;
    }
    // /maps/<slug> only — not /maps itself, not /maps?page=N, not subpaths.
    if (/^\/maps\/[a-z0-9][a-z0-9_-]*$/i.test(path) && !seen.has(canonical)) {
      seen.add(canonical);
      mapUrls.push(canonical);
    }
  }
  let nextPageUrl: string | null = null;
  const linkRe = /<link\b[^>]*\brel="next"[^>]*\bhref="([^"]+)"[^>]*>/i;
  const linkRe2 = /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="next"[^>]*>/i;
  const next = linkRe.exec(html) ?? linkRe2.exec(html);
  if (next) nextPageUrl = absolutize(pageUrl, next[1]);
  return { mapUrls, nextPageUrl };
}

/**
 * Discover all Eater NY map URLs by walking index pagination. Stops at the
 * first page without a next link, or at maxPages (safety bound). Only
 * same-origin URLs are ever returned: an index page linking off-origin
 * (or the next-page link doing so) is not followed.
 */
export async function discoverMaps(
  fetcher: MapPageSource,
  opts: { baseUrl?: string; maxPages?: number } = {}
): Promise<string[]> {
  const baseUrl = (opts.baseUrl ?? EATER_BASE_URL).replace(/\/+$/, "");
  const origin = new URL(baseUrl).origin;
  const maxPages = opts.maxPages ?? EATER_MAX_INDEX_PAGES;
  const found: string[] = [];
  const seen = new Set<string>();
  const visitedPages = new Set<string>();
  let pageUrl: string | null = `${baseUrl}/maps`;
  let pages = 0;
  while (pageUrl && pages < maxPages && !visitedPages.has(pageUrl)) {
    visitedPages.add(pageUrl);
    pages++;
    // Index pages are always fetched unconditionally: a 304 here would yield
    // an empty discovery result on a warm cache, silently crawling nothing.
    const res = await fetcher.fetch(pageUrl, `index-page-${pages}`, { conditional: false });
    if (res.status === 404 || res.body === null) break;
    const { mapUrls, nextPageUrl } = parseMapIndex(res.body, pageUrl);
    for (const u of mapUrls) {
      if (!seen.has(u) && isSameOrigin(u, origin)) {
        seen.add(u);
        found.push(u);
      }
    }
    pageUrl = nextPageUrl && isIndexPage(nextPageUrl, origin) ? nextPageUrl : null;
  }
  return found;
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * True for the /maps index pagination shape only. Discovery must never
 * become a site spider: a changed or hostile index page cannot redirect the
 * crawl onto arbitrary same-origin pages via rel="next".
 */
function isIndexPage(url: string, origin: string): boolean {
  if (!isSameOrigin(url, origin)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.pathname !== "/maps") return false;
  return [...u.searchParams.keys()].every((k) => k === "page");
}
