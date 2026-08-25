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
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  QUOTA_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentId, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { decodeFrames } from './eventstream.ts'
import { serializeRequest } from './serialize.ts'
import type { WireImageBlock } from './types.ts'
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
/**
 * Reasons that mean an allowance is spent rather than momentarily throttled,
 * taken from the service model's own enums rather than guessed:
 * `ThrottlingExceptionReason` is CREDIT_CONSUMPTION_RATE_EXCEEDED,
 * DAILY_REQUEST_COUNT, INSUFFICIENT_MODEL_CAPACITY, MONTHLY_REQUEST_COUNT,
 * SERVICE_REQUEST_RATE_EXCEEDED, USER_REQUEST_RATE_EXCEEDED; and
 * `ServiceQuotaExceededExceptionReason` is CONVERSATION_LIMIT_EXCEEDED,
 * MONTHLY_REQUEST_COUNT, OVERAGE_REQUEST_LIMIT_EXCEEDED.
 *
 * Only the counted allowances belong here. The three rate reasons and
 * INSUFFICIENT_MODEL_CAPACITY name something transient, so they stay a rate
 * limit and keep their backoff — including CREDIT_CONSUMPTION_RATE_EXCEEDED,
 * which is a burn rate in the throttling vocabulary, not an empty balance.
 */
const QUOTA_REASONS = [
  'MONTHLY_REQUEST_COUNT',
  'DAILY_REQUEST_COUNT',
  'OVERAGE_REQUEST_LIMIT_EXCEEDED',
] as const
/**
 * A conversation the service will not extend further. The harness's only lever
 * is to make the conversation smaller, which is what the overflow code asks for,
 * so it is reported as overflow rather than as an opaque quota failure. Inferred
 * from the enum; not yet observed live.
 */
const CONVERSATION_LIMIT_REASON = 'CONVERSATION_LIMIT_EXCEEDED'

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
  /**
   * Request modalities this model accepts, from the catalog's own
   * `supportedInputTypes`. Absent means text only, matching the harness rule
   * that an explicit omission is negative capability: a model whose capability
   * nobody stated must not be sent images.
   */
  inputModalities?: ModelModality[]
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
  /**
   * Reach the attachment store that owns image bytes, resolved per request so a
   * profile without it simply has no images rather than failing to load. Image
   * blocks carry a reference, never the bytes, so this is the only way to send
   * one upstream.
   */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** The attachment-store surface this adapter uses: one call, by reference. */
export interface AttachmentStore {
  readImageRequest: (
    ref: ImageAttachmentRef,
    policy: { maxPixels: number; maxBytes: number },
    signal?: AbortSignal,
  ) => Promise<{ data: Uint8Array; mediaType: ImageMediaType }>
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

/**
 * Request-image budget for a Kiro turn.
 *
 * Kiro's catalog states token limits and cache checkpoints but says nothing
 * about image bounds, so these follow the service its models run behind:
 * 8000x8000 is the documented per-image dimension ceiling, and 3.75 MB is the
 * encoded-byte ceiling. Both are applied before base64 expansion, which is what
 * the wire actually carries.
 */
const IMAGE_MAX_PIXELS = 8000 * 8000
const IMAGE_MAX_BYTES = 3_750_000

/** Media types Kiro's `ImageFormat` enum accepts, mapped to its own spelling. */
const IMAGE_FORMATS = new Map<ImageMediaType, WireImageBlock['format']>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

/**
 * Collect every image reference in one request, including images nested in tool
 * results, so each is read exactly once however often it is repeated.
 * @param content - blocks from one message.
 * @param refs - accumulator keyed by attachment id.
 */
function collectImageRefs(
  content: readonly ContentBlock[],
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  for (const block of content) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/**
 * Read and re-encode every request image into Kiro's wire shape.
 *
 * Returned as a map so serialization stays synchronous and the bytes for one
 * attachment are fetched once no matter how many turns repeat it.
 * @param options - the harness request.
 * @param store - the attachment store, when the profile mounts one.
 * @param signal - request cancellation.
 * @returns wire image blocks by attachment id; empty when the request has none.
 * @throws `LlmError('UNSUPPORTED_CONTENT')` for a media type Kiro cannot accept.
 */
async function prepareImages(
  options: GenerateOptions,
  store: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<Map<AttachmentId, WireImageBlock>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  const prepared = new Map<AttachmentId, WireImageBlock>()
  if (refs.size === 0) return prepared
  if (store === undefined) {
    throw new LlmError(
      'Kiro cannot send images because this profile mounts no attachment service.',
      'UNSUPPORTED_CONTENT',
    )
  }
  for (const [id, ref] of refs) {
    const version = await store.readImageRequest(
      ref,
      { maxPixels: IMAGE_MAX_PIXELS, maxBytes: IMAGE_MAX_BYTES },
      signal,
    )
    const format = IMAGE_FORMATS.get(version.mediaType)
    if (format === undefined) {
      throw new LlmError(
        `Kiro accepts png, jpeg, gif and webp images; ${ref.mediaType} is not one of them.`,
        'UNSUPPORTED_CONTENT',
      )
    }
    prepared.set(id, { format, source: { bytes: Buffer.from(version.data).toString('base64') } })
  }
  return prepared
}

/** Describe one catalog entry for selector consumers. */
function modelInfo(provider: string, model: KiroCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
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
  if (body.includes(CONTEXT_OVERFLOW_REASON) || body.includes(CONVERSATION_LIMIT_REASON)) return true
  const normalized = body.toLowerCase()
  return CONTEXT_OVERFLOW_MESSAGES.some(phrase => normalized.includes(phrase))
    || isContextWindowExceededError(body)
}

/**
 * Recognize a body that reports an exhausted account allowance rather than a
 * transient throttle. Kiro's own vocabulary is checked first, then the harness's
 * provider-neutral wording classifier.
 * @param body - the response body text, when available.
 * @returns true when the account's plan or credits are spent.
 */
export function isKiroQuotaExhausted(body?: string): boolean {
  if (body === undefined || body.length === 0) return false
  if (body.includes(CONVERSATION_LIMIT_REASON)) return false
  return QUOTA_REASONS.some(reason => body.includes(reason)) || isQuotaExceededError(body)
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
    // Kiro reports an unusable token, a revoked entitlement, and sometimes a
    // spent allowance all as 403. The bearer wording is the one the retry
    // executor can act on; an exhausted plan must not read as a permission
    // problem, because the fix is billing rather than access.
    if (body !== undefined && body.includes('bearer token')) return 'AUTH'
    return isKiroQuotaExhausted(body) ? QUOTA_EXCEEDED_CODE : 'FORBIDDEN'
  }
  // Kiro reports an exhausted plan as 402 with reasons such as
  // MONTHLY_REQUEST_COUNT or CREDIT_CONSUMPTION_RATE_EXCEEDED. That is a spent
  // allowance, not a transient rate limit: retrying cannot help, and DSH has a
  // canonical code so surfaces can say so instead of showing `HTTP_402`.
  // Checked ahead of the status branches: the reason strings are unambiguous,
  // and the service uses more than one status for the same condition. Compaction's
  // emergency recovery is keyed to this exact code, so an overflow reported as
  // anything else silently ends the turn instead.
  if (isKiroContextOverflow(body)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status === 402) return QUOTA_EXCEEDED_CODE
  if (status === 429) {
    // A throttle whose reason names a counted allowance is the plan running out,
    // not a burst to back off from.
    return isKiroQuotaExhausted(body) ? QUOTA_EXCEEDED_CODE : 'RATE_LIMIT'
  }
  if (status === 400) {
    if (body !== undefined && body.includes('INVALID_MODEL_ID')) return 'INVALID_MODEL'
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
    // Capability before bytes: a model the catalog says is text-only must be
    // refused here rather than have the service reject the whole turn, and the
    // harness's own gate reads the same `inputModalities` this reports.
    const requestHasImages = options.messages.some(message => contentHasImage(message.content))
    if (requestHasImages && selected?.inputModalities?.includes('image') !== true) {
      throw new LlmError(
        `Kiro model "${options.model}" does not accept images.`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const images = requestHasImages
      ? await prepareImages(options, this.config.resolveAttachments?.(), signal)
      : undefined
    const body = JSON.stringify(serializeRequest(
      options,
      connection.defaults,
      conversationIdFor(options.sessionId),
      profileArn,
      nativeEffort,
      selected?.maxTokensBounds === undefined
        ? undefined
        : { maxTokensBounds: selected.maxTokensBounds },
      images,
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

    // The context capacity the percentage is a fraction of: the live catalog's
    // exact value when discovery supplied one, else the configured default.
    yield* translate(
      decodeFrames(response.body, onActivity),
      selected?.contextWindow ?? connection.defaultContextWindow,
    )
  }
}
