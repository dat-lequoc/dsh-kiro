/** Resolve, refresh, and normalize every Kiro credential shape supported by the plugin. */
export declare const DEFAULT_REGION = "us-east-1";
/**
 * Authentication variants compatible with Kiro and 9Router credential records.
 *
 * `social` is Kiro IDE/CLI's own spelling for a Google or GitHub sign-in. It
 * matters because a fresh install has no plugin-owned credential and falls back
 * to Kiro's SSO cache, where this is the value on disk.
 */
export type KiroAuthMethod = 'builder-id' | 'idc' | 'google' | 'github' | 'social' | 'imported' | 'api_key' | 'external_idp';
/** Directory holding Kiro IDE/CLI's shared SSO cache. */
export declare function kiroCredentialDirectory(): string;
/** One usable credential and its request-routing metadata. */
export interface KiroToken {
    accessToken: string;
    region: string;
    expiresAt: number;
    authMethod: KiroAuthMethod;
    profileArn?: string;
}
/** Everything token resolution needs, including injectable transports for tests and proxies. */
export interface TokenSourceOptions {
    cacheDir?: string;
    expiryBufferMs: number;
    fetchJson: (url: string, body: unknown) => Promise<{
        status: number;
        body: unknown;
    }>;
    fetchForm?: (url: string, body: URLSearchParams) => Promise<{
        status: number;
        body: unknown;
    }>;
    resolveProfileArn?: (accessToken: string, region: string, authMethod: KiroAuthMethod) => Promise<string | undefined>;
    /** Persist rotated managed tokens; never enable this for Kiro IDE-owned cache files. */
    persistRefresh?: boolean;
}
export interface DirectoryTokenSourceOptions extends Omit<TokenSourceOptions, 'cacheDir' | 'persistRefresh'> {
    writableDirectories?: readonly string[];
}
/**
 * Normalize any credential record's recorded method into the vocabulary this
 * adapter acts on. Exported so surfaces report the method that actually decides
 * refresh and endpoint selection, instead of the raw string on disk.
 * @param value - the file's recorded method, if any.
 * @param source - the whole credential record, for provenance fallbacks.
 * @returns the normalized method.
 */
export declare function kiroAuthMethod(value: unknown, source?: Record<string, unknown>): KiroAuthMethod;
export declare function clearTokenCache(): void;
/** Resolve a currently usable token from one credential directory. */
export declare function resolveToken(options: TokenSourceOptions): Promise<KiroToken>;
/** Resolve the first present source, preferring DSH-managed credentials over Kiro's cache. */
export declare function resolveTokenFromDirectories(directories: readonly string[], options: DirectoryTokenSourceOptions): Promise<KiroToken>;
