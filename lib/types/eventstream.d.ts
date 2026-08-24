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
import type { WireFrame } from './types.ts';
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
export declare function decodeFrames(stream: AsyncIterable<Uint8Array>, onActivity?: () => void): AsyncGenerator<WireFrame>;
