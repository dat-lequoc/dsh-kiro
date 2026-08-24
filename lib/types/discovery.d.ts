/** Live Kiro model discovery through ListAvailableModels. */
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts';
import type { KiroToken } from './auth.ts';
import { getJson, postJsonWithHeaders } from './transport.ts';
/** Request hook used to test discovery without network access. */
export type ModelDiscoveryRequest = typeof getJson;
/** POST hook used for ListAvailableProfiles. */
export type ProfileDiscoveryRequest = typeof postJsonWithHeaders;
/** Constructor dependencies for {@link KiroModelDiscovery}. */
export interface KiroModelDiscoveryOptions {
    resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>;
    requestJson?: ModelDiscoveryRequest;
    profileRequestJson?: ProfileDiscoveryRequest;
    cacheTtlMs?: number;
}
/** Resolve the best CodeWhisperer profile ARN for one OAuth credential. */
export declare function discoverKiroProfileArn(connection: Pick<KiroConnectionOptions, 'region' | 'proxyUrl'>, token: KiroToken, signal: AbortSignal, request?: ProfileDiscoveryRequest): Promise<string | undefined>;
/** Infer whether a discovered route should expose Kiro's thinking controls. */
export declare function modelSupportsThinking(modelId: string): boolean;
interface ParsedEffortSchema {
    levels: string[];
    schemaPath: 'output_config' | 'reasoning';
    defaultLevel?: string;
}
/** Parse the same two effort-schema branches used by the installed Kiro client. */
export declare function parseEffortSchema(schema: unknown): ParsedEffortSchema | undefined;
/**
 * Parse Kiro's ListAvailableModels response into harness catalog entries.
 * @param body - decoded JSON response.
 * @returns unique models in provider order.
 */
export declare function parseAvailableModels(body: unknown): KiroCatalogModel[];
/** Cached account-specific model discovery used by the adapter and web UI. */
export declare class KiroModelDiscovery {
    private readonly options;
    private readonly requestJson;
    private readonly profileRequestJson;
    private readonly cacheTtlMs;
    private readonly cache;
    constructor(options: KiroModelDiscoveryOptions);
    private key;
    /** Drop all cached discovery results after login or logout. */
    clear(): void;
    private endpoint;
    private headers;
    private discoverProfile;
    /**
     * Return the last discovered catalog for this connection without I/O.
     * @param connection - current connection facts.
     * @returns cached models, if a matching discovery has completed.
     */
    current(connection: KiroConnectionOptions): readonly KiroCatalogModel[] | undefined;
    /**
     * Discover models offered to the signed-in account.
     * @param connection - frozen request facts.
     * @param signal - caller cancellation.
     * @param force - bypass a still-valid cache entry.
     * @returns live Kiro model metadata.
     */
    list(connection: KiroConnectionOptions, signal: AbortSignal, force?: boolean): Promise<readonly KiroCatalogModel[]>;
}
export {};
