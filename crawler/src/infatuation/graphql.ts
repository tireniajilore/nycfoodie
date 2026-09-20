// Client for The Infatuation's public post-search GraphQL endpoint.
// Polite by construction: a delay between requests, modest page sizes,
// honest user agent, and abortable timeouts.

import { INFATUATION_BASE_URL, USER_AGENT } from "./client.js";
import type {
  PostSearchInput,
  RawPostGuide,
  RawPostReview,
  SearchPostsPage,
} from "./types.js";

export const GRAPHQL_ENDPOINT = `${INFATUATION_BASE_URL}/direct/api/post-search/public/graphql`;

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Origin: INFATUATION_BASE_URL,
  Referer: `${INFATUATION_BASE_URL}/`,
  "User-Agent": USER_AGENT,
};

/** Delay between requests (ms). Keeps the crawl polite. */
export const POLITE_DELAY_MS = 1500;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Infatuation GraphQL unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`Infatuation GraphQL HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new Error(
      `Infatuation GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`
    );
  }
  if (!body.data) throw new Error("Infatuation GraphQL: missing data field");
  return body.data;
}

const REVIEW_FIELDS = `
  __typename
  documentIdentifier
  placeName
  placeRatingNumber
  placePriceIndicatorCode
  placeStreetName
  placeCityName
  placeStateName
  placeCountryName
  placeAddressPostalCode
  placeKnownTelephoneNumber
  placeUrl
  placeTimezoneName
  placeLocation { latitudeNumber longitudeNumber }
  headline
  shortDescriptionText
  url
  slugName
  canonicalPathText
  publishedTimestamp
  updateTimestamp
  reservationTipsText
  communityScores { aggregateSurveyOverallScore surveyRecordCount }
  openTableReservationUrl
  placeReservationUrl
  placeReservationPlatformName
  instagramSocialMediaIdentifier
  neighborhoods {
    ... on Neighborhood {
      neighborhoodIdentifier
      neighborhoodName
      neighborhoodDisplayName
      neighborhoodAttributePathText
    }
  }
  cuisines {
    ... on Cuisine {
      cuisineIdentifier
      cuisineName
      cuisineDisplayName
      cuisineAttributePathText
    }
  }
  categories {
    categoryDocumentIdentifier
    categoryDocumentName
    categoryDisplayName
    categoryAttributePathText
  }
  placeVenueTypes {
    venueTypeIdentifier
    venueTypeName
  }
`;

const SEARCH_POSTS_QUERY = `
  query SearchPosts($input: PostSearchInput!) {
    searchPosts(input: $input) {
      nodes {
        ... on PostReview { ${REVIEW_FIELDS} }
        ... on PostGuide {
          __typename
          documentIdentifier
          documentTitleText
          previewText
          url
          slugName
          canonicalPathText
          publishedTimestamp
          updateTimestamp
        }
      }
      pageInfo {
        moreDataIndicator
        endpageDirectionCode
      }
      receivedRecordCount
    }
  }
`;

interface SearchPostsData {
  searchPosts: {
    nodes: Array<RawPostReview | RawPostGuide>;
    pageInfo: { moreDataIndicator: boolean | null; endpageDirectionCode: string | null };
    receivedRecordCount: number;
  };
}

/** Fetch one page of search results. Returns the nodes plus the cursor for the next page (null = done). */
export async function searchPostsPage(
  input: PostSearchInput
): Promise<SearchPostsPage> {
  const data = await graphqlRequest<SearchPostsData>(SEARCH_POSTS_QUERY, { input });
  const sp = data.searchPosts;
  return {
    nodes: sp.nodes ?? [],
    endCursor: sp.pageInfo?.endpageDirectionCode ?? null,
    receivedRecordCount: sp.receivedRecordCount ?? 0,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Iterate all pages for a search input, politely. Calls onPage for each page;
 * stop when onPage returns false or there is no next cursor. maxPages caps the run.
 */
export async function forEachSearchPage(
  input: PostSearchInput,
  onPage: (page: SearchPostsPage, pageIndex: number) => boolean | Promise<boolean>,
  opts: { maxPages?: number; delayMs?: number; initialCursor?: string } = {}
): Promise<{ pages: number; nodes: number; completed: boolean }> {
  const { maxPages = 50, delayMs = POLITE_DELAY_MS, initialCursor } = opts;
  let cursor: string | undefined = initialCursor;
  let pages = 0;
  let nodes = 0;
  let completed = false;
  for (let i = 0; i < maxPages; i++) {
    const page = await searchPostsPage({ ...input, paginationContextualText: cursor });
    pages++;
    nodes += page.nodes.length;
    const cont = await onPage(page, i);
    if (!cont) break;
    if (!page.endCursor) {
      completed = true;
      break;
    }
    cursor = page.endCursor;
    await sleep(delayMs);
  }
  return { pages, nodes, completed };
}
