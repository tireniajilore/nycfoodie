// Typed HTTP client for The Infatuation's public web surface.
//
// The endpoint + field mapping lives in docs/infatuation-data-surface.md
// (step 2). Concrete fetchers (reviews, guides) are built in step 4, after
// schema sign-off.
export const INFATUATION_BASE_URL = "https://www.theinfatuation.com";
export const USER_AGENT = "taste-crawler/0.1 (research project; polite rate limits)";
export class InfatuationClient {
    baseUrl;
    fetchFn;
    constructor(baseUrl = INFATUATION_BASE_URL, fetchFn = fetch) {
        this.baseUrl = baseUrl;
        this.fetchFn = fetchFn;
    }
    async getJson(path) {
        const res = await this.fetchFn(new URL(path, this.baseUrl), {
            headers: { "user-agent": USER_AGENT, accept: "application/json" },
        });
        if (!res.ok) {
            throw new Error(`Infatuation request failed: ${res.status} ${res.statusText} for ${path}`);
        }
        return (await res.json());
    }
}
//# sourceMappingURL=client.js.map