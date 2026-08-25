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

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type {
  WireHistoryEntry,
  WireRequest,
  WireTool,
  WireToolResult,
  WireToolUse,
  WireUserInputMessage,
} from './types.ts'

/** Request origin Kiro attributes IDE traffic to. */
const ORIGIN = 'AI_EDITOR'
/**
 * Neutral user text standing in for an absent turn. Matches the installed Kiro
 * client's own `CONTINUE_MESSAGE_CONTENT`: ordinary conversational filler the
 * model has no reason to imitate as output.
 */
export const CONTINUE_PADDING = 'Continue'
/**
 * Neutral assistant text standing in for a turn with no prose of its own —
 * the installed Kiro client's `UNDERSTOOD_MESSAGE` content.
 */
export const ACKNOWLEDGE_PADDING = 'understood'
/**
 * The distinctive placeholder earlier versions used for structural padding.
 * It looked like an injected system message, so the model imitated it and DSH
 * persisted the imitation as visible assistant output. Sessions recorded before
 * the fix still contain it, so replayed history is scrubbed of exact matches
 * rather than replaying them into the model's context again.
 */
export const LEGACY_CONTINUATION = '[system: conversation continues]'
/** Content for a user turn that carries only tool results. */
const TOOL_RESULTS_ONLY = 'Tool results provided.'
/** Tool names CodeWhisperer accepts verbatim. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** Adapter-level request defaults resolved from plugin config. */
export interface RequestDefaults {
  /** Deployment thinking policy; `disabled` refuses every request-level enable. */
  thinking?: 'enabled' | 'disabled' | undefined
  /** Default thinking effort when a request names none. */
  reasoningEffort?: string | undefined
}

/** Live model-specific effort contract returned by ListAvailableModels. */
export interface NativeEffortConfig {
  schemaPath: 'output_config' | 'reasoning'
  levels: readonly string[]
  defaultLevel?: string
}

/** Live per-model generation bounds from the account's model catalog. */
export interface ModelLimits {
  /**
   * Bounds of the model's advertised `max_tokens` request field. Absent means
   * the model's live schema declares no output cap, and sending one is a
   * validation failure rather than a no-op.
   */
  maxTokensBounds?: { minimum: number; maximum: number }
}

/** Maximum thinking length published for each effort, in tokens. */
const THINKING_BUDGETS = { low: 4_000, medium: 12_000, high: 24_000 } as const

/**
 * Validate the adapter-owned effort.
 * @param effort - the request's opaque effort identifier.
 * @returns the same value, narrowed.
 * @throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` for any other value.
 */
function narrowLegacyEffort(
  effort: string,
): 'off' | 'low' | 'medium' | 'high' {
  if (effort === 'off' || effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort as 'off' | 'low' | 'medium' | 'high'
  }
  throw new LlmError(`Kiro does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

/**
 * Resolve the effort governing one request.
 * @param options - the harness request.
 * @param defaults - adapter-level defaults.
 * @returns the effort, or `off` when thinking is not in play.
 * @throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` when a deployment that
 *   disabled thinking is asked to enable it.
 */
function resolveEffort(
  options: GenerateOptions,
  defaults: RequestDefaults,
  native?: NativeEffortConfig,
): string | undefined {
  // A title's small budget must produce visible text, never spend itself thinking.
  if (options.purpose === 'session-title') return undefined
  const requested = options.reasoningEffort === undefined
    ? defaults.reasoningEffort ?? native?.defaultLevel
    : String(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && requested !== undefined
    && requested !== 'off' && requested !== 'none') {
    throw new LlmError(
      `Kiro deployment does not support reasoning effort "${requested}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (defaults.thinking === 'disabled') return undefined
  if (native !== undefined) {
    if (requested === undefined) return undefined
    if (!native.levels.includes(requested)) {
      throw new LlmError(
        `Kiro model does not advertise reasoning effort "${requested}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return requested
  }
  return requested === undefined ? 'off' : narrowLegacyEffort(requested)
}

/**
 * Build the system text Kiro sees, including thinking markers.
 * @param options - the harness request.
 * @param effort - the resolved effort.
 * @returns the system text, empty when there is nothing to say.
 */
function systemText(
  options: GenerateOptions,
  effort: string | undefined,
  native?: NativeEffortConfig,
): string {
  const persona = options.system ?? ''
  if (effort === undefined || effort === 'off' || effort === 'none' || native !== undefined) return persona
  const legacyEffort = narrowLegacyEffort(effort)
  if (legacyEffort === 'off') return persona
  // Kiro carries thinking as prompt markers rather than a request field; the
  // open-weight and Claude routes both honor this same pair.
  const markers = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${THINKING_BUDGETS[legacyEffort]}</max_thinking_length>`
  return persona.length === 0 ? markers : `${markers}\n${persona}`
}

/** Build Kiro's model-specific native effort object. */
export function buildEffortRequestFields(
  effort: string | undefined,
  native?: NativeEffortConfig,
): Record<string, unknown> | undefined {
  if (effort === undefined || native === undefined) return undefined
  return native.schemaPath === 'output_config'
    ? { output_config: { effort } }
    : { reasoning: { effort } }
}

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
export function buildModelRequestFields(
  effort: string | undefined,
  native?: NativeEffortConfig,
  maxTokens?: number,
  limits?: ModelLimits,
): Record<string, unknown> | undefined {
  // No live schema means the member itself is unsupported for this model.
  if (native === undefined) return undefined
  const fields: Record<string, unknown> = { ...buildEffortRequestFields(effort, native) }
  if (maxTokens !== undefined) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new LlmError(
        `Kiro requires a positive integer maxTokens; received ${String(maxTokens)}`,
        'INVALID_REQUEST',
      )
    }
    const bounds = limits?.maxTokensBounds
    // Clamped into the advertised range rather than dropped: the field has a
    // floor as well as a ceiling, and a value outside either is refused.
    if (bounds !== undefined) {
      fields.max_tokens = Math.min(Math.max(maxTokens, bounds.minimum), bounds.maximum)
    }
  }
  return Object.keys(fields).length === 0 ? undefined : fields
}

/**
 * Join the text blocks of one message, dropping blocks that are nothing but an
 * exact legacy continuation marker.
 *
 * Sessions recorded before the padding fix persisted the marker as whole
 * assistant text blocks; replaying them teaches the model the phrase again and
 * multiplies it through history. Only a block whose entire text is the marker is
 * dropped, so a message discussing the phrase in prose keeps it verbatim.
 */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .filter(block => block.text.trim() !== LEGACY_CONTINUATION)
    .map(block => block.text)
    .join('')
}

/** Reject image content before text flattening can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The Kiro adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/**
 * Validate one tool name against the wire pattern.
 * @param name - the harness tool name.
 * @returns the same name.
 * @throws `LlmError('UNSUPPORTED_TOOL_NAME')` when Kiro would reject it.
 */
function assertToolName(name: string): string {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new LlmError(
      `Kiro rejects tool name "${name}"; names must match ${String(TOOL_NAME_PATTERN)}`,
      'UNSUPPORTED_TOOL_NAME',
    )
  }
  return name
}

/** Serialize the tool-result blocks of one message. */
function toolResultsOf(message: Message): WireToolResult[] {
  return message.content
    .filter(block => block.type === 'tool-result')
    .map(block => ({
      toolUseId: block.toolCallId,
      // Empty tool output still needs content on the wire.
      content: [{ text: flattenText(block.content) || '(no output)' }],
      status: block.isError === true ? 'error' as const : 'success' as const,
    }))
}

/** Serialize the tool-call blocks of one assistant message. */
function toolUsesOf(message: Message): WireToolUse[] {
  return message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      toolUseId: block.id,
      name: assertToolName(block.name),
      // Kiro takes parsed arguments; the harness carries the model's raw JSON
      // string. Unparsable arguments reach the model as text below.
      input: parseArguments(block.arguments),
    }))
}

/**
 * Parse tool-call arguments into the object Kiro expects.
 * @param raw - the model's raw JSON argument string.
 * @returns the parsed value, or an empty object when the model emitted
 *   nothing or invalid JSON — replaying history must not fail a live request
 *   over a malformed past call.
 */
function parseArguments(raw: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** One user turn under construction, before it becomes history or currentMessage. */
interface UserTurn {
  text: string
  toolResults: WireToolResult[]
}

/**
 * Fold the harness conversation into alternating user and assistant turns.
 * Consecutive same-role messages merge, because Kiro accepts only strict
 * alternation.
 * @param messages - the harness conversation, in order.
 * @returns the folded turns, each tagged with its role.
 */
function foldTurns(messages: readonly Message[]): (
  | { role: 'user'; turn: UserTurn }
  | { role: 'assistant'; text: string; toolUses: WireToolUse[] }
)[] {
  const turns: ReturnType<typeof foldTurns> = []
  for (const message of messages) {
    assertTextOnly(message.content)
    const text = flattenText(message.content)
    if (message.role === 'assistant') {
      const toolUses = toolUsesOf(message)
      const last = turns.at(-1)
      if (last?.role === 'assistant') {
        last.text = [last.text, text].filter(part => part.length > 0).join('\n\n')
        last.toolUses = [...last.toolUses, ...toolUses]
        continue
      }
      turns.push({ role: 'assistant', text, toolUses })
      continue
    }
    // Both `user` and `system` roles reach the model as user content: Kiro has
    // no system slot, and a mid-conversation system message is context.
    const toolResults = toolResultsOf(message)
    const last = turns.at(-1)
    if (last?.role === 'user') {
      last.turn.text = [last.turn.text, text].filter(part => part.length > 0).join('\n\n')
      last.turn.toolResults = [...last.turn.toolResults, ...toolResults]
      continue
    }
    turns.push({ role: 'user', turn: { text, toolResults } })
  }
  return turns
}

/**
 * Build one wire user message.
 * @param turn - the folded user turn.
 * @param model - the wire model id, repeated on every user turn.
 * @param context - optional per-turn context (tools, tool results).
 * @returns the wire message.
 */
function userMessage(
  turn: UserTurn,
  model: string,
  context?: WireUserInputMessage['userInputMessageContext'],
): WireUserInputMessage {
  const content = turn.text.length > 0
    ? turn.text
    : turn.toolResults.length > 0 ? TOOL_RESULTS_ONLY : CONTINUE_PADDING
  return {
    content,
    modelId: model,
    origin: ORIGIN,
    ...context === undefined ? {} : { userInputMessageContext: context },
  }
}

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
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults,
  conversationId: string,
  profileArn?: string,
  nativeEffort?: NativeEffortConfig,
  limits?: ModelLimits,
): WireRequest {
  if (options.messages.length === 0) {
    throw new LlmError('Kiro requires at least one message', 'INVALID_REQUEST')
  }
  const effort = resolveEffort(options, defaults, nativeEffort)
  const turns = foldTurns(options.messages)
  if (turns.at(-1)?.role === 'assistant') {
    turns.push({ role: 'user', turn: { text: CONTINUE_PADDING, toolResults: [] } })
  }
  const current = turns.pop()
  /* v8 ignore next -- a non-empty conversation always folds to at least one turn */
  if (current === undefined || current.role !== 'user') {
    throw new LlmError('Kiro request has no user turn to answer', 'INVALID_REQUEST')
  }

  const history: WireHistoryEntry[] = []
  for (const entry of turns) {
    // The service requires alternation; a run of one role means the other's
    // turn was dropped upstream (compaction, a text-less assistant step).
    const expected = history.length % 2 === 0 ? 'user' : 'assistant'
    if (entry.role !== expected) {
      history.push(expected === 'user'
        ? { userInputMessage: userMessage({ text: CONTINUE_PADDING, toolResults: [] }, options.model) }
        : { assistantResponseMessage: { content: ACKNOWLEDGE_PADDING } })
    }
    if (entry.role === 'user') {
      history.push({
        userInputMessage: userMessage(
          entry.turn,
          options.model,
          entry.turn.toolResults.length > 0 ? { toolResults: entry.turn.toolResults } : undefined,
        ),
      })
      continue
    }
    history.push({
      assistantResponseMessage: {
        // A tool-only assistant step has no prose of its own. Its tool calls are
        // the content that matters, so the text slot gets the same neutral
        // acknowledgement the official client uses rather than a marker the
        // model can learn to emit.
        content: entry.text.length > 0 ? entry.text : ACKNOWLEDGE_PADDING,
        ...entry.toolUses.length > 0 ? { toolUses: entry.toolUses } : {},
      },
    })
  }
  // History ends on the assistant, since currentMessage supplies the next user turn.
  if (history.length % 2 !== 0) {
    history.push({ assistantResponseMessage: { content: ACKNOWLEDGE_PADDING } })
  }

  const issued = new Set(history.flatMap(entry =>
    'assistantResponseMessage' in entry
      ? (entry.assistantResponseMessage.toolUses ?? []).map(use => use.toolUseId)
      : []))
  // Kiro rejects a result whose call it never saw. Carrying the output as text
  // keeps the model's observation instead of failing the request.
  const matched = current.turn.toolResults.filter(result => issued.has(result.toolUseId))
  const orphaned = current.turn.toolResults.filter(result => !issued.has(result.toolUseId))
  const text = orphaned.reduce(
    (accumulated, result) =>
      `${accumulated}\n\n[Output for tool call ${result.toolUseId}]:\n${result.content[0]?.text ?? ''}`,
    current.turn.text,
  )

  const tools: WireTool[] = (options.tools ?? []).map(tool => ({
    toolSpecification: {
      name: assertToolName(tool.name),
      description: tool.description,
      inputSchema: { json: tool.parameters },
    },
  }))

  const system = systemText(options, effort, nativeEffort)
  const currentMessage = userMessage(
    { text, toolResults: matched },
    options.model,
    tools.length > 0 || matched.length > 0
      ? {
        ...tools.length > 0 ? { tools } : {},
        ...matched.length > 0 ? { toolResults: matched } : {},
      }
      : undefined,
  )
  if (system.length > 0) {
    // Kiro has no system slot: the prompt rides on the earliest user turn so
    // it stays at the front of the model's context and inside the cached prefix.
    const first = history.find((entry): entry is { userInputMessage: WireUserInputMessage } =>
      'userInputMessage' in entry)
    if (first === undefined) {
      currentMessage.content = `${system}\n\n${currentMessage.content}`
    } else {
      first.userInputMessage.content = `${system}\n\n${first.userInputMessage.content}`
    }
  }

  const additionalModelRequestFields = buildModelRequestFields(
    effort,
    nativeEffort,
    options.maxTokens,
    limits,
  )
  return {
    ...profileArn === undefined ? {} : { profileArn },
    ...additionalModelRequestFields === undefined ? {} : { additionalModelRequestFields },
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: { userInputMessage: currentMessage },
      ...history.length > 0 ? { history } : {},
    },
  }
}
