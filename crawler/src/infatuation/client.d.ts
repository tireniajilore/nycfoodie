export declare const INFATUATION_BASE_URL = "https://www.theinfatuation.com";
export declare const USER_AGENT = "taste-crawler/0.1 (research project; polite rate limits)";
export declare class InfatuationClient {
    private readonly baseUrl;
    private readonly fetchFn;
    constructor(baseUrl?: string, fetchFn?: typeof fetch);
    protected getJson<T>(path: string): Promise<T>;
}
//# sourceMappingURL=client.d.ts.map