/**
 * Incremental `vnd.amazon.eventstream` frame decoding. A frame is a 12-byte
 * prelude (total length, header length, prelude CRC), the headers, the
 * payload, and a trailing message CRC. Reads may split anywhere, so the
 * decoder buffers until a frame is complete and yields whole frames only.
 *
 * CRCs are not verified: TLS already protects the transport, and a corrupt
 * frame fails the JSON parse the caller performs on the payload.
 *
 * @module dsh-kiro/eventstream
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { WireFrame } from './types.ts'

/** Bytes before the headers: total length, header length, prelude CRC. */
const PRELUDE_BYTES = 12
/** Bytes after the payload holding the message CRC. */
const MESSAGE_CRC_BYTES = 4
/** Header value type tag for a UTF-8 string, the only type Kiro sends. */
const HEADER_TYPE_STRING = 7
/**
 * Largest frame this decoder will buffer. AWS caps event-stream messages at
 * 16 MiB, so a larger declared length is a desynchronized stream rather than
 * a big message, and refusing it bounds memory instead of buffering forever.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * Decode one frame's headers.
 * @param buffer - the whole buffered stream.
 * @param start - offset of the first header byte.
 * @param end - offset one past the last header byte.
 * @returns the header name/value pairs.
 * @throws `LlmError('MALFORMED_RESPONSE')` on a non-string header value type.
 */
function decodeHeaders(buffer: Uint8Array, start: number, end: number): Record<string, string> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const decoder = new TextDecoder()
  const headers: Record<string, string> = {}
  let offset = start
  while (offset < end) {
    const nameLength = view.getUint8(offset)
    offset += 1
    const name = decoder.decode(buffer.subarray(offset, offset + nameLength))
    offset += nameLength
    const type = view.getUint8(offset)
    offset += 1
    if (type !== HEADER_TYPE_STRING) {
      throw new LlmError(
        `Kiro event-stream header "${name}" has unsupported value type ${type}`,
        'MALFORMED_RESPONSE',
      )
    }
    const valueLength = view.getUint16(offset)
    offset += 2
    headers[name] = decoder.decode(buffer.subarray(offset, offset + valueLength))
    offset += valueLength
  }
  return headers
}

/**
 * Decode a byte stream into whole event-stream frames.
 *
 * A stream that ends mid-frame is truncation, not a flushable tail: the
 * response cannot be trusted, so it raises rather than yielding a partial
 * frame.
 * @param stream - raw response bytes; reads may split anywhere, including
 *   inside a prelude, header, or payload. Any async iterable of byte chunks
 *   works, so the same decoder serves a `fetch` body and a Node response.
 * @param onActivity - optional transport-activity callback invoked for each
 *   read, so an idle watchdog can distinguish a slow model from a dead socket.
 * @returns each complete frame in arrival order.
 * @throws `LlmError('STREAM_CLOSED')` when the stream ends mid-frame, or
 *   `LlmError('MALFORMED_RESPONSE')` on an implausible declared frame length.
 */
export async function* decodeFrames(
  stream: AsyncIterable<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<WireFrame> {
  let buffered = new Uint8Array(0)
  for await (const chunk of stream) {
    onActivity?.()
    const next = new Uint8Array(buffered.length + chunk.length)
    next.set(buffered)
    next.set(chunk, buffered.length)
    buffered = next

    while (buffered.length >= PRELUDE_BYTES) {
      const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength)
      const totalLength = view.getUint32(0)
      const headerLength = view.getUint32(4)
      if (totalLength > MAX_FRAME_BYTES
        || totalLength < PRELUDE_BYTES + headerLength + MESSAGE_CRC_BYTES) {
        throw new LlmError(
          `Kiro event-stream frame declares an implausible length of ${totalLength} bytes`,
          'MALFORMED_RESPONSE',
        )
      }
      if (buffered.length < totalLength) break
      const headerEnd = PRELUDE_BYTES + headerLength
      yield {
        headers: decodeHeaders(buffered, PRELUDE_BYTES, headerEnd),
        payload: buffered.subarray(headerEnd, totalLength - MESSAGE_CRC_BYTES),
      }
      buffered = buffered.subarray(totalLength)
    }
  }
  if (buffered.length > 0) {
    throw new LlmError(
      `Kiro event stream ended with ${buffered.length} bytes of an incomplete frame`,
      'STREAM_CLOSED',
    )
  }
}
