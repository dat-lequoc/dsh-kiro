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
 *   …, so gaps are filled with continuation placeholders.
 * - Tool results are per-turn context on the user message that carries them,
 *   and the service rejects a result whose `toolUseId` no history entry
 *   issued, so unmatched results degrade to text.
 *
 * @module dsh-kiro/serialize
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { WireRequest } from './types.ts';
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
/** Build Kiro's model-specific native effort object. */
export declare function buildEffortRequestFields(effort: string | undefined, native?: NativeEffortConfig): Record<string, unknown> | undefined;
/**
 * Build the complete wire request.
 *
 * The final user turn becomes `currentMessage` and carries the tool schemas;
 * everything before it becomes alternating history. A conversation whose last
 * turn is the assistant's (a resumed session, a compaction boundary) gets a
 * continuation user turn so there is something to answer.
 * @param options - the harness request.
 * @param defaults - adapter-level thinking defaults.
 * @param conversationId - identifier for this request's conversation.
 * @param profileArn - CodeWhisperer profile the account bills against.
 * @param nativeEffort - live effort levels and their provider request path.
 * @returns the request body.
 * @throws `LlmError` when the request carries images, an unusable tool name,
 *   an unsupported effort, or no messages at all.
 */
export declare function serializeRequest(options: GenerateOptions, defaults: RequestDefaults, conversationId: string, profileArn?: string, nativeEffort?: NativeEffortConfig): WireRequest;
