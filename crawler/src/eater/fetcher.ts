// Polite HTTP fetcher for the Eater crawler.
//
// Guarantees, by construction rather than convention:
// - at most 1 concurrent request (all fetches serialise through one queue)
// - at least `minIntervalMs` (default 1000) between request starts
// - the contact user agent on every request
// - honour for 429/503: Retry-After is respected, 5xx/network errors back off
// - conditional requests (ETag / Last-Modified) plus content-hash change
//   detection, so unchanged pages are recognised without re-parsing
// - raw HTML snapshots on disk for every changed fetch, for later reparsing
// - /search (and friends) can never be fetched, whatever the caller asks

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EATER_FETCH_TIMEOUT_MS,
  EATER_FORBIDDEN_PATH_PREFIXES,
  EATER_MAX_REDIRECTS,
  EATER_MAX_RETRIES,
  EATER_MIN_INTERVAL_MS,
  EATER_USER_AGENT,
} from "./types.js";

export class FetchError extends Error {
  readonly url: string;
  readonly status: number | null;
  /** True when the failure is transient and the fetch loop may retry it. */
  readonly retryable: boolean;
  constructor(url: string, status: number | null, message: string, retryable = false) {
    super(message);
    this.name = "FetchError";
    this.url = url;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface FetchResult {
  url: string;
  /** 200 on fresh content, 304/"not-modified" when unchanged, 404 when gone. */
  status: number | "not-modified";
  body: string | null;
  /** True when the content hash matches the last snapshot (no change). */
  unchanged: boolean;
  /** Path of the snapshot written for this fetch, if any. */
  snapshotPath: string | null;
  /**
   * The cache entry this fetch would commit — returned, never written. The
   * caller persists it via commitCache() only after downstream work (parse +
   * store) succeeds, so a failed map is refetched rather than 304-skipped
   * on the next run. Null when there is nothing new to remember.
   */
  cacheState: CacheEntry | null;
}

export interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  sha256: string | null;
}

/** Per-call options for PoliteFetcher.fetch. */
export interface FetchCallOptions {
  /**
   * Send conditional headers (If-None-Match / If-Modified-Since) from the
   * cache. Default true. Index/discovery fetches pass false: they always
   * need the full body, and a 304 on /maps must never yield an empty
   * discovery result.
   */
  conditional?: boolean;
}

export interface PoliteFetcherOptions {
  userAgent?: string;
  /** Minimum ms between request starts. Default: 1000 (1 req/s). */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Directory for raw HTML snapshots and the conditional-request cache.
   * Snapshots land in `<snapshotDir>/<name>/<timestamp>.html`. When null,
   * nothing is written to disk (used by dry runs and tests).
   */
  snapshotDir?: string | null;
  /** Injectable fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Optional per-URL allowlist consulted on every fetch, after the built-in
   * forbidden-path check. The crawler wires its parsed robots.txt groups
   * here so a rule disallowing a specific map path is honoured even though
   * the /maps/ prefix probe passed.
   */
  urlAllowed?: (url: string) => boolean;
  /**
   * Namespace for the on-disk fetch cache. The cache file is
   * `.fetch-cache-<sha1(scope)>.json` inside snapshotDir, so two different
   * databases sharing one snapshot directory never share change-detection
   * state. The crawler passes the resolved --db path.
   */
  cacheScope?: string;
  /**
   * Skip loading any persisted cache. The crawler sets this in write mode
   * when the DB shows no prior Eater crawl: on a fresh database "not
   * modified" must never skip ingestion that never happened. Commits still
   * work, so the run populates the cache for next time.
   */
  ignoreCache?: boolean;
  /** Message for the FetchError thrown when urlAllowed returns false. */
  urlBlockedMessage?: (url: string) => string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Pathname with percent-encoding resolved, for safety checks. Many servers
 * route `/se%61rch` identically to `/search`, so guards must compare the
 * decoded form. Re-parsing after decoding also normalises encoded
 * separators (%2F) and dot segments the way a server would. Returns null
 * when the path is undecodable — callers fail closed on null.
 */
function decodedPathname(url: string): string | null {
  let raw: string;
  try {
    raw = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!raw.includes("%")) return raw.toLowerCase();
  try {
    return new URL(decodeURIComponent(raw), "https://placeholder.invalid").pathname.toLowerCase();
  } catch {
    return null;
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function snapshotTimestamp(d = new Date()): string {
  // Filesystem-safe UTC timestamp: 2026-09-21T10-30-00-123Z
  return d.toISOString().replace(/[:.]/g, "-");
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms. */
function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 3600) * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 3600_000));
  return null;
}

export class PoliteFetcher {
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly snapshotDir: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly urlAllowed: ((url: string) => boolean) | null;
  private readonly urlBlockedMessage: ((url: string) => string) | null;
  private readonly cachePath: string | null;
  private cache: Record<string, CacheEntry> = {};

  /** Serialises all fetches: at most 1 concurrent request, ever. */
  private queue: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(opts: PoliteFetcherOptions = {}) {
    this.userAgent = opts.userAgent ?? EATER_USER_AGENT;
    this.minIntervalMs = opts.minIntervalMs ?? EATER_MIN_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? EATER_FETCH_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? EATER_MAX_RETRIES;
    this.snapshotDir = opts.snapshotDir ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.urlAllowed = opts.urlAllowed ?? null;
    this.urlBlockedMessage = opts.urlBlockedMessage ?? null;
    const scopeHash = createHash("sha1")
      .update(opts.cacheScope ?? "default", "utf8")
      .digest("hex")
      .slice(0, 12);
    this.cachePath = this.snapshotDir ? join(this.snapshotDir, `.fetch-cache-${scopeHash}.json`) : null;
    if (this.cachePath && !opts.ignoreCache) this.cache = this.loadCache();
    if (this.cachePath && opts.ignoreCache) {
      // The cache belongs to the database that produced it. A run that
      // ignores the cache is working with a fresh database, so a stale
      // cache file left by a previous database at the same path is deleted —
      // not just skipped in memory — or a later run could trust it for maps
      // this database never ingested. Best-effort: a failed delete must not
      // fail a crawl.
      try {
        rmSync(this.cachePath, { force: true });
      } catch {
        // ignore
      }
    }
  }

  private loadCache(): Record<string, CacheEntry> {
    try {
      const raw = readFileSync(this.cachePath!, "utf8");
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveCache(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(this.snapshotDir!, { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 1));
    } catch {
      // Cache persistence is best-effort; a failed write must not fail a crawl.
    }
  }

  private assertAllowed(url: string): void {
    const path = decodedPathname(url);
    if (path === null) {
      throw new FetchError(url, null, `refusing to fetch undecodable URL`);
    }
    for (const prefix of EATER_FORBIDDEN_PATH_PREFIXES) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        throw new FetchError(url, null, `refusing to fetch forbidden path ${path}`);
      }
    }
  }

  /**
   * Fetch a URL politely. Calls serialise: concurrent callers queue behind
   * each other, each waiting its turn plus the rate-limit interval.
   *
   * The fetch cache is read but never written here: the returned
   * `cacheState` is committed via commitCache() only after the caller has
   * successfully processed the body. A dry run therefore has no persistent
   * side effects, and a map whose store failed is refetched — never
   * 304-skipped — on the next run.
   */
  async fetch(url: string, snapshotName?: string, opts?: FetchCallOptions): Promise<FetchResult> {
    this.assertAllowed(url);
    if (this.urlAllowed && !this.urlAllowed(url)) {
      throw new FetchError(
        url,
        null,
        this.urlBlockedMessage ? this.urlBlockedMessage(url) : `refusing to fetch blocked URL ${url}`
      );
    }
    const run = this.queue.then(() => this.doFetch(url, snapshotName, opts));
    // Keep the chain alive even if this fetch rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Persist a fetch result's cache state. Call only after the body has been
   * fully processed (parsed and stored); never on dry runs, never after a
   * failure. "Not modified" must always mean "already ingested".
   */
  commitCache(url: string, result: FetchResult): void {
    if (!result.cacheState) return;
    this.cache[url] = result.cacheState;
    this.saveCache();
  }

  private isRedirect(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  /**
   * Validate a redirect target BEFORE any request goes to it. The target
   * must stay on the original origin, inside the /maps area, off the
   * forbidden paths, and allowed by the per-request robots hook.
   */
  private assertRedirectAllowed(originalUrl: string, origin: string, target: URL, status: number): void {
    // Compare the decoded path: /se%61rch must match the /search guard.
    // Undecodable paths fail closed.
    const p = decodedPathname(target.href);
    if (p === null) {
      throw new FetchError(originalUrl, status, `redirect to undecodable path: ${target.pathname}`);
    }
    if (target.origin !== origin) {
      throw new FetchError(originalUrl, status, `redirect leaves origin: ${target.origin}`);
    }
    if (!(p === "/maps" || p.startsWith("/maps/"))) {
      throw new FetchError(originalUrl, status, `redirect leaves the maps area: ${target.href}`);
    }
    this.assertAllowed(target.href);
    if (this.urlAllowed && !this.urlAllowed(target.href)) {
      throw new FetchError(
        originalUrl,
        status,
        this.urlBlockedMessage
          ? this.urlBlockedMessage(target.href)
          : `refusing to follow redirect to blocked URL ${target.href}`
      );
    }
  }

  private async doFetch(url: string, snapshotName?: string, opts?: FetchCallOptions): Promise<FetchResult> {
    const conditional = opts?.conditional !== false;
    const cached = conditional ? this.cache[url] : undefined;
    // assertAllowed already parsed this URL in fetch(); it cannot fail here.
    const origin = new URL(url).origin;
    let currentUrl = url;
    let redirects = 0;
    let attempt = 0;
    for (;;) {
      attempt++;
      // The 1 req/s floor applies to every request start, including retries
      // and redirect hops: a backoff sleep shorter than the floor must not
      // let a retry jump the queue.
      const wait = this.minIntervalMs - (Date.now() - this.lastStart);
      if (wait > 0) await this.sleepImpl(wait);
      this.lastStart = Date.now();

      const ctrl = new AbortController();
      // The timer bounds the whole attempt — headers AND body. A server that
      // resolves headers then stalls forever on res.text() still trips it.
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { "User-Agent": this.userAgent };
        if (cached?.etag) headers["If-None-Match"] = cached.etag;
        if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
        // Manual redirect handling: validate the Location target before any
        // request goes to it, so an off-origin or forbidden redirect never
        // receives even one request from us.
        let res: Response;
        try {
          res = await this.fetchImpl(currentUrl, { headers, redirect: "manual", signal: ctrl.signal });
        } catch (e) {
          throw new FetchError(url, null, `network error: ${(e as Error).message}`, true);
        }

      if (this.isRedirect(res.status)) {
        await res.arrayBuffer().catch(() => undefined); // drain before the next hop
        redirects++;
        if (redirects > EATER_MAX_REDIRECTS) {
          throw new FetchError(url, res.status, `too many redirects (>${EATER_MAX_REDIRECTS}) starting at ${url}`);
        }
        const location = res.headers.get("location");
        if (!location) {
          throw new FetchError(url, res.status, `redirect without a Location header`);
        }
        let target: URL;
        try {
          target = new URL(location, currentUrl);
        } catch {
          throw new FetchError(url, res.status, `redirect to unparseable Location: ${location}`);
        }
        this.assertRedirectAllowed(url, origin, target, res.status);
        currentUrl = target.href;
        continue;
      }
      if (res.status === 304) {
        return { url, status: "not-modified", body: null, unchanged: true, snapshotPath: null, cacheState: null };
      }
      if (res.status === 404) {
        return { url, status: 404, body: null, unchanged: false, snapshotPath: null, cacheState: null };
      }
      if (res.status === 429) {
        if (attempt > this.maxRetries) {
          throw new FetchError(url, 429, `rate limited after ${attempt} attempts`);
        }
        const waitMs = retryAfterMs(res.headers.get("retry-after")) ?? this.backoffMs(attempt);
        await res.arrayBuffer().catch(() => undefined); // drain
        await this.sleepImpl(waitMs);
        continue;
      }
      if (res.status >= 500) {
        await res.arrayBuffer().catch(() => undefined); // drain
        if (attempt > this.maxRetries) {
          throw new FetchError(url, res.status, `server error after ${attempt} attempts`);
        }
        // Honour Retry-After on 503 the same way the 429 branch does: a
        // server that asks us to wait 120s must not be retried in ~2s.
        const waitMs = retryAfterMs(res.headers.get("retry-after")) ?? this.backoffMs(attempt);
        await this.sleepImpl(waitMs);
        continue;
      }
      if (!res.ok) {
        throw new FetchError(url, res.status, `unexpected HTTP ${res.status}`);
      }

      let body: string;
      try {
        body = await res.text();
      } catch (e) {
        // Headers resolved but the body stalled or broke mid-read: same
        // handling as a network error, and still inside the abort timer.
        throw new FetchError(url, res.status, `body read failed: ${(e as Error).message}`, true);
      }
      const hash = sha256Hex(body);
      if (cached?.sha256 === hash) {
        // Same body as the cached copy, but the server may have rotated its
        // validators (ETag/Last-Modified). Return the fresh validators with
        // the unchanged body instead of a null cache state: committing them
        // keeps future runs 304-eligible rather than re-downloading the full
        // page forever. Safe: this body was already ingested on the run that
        // created the cache entry. No new snapshot — the body is byte-identical.
        const cacheState: CacheEntry = {
          etag: res.headers.get("etag"),
          lastModified: res.headers.get("last-modified"),
          sha256: hash,
        };
        return { url, status: 200, body, unchanged: true, snapshotPath: null, cacheState };
      }
      // Snapshot first, cache second: a failed snapshot must not poison the
      // cache into believing this content was already preserved. When a
      // snapshotDir is configured, snapshots are a hard requirement — a
      // write failure throws and the map is counted as failed, never
      // silently snapshotless. The cache entry itself is only returned, not
      // written: the caller commits it after parse + store succeed.
      let snapshotPath: string | null = null;
      if (this.snapshotDir && snapshotName) {
        snapshotPath = this.writeSnapshot(snapshotName, body);
      }
      const cacheState: CacheEntry = {
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        sha256: hash,
      };

      return { url, status: 200, body, unchanged: false, snapshotPath, cacheState };
      } catch (e) {
        // Transient failures (network errors, body stalls) are retried with
        // backoff; intentional refusals (redirect policy, unexpected status,
        // blocked URL, snapshot write failure) propagate immediately.
        if (e instanceof FetchError && e.retryable && attempt <= this.maxRetries) {
          await this.sleepImpl(this.backoffMs(attempt));
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Exponential backoff with jitter: 1s, 2s, 4s, … capped at 30s. */
  private backoffMs(attempt: number): number {
    const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  /**
   * Write a raw HTML snapshot. Throws on failure: when snapshots are
   * configured they are a provenance requirement, not best-effort.
   */
  private writeSnapshot(name: string, body: string): string {
    const safeName = name.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "page";
    const dir = join(this.snapshotDir!, safeName);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${snapshotTimestamp()}.html`);
    writeFileSync(path, body);
    return path;
  }
}
