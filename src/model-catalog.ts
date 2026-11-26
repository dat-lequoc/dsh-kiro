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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
import { credentialDirectory } from './paths.ts'

const CATALOG_FILE = 'model-catalog.json'
const CATALOG_VERSION = 1
/** A catalog older than this is refreshed in the background on next read. */
export const DEFAULT_CATALOG_TTL_MS = 24 * 60 * 60 * 1000
/** Wait this long after a failed background refresh before trying again. */
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000
/** Upper bound for one background refresh, which has no caller to cancel it. */
const BACKGROUND_TIMEOUT_MS = 60_000

/** One stored catalog generation. */
export interface KiroCatalogSnapshot {
  fetchedAt: number
  models: readonly KiroCatalogModel[]
}

export interface KiroModelCatalogOptions {
  /** Fetch a fresh catalog; throws or returns an empty list on failure. */
  fetch: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<readonly KiroCatalogModel[]>
  /** Called after every successful refresh, foreground or background. */
  onUpdate?: (snapshot: KiroCatalogSnapshot) => void | Promise<void>
  /** Reports background refresh failures, which have no caller to throw to. */
  onBackgroundError?: (error: unknown) => void
  file?: string
  ttlMs?: number
  retryDelayMs?: number
  now?: () => number
}

/** Default storage path, beside the model selection file. */
export function modelCatalogPath(): string {
  return join(credentialDirectory(), CATALOG_FILE)
}

function parseSnapshot(value: unknown): KiroCatalogSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== CATALOG_VERSION) return undefined
  if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return undefined
  if (!Array.isArray(record.models)) return undefined
  const models = record.models.filter((model): model is KiroCatalogModel =>
    typeof model === 'object' && model !== null
    && typeof (model as Record<string, unknown>).id === 'string'
    && ((model as Record<string, unknown>).id as string).length > 0)
  return models.length === 0 ? undefined : { fetchedAt: record.fetchedAt, models }
}

/** Await a shared promise, letting one caller stop waiting without cancelling it. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * The account's model catalog, loaded once from disk and kept current.
 *
 * Reads never wait on the network while any catalog exists: {@link peek}
 * returns what is known and schedules a refresh when it is stale, and only
 * the very first read with nothing stored ({@link get}) waits for discovery.
 * Refreshes are single-flight, so a page that polls status cannot stack up
 * `kiro-cli` processes.
 */
export class KiroModelCatalog {
  private readonly file: string
  private readonly ttlMs: number
  private readonly retryDelayMs: number
  private readonly now: () => number
  private snapshotValue: KiroCatalogSnapshot | undefined
  private loading: Promise<void> | undefined
  private inflight: Promise<KiroCatalogSnapshot> | undefined
  /** Earliest time a background refresh may run; pushed out after a failure. */
  private backgroundAfter = 0
  /** Set by an account change; cleared by the next successful refresh. */
  private invalidated = false

  constructor(private readonly options: KiroModelCatalogOptions) {
    this.file = options.file ?? modelCatalogPath()
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.now = options.now ?? Date.now
  }

  /** Read the stored catalog once; later calls share the same load. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const stored = parseSnapshot(JSON.parse(await readFile(this.file, 'utf8')))
        // A refresh that finished during the read is newer than the file.
        if (stored !== undefined && this.snapshotValue === undefined) this.snapshotValue = stored
      } catch {
        // Missing or unreadable: behave as if nothing was ever discovered.
      }
    })()
    return this.loading
  }

  /** The catalog in memory, without I/O; undefined before load or discovery. */
  snapshot(): KiroCatalogSnapshot | undefined {
    return this.snapshotValue
  }

  /**
   * Return the known catalog without waiting on discovery, scheduling a
   * background refresh when it is missing or older than the TTL.
   */
  async peek(connection: KiroConnectionOptions): Promise<KiroCatalogSnapshot | undefined> {
    await this.load()
    if (this.isStale()) this.revalidate(connection)
    return this.snapshotValue
  }

  /**
   * Return the known catalog, waiting for discovery only when none exists.
   * @param signal - stops this caller's wait; the shared refresh keeps
   *   running, so a later read still benefits from it.
   */
  async get(connection: KiroConnectionOptions, signal?: AbortSignal): Promise<KiroCatalogSnapshot> {
    const known = await this.peek(connection)
    return known ?? waitFor(this.refresh(connection), signal)
  }

  /**
   * Discover now, joining a refresh already running. The refresh owns its own
   * timeout rather than borrowing one caller's signal, because other readers
   * may be waiting on the same result.
   * @throws the discovery failure; the previous catalog stays in place.
   */
  refresh(connection: KiroConnectionOptions): Promise<KiroCatalogSnapshot> {
    this.inflight ??= this.run(connection, AbortSignal.timeout(BACKGROUND_TIMEOUT_MS))
      .finally(() => { this.inflight = undefined })
    return this.inflight
  }

  /**
   * Mark the catalog stale after an account change: it is still shown, but
   * the next read refreshes it for the new account.
   */
  invalidate(): void {
    this.invalidated = true
    this.backgroundAfter = 0
  }

  private isStale(): boolean {
    const current = this.snapshotValue
    return current === undefined || this.invalidated || this.now() - current.fetchedAt >= this.ttlMs
  }

  private revalidate(connection: KiroConnectionOptions): void {
    if (this.inflight !== undefined || this.now() < this.backgroundAfter) return
    this.refresh(connection).catch((error: unknown) => {
      this.backgroundAfter = this.now() + this.retryDelayMs
      this.options.onBackgroundError?.(error)
    })
  }

  private async run(connection: KiroConnectionOptions, signal: AbortSignal): Promise<KiroCatalogSnapshot> {
    // Load first so a failed forced refresh still leaves the stored catalog visible.
    await this.load()
    const models = await this.options.fetch(connection, signal)
    if (models.length === 0) throw new Error('Kiro model discovery returned no models')
    const next: KiroCatalogSnapshot = { fetchedAt: this.now(), models }
    this.snapshotValue = next
    this.invalidated = false
    this.backgroundAfter = 0
    await this.persist(next)
    await this.options.onUpdate?.(next)
    return next
  }

  private async persist(snapshot: KiroCatalogSnapshot): Promise<void> {
    // Same owner-only modes as the other files in the credential directory.
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, JSON.stringify({ version: CATALOG_VERSION, ...snapshot }, null, 2), { mode: 0o600 })
    await rename(temporary, this.file)
  }
}
