/**
 * Serialize harness messages into a Kiro `generateAssistantResponse` request.
 *
 * Three properties of the wire operation drive the whole translation:
 *
 * - There is no system slot. The system prompt is prepended to the content of
 *   the first user turn. Models without a live effort schema retain the legacy
 *   thinking markers; discovered models receive their native request field.
 * - The last user turn is `currentMessage`, not a history entry, and
 *   `conversationState.history` must strictly alternate user, assistant, user,
 *   …, so gaps are filled with the same neutral padding the official client
 *   uses. Padding text must be ordinary: a distinctive system-looking marker is
 *   imitated by the model and then persisted as visible output.
 * - Tool results are per-turn context on the user message that carries them,
 *   and the service rejects a result whose `toolUseId` no history entry
 *   issued, so unmatched results degrade to text.
 *
 * @module dsh-kiro/serialize
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { WireRequest } from './types.ts';
/**
 * Neutral user text standing in for an absent turn. Matches the installed Kiro
 * client's own `CONTINUE_MESSAGE_CONTENT`: ordinary conversational filler the
 * model has no reason to imitate as output.
 */
export declare const CONTINUE_PADDING = "Continue";
/**
 * Neutral assistant text standing in for a turn with no prose of its own —
 * the installed Kiro client's `UNDERSTOOD_MESSAGE` content.
 */
export declare const ACKNOWLEDGE_PADDING = "understood";
/**
 * The distinctive placeholder earlier versions used for structural padding.
 * It looked like an injected system message, so the model imitated it and DSH
 * persisted the imitation as visible assistant output. Sessions recorded before
 * the fix still contain it, so replayed history is scrubbed of exact matches
 * rather than replaying them into the model's context again.
 */
export declare const LEGACY_CONTINUATION = "[system: conversation continues]";
/** Adapter-level request defaults resolved from plugin config. */
export interface RequestDefaults {
    /** Deployment thinking policy; `disabled` refuses every request-level enable. */
    thinking?: 'enabled' | 'disabled' | undefined;
    /** Default thinking effort when a request names none. */
    reasoningEffort?: string | undefined;
}
/** Live model-specific effort contract returned by ListAvailableModels. */
export interface NativeEffortConfig {
    schemaPath: 'output_config' | 'reasoning';
    levels: readonly string[];
    defaultLevel?: string;
}
/** Live per-model generation bounds from the account's model catalog. */
export interface ModelLimits {
    /**
     * Bounds of the model's advertised `max_tokens` request field. Absent means
     * the model's live schema declares no output cap, and sending one is a
     * validation failure rather than a no-op.
     */
    maxTokensBounds?: {
        minimum: number;
        maximum: number;
    };
}
/** Build Kiro's model-specific native effort object. */
export declare function buildEffortRequestFields(effort: string | undefined, native?: NativeEffortConfig): Record<string, unknown> | undefined;
/**
 * Build `additionalModelRequestFields` for one request.
 *
 * This is the only place `generateAssistantResponse` accepts generation
 * controls: its request shape declares `conversationState`, `profileArn`,
 * `agentMode`, `additionalModelRequestFields`, and `systemPrompt` and nothing
 * else, so a top-level `inferenceConfig` is silently dropped by the service.
 * The object is validated against each model's advertised schema, which is
 * `additionalProperties: false`, and a model that advertises no schema rejects
 * the member outright — so nothing may be sent speculatively:
 *
 * - unadvertised property → HTTP 400 `property 'x' is not defined in the schema`
 * - model with no schema → HTTP 400 `additionalModelRequestFields is not supported for this model`
 *
 * @param effort - the resolved reasoning effort, when the model takes one.
 * @param native - the model's live effort contract, absent when it has no schema.
 * @param maxTokens - the caller's requested output cap, if any.
 * @param limits - the model's advertised field bounds.
 * @returns the object to send, or `undefined` when there is nothing valid to send.
 * @throws `LlmError('INVALID_REQUEST')` for an unusable caller value.
 */
export declare function buildModelRequestFields(effort: string | undefined, native?: NativeEffortConfig, maxTokens?: number, limits?: ModelLimits): Record<string, unknown> | undefined;
/**
 * Build the complete wire request.
 *
 * The final user turn becomes `currentMessage` and carries the tool schemas;
 * everything before it becomes alternating history. A conversation whose last
 * turn is the assistant's (a resumed session, a compaction boundary) gets a
 * neutral continuation user turn so there is something to answer.
 * @param options - the harness request.
 * @param defaults - adapter-level thinking defaults.
 * @param conversationId - identifier for this request's conversation.
 * @param profileArn - CodeWhisperer profile the account bills against.
 * @param nativeEffort - live effort levels and their provider request path.
 * @param limits - live per-model generation bounds, when discovery supplied them.
 * @returns the request body.
 * @throws `LlmError` when the request carries images, an unusable tool name,
 *   an unsupported effort, an unusable generation option, or no messages at all.
 */
export declare function serializeRequest(options: GenerateOptions, defaults: RequestDefaults, conversationId: string, profileArn?: string, nativeEffort?: NativeEffortConfig, limits?: ModelLimits): WireRequest;
