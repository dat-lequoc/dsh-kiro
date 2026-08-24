/**
 * Resolve a usable Kiro bearer token from managed or Kiro-owned credentials.
 *
 * Kiro's IDE sign-in writes `~/.aws/sso/cache/kiro-auth-token.json` (the
 * access and refresh tokens) plus a sibling `<clientIdHash>.json` (the OIDC
 * device-registration client id and secret). The two files are one credential:
 * refreshing requires the client pair that issued the refresh token, so a
 * token file naming a registration that is absent cannot be refreshed.
 *
 * Refreshed access tokens are cached in memory only. This avoids racing Kiro
 * IDE when its cache is the selected source, while the refresh token remains
 * sufficient to derive another access token after restart.
 *
 * @module dsh-kiro/auth
 */
/** Region used when the token file names none. */
export declare const DEFAULT_REGION = "us-east-1";
/**
 * Return Kiro IDE/CLI's shared SSO cache directory.
 * @returns an absolute directory below the current user's home.
 */
export declare function kiroCredentialDirectory(): string;
/** One usable bearer token and the region whose endpoint accepts it. */
export interface KiroToken {
    /** Bearer value for the `authorization` header. */
    accessToken: string;
    /** Region selecting the `q.<region>.amazonaws.com` endpoint. */
    region: string;
    /** Epoch milliseconds after which this token stops being accepted. */
    expiresAt: number;
}
/** Everything {@link resolveToken} needs, so tests can supply files and clock. */
export interface TokenSourceOptions {
    /** Directory holding the token and registration files; defaults to the user's SSO cache. */
    cacheDir?: string;
    /** Refresh this many milliseconds before actual expiry. */
    expiryBufferMs: number;
    /** HTTP transport for the refresh call, so a configured proxy applies to it too. */
    fetchJson: (url: string, body: unknown) => Promise<{
        status: number;
        body: unknown;
    }>;
}
/** Discard the cached access token; tests and credential rotation start clean. */
export declare function clearTokenCache(): void;
/**
 * Resolve a bearer token that is valid now.
 *
 * The in-memory token is preferred, then the token Kiro has on disk, and only
 * a request that finds neither usable spends an OIDC refresh — so a session
 * running beside the Kiro IDE normally reuses the IDE's own fresh token.
 * @param options - file location, expiry buffer, and refresh transport.
 * @returns a token whose remaining lifetime exceeds the configured buffer.
 * @throws `LlmError` with `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, or `AUTH`.
 */
export declare function resolveToken(options: TokenSourceOptions): Promise<KiroToken>;
/**
 * Resolve the first present credential source in priority order.
 * @param directories - managed directory first, Kiro IDE/CLI cache second.
 * @param options - token refresh configuration shared by every source.
 * @returns a usable token from the first existing source.
 */
export declare function resolveTokenFromDirectories(directories: readonly string[], options: Omit<TokenSourceOptions, 'cacheDir'>): Promise<KiroToken>;
