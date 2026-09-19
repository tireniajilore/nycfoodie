// Raw shapes from The Infatuation's web surface. Field-accurate types land in
// step 2 (docs/infatuation-data-surface.md); normalised entities land with the
// schema proposal (step 3).

/** TODO(step 2): fill in from the GraphQL/Next.js mapping. */
export interface RawInfatuationReview {
  slug: string;
  [key: string]: unknown;
}

/** TODO(step 2): fill in from the GraphQL/Next.js mapping. */
export interface RawInfatuationGuide {
  slug: string;
  entries: { restaurantSlug: string; rank: number }[];
  [key: string]: unknown;
}
