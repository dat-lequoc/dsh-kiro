/**
 * Serialize harness messages into a Kiro `generateAssistantResponse` request.
 *
 * Three properties of the wire operation drive the whole translation:
 *
 * - There is no system slot. The system prompt is prepended to the content of
 *   the first user turn, which is also where the thinking-mode markers go.
 * - The last user turn is `currentMessage`, not a history entry, and
 *   `conversationState.history` must strictly alternate user, assistant, user,
 *   …, so gaps are filled with continuation placeholders.
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
/** Text standing in for an absent turn, so history keeps alternating. */
const CONTINUATION = '[system: conversation continues]'
/** Content for a user turn that carries only tool results. */
const TOOL_RESULTS_ONLY = 'Tool results provided.'
/** Tool names CodeWhisperer accepts verbatim. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** Adapter-level request defaults resolved from plugin config. */
export interface RequestDefaults {
  /** Deployment thinking policy; `disabled` refuses every request-level enable. */
  thinking?: 'enabled' | 'disabled' | undefined
  /** Default thinking effort when a request names none. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | undefined
}

/** Maximum thinking length published for each effort, in tokens. */
const THINKING_BUDGETS = { low: 4_000, medium: 12_000, high: 24_000 } as const

/**
 * Validate the adapter-owned effort.
 * @param effort - the request's opaque effort identifier.
 * @returns the same value, narrowed.
 * @throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` for any other value.
 */
function narrowEffort(
  effort: NonNullable<GenerateOptions['reasoningEffort']>,
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
): 'off' | 'low' | 'medium' | 'high' {
  // A title's small budget must produce visible text, never spend itself thinking.
  if (options.purpose === 'session-title') return 'off'
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : narrowEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `Kiro deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  return effort ?? 'off'
}

/**
 * Build the system text Kiro sees, including thinking markers.
 * @param options - the harness request.
 * @param effort - the resolved effort.
 * @returns the system text, empty when there is nothing to say.
 */
function systemText(options: GenerateOptions, effort: 'off' | 'low' | 'medium' | 'high'): string {
  const persona = options.system ?? ''
  if (effort === 'off') return persona
  // Kiro carries thinking as prompt markers rather than a request field; the
  // open-weight and Claude routes both honor this same pair.
  const markers = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${THINKING_BUDGETS[effort]}</max_thinking_length>`
  return persona.length === 0 ? markers : `${markers}\n${persona}`
}

/** Join the text blocks of one message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
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
    : turn.toolResults.length > 0 ? TOOL_RESULTS_ONLY : CONTINUATION
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
 * continuation user turn so there is something to answer.
 * @param options - the harness request.
 * @param defaults - adapter-level thinking defaults.
 * @param conversationId - identifier for this request's conversation.
 * @param profileArn - CodeWhisperer profile the account bills against.
 * @returns the request body.
 * @throws `LlmError` when the request carries images, an unusable tool name,
 *   an unsupported effort, or no messages at all.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults,
  conversationId: string,
  profileArn?: string,
): WireRequest {
  if (options.messages.length === 0) {
    throw new LlmError('Kiro requires at least one message', 'INVALID_REQUEST')
  }
  const effort = resolveEffort(options, defaults)
  const turns = foldTurns(options.messages)
  if (turns.at(-1)?.role === 'assistant') {
    turns.push({ role: 'user', turn: { text: CONTINUATION, toolResults: [] } })
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
        ? { userInputMessage: userMessage({ text: CONTINUATION, toolResults: [] }, options.model) }
        : { assistantResponseMessage: { content: CONTINUATION } })
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
        content: entry.text.length > 0 ? entry.text : CONTINUATION,
        ...entry.toolUses.length > 0 ? { toolUses: entry.toolUses } : {},
      },
    })
  }
  // History ends on the assistant, since currentMessage supplies the next user turn.
  if (history.length % 2 !== 0) {
    history.push({ assistantResponseMessage: { content: CONTINUATION } })
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

  const system = systemText(options, effort)
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

  return {
    ...profileArn === undefined ? {} : { profileArn },
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: { userInputMessage: currentMessage },
      ...history.length > 0 ? { history } : {},
    },
  }
}
