/**
 * Build `vnd.amazon.eventstream` frames, so tests can script a Kiro response
 * the same way the service frames one.
 */

/** Header value type tag for a UTF-8 string. */
const HEADER_TYPE_STRING = 7

/**
 * Encode one frame.
 * @param headers - frame headers, all string-valued.
 * @param payload - the payload text.
 * @returns the complete frame bytes, CRC fields zeroed (the decoder ignores them).
 */
export function frame(headers: Record<string, string>, payload: string): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name)
    const valueBytes = encoder.encode(value)
    const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
    const view = new DataView(header.buffer)
    view.setUint8(0, nameBytes.length)
    header.set(nameBytes, 1)
    view.setUint8(1 + nameBytes.length, HEADER_TYPE_STRING)
    view.setUint16(1 + nameBytes.length + 1, valueBytes.length)
    header.set(valueBytes, 1 + nameBytes.length + 3)
    parts.push(header)
  }
  const headerBytes = parts.reduce((total, part) => total + part.length, 0)
  const payloadBytes = encoder.encode(payload)
  const total = 12 + headerBytes + payloadBytes.length + 4
  const buffer = new Uint8Array(total)
  const view = new DataView(buffer.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerBytes)
  let offset = 12
  for (const part of parts) {
    buffer.set(part, offset)
    offset += part.length
  }
  buffer.set(payloadBytes, offset)
  return buffer
}

/** Frame one `assistantResponseEvent` carrying model text. */
export function textFrame(content: string): Uint8Array {
  return frame(
    { ':event-type': 'assistantResponseEvent', ':content-type': 'application/json', ':message-type': 'event' },
    JSON.stringify({ content, modelId: 'claude-sonnet-4.5' }),
  )
}

/** Frame one `toolUseEvent` step. */
export function toolFrame(event: Record<string, unknown>): Uint8Array {
  return frame(
    { ':event-type': 'toolUseEvent', ':content-type': 'application/json', ':message-type': 'event' },
    JSON.stringify(event),
  )
}

/**
 * Concatenate frames into one buffer, so a test can split them at arbitrary
 * offsets to prove incremental decoding.
 * @param frames - the frames to join.
 * @returns the joined bytes.
 */
export function join(...frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, one) => sum + one.length, 0)
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const one of frames) {
    buffer.set(one, offset)
    offset += one.length
  }
  return buffer
}

/**
 * Yield a buffer as an async byte stream split into fixed-size reads.
 * @param buffer - the bytes to stream.
 * @param chunkSize - bytes per read; small values split frames mid-header.
 * @returns the chunk stream.
 */
export async function* chunked(buffer: Uint8Array, chunkSize: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length))
  }
}
