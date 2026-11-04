/**
 * Persistent Kiro model catalog with stale-while-revalidate refresh.
 *
 * Discovery is slow (a `kiro-cli` subprocess or a paged API walk) while the
 * catalog changes rarely, so the last successful result is kept on disk and
 * served immediately — across restarts too. A catalog older than its TTL is
 * still served, and one background refresh replaces it when it succeeds. A
 * failed refresh never discards the catalog the user already has; it only
 * postpones the next background attempt.
 *
 * @module dsh-kiro/model-catalog
 */
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts';
/** A catalog older than this is refreshed in the background on next read. */
export declare const DEFAULT_CATALOG_TTL_MS: number;
/** One stored catalog generation. */
export interface KiroCatalogSnapshot {
    fetchedAt: number;
    models: readonly KiroCatalogModel[];
}
export interface KiroModelCatalogOptions {
    /** Fetch a fresh catalog; throws or returns an empty list on failure. */
    fetch: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<readonly KiroCatalogModel[]>;
    /** Called after every successful refresh, foreground or background. */
    onUpdate?: (snapshot: KiroCatalogSnapshot) => void | Promise<void>;
    /** Reports background refresh failures, which have no caller to throw to. */
    onBackgroundError?: (error: unknown) => void;
    file?: string;
    ttlMs?: number;
    retryDelayMs?: number;
    now?: () => number;
}
/** Default storage path, beside the model selection file. */
export declare function modelCatalogPath(): string;
/**
 * The account's model catalog, loaded once from disk and kept current.
 *
 * Reads never wait on the network while any catalog exists: {@link peek}
 * returns what is known and schedules a refresh when it is stale, and only
 * the very first read with nothing stored ({@link get}) waits for discovery.
 * Refreshes are single-flight, so a page that polls status cannot stack up
 * `kiro-cli` processes.
 */
export declare class KiroModelCatalog {
    private readonly options;
    private readonly file;
    private readonly ttlMs;
    private readonly retryDelayMs;
    private readonly now;
    private snapshotValue;
    private loading;
    private inflight;
    /** Earliest time a background refresh may run; pushed out after a failure. */
    private backgroundAfter;
    /** Set by an account change; cleared by the next successful refresh. */
    private invalidated;
    constructor(options: KiroModelCatalogOptions);
    /** Read the stored catalog once; later calls share the same load. */
    load(): Promise<void>;
    /** The catalog in memory, without I/O; undefined before load or discovery. */
    snapshot(): KiroCatalogSnapshot | undefined;
    /**
     * Return the known catalog without waiting on discovery, scheduling a
     * background refresh when it is missing or older than the TTL.
     */
    peek(connection: KiroConnectionOptions): Promise<KiroCatalogSnapshot | undefined>;
    /**
     * Return the known catalog, waiting for discovery only when none exists.
     * @param signal - stops this caller's wait; the shared refresh keeps
     *   running, so a later read still benefits from it.
     */
    get(connection: KiroConnectionOptions, signal?: AbortSignal): Promise<KiroCatalogSnapshot>;
    /**
     * Discover now, joining a refresh already running. The refresh owns its own
     * timeout rather than borrowing one caller's signal, because other readers
     * may be waiting on the same result.
     * @throws the discovery failure; the previous catalog stays in place.
     */
    refresh(connection: KiroConnectionOptions): Promise<KiroCatalogSnapshot>;
    /**
     * Mark the catalog stale after an account change: it is still shown, but
     * the next read refreshes it for the new account.
     */
    invalidate(): void;
    private isStale;
    private revalidate;
    private run;
    private persist;
}
