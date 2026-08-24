/**
 * HTTPS transport with optional HTTP-proxy egress.
 *
 * `fetch` cannot be pointed at a proxy without a custom undici dispatcher, and
 * this adapter needs one: Kiro authorizes Claude models by request egress, so
 * the Claude routes are reachable only through a permitted exit. Node's
 * `http`/`tls` modules already express that directly — a `CONNECT` tunnel with
 * TLS negotiated inside it — so the proxy support costs no dependency, and
 * proxy and direct requests differ only in how the socket is obtained.
 *
 * @module dsh-kiro/transport
 */
/** One HTTPS response: status, headers, and the undecoded body byte stream. */
export interface TransportResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    /** Body chunks in arrival order; iterate to completion or abort the request signal. */
    body: AsyncIterable<Uint8Array>;
}
/** One POST through this transport. */
export interface TransportRequest {
    /** Absolute `https:` URL. */
    url: string;
    headers: Record<string, string>;
    /** Already-serialized request body. */
    body: string;
    /** Caller cancellation; aborts the tunnel, TLS handshake, and body read alike. */
    signal: AbortSignal;
    /**
     * Proxy egress as `scheme://[user:pass@]host:port`, or `undefined` for a
     * direct connection.
     */
    proxyUrl?: string;
}
/**
 * Validate a proxy URL at its configuration boundary.
 * @param raw - the configured proxy URL.
 * @returns the parsed URL.
 * @throws when the value is not a URL, or names a scheme this transport cannot open.
 */
export declare function parseProxyUrl(raw: string): URL;
export declare function post(options: TransportRequest): Promise<TransportResponse>;
/**
 * POST JSON and read the whole response, for the small non-streaming calls
 * (token refresh) that share this transport's egress.
 * @param url - absolute `https:` URL.
 * @param body - value serialized as the JSON request body.
 * @param proxyUrl - optional proxy egress.
 * @param signal - caller cancellation.
 * @returns the status and parsed JSON body; an unparsable body resolves as `undefined`.
 */
export declare function postJson(url: string, body: unknown, proxyUrl: string | undefined, signal: AbortSignal): Promise<{
    status: number;
    body: unknown;
}>;
/**
 * POST and parse JSON while supplying operation-specific headers.
 * @param url - absolute HTTPS URL.
 * @param body - JSON request value.
 * @param headers - extra request headers such as Kiro authorization.
 * @param proxyUrl - optional proxy egress.
 * @param signal - caller cancellation.
 * @returns status and parsed response body.
 */
export declare function postJsonWithHeaders(url: string, body: unknown, headers: Record<string, string>, proxyUrl: string | undefined, signal: AbortSignal): Promise<{
    status: number;
    body: unknown;
}>;
/** POST an OAuth form and parse its small JSON response. */
export declare function postForm(url: string, body: URLSearchParams, proxyUrl: string | undefined, signal: AbortSignal): Promise<{
    status: number;
    body: unknown;
}>;
/**
 * GET and parse a small JSON response through the same optional proxy.
 * @param url - absolute HTTPS URL.
 * @param headers - request headers.
 * @param proxyUrl - optional proxy egress.
 * @param signal - caller cancellation.
 * @returns status and parsed response body.
 */
export declare function getJson(url: string, headers: Record<string, string>, proxyUrl: string | undefined, signal: AbortSignal): Promise<{
    status: number;
    body: unknown;
}>;
