/** Cached Kiro account usage retrieval through the control-plane API. */
import type { KiroConnectionOptions } from './adapter.ts';
import type { KiroToken } from './auth.ts';
import { getJson, postJsonWithHeaders } from './transport.ts';
export interface KiroUsageRow {
    id: string;
    label: string;
    used: number;
    limit: number;
    remaining: number;
    usedPercent: number;
    remainingPercent: number;
    resetAt?: string;
    kind: 'subscription' | 'bonus' | 'addon';
    /**
     * True when the provider reports no usable bound for this row — Kiro's
     * no-limit sentinel or an absent limit. Percentages are meaningless for such
     * a row and are published as zero, so surfaces must branch on this flag
     * instead of rendering a fabricated ceiling.
     */
    unlimited?: boolean;
}
export interface KiroUsage {
    plan: string;
    fetchedAt: number;
    resetAt?: string;
    rows: readonly KiroUsageRow[];
}
export type UsageGetRequest = typeof getJson;
export type UsagePostRequest = typeof postJsonWithHeaders;
export interface KiroUsageServiceOptions {
    resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>;
    getRequest?: UsageGetRequest;
    postRequest?: UsagePostRequest;
    cacheTtlMs?: number;
}
/**
 * Normalize the public quota response without retaining account identity fields.
 *
 * Every structure the installed Kiro client reads is covered: subscription
 * breakdowns, the welcome trial (only while the provider calls it `ACTIVE`),
 * named bonus grants, and purchased overage credit packs. Unknown or unbounded
 * limits are marked, never converted into a percentage.
 * @param value - the decoded GetUsageLimits response.
 * @param now - current epoch milliseconds, injectable for tests.
 * @returns the normalized usage snapshot.
 */
export declare function parseKiroUsage(value: unknown, now?: number): KiroUsage;
/** Account-scoped five-minute usage cache with forced refresh support. */
export declare class KiroUsageService {
    private readonly options;
    private readonly getRequest;
    private readonly postRequest;
    private readonly cacheTtlMs;
    private readonly cache;
    constructor(options: KiroUsageServiceOptions);
    private key;
    clear(): void;
    current(connection: KiroConnectionOptions): KiroUsage | undefined;
    get(connection: KiroConnectionOptions, signal: AbortSignal, force?: boolean): Promise<KiroUsage>;
}
