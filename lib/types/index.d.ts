/**
 * Register a {@link KiroAdapter} for the `kiro` provider route on `ctx.llm`,
 * with connection facts resolved per request instead of frozen at load: the
 * plugin layers its `cordis.yml` entry config under the optional `llm-kiro`
 * user-settings section (`ctx.settings`), so a changed proxy, profile, or
 * catalog reaches the very next request without restarting anything, while an
 * in-flight stream keeps the facts it started with. The one
 * registration-captured fact — the retry policy — re-registers the route in
 * place when it changes.
 *
 * Credentials are not configured here. Builder ID login writes a DSH-owned
 * credential directory; when absent, Kiro IDE/CLI's SSO cache is the fallback.
 *
 * @module dsh-kiro
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts';
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_STREAM_IDLE_TIMEOUT_MS, KiroAdapter, httpErrorCode, } from './adapter.ts';
export type { KiroAdapterOptions, KiroCatalogModel, KiroConnectionOptions } from './adapter.ts';
export { clearTokenCache, DEFAULT_REGION, kiroAuthMethod, kiroCredentialDirectory, resolveToken, resolveTokenFromDirectories, } from './auth.ts';
export type { KiroToken, TokenSourceOptions } from './auth.ts';
export type { DirectoryTokenSourceOptions, KiroAuthMethod } from './auth.ts';
export { discoverKiroProfileArn, KiroModelDiscovery, modelPageToken, modelSupportsThinking, parseAvailableModels, parseEffortSchema, parseMaxTokensBounds, } from './discovery.ts';
export { compareKiroModels, FileModelSettingsStore, modelSelection, modelSettingsPath, } from './model-settings.ts';
export type { KiroModelSettings } from './model-settings.ts';
export { assertMicrosoftTokenEndpoint, normalizeExternalIdpCredentials } from './external-idp.ts';
export { BUILDER_START_URL, credentialSummary, deleteDeviceCredentials, importApiKey, importExternalIdp, importRefreshToken, pollDeviceLogin, pollSocialDeviceLogin, resolveRefreshTokenOrigin, saveDeviceCredentials, saveManagedCredentials, startDeviceLogin, startSocialDeviceLogin, } from './login.ts';
export type { DeviceCredentials, DeviceLoginOptions, DeviceLoginPoll, DeviceLoginSession, ManagedCredentials, RefreshTokenOrigin, SocialDeviceLoginPoll, SocialDeviceLoginSession, } from './login.ts';
export { credentialDirectory } from './paths.ts';
export { assertKiroProfileArn, profileRegion } from './profile.ts';
export { assertKiroRegion } from './region.ts';
export { getJson, parseProxyUrl, postForm, postJson, postJsonWithHeaders } from './transport.ts';
export { KiroUsageService, parseKiroUsage } from './usage.ts';
export type { KiroUsage, KiroUsageRow, KiroUsageServiceOptions } from './usage.ts';
export { buildModelRequestFields } from './serialize.ts';
export type { ModelLimits, RequestDefaults } from './serialize.ts';
export type * from './types.ts';
export declare const name = "dsh-kiro";
export declare const inject: string[];
/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-kiro` settings-section shape. Every field is optional in yml: an
 * absent Kiro sign-in fails at the first request with `MISSING_CREDENTIAL`
 * rather than at plugin load, and an omitted region follows the token file.
 */
export interface Config {
    /**
     * Proxy egress for every Kiro request as `scheme://[user:pass@]host:port`
     * (`http://` or `https://`). Kiro authorizes Claude models by request
     * egress: a deployment whose own egress is unauthorized reaches the
     * `claude-*` models only through a permitted proxy, while the open-weight
     * models answer without one. An invalid value fails plugin loading.
     */
    proxyUrl: Volatile<string | undefined>;
    /** Region selecting the endpoint; omitted follows the signed-in token file. */
    region: Volatile<string | undefined>;
    /** CodeWhisperer profile ARN; omitted uses the account default. */
    profileArn: Volatile<string | undefined>;
    /** Deployment thinking policy; `disabled` suppresses model reasoning. */
    thinking: Volatile<'enabled' | 'disabled' | undefined>;
    /** Optional provider-wide override; omission follows each model's live default. */
    reasoningEffort: Volatile<'none' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined>;
    /** Positive context capacity used when the selected model has no exact value (default 200,000). */
    defaultContextWindow: Volatile<number>;
    /** Advisory models shown by discovery consumers; defaults to the verified account tier. */
    models: Volatile<KiroCatalogModel[]>;
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs: Volatile<number>;
    /** Refresh the access token this long before expiry (default five minutes). */
    tokenExpiryBufferMs: Volatile<number>;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy: Volatile<RetryPolicyConfig | undefined>;
}
/** Plain values accepted by the provider resolver. */
export type Options = {
    [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : never;
};
/** Read the current value behind every validated configuration reference. */
export declare function plainOptions(config: Config): Options;
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    proxyUrl: z<string, string, "volatile">;
    region: z<string, string, "volatile">;
    profileArn: z<string, string, "volatile">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "volatile">;
    reasoningEffort: z<"none" | "off" | "low" | "medium" | "high" | "xhigh" | "max", "none" | "off" | "low" | "medium" | "high" | "xhigh" | "max", "volatile">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    models: z<NoInfer<KiroCatalogModel[]>, NoInfer<KiroCatalogModel[]>, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    tokenExpiryBufferMs: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    proxyUrl: z<string, string, "volatile">;
    region: z<string, string, "volatile">;
    profileArn: z<string, string, "volatile">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "volatile">;
    reasoningEffort: z<"none" | "off" | "low" | "medium" | "high" | "xhigh" | "max", "none" | "off" | "low" | "medium" | "high" | "xhigh" | "max", "volatile">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    models: z<NoInfer<KiroCatalogModel[]>, NoInfer<KiroCatalogModel[]>, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    tokenExpiryBufferMs: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/**
 * One resolution's complete request facts. Connection, proxy, and token-policy
 * facts are one value on purpose: a snapshot the resolver rejects keeps the
 * whole previous generation, so a request can never pair a stale endpoint with
 * a newer egress.
 */
export type ResolvedKiroOptions = KiroConnectionOptions;
/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load
 * (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 * @throws when a field is present but unusable (a malformed proxy URL, a
 *   duplicate catalog id, an out-of-range timeout).
 */
export declare function resolveAdapterOptions(config: Options): ResolvedKiroOptions;
export declare function apply(ctx: Context, config: Config): void;
