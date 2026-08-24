/** Live Kiro model discovery through ListAvailableModels. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
import type { KiroAuthMethod, KiroToken } from './auth.ts'
import { assertKiroProfileArn } from './profile.ts'
import { getJson, postJsonWithHeaders } from './transport.ts'

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const KIRO_USER_AGENT = 'aws-sdk-js/3.738.0 KiroIDE'

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
  const candidates = [...new Set([connection.region, token.region, 'us-east-1', 'eu-central-1']
    .filter((candidate): candidate is string => candidate !== undefined))]
  for (const candidate of candidates) {
    const endpoint = `https://codewhisperer.${candidate}.amazonaws.com`
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
      const response = await request(
        attempt.url,
        { maxResults: 50 },
        attempt.headers,
        connection.proxyUrl,
        signal,
      )
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
      const regional = valid.find(arn => arn.split(':')[3] === token.region)
      if (regional !== undefined) return regional
      if (valid[0] !== undefined) return valid[0]
    }
  }
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
 * Parse Kiro's ListAvailableModels response into harness catalog entries.
 * @param body - decoded JSON response.
 * @returns unique models in provider order.
 */
export function parseAvailableModels(body: unknown): KiroCatalogModel[] {
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
    const effort = parseEffortSchema(model.additionalModelRequestFieldsSchema)
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
      thinking: hasEffortSchema ? effort !== undefined : modelSupportsThinking(model.modelId),
      ...effort === undefined ? {} : {
        reasoningEfforts: effort.levels,
        defaultReasoningEffort: effort.defaultLevel,
        effortSchemaPath: effort.schemaPath,
      },
    })
  }
  if (models.length === 0) throw new Error('Kiro ListAvailableModels returned no usable model ids')
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
    const authRegion = connection.region ?? token.region
    const key = this.key(connection, authRegion)
    const cached = this.cache.get(key)
    if (!force && cached !== undefined && cached.expiresAt > Date.now()) return cached.models

    const profileArn = connection.profileArn
      ?? token.profileArn
      ?? await this.discoverProfile(connection, token, authRegion, signal)
    const profileRegion = profileArn?.split(':')[3]
    const region = profileRegion !== undefined
      && /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/u.test(profileRegion)
      ? profileRegion
      : authRegion
    const url = new URL(`${this.endpoint(region)}/ListAvailableModels`)
    url.searchParams.set('origin', 'AI_EDITOR')
    url.searchParams.set('maxResults', '50')
    if (profileArn !== undefined) url.searchParams.set('profileArn', profileArn)
    const response = await this.requestJson(
      url.toString(),
      this.headers(token),
      connection.proxyUrl,
      signal,
    )
    if (response.status !== 200) throw discoveryError(response.status, response.body)
    const models = parseAvailableModels(response.body)
    this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, models })
    return models
  }
}
