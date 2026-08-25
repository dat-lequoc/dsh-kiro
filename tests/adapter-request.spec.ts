/**
 * End-to-end request-shaping contract for the adapter: what a live turn
 * actually puts on the wire. Covers the audit's conversation-identity and
 * generation-option findings through the real `stream()` path rather than the
 * serializer alone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { TransportRequest, TransportResponse } from '../src/transport.ts'
import type { WireRequest } from '../src/types.ts'

const posted: TransportRequest[] = []
let respond: () => TransportResponse

vi.mock('../src/transport.ts', () => ({
  post: (options: TransportRequest) => {
    posted.push(options)
    return Promise.resolve(respond())
  },
}))

const { conversationIdFor, KiroAdapter } = await import('../src/adapter.ts')
const { frame, join, metadataFrame, textFrame } = await import('./frames.ts')
type KiroConnectionOptions = import('../src/adapter.ts').KiroConnectionOptions

const SOURCE = { kind: 'plugin' as const, plugin: 'test' }
/** UUID shape the service accepts for a conversation id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: SOURCE })
}

function connection(): KiroConnectionOptions {
  return {
    region: 'us-east-1',
    defaults: {},
    defaultContextWindow: 200_000,
    models: [{
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinking: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high',
      effortSchemaPath: 'output_config',
      maxTokensBounds: { minimum: 1024, maximum: 128_000 },
      inputModalities: ['text', 'image'],
    }],
    streamIdleTimeoutMs: 300_000,
    tokenExpiryBufferMs: 300_000,
    retryPolicy: {},
  } as KiroConnectionOptions
}

function adapter(
  options = connection(),
  extra: Record<string, unknown> = {},
): InstanceType<typeof KiroAdapter> {
  return new KiroAdapter({
    options: () => options,
    resolveToken: () => Promise.resolve({
      accessToken: 'access',
      region: 'us-east-1',
      expiresAt: Date.now() + 60_000,
      authMethod: 'builder-id' as const,
    }),
    ...extra,
  } as never)
}

/** One user message carrying an image reference, as the harness would build it. */
function userImage(id: string, text?: string): Message {
  return createUserMessage({
    content: [
      ...text === undefined ? [] : [{ type: 'text' as const, text }],
      {
        type: 'image' as const,
        attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
      },
    ],
    source: SOURCE,
  } as never)
}

/** One successful response body: some text and a normal terminal stop. */
function okResponse(...frames: Uint8Array[]): TransportResponse {
  const buffer = join(...frames)
  return {
    status: 200,
    headers: {},
    body: (async function* body() {
      yield buffer
    })(),
  }
}

/** Run one turn to completion and return the request body Kiro received. */
async function turn(
  instance: InstanceType<typeof KiroAdapter>,
  extra: Partial<GenerateOptions> = {},
): Promise<WireRequest> {
  const chunks: unknown[] = []
  for await (const chunk of instance.stream({
    provider: 'kiro',
    model: 'claude-opus-5',
    messages: [user('hello')],
    ...extra,
  } as GenerateOptions)) {
    chunks.push(chunk)
  }
  const last = posted.at(-1)
  if (last === undefined) throw new Error('no request was posted')
  return JSON.parse(last.body) as WireRequest
}

describe('Kiro request identity and generation options', () => {
  beforeEach(() => {
    posted.length = 0
    respond = () => okResponse(textFrame('hi'), metadataFrame({ outputTokens: 3 }))
  })

  it('derives one stable conversation id for every turn of a DSH session', async () => {
    const instance = adapter()
    const first = await turn(instance, { sessionId: 'session-a' } as Partial<GenerateOptions>)
    const second = await turn(instance, { sessionId: 'session-a' } as Partial<GenerateOptions>)
    expect(first.conversationState.conversationId).toMatch(UUID)
    expect(second.conversationState.conversationId)
      .toBe(first.conversationState.conversationId)
  })

  it('separates conversations across DSH sessions', async () => {
    const instance = adapter()
    const first = await turn(instance, { sessionId: 'session-a' } as Partial<GenerateOptions>)
    const second = await turn(instance, { sessionId: 'session-b' } as Partial<GenerateOptions>)
    expect(second.conversationState.conversationId)
      .not.toBe(first.conversationState.conversationId)
  })

  it('never forwards the DSH session id itself', () => {
    expect(conversationIdFor('session-a')).not.toContain('session-a')
    expect(conversationIdFor('session-a')).toBe(conversationIdFor('session-a'))
    expect(conversationIdFor('session-a')).not.toBe(conversationIdFor('session-b'))
  })

  it('falls back to a fresh random id when no session is named', async () => {
    const instance = adapter()
    const first = await turn(instance)
    const second = await turn(instance)
    expect(first.conversationState.conversationId).toMatch(UUID)
    expect(second.conversationState.conversationId)
      .not.toBe(first.conversationState.conversationId)
  })

  it('sends the caller’s output cap in the field the model advertises', async () => {
    const request = await turn(adapter(), { maxTokens: 8000, temperature: 0.2 })
    // `max_tokens` inside the advertised schema branch is the only accepted
    // placement; temperature has none, so it must not appear anywhere.
    expect(request.additionalModelRequestFields)
      .toEqual({ output_config: { effort: 'high' }, max_tokens: 8000 })
    expect(JSON.stringify(request)).not.toContain('temperature')
    expect(JSON.stringify(request)).not.toContain('inferenceConfig')
  })

  it('clamps the cap to the model’s advertised range', async () => {
    const request = await turn(adapter(), { maxTokens: 999_999 })
    expect(request.additionalModelRequestFields)
      .toEqual({ output_config: { effort: 'high' }, max_tokens: 128_000 })
  })

  it('maps a provider context-overflow rejection to the compaction trigger code', async () => {
    respond = () => ({
      status: 400,
      headers: { 'x-amzn-requestid': 'req-1' },
      body: (async function* body() {
        yield new TextEncoder().encode(JSON.stringify({
          message: 'Input is too long.',
          reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
        }))
      })(),
    })
    await expect(turn(adapter())).rejects.toMatchObject({
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'Input is too long.',
    })
  })

  it('reports no usage at all when Kiro sends no usable signal', async () => {
    respond = () => okResponse(
      textFrame('answer'),
      frame(
        { ':event-type': 'metadataEvent', ':message-type': 'event' },
        JSON.stringify({ stopReason: 'END_TURN' }),
      ),
    )
    const chunks: { type: string }[] = []
    for await (const chunk of adapter().stream({
      provider: 'kiro',
      model: 'claude-opus-5',
      messages: [user('hello')],
    } as GenerateOptions)) {
      chunks.push(chunk as { type: string })
    }
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('sends a user image as a wire image block on a vision model', async () => {
    respond = () => okResponse(textFrame('a cat'))
    const read: string[] = []
    const chunks: { type: string }[] = []
    for await (const chunk of adapter(connection(), {
      resolveAttachments: () => ({
        readImageRequest: async (ref: { attachmentId: string }) => {
          read.push(ref.attachmentId)
          return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }
        },
      }),
    }).stream({
      provider: 'kiro',
      model: 'claude-opus-5',
      messages: [userImage('att-1', 'what is this?')],
    } as GenerateOptions)) {
      chunks.push(chunk as { type: string })
    }
    expect(read).toEqual(['att-1'])
    const body = JSON.parse(posted.at(-1)?.body ?? '{}') as WireRequest
    expect(body.conversationState.currentMessage.userInputMessage.images).toEqual([
      { format: 'png', source: { bytes: 'AQID' } },
    ])
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  })

  it('refuses an image for a model the catalog reports as text-only', async () => {
    // Refused before any byte is read: the service would reject the whole turn,
    // and the harness gates on the same capability this reports.
    let readCalls = 0
    await expect((async () => {
      const textOnly = { ...connection(), models: [{ id: 'glm-5', name: 'GLM-5', inputModalities: ['text'] }] } as KiroConnectionOptions
      for await (const _chunk of adapter(textOnly, {
        resolveAttachments: () => ({
          readImageRequest: async () => {
            readCalls += 1
            return { data: new Uint8Array([1]), mediaType: 'image/png' as const }
          },
        }),
      }).stream({
        provider: 'kiro',
        model: 'glm-5',
        messages: [userImage('att-1')],
      } as GenerateOptions)) { /* the first pull throws */ }
    })()).rejects.toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
    expect(readCalls).toBe(0)
  })

  it('refuses an image when the profile mounts no attachment service', async () => {
    await expect((async () => {
      for await (const _chunk of adapter().stream({
        provider: 'kiro',
        model: 'claude-opus-5',
        messages: [userImage('att-1')],
      } as GenerateOptions)) { /* the first pull throws */ }
    })()).rejects.toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('refuses a media type outside Kiro’s image formats', async () => {
    await expect((async () => {
      for await (const _chunk of adapter(connection(), {
        resolveAttachments: () => ({
          readImageRequest: async () => ({
            data: new Uint8Array([1]),
            mediaType: 'image/bmp' as never,
          }),
        }),
      }).stream({
        provider: 'kiro',
        model: 'claude-opus-5',
        messages: [userImage('att-1')],
      } as GenerateOptions)) { /* the first pull throws */ }
    })()).rejects.toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('prices the turn from the provider’s context percentage and the catalog window', async () => {
    // This is the signal every observed live route actually sends. The catalog
    // entry advertises a 1,000,000-token window, so 2.5% is 25,000 input tokens.
    respond = () => okResponse(
      textFrame('answer'),
      frame(
        { ':event-type': 'contextUsageEvent', ':message-type': 'event' },
        JSON.stringify({ contextUsagePercentage: 2.5 }),
      ),
      frame(
        { ':event-type': 'meteringEvent', ':message-type': 'event' },
        JSON.stringify({ unit: 'credit', unitPlural: 'credits', usage: 1 }),
      ),
    )
    const chunks: { type: string }[] = []
    for await (const chunk of adapter().stream({
      provider: 'kiro',
      model: 'claude-opus-5',
      messages: [user('hello')],
    } as GenerateOptions)) {
      chunks.push(chunk as { type: string })
    }
    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 25_000, outputTokens: 2 } })
  })
})
