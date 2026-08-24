/**
 * `KiroAdapter`: the Kiro `generateAssistantResponse` operation behind the
 * harness LLM seam. The adapter is transport-only — connection facts arrive
 * through a thunk resolved once per stream call and the bearer token through a
 * per-request resolver — so the registering plugin owns validation, layering,
 * and credential policy.
 *
 * @module dsh-kiro/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RequestDefaults } from './serialize.ts';
import type { KiroToken } from './auth.ts';
/** Default maximum idle interval while an outstanding provider read is pending. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Default combined request/response context capacity for a Kiro model. */
export declare const DEFAULT_CONTEXT_WINDOW = 200000;
/** Location of Kiro's native effort field in `additionalModelRequestFields`. */
export type KiroEffortSchemaPath = 'output_config' | 'reasoning';
/** One model entry advertised for the Kiro route. */
export interface KiroCatalogModel {
    /** Wire model id, sent as `modelId` on every turn. */
    id: string;
    /** Selector label; defaults to {@link id}. */
    name?: string;
    /** Optional selector detail. */
    description?: string;
    /** Known combined request/response context capacity. */
    contextWindow?: number;
    /** Known provider output limit. */
    maxTokens?: number;
    /** Whether this model honors the thinking markers. */
    thinking?: boolean;
    /** Exact effort ids advertised by this account's live model schema. */
    reasoningEfforts?: string[];
    /** Provider-selected effort for this model. */
    defaultReasoningEffort?: string;
    /** Native request-object branch that receives the selected effort. */
    effortSchemaPath?: KiroEffortSchemaPath;
}
/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * value; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface KiroConnectionOptions {
    /** Region selecting the `q.<region>.amazonaws.com` endpoint. */
    region?: string;
    /**
     * Proxy egress for every Kiro request, or `undefined` for a direct
     * connection. Kiro authorizes Claude models by request egress, so a
     * deployment whose own egress is unauthorized reaches them only through a
     * permitted proxy.
     */
    proxyUrl?: string;
    /** CodeWhisperer profile the account bills against; omitted uses the account default. */
    profileArn?: string;
    /** Request defaults applied to every call. */
    defaults: RequestDefaults;
    /** Positive context capacity used when the selected model has no exact value. */
    defaultContextWindow: number;
    /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
    models: readonly KiroCatalogModel[];
    /** Maximum provider idle time while one stream read is outstanding. */
    streamIdleTimeoutMs: number;
    /** Refresh the access token this long before its expiry. */
    tokenExpiryBufferMs: number;
    /** Provider-owned model-request retry policy, already resolved. */
    retryPolicy: ResolvedRetryPolicy;
}
/** Constructor options: the operation-local resolution hooks the plugin owns. */
export interface KiroAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => KiroConnectionOptions;
    /**
     * Resolve a usable bearer token for one request's connection facts. The
     * snapshot is passed in rather than re-read, so a token can never be paired
     * with a different generation's endpoint or proxy.
     */
    resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>;
    /** Resolve the current account catalog; failures should return configured fallback models. */
    discoverModels?: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<readonly KiroCatalogModel[]>;
    /** Return the last discovered catalog synchronously for exact-model metadata. */
    currentModels?: (connection: KiroConnectionOptions) => readonly KiroCatalogModel[] | undefined;
    /** Apply the plugin-owned enabled-model selection before publishing the catalog. */
    selectModels?: (models: readonly KiroCatalogModel[]) => Promise<readonly KiroCatalogModel[]>;
}
/** Select the auth-specific upstream surface Kiro accepts. */
export declare function kiroRequestEndpoint(token: KiroToken, region: string): string;
/** Add the token discriminator required by API-key and external-IdP auth. */
export declare function kiroTokenTypeHeaders(token: KiroToken): Record<string, string>;
/**
 * Map a Kiro HTTP status and error body to a stable harness code.
 * @param status - status of a non-2xx response.
 * @param body - the response body text, when available.
 * @returns the normalized harness error code.
 */
export declare function httpErrorCode(status: number, body?: string): string;
/**
 * The Kiro adapter. One instance serves the whole route: the harness model
 * name is the wire `modelId`, so adding a Kiro model is configuration rather
 * than registration.
 */
export declare class KiroAdapter extends LlmAdapter {
    private readonly config;
    constructor(config: KiroAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private request;
}
