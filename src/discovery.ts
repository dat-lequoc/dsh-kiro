/** Live Kiro model discovery through ListAvailableModels. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { kiroServiceRegion } from './adapter.ts'
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
import type { KiroAuthMethod, KiroToken } from './auth.ts'
import { assertKiroProfileArn } from './profile.ts'
import { getJson, postJsonWithHeaders } from './transport.ts'

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const KIRO_USER_AGENT = 'aws-sdk-js/3.738.0 KiroIDE'
/** Models requested per page; the service caps a page at its own maximum. */
const PAGE_SIZE = 50
/**
 * Pages followed before giving up on a continuation token. `ListAvailableModels`
 * declares `nextToken` on both its request and its response, so a truncated
 * catalog is a real possibility; a bounded walk keeps a misbehaving or looping
 * token from turning discovery into an unbounded request sequence.
 */
const MAX_PAGES = 10

interface WireTokenLimits {
  maxInputTokens?: unknown
  maxOutputTokens?: unknown
}

interface WireModel {
  modelId?: unknown
  modelName?: unknown
  description?: unknown
  supportedInputTypes?: unknown
  tokenLimits?: unknown
  additionalModelRequestFieldsSchema?: unknown
}

/**
 * Modalities in the order selectors should show them. Fixed rather than taken
 * from the wire so one account's ordering cannot become a UI difference.
 */
const MODALITY_ORDER = ['text', 'image'] as const

/**
 * Read the input modalities a catalog entry declares.
 *
 * The service states this per model as `supportedInputTypes: ["TEXT","IMAGE"]`,
 * so the capability is read rather than inferred from the model id: on this
 * account 17 of 19 models accept images while `glm-5` and `minimax-m2.5` accept
 * only text, and an id-based guess would send images to a model that refuses
 * them. An unreadable value yields absence, which leaves the configured default
 * in force instead of silently narrowing the model to text.
 * @param value - the raw `supportedInputTypes` member.
 * @returns declared modalities in display order, or undefined when unreadable.
 */
export function parseInputModalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const declared = new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLowerCase()))
  const modalities = MODALITY_ORDER.filter(modality => declared.has(modality))
  return modalities.length === 0 ? undefined : [...modalities]
}

/** Request hook used to test discovery without network access. */
export type ModelDiscoveryRequest = typeof getJson
/** POST hook used for ListAvailableProfiles. */
export type ProfileDiscoveryRequest = typeof postJsonWithHeaders

/** Constructor dependencies for {@link KiroModelDiscovery}. */
export interface KiroModelDiscoveryOptions {
  resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>
  requestJson?: ModelDiscoveryRequest
  profileRequestJson?: ProfileDiscoveryRequest
  cacheTtlMs?: number
}

interface CacheEntry {
  expiresAt: number
  models: readonly KiroCatalogModel[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function tokenTypeHeaders(authMethod: KiroAuthMethod): Record<string, string> {
  if (authMethod === 'api_key') return { TokenType: 'API_KEY' }
  if (authMethod === 'external_idp') return { TokenType: 'EXTERNAL_IDP' }
  return {}
}

function authHeaders(token: KiroToken): Record<string, string> {
  return {
    authorization: `Bearer ${token.accessToken}`,
    'user-agent': KIRO_USER_AGENT,
    'x-amz-user-agent': KIRO_USER_AGENT,
    'x-amzn-codewhisperer-optout': 'true',
    ...tokenTypeHeaders(token.authMethod),
  }
}

/** Resolve the best CodeWhisperer profile ARN for one OAuth credential. */
export async function discoverKiroProfileArn(
  connection: Pick<KiroConnectionOptions, 'region' | 'proxyUrl'>,
  token: KiroToken,
  signal: AbortSignal,
  request: ProfileDiscoveryRequest = postJsonWithHeaders,
): Promise<string | undefined> {
  if (token.authMethod === 'api_key') return undefined
  const candidates = [...new Set([kiroServiceRegion(connection, token), 'us-east-1', 'eu-central-1']
    .filter((candidate): candidate is string => candidate !== undefined))]
  let firstTransportError: unknown
  for (const candidate of candidates) {
    const endpoint = `https://codewhisperer.${candidate}.amazonaws.com`
    let reachedEndpoint = false
    const attempts = [
      { url: `${endpoint}/ListAvailableProfiles`, headers: authHeaders(token) },
      {
        url: endpoint,
        headers: {
          ...authHeaders(token),
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': 'AmazonCodeWhispererService.ListAvailableProfiles',
        },
      },
    ]
    for (const attempt of attempts) {
      let response: Awaited<ReturnType<ProfileDiscoveryRequest>>
      try {
        response = await request(
          attempt.url,
          { maxResults: 50 },
          attempt.headers,
          connection.proxyUrl,
          signal,
        )
      } catch (error: unknown) {
        if (signal.aborted) throw error
        firstTransportError ??= error
        continue
      }
      reachedEndpoint = true
      if (response.status !== 200) continue
      const profiles = record(response.body)?.profiles
      if (!Array.isArray(profiles)) continue
      const valid: string[] = []
      for (const raw of profiles) {
        const value = record(raw)
        const candidateArn = value?.arn ?? value?.profileArn
        if (typeof candidateArn !== 'string') continue
        try {
          valid.push(assertKiroProfileArn(candidateArn))
        } catch {
          // Ignore malformed upstream entries instead of allowing them into a URL.
        }
      }
      const regional = valid.find(arn => arn.split(':')[3] === candidate)
      if (regional !== undefined) return regional
      if (valid[0] !== undefined) return valid[0]
    }
    // A real response proves this is the credential's reachable service region.
    // Alternate regions are only transport fallbacks; probing them after a 4xx
    // lets an unrelated proxy failure hide the useful response above.
    if (reachedEndpoint) return undefined
  }
  if (firstTransportError !== undefined) throw firstTransportError
  return undefined
}

/** Infer whether a discovered route should expose Kiro's thinking controls. */
export function modelSupportsThinking(modelId: string): boolean {
  return !/^(?:auto$|claude-sonnet-4$|claude-haiku-|qwen3-coder-next$)/iu.test(modelId)
}

interface ParsedEffortSchema {
  levels: string[]
  schemaPath: 'output_config' | 'reasoning'
  defaultLevel?: string
}

/** Parse the same two effort-schema branches used by the installed Kiro client. */
export function parseEffortSchema(schema: unknown): ParsedEffortSchema | undefined {
  const root = record(schema)
  const properties = record(root?.properties)
  for (const schemaPath of ['output_config', 'reasoning'] as const) {
    const branch = record(properties?.[schemaPath])
    const effort = record(record(branch?.properties)?.effort)
    const rawLevels = effort?.enum
    if (!Array.isArray(rawLevels)) continue
    const levels = [...new Set(rawLevels.filter((level): level is string =>
      typeof level === 'string' && level.length > 0))]
    if (levels.length === 0) continue
    const defaultLevel = typeof effort?.default === 'string' && levels.includes(effort.default)
      ? effort.default
      : undefined
    return {
      levels,
      schemaPath,
      ...defaultLevel === undefined ? {} : { defaultLevel },
    }
  }
  return undefined
}

/**
 * Read the bounds of the model's advertised `max_tokens` request field.
 *
 * The field is the only output cap `generateAssistantResponse` honors, and the
 * advertised schema is `additionalProperties: false`, so a value outside the
 * declared range — or the field itself on a model that does not declare it —
 * fails validation. Sending it therefore requires reading these bounds first.
 * @param schema - the model's `additionalModelRequestFieldsSchema`.
 * @returns the inclusive bounds, or `undefined` when the model declares none.
 */
export function parseMaxTokensBounds(
  schema: unknown,
): { minimum: number; maximum: number } | undefined {
  const field = record(record(record(schema)?.properties)?.max_tokens)
  if (field === undefined || field.type !== 'integer') return undefined
  const maximum = positiveInteger(field.maximum)
  if (maximum === undefined) return undefined
  const minimum = positiveInteger(field.minimum) ?? 1
  return minimum > maximum ? undefined : { minimum, maximum }
}

/**
 * Parse Kiro's ListAvailableModels response into harness catalog entries.
 * @param body - decoded JSON response.
 * @returns unique models in provider order.
 */
export function parseAvailableModels(body: unknown): KiroCatalogModel[] {
  const models = parseModelPage(body)
  if (models.length === 0) throw new Error('Kiro ListAvailableModels returned no usable model ids')
  return models
}

/**
 * Read the continuation token of one ListAvailableModels page.
 * @param body - decoded JSON response.
 * @returns the token, or `undefined` when this page is the last.
 */
export function modelPageToken(body: unknown): string | undefined {
  const token = record(body)?.nextToken
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

/**
 * Parse one page of the model catalog without requiring it to be non-empty:
 * a continuation page may legitimately add nothing new.
 * @param body - decoded JSON response.
 * @returns the page's models in provider order.
 */
function parseModelPage(body: unknown): KiroCatalogModel[] {
  const root = record(body)
  const rawModels = root?.models
  if (!Array.isArray(rawModels)) throw new Error('Kiro ListAvailableModels returned no models array')
  const seen = new Set<string>()
  const models: KiroCatalogModel[] = []
  for (const raw of rawModels) {
    const rawModel = record(raw)
    const model = rawModel as WireModel | undefined
    if (model === undefined || typeof model.modelId !== 'string' || model.modelId.length === 0) continue
    if (seen.has(model.modelId)) continue
    seen.add(model.modelId)
    const limits = record(model.tokenLimits) as WireTokenLimits | undefined
    const contextWindow = positiveInteger(limits?.maxInputTokens)
    const maxTokens = positiveInteger(limits?.maxOutputTokens)
    const inputModalities = parseInputModalities(model.supportedInputTypes)
    const effort = parseEffortSchema(model.additionalModelRequestFieldsSchema)
    const maxTokensBounds = parseMaxTokensBounds(model.additionalModelRequestFieldsSchema)
    const hasEffortSchema = rawModel !== undefined
      && Object.hasOwn(rawModel, 'additionalModelRequestFieldsSchema')
    models.push({
      id: model.modelId,
      ...typeof model.modelName === 'string' && model.modelName.length > 0 ? { name: model.modelName } : {},
      ...typeof model.description === 'string' && model.description.length > 0
        ? { description: model.description }
        : {},
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...inputModalities === undefined ? {} : { inputModalities },
      thinking: hasEffortSchema ? effort !== undefined : modelSupportsThinking(model.modelId),
      ...effort === undefined ? {} : {
        reasoningEfforts: effort.levels,
        defaultReasoningEffort: effort.defaultLevel,
        effortSchemaPath: effort.schemaPath,
      },
      ...maxTokensBounds === undefined ? {} : { maxTokensBounds },
    })
  }
  return models
}

function discoveryError(status: number, body: unknown): LlmError {
  const value = record(body)
  const message = typeof value?.message === 'string'
    ? value.message
    : `Kiro model discovery failed (HTTP ${status})`
  const code = status === 401 ? 'AUTH'
    : status === 403 ? 'FORBIDDEN'
      : status === 429 ? 'RATE_LIMIT'
        : status >= 500 ? 'SERVER'
          : 'INVALID_REQUEST'
  return new LlmError(message, code, { status })
}

/** Cached account-specific model discovery used by the adapter and web UI. */
export class KiroModelDiscovery {
  private readonly requestJson: ModelDiscoveryRequest
  private readonly profileRequestJson: ProfileDiscoveryRequest
  private readonly cacheTtlMs: number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly options: KiroModelDiscoveryOptions) {
    this.requestJson = options.requestJson ?? getJson
    this.profileRequestJson = options.profileRequestJson ?? postJsonWithHeaders
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  private key(connection: KiroConnectionOptions, region: string): string {
    return `${region}\u0000${connection.profileArn ?? ''}\u0000${connection.proxyUrl ?? ''}`
  }

  /** Drop all cached discovery results after login or logout. */
  clear(): void {
    this.cache.clear()
  }

  private endpoint(region: string): string {
    return region === 'us-east-1'
      ? 'https://codewhisperer.us-east-1.amazonaws.com'
      : `https://q.${region}.amazonaws.com`
  }

  private headers(token: KiroToken): Record<string, string> {
    return authHeaders(token)
  }

  private async discoverProfile(
    connection: KiroConnectionOptions,
    token: KiroToken,
    region: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    return discoverKiroProfileArn({ ...connection, region }, token, signal, this.profileRequestJson)
  }

  /**
   * Return the last discovered catalog for this connection without I/O.
   * @param connection - current connection facts.
   * @returns cached models, if a matching discovery has completed.
   */
  current(connection: KiroConnectionOptions): readonly KiroCatalogModel[] | undefined {
    const region = connection.region
    if (region !== undefined) return this.cache.get(this.key(connection, region))?.models
    for (const [key, value] of this.cache) {
      if (key.endsWith(`\u0000${connection.profileArn ?? ''}\u0000${connection.proxyUrl ?? ''}`)) return value.models
    }
    return undefined
  }

  /**
   * Discover models offered to the signed-in account.
   * @param connection - frozen request facts.
   * @param signal - caller cancellation.
   * @param force - bypass a still-valid cache entry.
   * @returns live Kiro model metadata.
   */
  async list(
    connection: KiroConnectionOptions,
    signal: AbortSignal,
    force = false,
  ): Promise<readonly KiroCatalogModel[]> {
    const token = await this.options.resolveToken(connection, signal)
    const serviceRegion = kiroServiceRegion(connection, token)
    const key = this.key(connection, serviceRegion)
    const cached = this.cache.get(key)
    if (!force && cached !== undefined && cached.expiresAt > Date.now()) return cached.models

    let profileArn = connection.profileArn ?? token.profileArn
    if (profileArn === undefined) {
      try {
        profileArn = await this.discoverProfile(connection, token, serviceRegion, signal)
      } catch (error: unknown) {
        // A profile is optional for ListAvailableModels. Let that operation
        // provide the authoritative failure instead of stopping at a probe.
        if (signal.aborted) throw error
      }
    }
    const profileRegion = profileArn?.split(':')[3]
    const region = profileRegion !== undefined
      && /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u.test(profileRegion)
      ? profileRegion
      : serviceRegion
    const url = new URL(`${this.endpoint(region)}/ListAvailableModels`)
    url.searchParams.set('origin', 'AI_EDITOR')
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (profileArn !== undefined) url.searchParams.set('profileArn', profileArn)
    // `ListAvailableModels` is a paginated operation: the request accepts
    // `nextToken` and the response returns one. A single page happens to hold
    // this tier's catalog today, so following the token is what keeps a larger
    // catalog from being silently truncated to the first page.
    const models: KiroCatalogModel[] = []
    const seen = new Set<string>()
    const usedTokens = new Set<string>()
    let nextToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let added = 0
      if (nextToken === undefined) {
        url.searchParams.delete('nextToken')
      } else {
        url.searchParams.set('nextToken', nextToken)
      }
      const response = await this.requestJson(
        url.toString(),
        this.headers(token),
        connection.proxyUrl,
        signal,
      )
      if (response.status !== 200) {
        // A first-page failure is the discovery failure; a later one leaves the
        // pages already read usable instead of discarding the whole catalog.
        if (models.length === 0) throw discoveryError(response.status, response.body)
        break
      }
      for (const model of page === 0
        ? parseAvailableModels(response.body)
        : parseModelPage(response.body)) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
        added += 1
      }
      nextToken = modelPageToken(response.body)
      // Three stop conditions, because the live endpoint returns an empty
      // `nextToken` on every page and would otherwise be walked forever: no
      // usable token, a token already used, or a page that added nothing new.
      if (nextToken === undefined || usedTokens.has(nextToken) || (page > 0 && added === 0)) break
      usedTokens.add(nextToken)
    }
    this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, models })
    return models
  }
}
