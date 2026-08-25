/**
 * `KiroAdapter`: the Kiro `generateAssistantResponse` operation behind the
 * harness LLM seam. The adapter is transport-only — connection facts arrive
 * through a thunk resolved once per stream call and the bearer token through a
 * per-request resolver — so the registering plugin owns validation, layering,
 * and credential policy.
 *
 * @module dsh-kiro/adapter
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { decodeFrames } from './eventstream.ts'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { post } from './transport.ts'
import { translate } from './translate.ts'
import type { KiroToken } from './auth.ts'
import { profileRegion } from './profile.ts'

/** Default maximum idle interval while an outstanding provider read is pending. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity for a Kiro model. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Timeout code distinguishing watchdog expiry from caller cancellation. */
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
/** User agent Kiro's own IDE sends; the service gates model access on it. */
const KIRO_USER_AGENT = 'aws-sdk-js/3.738.0 KiroIDE'
const CODEWHISPERER_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'

const OFF = ReasoningEffortId('off')
/** Legacy efforts for configured models that predate live schema discovery. */
const LEGACY_REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const
/** The only effort a thinking-disabled deployment publishes. */
const OFF_ONLY_REASONING_EFFORTS = [{ id: OFF, name: 'Off' }] as const

/**
 * Kiro's `ValidationException` reason for a request whose serialized content
 * exceeded the service bound. Kiro's own client maps exactly this reason to a
 * context-window-exceeded failure, which is what makes DSH compaction run.
 */
const CONTEXT_OVERFLOW_REASON = 'CONTENT_LENGTH_EXCEEDS_THRESHOLD'
/**
 * Message wording Kiro's own client treats as context overflow. Kept byte-for-byte
 * with `src/utils/context-overflow.ts` in the installed Kiro agent so a provider
 * message that reaches recovery there also reaches it here.
 */
const CONTEXT_OVERFLOW_MESSAGES = ['input is too long', 'prompt is too long'] as const

/** Location of Kiro's native effort field in `additionalModelRequestFields`. */
export type KiroEffortSchemaPath = 'output_config' | 'reasoning'

function effortName(effort: string): string {
  if (effort === 'xhigh') return 'xHigh'
  return effort.length === 0 ? effort : `${effort[0]?.toUpperCase() ?? ''}${effort.slice(1)}`
}

function effortInfo(efforts: readonly string[]): { id: ReasoningEffortId; name: string }[] {
  return efforts.map(effort => ({ id: ReasoningEffortId(effort), name: effortName(effort) }))
}

/** One model entry advertised for the Kiro route. */
export interface KiroCatalogModel {
  /** Wire model id, sent as `modelId` on every turn. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Known provider output limit. */
  maxTokens?: number
  /** Whether this model honors the thinking markers. */
  thinking?: boolean
  /** Exact effort ids advertised by this account's live model schema. */
  reasoningEfforts?: string[]
  /** Provider-selected effort for this model. */
  defaultReasoningEffort?: string
  /** Native request-object branch that receives the selected effort. */
  effortSchemaPath?: KiroEffortSchemaPath
  /**
   * Inclusive bounds of the `max_tokens` property this model's live schema
   * advertises. Present only when the model declares the field: the schema is
   * `additionalProperties: false`, so an output cap can be sent to this model
   * and to no other.
   */
  maxTokensBounds?: { minimum: number; maximum: number }
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * value; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface KiroConnectionOptions {
  /** Region selecting the `q.<region>.amazonaws.com` endpoint. */
  region?: string
  /**
   * Proxy egress for every Kiro request, or `undefined` for a direct
   * connection. Kiro authorizes Claude models by request egress, so a
   * deployment whose own egress is unauthorized reaches them only through a
   * permitted proxy.
   */
  proxyUrl?: string
  /** CodeWhisperer profile the account bills against; omitted uses the account default. */
  profileArn?: string
  /** Request defaults applied to every call. */
  defaults: RequestDefaults
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly KiroCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Refresh the access token this long before its expiry. */
  tokenExpiryBufferMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options: the operation-local resolution hooks the plugin owns. */
export interface KiroAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => KiroConnectionOptions
  /**
   * Resolve a usable bearer token for one request's connection facts. The
   * snapshot is passed in rather than re-read, so a token can never be paired
   * with a different generation's endpoint or proxy.
   */
  resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>
  /** Resolve the current account catalog; failures should return configured fallback models. */
  discoverModels?: (
    connection: KiroConnectionOptions,
    signal: AbortSignal,
  ) => Promise<readonly KiroCatalogModel[]>
  /** Return the last discovered catalog synchronously for exact-model metadata. */
  currentModels?: (connection: KiroConnectionOptions) => readonly KiroCatalogModel[] | undefined
  /** Apply the plugin-owned enabled-model selection before publishing the catalog. */
  selectModels?: (models: readonly KiroCatalogModel[]) => Promise<readonly KiroCatalogModel[]>
}

/** Select the auth-specific upstream surface Kiro accepts. */
export function kiroRequestEndpoint(token: KiroToken, region: string): string {
  return token.authMethod === 'idc' || token.authMethod === 'external_idp'
    ? `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`
    : `https://q.${region}.amazonaws.com/generateAssistantResponse`
}

/** Add the token discriminator required by API-key and external-IdP auth. */
export function kiroTokenTypeHeaders(token: KiroToken): Record<string, string> {
  if (token.authMethod === 'api_key') return { TokenType: 'API_KEY' }
  if (token.authMethod === 'external_idp') return { TokenType: 'EXTERNAL_IDP' }
  return {}
}

/** Describe one catalog entry for selector consumers. */
function modelInfo(provider: string, model: KiroCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

/**
 * Recognize a Kiro HTTP 400 body that reports a context-window overflow rather
 * than an ordinary validation failure. Deliberately narrow: only Kiro's own
 * validation reason, the two message phrases its client matches, and the
 * harness's provider-neutral wording classifier. Every other 400 stays a plain
 * invalid request, because mapping all of them would make DSH compact and
 * retry turns that a smaller context cannot fix.
 * @param body - the response body text, when available.
 * @returns true when the body identifies a context-overflow rejection.
 */
export function isKiroContextOverflow(body?: string): boolean {
  if (body === undefined || body.length === 0) return false
  if (body.includes(CONTEXT_OVERFLOW_REASON)) return true
  const normalized = body.toLowerCase()
  return CONTEXT_OVERFLOW_MESSAGES.some(phrase => normalized.includes(phrase))
    || isContextWindowExceededError(body)
}

/**
 * Map a Kiro HTTP status and error body to a stable harness code.
 * @param status - status of a non-2xx response.
 * @param body - the response body text, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, body?: string): string {
  if (status === 401) return 'AUTH'
  if (status === 403) {
    // Kiro reports both an unusable token and a revoked entitlement as 403;
    // the bearer wording is the one the retry executor can act on.
    return body !== undefined && body.includes('bearer token') ? 'AUTH' : 'FORBIDDEN'
  }
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (body !== undefined && body.includes('INVALID_MODEL_ID')) return 'INVALID_MODEL'
    // Compaction's emergency recovery is keyed to this exact code, so an
    // overflow reported as INVALID_REQUEST silently ends the turn instead.
    if (isKiroContextOverflow(body)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Derive the provider conversation id for one DSH session.
 *
 * Kiro correlates caching and diagnostics by `conversationId`, so a new random
 * id per turn presents one durable session as a stream of unrelated
 * conversations. The id is a keyed digest of the DSH session id rather than the
 * id itself: stable for the session, separate across sessions, and carrying no
 * recoverable DSH identifier upstream.
 * @param sessionId - the DSH session identity stamped on the request, if any.
 * @returns a UUID-shaped conversation id, random when no session is named.
 */
export function conversationIdFor(sessionId?: string): string {
  if (sessionId === undefined || sessionId.length === 0) return randomUUID()
  const digest = createHash('sha256').update(`dsh-kiro:conversation:${sessionId}`).digest()
  // RFC 9562 layout with version 8 (custom) so the value is a well-formed UUID
  // the service accepts, and never mistakable for a random v4.
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * The Kiro adapter. One instance serves the whole route: the harness model
 * name is the wire `modelId`, so adding a Kiro model is configuration rather
 * than registration.
 */
export class KiroAdapter extends LlmAdapter {
  constructor(private readonly config: KiroAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Kiro' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.config.options()
    const discovered = this.config.discoverModels === undefined
      ? connection.models
      : await this.config.discoverModels(connection, AbortSignal.timeout(10_000))
    const models = this.config.selectModels === undefined
      ? discovered
      : await this.config.selectModels(discovered)
    return models.map(model => modelInfo(provider, model))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const catalog = this.config.currentModels?.(connection) ?? connection.models
    const configured = catalog.find(entry => entry.id === model)
    const thinking = connection.defaults.thinking !== 'disabled' && (configured?.thinking ?? true)
    const discoveredEfforts = configured?.reasoningEfforts
    const efforts: readonly string[] = discoveredEfforts ?? (thinking ? LEGACY_REASONING_EFFORTS : ['off'])
    const requestedDefault = connection.defaults.reasoningEffort
    const defaultEffort = requestedDefault !== undefined && efforts.includes(requestedDefault)
      ? requestedDefault
      : configured?.defaultReasoningEffort !== undefined
          && efforts.includes(configured.defaultReasoningEffort)
        ? configured.defaultReasoningEffort
        : efforts.includes('high') ? 'high' : efforts[0] ?? 'off'
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      ...configured?.maxTokens === undefined ? {} : { defaultMaxTokens: configured.maxTokens },
      reasoning: thinking
        ? { efforts: effortInfo(efforts), defaultEffort: ReasoningEffortId(defaultEffort) }
        : { efforts: OFF_ONLY_REASONING_EFFORTS, defaultEffort: OFF },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the token freeze
    // here and hold for the whole request, so an in-flight stream never
    // observes a configuration change and the next call re-resolves.
    const connection = this.config.options()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, watchdog.signal, connection, () => { watchdog.pulse() })[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Kiro request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('Kiro API stream failed', 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Kiro stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: KiroConnectionOptions,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const token = await this.config.resolveToken(connection, signal)
    const profileArn = connection.profileArn ?? token.profileArn
    const region = profileArn === undefined
      ? connection.region ?? token.region
      : profileRegion(profileArn)
    const url = kiroRequestEndpoint(token, region)
    // Prepared before the transport call so a serialization failure keeps its
    // own diagnosis instead of being relabeled a transport failure.
    const catalog = this.config.currentModels?.(connection) ?? connection.models
    const selected = catalog.find(model => model.id === options.model)
    const nativeEffort = selected?.effortSchemaPath === undefined
      || selected.reasoningEfforts === undefined
      ? undefined
      : {
          schemaPath: selected.effortSchemaPath,
          levels: selected.reasoningEfforts,
          ...selected.defaultReasoningEffort === undefined
            ? {}
            : { defaultLevel: selected.defaultReasoningEffort },
        }
    const body = JSON.stringify(serializeRequest(
      options,
      connection.defaults,
      conversationIdFor(options.sessionId),
      profileArn,
      nativeEffort,
      selected?.maxTokensBounds === undefined
        ? undefined
        : { maxTokensBounds: selected.maxTokensBounds },
    ))
    const response = await post({
      url,
      headers: {
        'content-type': 'application/json',
        accept: 'application/vnd.amazon.eventstream',
        authorization: `Bearer ${token.accessToken}`,
        ...url.includes('://codewhisperer.') ? { 'x-amz-target': CODEWHISPERER_TARGET } : {},
        ...kiroTokenTypeHeaders(token),
        'x-amzn-kiro-agent-mode': 'vibe',
        // Kiro authorizes by client identity: a request whose `user-agent`
        // does not name its IDE is refused with "Your subscription does not
        // support this application", so this header is a protocol constant
        // rather than attribution. Harness attribution therefore travels in
        // `x-amz-user-agent`, which the service passes through.
        'user-agent': KIRO_USER_AGENT,
        'x-amz-user-agent': `${KIRO_USER_AGENT} ${userAgent()}`,
      },
      body,
      signal,
      ...connection.proxyUrl === undefined ? {} : { proxyUrl: connection.proxyUrl },
    })

    if (response.status !== 200) {
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      let message = `Kiro API error (HTTP ${response.status})`
      try {
        const parsed = JSON.parse(text) as { message?: string }
        if (parsed.message !== undefined) message = parsed.message
      } catch {
        // Only swallow error-body parsing: the status still identifies the
        // failure, so an HTML proxy error page must not mask it.
      }
      const id = response.headers['x-amzn-requestid']
      throw new LlmError(message, httpErrorCode(response.status, text), {
        status: response.status,
        ...typeof id === 'string' && id.length > 0 ? { requestId: ProviderRequestId(id) } : {},
      })
    }

    yield* translate(decodeFrames(response.body, onActivity))
  }
}
