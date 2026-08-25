/**
 * Reproduction suite for the audit findings in ISSUE.md. Every case here fails
 * against the audited revision and passes once the corresponding defect is
 * fixed. Kept in the tree as the regression contract for those defects.
 */

import { describe, expect, it } from 'vitest'
import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { httpErrorCode } from '../src/adapter.ts'
import { serializeRequest } from '../src/serialize.ts'
import { contextUsageTokens, translate } from '../src/translate.ts'
import { decodeFrames } from '../src/eventstream.ts'
import type { WireHistoryEntry } from '../src/types.ts'
import { chunked, frame, join } from './frames.ts'

const SOURCE = { kind: 'plugin' as const, plugin: 'test' }
const LEGACY_MARKER = '[system: conversation continues]'

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: SOURCE })
}

function assistant(text: string, calls: { id: string; name: string; args: string }[] = []): Message {
  return createAssistantMessage({
    content: [
      ...text.length > 0 ? [{ type: 'text' as const, text }] : [],
      ...calls.map(call => ({
        type: 'tool-call' as const,
        id: CallId(call.id),
        name: call.name,
        arguments: call.args,
      })),
    ],
    source: { provider: 'kiro', model: 'claude-sonnet-4.5' },
  })
}

function toolResult(id: string, text: string): Message {
  return createToolResultMessage({ callId: CallId(id), content: [{ type: 'text', text }] })
}

function serialize(messages: Message[], extra: Partial<GenerateOptions> = {}, defaults = {}) {
  return serializeRequest(
    { provider: 'kiro', model: 'claude-sonnet-4.5', messages, ...extra },
    defaults,
    'conv-1',
  )
}

/** Every text Kiro would see in one serialized request. */
function wireTexts(request: ReturnType<typeof serialize>): string[] {
  const entries: WireHistoryEntry[] = request.conversationState.history ?? []
  return [
    request.conversationState.currentMessage.userInputMessage.content,
    ...entries.map(entry =>
      'userInputMessage' in entry
        ? entry.userInputMessage.content
        : entry.assistantResponseMessage.content),
  ]
}

function event(type: string, payload: unknown): Uint8Array {
  return frame({ ':event-type': type, ':message-type': 'event' }, JSON.stringify(payload))
}

async function run(...frames: Uint8Array[]): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = []
  // 200,000 is the advertised window of the model these fixtures stand in for.
  for await (const chunk of translate(decodeFrames(chunked(join(...frames), 4096)), 200_000)) {
    collected.push(chunk)
  }
  return collected
}

function textOf(chunks: StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

function reasoningOf(chunks: StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
}

function finishOf(chunks: StreamChunk[]) {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  if (finish?.type !== 'finish') throw new Error('no finish chunk')
  return finish.reason
}

describe('P0-1 Kiro context overflow classification', () => {
  it('maps the CONTENT_LENGTH_EXCEEDS_THRESHOLD validation reason', () => {
    const body = JSON.stringify({
      message: 'Improperly formed request.',
      reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
    })
    expect(httpErrorCode(400, body)).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('maps the observed "Input is too long." message', () => {
    expect(httpErrorCode(400, JSON.stringify({ message: 'Input is too long.' })))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('maps "Prompt is too long." case-insensitively', () => {
    expect(httpErrorCode(400, JSON.stringify({ message: 'prompt is TOO LONG' })))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('keeps an ordinary validation 400 as INVALID_REQUEST', () => {
    expect(httpErrorCode(400, JSON.stringify({ message: 'Improperly formed request.' })))
      .toBe('INVALID_REQUEST')
    expect(httpErrorCode(400, JSON.stringify({
      message: 'tool name is invalid',
      reason: 'INVALID_TOOL_NAME',
    }))).toBe('INVALID_REQUEST')
  })

  it('keeps the invalid-model 400 mapping', () => {
    expect(httpErrorCode(400, JSON.stringify({ reason: 'INVALID_MODEL_ID' }))).toBe('INVALID_MODEL')
  })
})

describe('P0-2 continuation marker never reaches the wire or the user', () => {
  it('omits the legacy marker when the conversation ends on the assistant', () => {
    const request = serialize([user('hi'), assistant('done')])
    expect(wireTexts(request).join('\n')).not.toContain(LEGACY_MARKER)
  })

  it('omits the legacy marker from a tool-only assistant turn', () => {
    const request = serialize([
      user('go'),
      assistant('', [{ id: 'call-1', name: 'run', args: '{}' }]),
      toolResult('call-1', 'ok'),
    ])
    expect(wireTexts(request).join('\n')).not.toContain(LEGACY_MARKER)
  })

  it('strips legacy markers already persisted in replayed history', () => {
    const request = serialize([
      user('one'),
      assistant(LEGACY_MARKER),
      user('two'),
      assistant(LEGACY_MARKER),
      user('three'),
    ])
    expect(wireTexts(request).join('\n')).not.toContain(LEGACY_MARKER)
  })

  it('suppresses an exact standalone legacy marker returned by the model', async () => {
    const chunks = await run(event('assistantResponseEvent', { content: LEGACY_MARKER }))
    expect(textOf(chunks)).not.toContain(LEGACY_MARKER)
    expect(chunks.some(chunk => chunk.type === 'block-start')).toBe(false)
    // Nothing usable was produced, so the turn is a repeatable empty response
    // rather than a success carrying a system-looking placeholder.
    const reason = finishOf(chunks)
    expect(reason.kind === 'error' ? reason.failure.code : '').toBe('EMPTY_RESPONSE')
  })

  it('suppresses a marker split across frames', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: '[system: conversation' }),
      event('assistantResponseEvent', { content: ' continues]' }),
    )
    expect(textOf(chunks)).toBe('')
  })

  it('releases a withheld prefix as soon as the text diverges', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: '[system' }),
      event('assistantResponseEvent', { content: 'd] is a daemon.' }),
    )
    expect(textOf(chunks)).toBe('[systemd] is a daemon.')
  })

  it('preserves ordinary prose that merely mentions the marker', async () => {
    const prose = `The bug was that ${LEGACY_MARKER} leaked into output.`
    const chunks = await run(event('assistantResponseEvent', { content: prose }))
    expect(textOf(chunks)).toBe(prose)
  })
})

describe('P1-1 native reasoning events', () => {
  it('routes reasoningContentEvent text to reasoning blocks', async () => {
    const chunks = await run(
      event('reasoningContentEvent', { text: 'let me think' }),
      event('assistantResponseEvent', { content: 'answer' }),
    )
    expect(reasoningOf(chunks)).toBe('let me think')
    expect(textOf(chunks)).toBe('answer')
  })

  it('joins reasoning text fragmented across frames', async () => {
    const chunks = await run(
      event('reasoningContentEvent', { text: 'part one ' }),
      event('reasoningContentEvent', { text: 'part two' }),
      event('assistantResponseEvent', { content: 'done' }),
    )
    expect(reasoningOf(chunks)).toBe('part one part two')
  })

  it('never surfaces a signature-only or redacted frame as visible prose', async () => {
    const chunks = await run(
      event('reasoningContentEvent', { signature: 'sig-abc' }),
      event('reasoningContentEvent', { redactedContent: 'AAAA' }),
      event('assistantResponseEvent', { content: 'visible' }),
    )
    expect(textOf(chunks)).toBe('visible')
    expect(reasoningOf(chunks)).toBe('')
  })

  it('skips a content-less assistant frame instead of failing the stream', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { modelId: 'claude-opus-5' }),
      event('assistantResponseEvent', { content: 'real text' }),
    )
    expect(textOf(chunks)).toBe('real text')
  })
})

describe('P1-2 provider stop reasons', () => {
  it('maps MAX_TOKENS to the max-tokens finish reason', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: 'truncated' }),
      event('metadataEvent', { stopReason: 'MAX_TOKENS' }),
    )
    expect(finishOf(chunks)).toEqual({ kind: 'max-tokens' })
  })

  it('maps MODEL_CONTEXT_WINDOW_EXCEEDED to a context-overflow failure', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: 'partial' }),
      event('metadataEvent', { stopReason: 'MODEL_CONTEXT_WINDOW_EXCEEDED' }),
    )
    const reason = finishOf(chunks)
    expect(reason.kind).toBe('error')
    expect(reason.kind === 'error' ? reason.failure.code : '').toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('maps CONTENT_FILTERED with refusal details to an error finish', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: 'sorry' }),
      event('metadataEvent', {
        stopReason: 'CONTENT_FILTERED',
        stopDetails: { refusal: { category: 'CYBER', explanation: 'declined' } },
      }),
    )
    const reason = finishOf(chunks)
    expect(reason.kind).toBe('error')
    expect(reason.kind === 'error' ? reason.failure.code : '').toBe('CONTENT_FILTERED')
    expect(reason.kind === 'error' ? reason.failure.message : '').toContain('declined')
  })

  it('keeps END_TURN a normal stop and TOOL_USE a tool-calls finish', async () => {
    const normal = await run(
      event('assistantResponseEvent', { content: 'done' }),
      event('metadataEvent', { stopReason: 'END_TURN' }),
    )
    expect(finishOf(normal)).toEqual({ kind: 'stop' })
    const tools = await run(
      event('toolUseEvent', { toolUseId: 't1', name: 'run', input: '{}' }),
      event('toolUseEvent', { toolUseId: 't1', stop: true }),
      event('metadataEvent', { stopReason: 'TOOL_USE' }),
    )
    expect(finishOf(tools)).toEqual({ kind: 'tool-calls' })
  })

  it('keeps an unknown terminal reason diagnosable instead of a silent success', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: 'partial' }),
      event('metadataEvent', { stopReason: 'SOMETHING_NEW' }),
    )
    const reason = finishOf(chunks)
    expect(reason.kind).toBe('error')
    expect(reason.kind === 'error' ? reason.failure.message : '').toContain('SOMETHING_NEW')
  })

  it('reports a paused turn as incomplete under its own code', async () => {
    // PAUSE_TURN is the provider interrupting itself mid-turn. It is not a
    // completion, so it keeps a distinct code rather than being folded into the
    // unknown-reason bucket or reported as a normal stop.
    const chunks = await run(
      event('assistantResponseEvent', { content: 'partial' }),
      event('metadataEvent', { stopReason: 'PAUSE_TURN' }),
    )
    const reason = finishOf(chunks)
    expect(reason.kind === 'error' ? reason.failure.code : '').toBe('PAUSE_TURN')
  })

  it('accepts the lower-case stop vocabulary the proxies use', async () => {
    // Kiro's own enum is upper snake case, but its lifecycle and the community
    // proxies report the same outcomes in lower snake case.
    const chunks = await run(
      event('assistantResponseEvent', { content: 'partial' }),
      event('metadataEvent', { stopReason: 'model_context_window_exceeded' }),
    )
    const reason = finishOf(chunks)
    expect(reason.kind === 'error' ? reason.failure.code : '').toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('still finishes a stream that closes with no terminal metadata', async () => {
    const chunks = await run(event('assistantResponseEvent', { content: 'text only' }))
    expect(finishOf(chunks)).toEqual({ kind: 'stop' })
  })

  it('prefers the truncation reason over the tool-call inference', async () => {
    // Arguments cut off mid-JSON are not safe to execute, so a max-token stop
    // must not be reported as a normal round of tool calls.
    const chunks = await run(
      event('toolUseEvent', { toolUseId: 't1', name: 'run', input: '{"partial' }),
      event('metadataEvent', { stopReason: 'MAX_TOKENS' }),
    )
    expect(finishOf(chunks)).toEqual({ kind: 'max-tokens' })
  })

  it('keeps tool calls actionable when the model also spoke', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: 'calling a tool' }),
      event('toolUseEvent', { toolUseId: 't1', name: 'run', input: '{}' }),
      event('metadataEvent', { stopReason: 'END_TURN' }),
    )
    expect(finishOf(chunks)).toEqual({ kind: 'tool-calls' })
  })

  it('treats a normal stop with no content as an empty response', async () => {
    const chunks = await run(event('metadataEvent', { stopReason: 'END_TURN' }))
    const reason = finishOf(chunks)
    expect(reason.kind === 'error' ? reason.failure.code : '').toBe('EMPTY_RESPONSE')
  })

  it('closes an unfinished tool call when the stream ends without its stop frame', async () => {
    // Abnormal termination: the service stopped mid-call. The partial arguments
    // are still surfaced as the block they belong to rather than lost, and the
    // turn is reported as tool-calls so the loop can judge them.
    const chunks = await run(
      event('toolUseEvent', { toolUseId: 't1', name: 'run', input: '{"partial' }),
    )
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end?.type === 'block-end' ? end.block : undefined)
      .toEqual({ type: 'tool-call', id: 't1', name: 'run', arguments: '{"partial' })
    expect(finishOf(chunks)).toEqual({ kind: 'tool-calls' })
  })

  it('fails the stream on an in-band service exception frame', async () => {
    await expect(run(
      event('assistantResponseEvent', { content: 'partial' }),
      frame(
        { ':exception-type': 'throttlingException', ':message-type': 'exception' },
        JSON.stringify({ message: 'slow down' }),
      ),
    )).rejects.toMatchObject({ code: 'throttlingException' })
  })
})

describe('plugin boundary: the adapter never compacts', () => {
  // As a plugin this owns the provider seam only. Deciding what a conversation
  // should contain is `dsh-compaction-basic`'s job, driven by the token meter and
  // by the overflow code this adapter reports. So the serializer may repair
  // protocol shape — merge same-role runs, pad an alternation gap, carry an
  // orphaned tool result as text — but it must never drop or condense content to
  // make a request fit.

  it('puts every message on the wire, whatever the conversation contains', () => {
    const messages = [
      user('first question'),
      assistant('first answer', [{ id: 'call-1', name: 'run', args: '{"a":1}' }]),
      toolResult('call-1', 'tool output one'),
      assistant('second answer'),
      user('second question'),
      assistant('third answer', [{ id: 'call-2', name: 'run', args: '{"b":2}' }]),
      toolResult('call-2', 'tool output two'),
      user('third question'),
    ]
    // The whole body, because a matched tool result travels in the turn's
    // `userInputMessageContext.toolResults` rather than in its content.
    const wire = JSON.stringify(serialize(messages))
    for (const fragment of [
      'first question', 'first answer', 'tool output one', 'second answer',
      'second question', 'third answer', 'tool output two', 'third question',
    ]) {
      expect(wire).toContain(fragment)
    }
  })

  it('sends a conversation far larger than any context window in full', () => {
    // The provider decides what is too large, and its refusal is what triggers
    // the harness's recovery. Trimming here would hide that from the harness and
    // silently discard turns it still believes it has.
    const block = 'x'.repeat(50_000)
    const messages = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0 ? user(`${block}-u${index}`) : assistant(`${block}-a${index}`))
    const request = serialize([...messages, user('final')])
    const serialized = JSON.stringify(request)
    expect(serialized.length).toBeGreaterThan(2_000_000)
    for (const index of [0, 1, 20, 39]) {
      expect(serialized).toContain(`-${index % 2 === 0 ? 'u' : 'a'}${index}`)
    }
    expect(wireTexts(request).length).toBeGreaterThanOrEqual(40)
  })

  it('keeps an orphaned tool result as text instead of discarding it', () => {
    const request = serialize([user('go'), toolResult('call-gone', 'observation worth keeping')])
    expect(wireTexts(request).join('\n')).toContain('observation worth keeping')
  })

  it('omits nothing but the marker this plugin itself authored', () => {
    const request = serialize([
      user('question'),
      assistant(LEGACY_MARKER),
      user('follow-up'),
    ])
    const wire = wireTexts(request).join('\n')
    expect(wire).toContain('question')
    expect(wire).toContain('follow-up')
    expect(wire).not.toContain(LEGACY_MARKER)
  })

  it('reports the overflow and leaves recovery to the harness', () => {
    // The adapter's whole contribution to recovery is this code. It does not
    // retry, summarize, or edit the conversation: the compaction plugin owns that,
    // and it keys on exactly this value.
    expect(httpErrorCode(400, JSON.stringify({
      message: 'Input is too long.',
      reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
    }))).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
  })

  it('declares no dependency on any compaction or session service', async () => {
    // A plugin that never compacts has no reason to inject the services that do.
    const plugin = await import('../src/index.ts')
    expect(plugin.inject).toEqual(['llm'])
  })
})

describe('P1-4 usage telemetry', () => {
  it('publishes exact buckets when Kiro sends them', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: 'hi' }),
      event('metadataEvent', {
        tokenUsage: {
          uncachedInputTokens: 120,
          outputTokens: 8,
          cacheReadInputTokens: 4000,
          cacheWriteInputTokens: 40,
          totalTokens: 4168,
        },
      }),
    )
    expect(chunks.find(chunk => chunk.type === 'usage'))
      .toEqual({
        type: 'usage',
        usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 4000, cacheWriteTokens: 40 },
      })
  })

  it('recovers the input bucket from a total-only report', async () => {
    // `totalTokens` is declared alongside the buckets; a route that reports the
    // total without the uncached bucket must still price the input.
    const chunks = await run(
      event('assistantResponseEvent', { content: 'hi' }),
      event('metadataEvent', {
        tokenUsage: { totalTokens: 500, outputTokens: 100, cacheReadInputTokens: 300 },
      }),
    )
    expect(chunks.find(chunk => chunk.type === 'usage'))
      .toEqual({
        type: 'usage',
        usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 300 },
      })
  })

  it('prices the call from the provider’s context percentage when no buckets arrive', async () => {
    // Every observed live route sends contextUsageEvent and no metadataEvent, so
    // this is the path that actually runs. 12.5% of a 200,000-token window is
    // 25,000 input tokens; the output side is scaled from emitted characters.
    const chunks = await run(
      event('assistantResponseEvent', { content: 'x'.repeat(40) }),
      event('contextUsageEvent', { contextUsagePercentage: 12.5 }),
      event('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 1 }),
    )
    expect(chunks.find(chunk => chunk.type === 'usage'))
      .toEqual({ type: 'usage', usage: { inputTokens: 25_000, outputTokens: 10 } })
  })

  it('prefers exact buckets over the derived measurement', async () => {
    const chunks = await run(
      event('assistantResponseEvent', { content: 'x'.repeat(40) }),
      event('contextUsageEvent', { contextUsagePercentage: 50 }),
      event('metadataEvent', { tokenUsage: { uncachedInputTokens: 7, outputTokens: 3 } }),
    )
    expect(chunks.find(chunk => chunk.type === 'usage'))
      .toEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } })
  })

  it('publishes nothing when neither signal is usable', async () => {
    expect(contextUsageTokens(undefined, 200_000, 100)).toBeUndefined()
    expect(contextUsageTokens(12.5, undefined, 100)).toBeUndefined()
    expect(contextUsageTokens(0, 200_000, 100)).toBeUndefined()
    expect(contextUsageTokens(101, 200_000, 100)).toBeUndefined()
    expect(contextUsageTokens(12.5, 0, 100)).toBeUndefined()
    // A percentage too small to round up to one token is not usage either.
    expect(contextUsageTokens(0.00001, 1000, 0)).toBeUndefined()
  })

  it('counts reasoning characters towards the derived output', async () => {
    const chunks = await run(
      event('reasoningContentEvent', { text: 'y'.repeat(20) }),
      event('assistantResponseEvent', { content: 'z'.repeat(20) }),
      event('contextUsageEvent', { contextUsagePercentage: 1 }),
    )
    expect(chunks.find(chunk => chunk.type === 'usage'))
      .toEqual({ type: 'usage', usage: { inputTokens: 2000, outputTokens: 10 } })
  })
})

describe('account allowance classification', () => {
  it('maps Kiro’s 402 plan limit to the canonical quota code', () => {
    // Observed live once the account was spent: retrying cannot help, so it must
    // not read as a rate limit or an opaque HTTP_402.
    expect(httpErrorCode(402, JSON.stringify({
      message: 'You have reached the limit.',
      reason: 'MONTHLY_REQUEST_COUNT',
    }))).toBe('QUOTA')
  })

  it('maps a credit-rate 403 to quota but keeps other 403s forbidden', () => {
    expect(httpErrorCode(403, JSON.stringify({ reason: 'CREDIT_CONSUMPTION_RATE_EXCEEDED' })))
      .toBe('QUOTA')
    expect(httpErrorCode(403, JSON.stringify({ message: 'not entitled' }))).toBe('FORBIDDEN')
    expect(httpErrorCode(403, 'expired bearer token')).toBe('AUTH')
  })

  it('separates a burst throttle from a spent monthly allowance', () => {
    expect(httpErrorCode(429, JSON.stringify({ reason: 'USER_REQUEST_RATE_EXCEEDED' })))
      .toBe('RATE_LIMIT')
    expect(httpErrorCode(429, JSON.stringify({ reason: 'MONTHLY_REQUEST_COUNT' })))
      .toBe('QUOTA')
  })
})

describe('P1-3 generation options reach the only field that accepts them', () => {
  // `generateAssistantResponse` declares no `inferenceConfig` member — the
  // service drops one silently — and its `additionalModelRequestFields` is
  // validated against each model's advertised schema with
  // `additionalProperties: false`. Live probes recorded all three outcomes:
  // an unadvertised property is HTTP 400 `property 'temperature' is not defined
  // in the schema`, the member on a schema-less model is HTTP 400
  // `additionalModelRequestFields is not supported for this model`, and
  // `max_tokens` inside the advertised branch is accepted.
  const native = {
    schemaPath: 'output_config' as const,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultLevel: 'high',
  }
  const limits = { maxTokensBounds: { minimum: 1024, maximum: 128_000 } }

  function serializeFor(extra: Partial<GenerateOptions>) {
    return serializeRequest(
      { provider: 'kiro', model: 'claude-opus-5', messages: [user('hi')], ...extra },
      {},
      'conv-1',
      undefined,
      native,
      limits,
    )
  }

  it('sends the output cap as the advertised max_tokens field', () => {
    const request = serializeFor({ maxTokens: 4096, reasoningEffort: ReasoningEffortId('high') })
    expect(request.additionalModelRequestFields)
      .toEqual({ output_config: { effort: 'high' }, max_tokens: 4096 })
  })

  it('never emits a top-level inferenceConfig the service would ignore', () => {
    const request = serializeFor({ maxTokens: 4096 })
    expect(Object.keys(request)).not.toContain('inferenceConfig')
  })

  it('clamps the cap into the advertised bounds at both ends', () => {
    expect(serializeFor({ maxTokens: 500_000 }).additionalModelRequestFields)
      .toEqual({ output_config: { effort: 'high' }, max_tokens: 128_000 })
    // The field has a floor as well as a ceiling; below it the value is refused.
    expect(serializeFor({ maxTokens: 16 }).additionalModelRequestFields)
      .toEqual({ output_config: { effort: 'high' }, max_tokens: 1024 })
  })

  it('sends nothing at all to a model that advertises no request-field schema', () => {
    const request = serializeRequest(
      {
        provider: 'kiro',
        model: 'claude-sonnet-4.5',
        messages: [user('hi')],
        maxTokens: 4096,
        temperature: 0.4,
      },
      {},
      'conv-1',
    )
    expect(request.additionalModelRequestFields).toBeUndefined()
    expect(Object.keys(request)).not.toContain('inferenceConfig')
  })

  it('omits the cap when the model advertises a schema without max_tokens', () => {
    const request = serializeRequest(
      {
        provider: 'kiro',
        model: 'gpt-5.6-sol',
        messages: [user('hi')],
        maxTokens: 4096,
        reasoningEffort: ReasoningEffortId('high'),
      },
      {},
      'conv-1',
      undefined,
      { schemaPath: 'reasoning', levels: ['low', 'high'], defaultLevel: 'high' },
    )
    expect(request.additionalModelRequestFields).toEqual({ reasoning: { effort: 'high' } })
  })

  it('never sends temperature, which has no accepted placement', () => {
    const request = serializeFor({ temperature: 0.4 })
    expect(JSON.stringify(request)).not.toContain('temperature')
  })

  it('rejects an unusable output cap instead of sending it', () => {
    expect(() => serializeFor({ maxTokens: 0 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(() => serializeFor({ maxTokens: 1.5 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
})
