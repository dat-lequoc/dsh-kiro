import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { decodeFrames } from '../src/eventstream.ts'
import { chunked, frame, join, textFrame } from './frames.ts'

/** Collect a decoder's frames as event-type/payload pairs. */
async function decode(stream: AsyncIterable<Uint8Array>): Promise<{ type: string; text: string }[]> {
  const decoded: { type: string; text: string }[] = []
  for await (const one of decodeFrames(stream)) {
    decoded.push({
      type: one.headers[':event-type'] ?? '',
      text: new TextDecoder().decode(one.payload),
    })
  }
  return decoded
}

describe('decodeFrames', () => {
  it('decodes whole frames from a single read', async () => {
    const decoded = await decode(chunked(join(textFrame('one'), textFrame('two')), 4096))
    expect(decoded.map(one => JSON.parse(one.text).content)).toEqual(['one', 'two'])
    expect(decoded.every(one => one.type === 'assistantResponseEvent')).toBe(true)
  })

  it.each([1, 3, 13, 64])('reassembles frames split every %i bytes', async (chunkSize) => {
    // Byte-at-a-time reads split the prelude, headers, and payload of every
    // frame; the decoder must still yield exactly the two whole frames.
    const decoded = await decode(chunked(join(textFrame('hello'), textFrame(' world')), chunkSize))
    expect(decoded.map(one => JSON.parse(one.text).content)).toEqual(['hello', ' world'])
  })

  it('reports a stream that ends mid-frame as truncation', async () => {
    const whole = textFrame('partial')
    const cut = whole.subarray(0, whole.length - 3)
    await expect(decode(chunked(cut, 4096))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('refuses a frame whose declared length is implausible', async () => {
    const bogus = new Uint8Array(16)
    new DataView(bogus.buffer).setUint32(0, 0x7fff_ffff)
    await expect(decode(chunked(bogus, 16))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('refuses a frame whose declared length cannot hold its own headers', async () => {
    const bogus = new Uint8Array(16)
    const view = new DataView(bogus.buffer)
    view.setUint32(0, 16)
    view.setUint32(4, 999)
    await expect(decode(chunked(bogus, 16))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('refuses a non-string header value type', async () => {
    // Header type 0 (boolean true) is legal event-stream but never sent by
    // Kiro; accepting it would mean guessing at a value length.
    const legal = frame({ ':event-type': 'x' }, '{}')
    const tampered = Uint8Array.from(legal)
    // The type tag sits after the 12-byte prelude, the 1-byte name length, and the name.
    tampered[12 + 1 + ':event-type'.length] = 0
    await expect(decode(chunked(tampered, 4096))).rejects.toBeInstanceOf(LlmError)
  })

  it('reports transport activity for each read', async () => {
    let reads = 0
    const frames = decodeFrames(chunked(join(textFrame('a'), textFrame('b')), 8), () => { reads += 1 })
    for await (const _one of frames) { /* drain */ }
    expect(reads).toBeGreaterThan(1)
  })

  it('accepts an empty stream as an empty frame sequence', async () => {
    expect(await decode(chunked(new Uint8Array(0), 16))).toEqual([])
  })
})
