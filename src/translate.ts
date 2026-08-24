/**
 * Translate Kiro event-stream frames into the harness `StreamChunk` protocol.
 *
 * Kiro reports thinking inside the same text channel as visible output,
 * delimited by `<thinking>` markers, and open-weight routes additionally leak
 * a `<｜DSML｜` tool-call preamble into that channel. Both are filtered by a
 * scanner that holds back only a tail short enough to be a partial marker, so
 * markers split across frames are still recognized without delaying output.
 *
 * The stream carries no finish event: the frame sequence simply ends. Its
 * terminal `metadataEvent` does carry exact, disjoint token counters. The
 * finish reason is derived — `tool-calls` when the model opened any tool call,
 * `stop` otherwise, and `EMPTY_RESPONSE` for a stream with no content at all.
 *
 * @module dsh-kiro/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  WireAssistantResponseEvent,
  WireFrame,
  WireMetadataEvent,
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
 * Missing counters are zero, matching Kiro CLI's own stream parser. A present
 * malformed counter rejects the event instead of publishing misleading data.
 */
function tokenUsageOf(value: WireTokenUsage | undefined): TokenUsage | undefined {
  if (value === undefined || typeof value !== 'object' || value === null) return undefined
  const fields = [
    value.uncachedInputTokens,
    value.outputTokens,
    value.cacheReadInputTokens,
    value.cacheWriteInputTokens,
  ]
  if (fields.some(field => field !== undefined && tokenCount(field) === undefined)) return undefined
  const inputTokens = tokenCount(value.uncachedInputTokens) ?? 0
  const outputTokens = tokenCount(value.outputTokens) ?? 0
  const cacheReadTokens = tokenCount(value.cacheReadInputTokens) ?? 0
  const cacheWriteTokens = tokenCount(value.cacheWriteInputTokens) ?? 0
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
 * Translate decoded frames into harness chunks.
 * @param frames - decoded event-stream frames in arrival order.
 * @returns deltas as they arrive, then every `block-end`, then one terminal
 *   exact terminal `usage` when supplied by Kiro, and one `finish`.
 * @throws `LlmError` for an in-band service exception frame or a malformed payload.
 */
export async function* translate(frames: AsyncIterable<WireFrame>): AsyncGenerator<StreamChunk> {
  const router = new TextRouter()
  const order: OpenBlock[] = []
  const toolBlocks = new Map<string, OpenBlock>()
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  let usage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  function* route(runs: Routed[]): Generator<StreamChunk> {
    for (const run of runs) {
      if (run.channel === 'reasoning') {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += run.text
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: run.text }
        continue
      }
      if (textBlock === undefined) {
        textBlock = open('text')
        yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
      }
      textBlock.text += run.text
      yield { type: 'text-delta', index: textBlock.index, text: run.text }
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
        if (event.content.length > 0) yield* route(router.push(event.content))
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
        break
      }
      default:
        // contextUsageEvent, meteringEvent, followupPrompt, and future events
        // carry no additional harness vocabulary; the protocol grows by
        // adding cases here, never by surfacing unknown frames as content.
        break
    }
  }
  yield* route(router.flush())

  for (const block of order) {
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }
  const reason: FinishReason = toolBlocks.size > 0
    ? { kind: 'tool-calls' }
    : order.length > 0
      ? { kind: 'stop' }
      : {
        kind: 'error',
        failure: {
          message: 'Kiro returned a completed response with no content',
          code: EMPTY_RESPONSE_CODE,
        },
      }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason }
}
