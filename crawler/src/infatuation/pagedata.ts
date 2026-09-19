// Enrichment from The Infatuation's server-rendered page data.
//
// Each review/guide page ships its full dataset as JSON:
//   /_next/data/<buildId>/{city}/reviews|guides/{slug}.json
// which contains the same pageProps.initialApolloState as __NEXT_DATA__.
// No auth needed; same polite fetching as the GraphQL client.

import { USER_AGENT } from "./client.js";
import { POLITE_DELAY_MS, sleep } from "./graphql.js";

export const INFATUATION_BASE = "https://www.theinfatuation.com";

export interface EnrichedVenue {
  name: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  url: string | null;
  instagram: string | null;
  price: number | null;
  closed: boolean | null;
  closedStatus: string | null;
  lat: number | null;
  lon: number | null;
  reservationUrl: string | null;
}

export interface EnrichedDish {
  name: string;
  description: string | null;
}

export interface EnrichedReview {
  title: string | null;
  headline: string | null;
  preview: string | null;
  rating: number | null;
  bodyMarkdown: string;
  publishedAt: string | null;
  author: string | null;
  venue: EnrichedVenue;
  perfectFor: string[];
  dishes: EnrichedDish[];
}

type ApolloState = Record<string, unknown>;

function isRef(v: unknown): v is { __ref: string } {
  return typeof v === "object" && v !== null && "__ref" in v && typeof (v as { __ref: unknown }).__ref === "string";
}

/** Resolve __ref pointers in a normalised Apollo cache (cycle-safe, depth-limited). */
function deref(state: ApolloState, value: unknown, seen = new Set<string>(), depth = 0): unknown {
  if (depth > 12) return value;
  if (isRef(value)) {
    if (seen.has(value.__ref)) return null;
    seen.add(value.__ref);
    return deref(state, state[value.__ref], seen, depth + 1);
  }
  if (Array.isArray(value)) return value.map((v) => deref(state, v, new Set(seen), depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deref(state, v, new Set(seen), depth + 1);
    return out;
  }
  return value;
}

interface RichTextNode {
  nodeType: string;
  value?: string;
  marks?: Array<{ type: string }>;
  data?: { uri?: string };
  content?: RichTextNode[];
}

/** Convert a Contentful rich-text document to lightweight markdown. */
export function richTextToMarkdown(doc: unknown): string {
  const root = doc as RichTextNode;
  if (!root || root.nodeType !== "document" || !Array.isArray(root.content)) return "";
  const parts: string[] = [];
  const inline = (nodes: RichTextNode[] = []): string =>
    nodes
      .map((n) => {
        if (n.nodeType === "text") {
          let t = n.value ?? "";
          const marks = new Set((n.marks ?? []).map((m) => m.type));
          if (marks.has("code")) t = `\`${t}\``;
          if (marks.has("bold")) t = `**${t}**`;
          if (marks.has("italic")) t = `_${t}_`;
          return t;
        }
        if (n.nodeType === "hyperlink" && n.data?.uri) return `[${inline(n.content)}](${n.data.uri})`;
        return inline(n.content);
      })
      .join("");
  for (const n of root.content) {
    if (n.nodeType === "paragraph") {
      const t = inline(n.content).trim();
      if (t) parts.push(t);
    } else if (n.nodeType.startsWith("heading-")) {
      const level = parseInt(n.nodeType.slice(8), 10) || 2;
      const t = inline(n.content).trim();
      if (t) parts.push(`${"#".repeat(Math.min(level, 6))} ${t}`);
    }
    // embedded-entry-block nodes (galleries etc.) are skipped in prose;
    // dish-like entries are harvested separately.
  }
  return parts.join("\n\n");
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Harvest dish-like embedded entries from rich-text links (defensive: unknown types are ignored). */
function harvestDishes(links: unknown): EnrichedDish[] {
  const dishes: EnrichedDish[] = [];
  const l = links as { entries?: { block?: unknown[]; inline?: unknown[] } } | null;
  const blocks = [...(l?.entries?.block ?? []), ...(l?.entries?.inline ?? [])] as Array<
    Record<string, unknown>
  >;
  for (const b of blocks) {
    const t = b["__typename"];
    if (t === "Dish" || t === "FoodRundownItem" || t === "MenuItem") {
      const name = (b["name"] ?? b["title"]) as string | undefined;
      if (name) dishes.push({ name, description: (b["description"] as string) ?? null });
    }
  }
  return dishes;
}

let cachedBuildId: string | null = null;

/** Scrape the current Next.js buildId from a page's HTML (cached per run). */
export async function fetchBuildId(city: string, slug: string): Promise<string> {
  if (cachedBuildId) return cachedBuildId;
  const res = await fetch(`${INFATUATION_BASE}/${city}/reviews/${slug}`, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Review HTML fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error("Could not find buildId in review HTML");
  cachedBuildId = m[1];
  return cachedBuildId;
}

/** Fetch the raw _next/data JSON for a review page. */
export async function fetchReviewPageData(
  city: string,
  slug: string,
  buildId?: string
): Promise<ApolloState> {
  const id = buildId ?? (await fetchBuildId(city, slug));
  const url = `${INFATUATION_BASE}/_next/data/${id}/${city}/reviews/${slug}.json`;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404 && !buildId) {
    // Build id rotated mid-run; refresh once and retry.
    cachedBuildId = null;
    return fetchReviewPageData(city, slug, await fetchBuildId(city, slug));
  }
  if (!res.ok) throw new Error(`Page data fetch failed: HTTP ${res.status} for ${url}`);
  const json = (await res.json()) as { pageProps?: { initialApolloState?: ApolloState } };
  const state = json.pageProps?.initialApolloState;
  if (!state) throw new Error("Page data missing initialApolloState");
  return state;
}

/** Extract the enriched review from a page's Apollo state. */
export function extractReview(state: ApolloState): EnrichedReview | null {
  const root = state["ROOT_QUERY"] as Record<string, unknown> | undefined;
  if (!root) return null;
  const collKey = Object.keys(root).find((k) => k.startsWith("postReviewCollection"));
  if (!collKey) return null;
  const coll = deref(state, root[collKey]) as {
    items?: Array<Record<string, unknown>>;
  } | null;
  const rawItem = coll?.items?.[0];
  if (!rawItem) return null;
  const item = rawItem as Record<string, unknown>;

  const venue = (item["venue"] as Record<string, unknown> | undefined) ?? {};
  const latlong = (venue["latlong"] as Record<string, unknown> | undefined) ?? {};
  const resKey = Object.keys(venue).find((k) => k.startsWith("reservation("));
  const reservation = (resKey ? venue[resKey] : null) as Record<string, unknown> | null;

  const byPrefix = (prefix: string): Record<string, unknown> | undefined => {
    const k = Object.keys(item).find((x) => x === prefix || x.startsWith(prefix + "("));
    return k ? (item[k] as Record<string, unknown>) : undefined;
  };

  const perfectFor = (
    (byPrefix("perfectForCollection")?.["items"] as Array<Record<string, unknown>>) ?? []
  )
    .map((x) => x["name"] as string | undefined)
    .filter((x): x is string => !!x);

  const contributors = (
    (byPrefix("contributorCollection")?.["items"] as Array<Record<string, unknown>>) ?? []
  );

  const content = (item["content"] as Record<string, unknown> | undefined) ?? {};

  return {
    title: (item["title"] as string) ?? null,
    headline: (item["headline"] as string) ?? null,
    preview: (item["preview"] as string) ?? null,
    rating:
      typeof item["rating"] === "number" && item["rating"] > 0
        ? Math.round((item["rating"] as number) * 10) / 10
        : null,
    bodyMarkdown: richTextToMarkdown(content["json"]),
    publishedAt: (item["publishDate"] as string) ?? null,
    author: (contributors[0]?.["name"] as string) ?? null,
    venue: {
      name: (venue["name"] as string) ?? null,
      street: (venue["street"] as string) ?? null,
      city: (venue["city"] as string) ?? null,
      state: (venue["state"] as string) ?? null,
      postalCode: (venue["postalCode"] as string) ?? null,
      country: (venue["country"] as string) ?? null,
      phone: (venue["phone"] as string) ?? null,
      url: (venue["url"] as string) ?? null,
      instagram: (venue["instagram"] as string) ?? null,
      price: typeof venue["price"] === "number" ? (venue["price"] as number) : null,
      closed: typeof venue["closed"] === "boolean" ? (venue["closed"] as boolean) : null,
      closedStatus: typeof venue["closedStatus"] === "string" ? (venue["closedStatus"] as string) : null,
      lat: typeof latlong["lat"] === "number" ? (latlong["lat"] as number) : null,
      lon: typeof latlong["lon"] === "number" ? (latlong["lon"] as number) : null,
      reservationUrl: (reservation?.["reservationUrl"] as string) ?? null,
    },
    perfectFor,
    dishes: harvestDishes(content["links"]),
  };
}

/** Fetch + extract a review's enrichment, with politeness delay. */
export async function enrichReview(
  city: string,
  slug: string,
  delayMs = POLITE_DELAY_MS
): Promise<EnrichedReview | null> {
  await sleep(delayMs);
  const state = await fetchReviewPageData(city, slug);
  return extractReview(state);
}

export { slugify };
