/**
 * Translate Kiro event-stream frames into the harness `StreamChunk` protocol.
 *
 * Kiro reports legacy thinking inside the same text channel as visible output,
 * delimited by `<thinking>` markers, and open-weight routes additionally leak
 * a `<｜DSML｜` tool-call preamble into that channel. Both are filtered by a
 * scanner that holds back only a tail short enough to be a partial marker, so
 * markers split across frames are still recognized without delaying output.
 * Models with a native effort schema instead deliver reasoning out of band as
 * `reasoningContentEvent` frames, which route straight to reasoning blocks.
 *
 * The terminal `metadataEvent` carries the provider `stopReason` and, when
 * Kiro supplies them, exact disjoint token counters. The finish reason follows
 * the provider's own terminal vocabulary; only a stream that ends without one
 * falls back to inference — `tool-calls` when the model opened any tool call,
 * `stop` otherwise, and `EMPTY_RESPONSE` for a stream with no content at all.
 *
 * @module dsh-kiro/translate
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  WireAssistantResponseEvent,
  WireContextUsageEvent,
  WireFrame,
  WireMetadataEvent,
  WireReasoningContentEvent,
  WireStopDetails,
  WireTokenUsage,
  WireToolUseEvent,
} from './types.ts'

/** Opens Kiro's in-band thinking channel. */
const THINKING_OPEN = '<thinking>'
/** Closes Kiro's in-band thinking channel. */
const THINKING_CLOSE = '</thinking>'
/**
 * Tool-call preamble the open-weight routes leak into the text channel. It is
 * an artifact of their prompt format, never content the user should read, and
 * the real call always follows as a `toolUseEvent`.
 */
const DSML_MARKER = '<\uFF5CDSML\uFF5C'
/**
 * The structural padding earlier versions sent as history. Enough of it reached
 * the model that it learned to answer with the phrase verbatim; sessions still
 * replay those answers. Serialization no longer produces it, and a response
 * that is nothing but the marker is suppressed here so the last contaminated
 * turns cannot surface as visible assistant output.
 */
const LEGACY_CONTINUATION = '[system: conversation continues]'

/**
 * Withhold a visible response that may turn out to be nothing but the legacy
 * continuation marker.
 *
 * Only an exact standalone marker is suppressed. Text is held back only while
 * everything seen so far is still a prefix of the marker, so ordinary prose —
 * including prose that discusses the phrase — is released as soon as it
 * diverges and is never altered.
 */
export class LegacyMarkerGuard {
  private pending = ''
  private settled = false

  /**
   * Filter one visible run.
   * @param text - the run exactly as the router produced it.
   * @returns the text that can be emitted now, empty while undecided.
   */
  push(text: string): string {
    if (this.settled) return text
    this.pending += text
    const trimmed = this.pending.trim()
    if (trimmed.length === 0 || LEGACY_CONTINUATION.startsWith(trimmed)) return ''
    this.settled = true
    const released = this.pending
    this.pending = ''
    return released
  }

  /**
   * Resolve the withheld text when the stream ends.
   * @returns the withheld text, or nothing when it was exactly the marker.
   */
  flush(): string {
    if (this.settled) return ''
    const pending = this.pending
    this.pending = ''
    this.settled = true
    return pending.trim() === LEGACY_CONTINUATION ? '' : pending
  }
}

/** Which channel the scanner is currently routing text to. */
type Channel = 'text' | 'reasoning' | 'suppressed'

/** One routed run of text. */
interface Routed {
  channel: 'text' | 'reasoning'
  text: string
}

/**
 * Length of the longest suffix of `buffer` that is a proper prefix of any
 * watched token. That tail must be held back: it may complete into a marker
 * on the next frame.
 * @param buffer - the unrouted text.
 * @param tokens - markers being watched in the current channel.
 * @returns the number of trailing characters to withhold.
 */
function heldSuffixLength(buffer: string, tokens: readonly string[]): number {
  const longest = Math.max(...tokens.map(token => token.length))
  for (let length = Math.min(longest - 1, buffer.length); length > 0; length -= 1) {
    const suffix = buffer.slice(buffer.length - length)
    if (tokens.some(token => token.startsWith(suffix))) return length
  }
  return 0
}

/**
 * Routes Kiro's single text channel into harness text and reasoning runs.
 *
 * Marker recognition is stateful across frames, which is the point: a delta
 * boundary inside `</thinking>` must not surface the tag as visible output.
 */
export class TextRouter {
  private channel: Channel = 'text'
  private buffer = ''

  /** Markers that end the current channel's run. */
  private get watched(): readonly string[] {
    switch (this.channel) {
      case 'text': return [THINKING_OPEN, DSML_MARKER]
      case 'reasoning': return [THINKING_CLOSE]
      case 'suppressed': return []
    }
  }

  /**
   * Route one text delta.
   * @param delta - text exactly as the frame carried it.
   * @returns the runs that can be emitted now, in order; a delta ending
   *   mid-marker contributes nothing until the marker resolves.
   */
  push(delta: string): Routed[] {
    if (this.channel === 'suppressed') return []
    this.buffer += delta
    const routed: Routed[] = []
    while (true) {
      const watched = this.watched
      if (watched.length === 0) {
        // The DSML preamble runs to the end of the text channel.
        this.buffer = ''
        return routed
      }
      const hit = watched
        .map(token => ({ token, at: this.buffer.indexOf(token) }))
        .filter(candidate => candidate.at >= 0)
        .sort((left, right) => left.at - right.at)[0]
      if (hit === undefined) break
      const before = this.buffer.slice(0, hit.at)
      if (before.length > 0 && this.channel !== 'suppressed') {
        routed.push({ channel: this.channel, text: before })
      }
      this.buffer = this.buffer.slice(hit.at + hit.token.length)
      this.channel = hit.token === THINKING_OPEN
        ? 'reasoning'
        : hit.token === THINKING_CLOSE ? 'text' : 'suppressed'
    }
    if (this.channel === 'suppressed') return routed
    const held = heldSuffixLength(this.buffer, this.watched)
    const emit = this.buffer.slice(0, this.buffer.length - held)
    this.buffer = this.buffer.slice(this.buffer.length - held)
    if (emit.length > 0) routed.push({ channel: this.channel, text: emit })
    return routed
  }

  /**
   * Release text withheld as a possible partial marker.
   * @returns the final run, or nothing when the buffer is empty or suppressed.
   */
  flush(): Routed[] {
    if (this.channel === 'suppressed' || this.buffer.length === 0) return []
    const text = this.buffer
    this.buffer = ''
    // An unterminated `<thinking>` leaves the channel open; the text it
    // accumulated is still the model's reasoning.
    return [{ channel: this.channel, text }]
  }
}

/** One harness block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Parse one frame payload as JSON.
 * @param frame - the decoded frame.
 * @returns the parsed event.
 * @throws `LlmError('MALFORMED_RESPONSE')` when the payload is not JSON.
 */
function parsePayload<T>(frame: WireFrame): T {
  const text = new TextDecoder().decode(frame.payload)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new LlmError(`malformed Kiro event payload: ${text.slice(0, 120)}`, 'MALFORMED_RESPONSE')
  }
}

/** Accept one provider counter only when it is safe for DSH's usage schema. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/**
 * Convert Kiro's disjoint token buckets to DSH's native usage vocabulary.
 *
 * Missing counters are zero, matching Kiro CLI's own stream parser, and a
 * present malformed counter rejects the event instead of publishing misleading
 * data. `totalTokens` is used only to recover the uncached input when the
 * provider reports the total without that bucket. An event with no non-zero
 * counter publishes nothing at all: usage DSH never received must read as
 * unavailable, not as zero.
 */
function tokenUsageOf(value: WireTokenUsage | undefined): TokenUsage | undefined {
  if (value === undefined || typeof value !== 'object' || value === null) return undefined
  const fields = [
    value.uncachedInputTokens,
    value.outputTokens,
    value.totalTokens,
    value.cacheReadInputTokens,
    value.cacheWriteInputTokens,
  ]
  if (fields.some(field => field !== undefined && tokenCount(field) === undefined)) return undefined
  const outputTokens = tokenCount(value.outputTokens) ?? 0
  const cacheReadTokens = tokenCount(value.cacheReadInputTokens) ?? 0
  const cacheWriteTokens = tokenCount(value.cacheWriteInputTokens) ?? 0
  const total = tokenCount(value.totalTokens)
  // Prefer the bucket; fall back to what the total leaves once the other
  // disjoint buckets are removed, so a total-only report still prices input.
  const inputTokens = tokenCount(value.uncachedInputTokens)
    ?? (total === undefined
      ? 0
      : Math.max(0, total - outputTokens - cacheReadTokens - cacheWriteTokens))
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens,
    ...cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
  }
}

/**
 * Price one call from the provider's own context measurement.
 *
 * Kiro does not send `metadataEvent.tokenUsage` on every route — this account's
 * traffic never received one — but it does send `contextUsageEvent` on every
 * request, and the wire schema treats `contextUsagePercentage` as part of token
 * accounting. Scaling it by the model's advertised window recovers the absolute
 * input size, which is what the harness needs to know how full the window is:
 * without any usage the token meter has no provider anchor and prices the whole
 * conversation from a local heuristic, so its compaction thresholds drift.
 *
 * Both local reference implementations do exactly this, for the same stated
 * reason (`Kiro-Go/proxy/kiro.go:766`, `9router/open-sse/executors/kiro.js:1086`).
 * The result is the provider's own measurement at the precision the provider
 * reported it, not an exact per-request count: the output side has no such
 * signal and is priced from the characters this stream actually emitted.
 * @param percentage - the last `contextUsagePercentage` the stream reported.
 * @param contextWindow - the selected model's advertised input capacity.
 * @param outputCharacters - characters emitted as visible text and reasoning.
 * @returns derived usage, or `undefined` when either input is unusable.
 */
export function contextUsageTokens(
  percentage: number | undefined,
  contextWindow: number | undefined,
  outputCharacters: number,
): TokenUsage | undefined {
  if (percentage === undefined || contextWindow === undefined) return undefined
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) return undefined
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  const inputTokens = Math.round(percentage / 100 * contextWindow)
  if (inputTokens <= 0) return undefined
  // Four characters per token is the same coarse ratio the reference
  // implementations use for the side the provider says nothing about.
  const outputTokens = outputCharacters > 0 ? Math.max(1, Math.round(outputCharacters / 4)) : 0
  return { inputTokens, outputTokens }
}

/**
 * Normalize a provider stop reason for comparison.
 *
 * Kiro's `StopReason` enum is upper snake case, while its lifecycle and proxy
 * vocabularies use lower snake or camel case for the same outcomes. One
 * normalized form keeps the mapping table small and case-independent.
 * @param reason - the raw provider value.
 * @returns the upper snake-case form.
 */
function normalizeStopReason(reason: string): string {
  return reason
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[\s-]+/gu, '_')
    .toUpperCase()
}

/** Render the refusal detail Kiro attaches to a filtered or declined turn. */
function refusalDetail(details: WireStopDetails | undefined): string {
  const refusal = details?.refusal
  if (refusal === undefined) return ''
  const parts = [refusal.category, refusal.explanation, refusal.recommendedModel]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
  return parts.length === 0 ? '' : ` (${parts.join('; ')})`
}

/**
 * Map one provider stop reason to the harness finish reason.
 *
 * Terminal protocol semantics are the provider's to state: a turn cut off by an
 * output cap, an exhausted context, or a refusal must not be reported as a
 * normal completion. An unrecognized reason stays a diagnosable failure rather
 * than becoming a silent success, because a new terminal reason is exactly the
 * case where guessing `stop` loses information.
 * @param reason - the raw `metadataEvent.stopReason`.
 * @param details - the accompanying `stopDetails`, when present.
 * @param sawToolCalls - whether the stream opened any tool call.
 * @returns the finish reason, or `undefined` when the provider named none.
 */
export function finishReasonOf(
  reason: string | undefined,
  details: WireStopDetails | undefined,
  sawToolCalls: boolean,
): FinishReason | undefined {
  if (reason === undefined || reason.trim().length === 0) return undefined
  switch (normalizeStopReason(reason)) {
    case 'END_TURN':
    case 'STOP':
    case 'STOP_SEQUENCE':
      // A model that both spoke and called tools still needs its calls run.
      return sawToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
    case 'TOOL_USE':
    case 'TOOL_CALLS':
      return { kind: 'tool-calls' }
    case 'MAX_TOKENS':
    case 'MAX_OUTPUT_TOKENS':
    case 'LENGTH':
      // Truncation wins over the tool-call inference: arguments cut mid-JSON
      // are not safe to execute, and the loop must see the turn as incomplete.
      return { kind: 'max-tokens' }
    case 'MODEL_CONTEXT_WINDOW_EXCEEDED':
    case 'CONTEXT_WINDOW_EXCEEDED':
      return {
        kind: 'error',
        failure: {
          message: 'Kiro stopped the turn because the model context window was exceeded',
          code: CONTEXT_WINDOW_EXCEEDED_CODE,
        },
      }
    case 'CONTENT_FILTERED':
    case 'REFUSAL':
      return {
        kind: 'error',
        failure: {
          message: `Kiro stopped the turn with a content refusal${refusalDetail(details)}`,
          code: 'CONTENT_FILTERED',
        },
      }
    case 'PAUSE_TURN':
      return {
        kind: 'error',
        failure: {
          message: 'Kiro paused the turn before it completed',
          code: 'PAUSE_TURN',
        },
      }
    default:
      return {
        kind: 'error',
        failure: {
          message: `Kiro stopped the turn with an unrecognized reason "${reason}"`,
          code: 'UNKNOWN_STOP_REASON',
        },
      }
  }
}

/**
 * Translate decoded frames into harness chunks.
 * @param frames - decoded event-stream frames in arrival order.
 * @returns deltas as they arrive, every `block-end`, exact terminal `usage`
 *   when supplied by Kiro, then one `finish`.
 * @throws `LlmError` for an in-band service exception frame or a malformed payload.
 */
export async function* translate(
  frames: AsyncIterable<WireFrame>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  const router = new TextRouter()
  const guard = new LegacyMarkerGuard()
  const order: OpenBlock[] = []
  const toolBlocks = new Map<string, OpenBlock>()
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  let usage: TokenUsage | undefined
  let stopReason: string | undefined
  let stopDetails: WireStopDetails | undefined
  let contextPercentage: number | undefined
  let outputCharacters = 0

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  function* emitText(text: string): Generator<StreamChunk> {
    outputCharacters += text.length
    if (textBlock === undefined) {
      textBlock = open('text')
      yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
    }
    textBlock.text += text
    yield { type: 'text-delta', index: textBlock.index, text }
  }

  function* emitReasoning(text: string): Generator<StreamChunk> {
    outputCharacters += text.length
    if (reasoningBlock === undefined) {
      reasoningBlock = open('reasoning')
      yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
    }
    reasoningBlock.text += text
    yield { type: 'reasoning-delta', index: reasoningBlock.index, text }
  }

  function* route(runs: Routed[]): Generator<StreamChunk> {
    for (const run of runs) {
      if (run.channel === 'reasoning') {
        yield* emitReasoning(run.text)
        continue
      }
      const visible = guard.push(run.text)
      if (visible.length > 0) yield* emitText(visible)
    }
  }

  for await (const frame of frames) {
    const exception = frame.headers[':exception-type']
    if (exception !== undefined) {
      const detail = new TextDecoder().decode(frame.payload)
      throw new LlmError(`Kiro service exception ${exception}: ${detail.slice(0, 300)}`, exception)
    }
    switch (frame.headers[':event-type']) {
      case 'assistantResponseEvent': {
        const event = parsePayload<WireAssistantResponseEvent>(frame)
        // Guarded like Kiro's own parser: a frame without string content is
        // skipped rather than allowed to fail the stream on a property access.
        if (typeof event.content === 'string' && event.content.length > 0) {
          yield* route(router.push(event.content))
        }
        break
      }
      case 'reasoningContentEvent': {
        const event = parsePayload<WireReasoningContentEvent>(frame)
        // Native reasoning arrives out of band, so it bypasses the in-band
        // marker scanner entirely. `signature` and `redactedContent` have no DSH
        // representation; they are consumed silently rather than shown as prose.
        if (typeof event.text === 'string' && event.text.length > 0) {
          yield* emitReasoning(event.text)
        }
        break
      }
      case 'toolUseEvent': {
        const event = parsePayload<WireToolUseEvent>(frame)
        let block = toolBlocks.get(event.toolUseId)
        if (block === undefined) {
          block = open('tool-call')
          block.callId = event.toolUseId
          toolBlocks.set(event.toolUseId, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (event.name !== undefined) block.name = event.name
        const fragment = event.input ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(event.toolUseId),
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: fragment,
        }
        break
      }
      case 'metadataEvent': {
        const event = parsePayload<WireMetadataEvent>(frame)
        // Kiro treats streamed token metadata as last-write-wins.
        usage = tokenUsageOf(event.tokenUsage) ?? usage
        // The terminal event repeats the percentage; keep it as a fallback for
        // the routes that send this event but no token buckets.
        const percentage = event.tokenUsage?.contextUsagePercentage
        if (typeof percentage === 'number' && Number.isFinite(percentage)) {
          contextPercentage = percentage
        }
        if (typeof event.stopReason === 'string' && event.stopReason.length > 0) {
          stopReason = event.stopReason
          stopDetails = event.stopDetails
        }
        break
      }
      case 'contextUsageEvent': {
        const event = parsePayload<WireContextUsageEvent>(frame)
        // The one usage signal every observed route does send. Last value wins:
        // it describes the request as finally priced by the service.
        if (typeof event.contextUsagePercentage === 'number'
          && Number.isFinite(event.contextUsagePercentage)) {
          contextPercentage = event.contextUsagePercentage
        }
        break
      }
      default:
        // meteringEvent, followupPrompt, and future events carry no additional
        // harness vocabulary; the protocol grows by adding cases here, never by
        // surfacing unknown frames as content.
        break
    }
  }
  yield* route(router.flush())
  const withheld = guard.flush()
  if (withheld.length > 0) yield* emitText(withheld)

  for (const block of order) {
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }
  const provided = finishReasonOf(stopReason, stopDetails, toolBlocks.size > 0)
  const reason: FinishReason = provided ?? (toolBlocks.size > 0
    ? { kind: 'tool-calls' }
    : order.length > 0
      ? { kind: 'stop' }
      : {
        kind: 'error',
        failure: {
          message: 'Kiro returned a completed response with no content',
          code: EMPTY_RESPONSE_CODE,
        },
      })
  // A provider that named a normal stop but produced nothing is still an empty
  // response: the loop needs something to act on, and the attempt is repeatable.
  const settled: FinishReason = order.length === 0
    && (reason.kind === 'stop' || reason.kind === 'tool-calls')
    ? {
      kind: 'error',
      failure: {
        message: 'Kiro returned a completed response with no content',
        code: EMPTY_RESPONSE_CODE,
      },
    }
    : reason
  const priced = usage
    ?? contextUsageTokens(contextPercentage, contextWindow, outputCharacters)
  if (priced !== undefined) yield { type: 'usage', usage: priced }
  yield { type: 'finish', reason: settled }
}
