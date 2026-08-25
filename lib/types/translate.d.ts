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
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { WireFrame, WireStopDetails } from './types.ts';
/**
 * Withhold a visible response that may turn out to be nothing but the legacy
 * continuation marker.
 *
 * Only an exact standalone marker is suppressed. Text is held back only while
 * everything seen so far is still a prefix of the marker, so ordinary prose —
 * including prose that discusses the phrase — is released as soon as it
 * diverges and is never altered.
 */
export declare class LegacyMarkerGuard {
    private pending;
    private settled;
    /**
     * Filter one visible run.
     * @param text - the run exactly as the router produced it.
     * @returns the text that can be emitted now, empty while undecided.
     */
    push(text: string): string;
    /**
     * Resolve the withheld text when the stream ends.
     * @returns the withheld text, or nothing when it was exactly the marker.
     */
    flush(): string;
}
/** One routed run of text. */
interface Routed {
    channel: 'text' | 'reasoning';
    text: string;
}
/**
 * Routes Kiro's single text channel into harness text and reasoning runs.
 *
 * Marker recognition is stateful across frames, which is the point: a delta
 * boundary inside `</thinking>` must not surface the tag as visible output.
 */
export declare class TextRouter {
    private channel;
    private buffer;
    /** Markers that end the current channel's run. */
    private get watched();
    /**
     * Route one text delta.
     * @param delta - text exactly as the frame carried it.
     * @returns the runs that can be emitted now, in order; a delta ending
     *   mid-marker contributes nothing until the marker resolves.
     */
    push(delta: string): Routed[];
    /**
     * Release text withheld as a possible partial marker.
     * @returns the final run, or nothing when the buffer is empty or suppressed.
     */
    flush(): Routed[];
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
export declare function finishReasonOf(reason: string | undefined, details: WireStopDetails | undefined, sawToolCalls: boolean): FinishReason | undefined;
/**
 * Translate decoded frames into harness chunks.
 * @param frames - decoded event-stream frames in arrival order.
 * @returns deltas as they arrive, every `block-end`, exact terminal `usage`
 *   when supplied by Kiro, then one `finish`.
 * @throws `LlmError` for an in-band service exception frame or a malformed payload.
 */
export declare function translate(frames: AsyncIterable<WireFrame>): AsyncGenerator<StreamChunk>;
export {};
