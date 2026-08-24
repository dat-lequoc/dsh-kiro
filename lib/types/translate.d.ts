/**
 * Translate Kiro event-stream frames into the harness `StreamChunk` protocol.
 *
 * Kiro reports thinking inside the same text channel as visible output,
 * delimited by `<thinking>` markers, and open-weight routes additionally leak
 * a `<｜DSML｜` tool-call preamble into that channel. Both are filtered by a
 * scanner that holds back only a tail short enough to be a partial marker, so
 * markers split across frames are still recognized without delaying output.
 *
 * The stream carries no finish event and no token counts: the frame sequence
 * simply ends. The terminal reason is therefore derived — `tool-calls` when
 * the model opened any tool call, `stop` otherwise, and `EMPTY_RESPONSE` for a
 * stream that produced no content at all.
 *
 * @module dsh-kiro/translate
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { WireFrame } from './types.ts';
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
 * Translate decoded frames into harness chunks.
 * @param frames - decoded event-stream frames in arrival order.
 * @returns deltas as they arrive, then every `block-end`, then one terminal
 *   `finish`. No `usage` chunk is emitted: the operation reports consumed
 *   account credits rather than token counts.
 * @throws `LlmError` for an in-band service exception frame or a malformed payload.
 */
export declare function translate(frames: AsyncIterable<WireFrame>): AsyncGenerator<StreamChunk>;
export {};
