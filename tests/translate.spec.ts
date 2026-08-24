import { describe, expect, it } from 'vitest'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { decodeFrames } from '../src/eventstream.ts'
import { TextRouter, translate } from '../src/translate.ts'
import type { WireFrame } from '../src/types.ts'
import { chunked, frame, join, textFrame, toolFrame } from './frames.ts'

/** Wrap raw frames as the async iterable the translator consumes. */
async function* framesOf(...produced: WireFrame[]): AsyncGenerator<WireFrame> {
  for (const one of produced) yield one
}

/** Build one event frame the decoder will parse. */
function event(type: string, payload: string): Uint8Array {
  return frame({ ':event-type': type, ':message-type': 'event' }, payload)
}

/** Collect the translator's chunks. */
async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = []
  for await (const chunk of chunks) collected.push(chunk)
  return collected
}

/** Translate a byte buffer end to end, as the adapter does. */
function run(buffer: Uint8Array, chunkSize = 4096): Promise<StreamChunk[]> {
  return collect(translate(decodeFrames(chunked(buffer, chunkSize))))
}

/** Concatenated text of every emitted text delta. */
function textOf(chunks: StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

/** Concatenated text of every emitted reasoning delta. */
function reasoningOf(chunks: StreamChunk[]): string {
  return chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
}

describe('TextRouter', () => {
  it('routes plain text to the visible channel', () => {
    expect(new TextRouter().push('hello')).toEqual([{ channel: 'text', text: 'hello' }])
  })

  it('routes thinking content to the reasoning channel', () => {
    const router = new TextRouter()
    const runs = [...router.push('<thinking>why</thinking>answer'), ...router.flush()]
    expect(runs).toEqual([
      { channel: 'reasoning', text: 'why' },
      { channel: 'text', text: 'answer' },
    ])
  })

  it('withholds a tail that could still become a marker', () => {
    const router = new TextRouter()
    // `<thin` is a prefix of `<thinking>`: emitting it would leak markup, and
    // the next delta decides whether it is a marker or literal text.
    expect(router.push('done<thin')).toEqual([{ channel: 'text', text: 'done' }])
    // The completed marker switches channel, and the text after it is
    // unambiguous, so it routes immediately rather than waiting for a flush.
    expect(router.push('king>secret')).toEqual([{ channel: 'reasoning', text: 'secret' }])
    expect(router.flush()).toEqual([])
  })

  it('emits a withheld tail that turns out to be literal text', () => {
    const router = new TextRouter()
    expect(router.push('a<th')).toEqual([{ channel: 'text', text: 'a' }])
    expect(router.push('e end')).toEqual([{ channel: 'text', text: '<the end' }])
  })

  it('keeps an unterminated thinking run as reasoning', () => {
    const router = new TextRouter()
    expect(router.push('<thinking>cut off')).toEqual([{ channel: 'reasoning', text: 'cut off' }])
    expect(router.flush()).toEqual([])
  })

  it('releases a withheld close-marker prefix when the stream ends', () => {
    const router = new TextRouter()
    // `</th` is a prefix of `</thinking>`, so it is withheld while the stream
    // might complete it; a stream that ends there still owes those characters.
    expect(router.push('<thinking>partial</th')).toEqual([{ channel: 'reasoning', text: 'partial' }])
    expect(router.flush()).toEqual([{ channel: 'reasoning', text: '</th' }])
  })

  it('suppresses everything after the DSML preamble', () => {
    const router = new TextRouter()
    expect(router.push('I will call it.\n\n<\uFF5CDSML\uFF5Cfunction_calls'))
      .toEqual([{ channel: 'text', text: 'I will call it.\n\n' }])
    expect(router.push('more leakage')).toEqual([])
    expect(router.flush()).toEqual([])
  })

  it('returns nothing for an empty buffer flush', () => {
    expect(new TextRouter().flush()).toEqual([])
  })
})

describe('translate', () => {
  it('assembles a text response and derives a stop finish', async () => {
    const chunks = await run(join(textFrame('Hello'), textFrame(' world')))
    expect(textOf(chunks)).toBe('Hello world')
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.at(-2)).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } })
  })

  it('separates in-band thinking from visible text', async () => {
    const chunks = await run(join(
      textFrame('<thinking>The user asked'),
      textFrame(' twice</thinking>'),
      textFrame('Answer.'),
    ))
    expect(reasoningOf(chunks)).toBe('The user asked twice')
    expect(textOf(chunks)).toBe('Answer.')
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user asked twice' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Answer.' } },
    ])
  })

  it('recognizes a thinking marker split across frames', async () => {
    const chunks = await run(join(textFrame('<think'), textFrame('ing>hidden</thinking>shown')))
    expect(reasoningOf(chunks)).toBe('hidden')
    expect(textOf(chunks)).toBe('shown')
  })

  it('drops the DSML preamble the open-weight routes leak', async () => {
    const chunks = await run(join(
      textFrame("I'll get the weather.\n\n"),
      textFrame('<\uFF5CDSML\uFF5Cfunction_calls'),
      toolFrame({ name: 'get_weather', toolUseId: 'tool-1' }),
      toolFrame({ name: 'get_weather', toolUseId: 'tool-1', input: '{"city": "Beijing"}' }),
      toolFrame({ name: 'get_weather', toolUseId: 'tool-1', stop: true }),
    ))
    expect(textOf(chunks)).toBe("I'll get the weather.\n\n")
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('assembles a streamed tool call and derives a tool-calls finish', async () => {
    const chunks = await run(join(
      textFrame('Checking.'),
      toolFrame({ name: 'get_weather', toolUseId: 'tool-1' }),
      toolFrame({ name: 'get_weather', toolUseId: 'tool-1', input: '{"city": ' }),
      toolFrame({ name: 'get_weather', toolUseId: 'tool-1', input: '"Beijing"}' }),
      toolFrame({ name: 'get_weather', toolUseId: 'tool-1', stop: true }),
    ))
    expect(chunks.filter(chunk => chunk.type === 'block-end').at(-1)).toEqual({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'tool-1', name: 'get_weather', arguments: '{"city": "Beijing"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('keeps parallel tool calls in separate blocks', async () => {
    const chunks = await run(join(
      toolFrame({ name: 'a', toolUseId: 'tool-1', input: '{}' }),
      toolFrame({ name: 'b', toolUseId: 'tool-2', input: '{}' }),
      toolFrame({ name: 'a', toolUseId: 'tool-1', stop: true }),
      toolFrame({ name: 'b', toolUseId: 'tool-2', stop: true }),
    ))
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'tool-1', name: 'a', arguments: '{}' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'tool-2', name: 'b', arguments: '{}' } },
    ])
  })

  it('reports a content-free stream as an empty response', async () => {
    const chunks = await run(join(
      event('contextUsageEvent', '{"contextUsagePercentage":2.5}'),
      event('meteringEvent', '{"unit":"credit","unitPlural":"credits","usage":0.02}'),
    ))
    expect(chunks).toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'Kiro returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    }])
  })

  it('ignores empty text frames', async () => {
    // Kiro opens most responses with an empty content frame; it must not open a block.
    const chunks = await run(join(textFrame(''), textFrame('real')))
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(1)
    expect(textOf(chunks)).toBe('real')
  })

  it('raises an in-band service exception', async () => {
    const exception = frame(
      { ':exception-type': 'throttlingException', ':message-type': 'exception' },
      '{"message":"Too many requests"}',
    )
    const decoded: WireFrame[] = []
    for await (const one of decodeFrames(chunked(exception, 4096))) decoded.push(one)
    await expect(collect(translate(framesOf(...decoded))))
      .rejects.toMatchObject({ code: 'throttlingException' })
  })

  it('raises a malformed event payload', async () => {
    await expect(run(event('assistantResponseEvent', '{not json')))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('ignores an unknown event type instead of surfacing it as content', async () => {
    const chunks = await run(join(event('followupPromptEvent', '{"followupPrompt":{}}'), textFrame('text')))
    expect(textOf(chunks)).toBe('text')
  })
})
