// Raw shapes from The Infatuation's post-search GraphQL surface.
// Field mapping: docs/infatuation-data-surface.md §1A.

export interface RawNeighborhood {
  neighborhoodIdentifier?: string;
  neighborhoodName?: string;
  neighborhoodDisplayName?: string;
  neighborhoodAttributePathText?: string;
}

export interface RawCuisine {
  cuisineIdentifier?: string;
  cuisineName?: string;
  cuisineDisplayName?: string;
  cuisineAttributePathText?: string;
}

export interface RawCategory {
  categoryDocumentIdentifier?: string;
  categoryDocumentName?: string;
  categoryDisplayName?: string;
  categoryAttributePathText?: string;
}

export interface RawVenueType {
  venueTypeIdentifier?: string;
  venueTypeName?: string;
}

/** One PostReview node from searchPosts. All fields optional — the surface is undocumented. */
export interface RawPostReview {
  __typename?: string;
  documentIdentifier?: string;
  placeName?: string;
  placeRatingNumber?: number;
  placePriceIndicatorCode?: string;
  placeStreetName?: string;
  placeCityName?: string;
  placeStateName?: string;
  placeCountryName?: string;
  placeAddressPostalCode?: string;
  placeKnownTelephoneNumber?: string;
  placeUrl?: string;
  placeTimezoneName?: string;
  placeLocation?: { latitudeNumber?: number; longitudeNumber?: number };
  headline?: string;
  shortDescriptionText?: string;
  contents?: string;
  url?: string;
  slugName?: string;
  canonicalPathText?: string;
  publishedTimestamp?: string;
  updateTimestamp?: string;
  pageViewCount?: number;
  reservationTipsText?: string;
  communityScores?: {
    aggregateSurveyOverallScore?: number;
    surveyRecordCount?: number;
  };
  openTableReservationUrl?: string;
  placeReservationUrl?: string;
  placeReservationPlatformName?: string;
  instagramSocialMediaIdentifier?: string;
  neighborhoods?: RawNeighborhood[];
  cuisines?: RawCuisine[];
  categories?: RawCategory[];
  placeVenueTypes?: RawVenueType[];
}

/** One PostGuide node from searchPosts. */
export interface RawPostGuide {
  __typename?: string;
  documentIdentifier?: string;
  guideTitleText?: string;
  guidePreviewText?: string;
  url?: string;
  slugName?: string;
  canonicalPathText?: string;
  publishedTimestamp?: string;
  updateTimestamp?: string;
}

export interface SearchPostsPage {
  nodes: Array<RawPostReview | RawPostGuide>;
  endCursor: string | null;
  receivedRecordCount: number;
}

export interface PostSearchInput {
  attributePathText?: string;
  searchText?: string;
  postCategoryTypeText?: string[];
  sizeNumber?: number;
  paginationContextualText?: string;
  cityTypeCode?: string;
  includeUnratedSpots?: boolean;
  [key: string]: unknown;
}
