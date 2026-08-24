import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from '../src/serialize.ts'
import type { WireUserInputMessage } from '../src/types.ts'

const SOURCE = { kind: 'plugin' as const, plugin: 'test' }

/** One user message carrying plain text. */
function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: SOURCE })
}

/** One assistant message carrying text and optional tool calls. */
function assistant(text: string, calls: { id: string; name: string; args: string }[] = []): Message {
  return createAssistantMessage({
    content: [
      ...text.length > 0 ? [{ type: 'text' as const, text }] : [],
      ...calls.map(call => ({
        type: 'tool-call' as const,
        id: CallId(call.id),
        name: call.name,
        arguments: call.args,
      })),
    ],
    source: { provider: 'kiro', model: 'claude-sonnet-4.5' },
  })
}

/** One tool-result message for the named call. */
function toolResult(id: string, text: string, isError = false): Message {
  return createToolResultMessage({
    callId: CallId(id),
    content: [{ type: 'text', text }],
    isError,
  })
}

/** Serialize with the fields every case shares. */
function serialize(messages: Message[], extra: Partial<GenerateOptions> = {}, defaults = {}) {
  return serializeRequest(
    { provider: 'kiro', model: 'claude-sonnet-4.5', messages, ...extra },
    defaults,
    'conv-1',
    'arn:aws:codewhisperer:us-east-1:1:profile/X',
  )
}

/** The history entries, narrowed for assertions. */
function history(request: ReturnType<typeof serialize>) {
  return request.conversationState.history ?? []
}

/** The current user message. */
function currentOf(request: ReturnType<typeof serialize>): WireUserInputMessage {
  return request.conversationState.currentMessage.userInputMessage
}

describe('serializeRequest', () => {
  it('sends a lone user turn as currentMessage with no history', () => {
    const request = serialize([user('hello')])
    expect(currentOf(request).content).toBe('hello')
    expect(currentOf(request).modelId).toBe('claude-sonnet-4.5')
    expect(currentOf(request).origin).toBe('AI_EDITOR')
    expect(request.conversationState.history).toBeUndefined()
    expect(request.profileArn).toBe('arn:aws:codewhisperer:us-east-1:1:profile/X')
  })

  it('omits profileArn when the account default applies', () => {
    const request = serializeRequest(
      { provider: 'kiro', model: 'auto', messages: [user('hi')] },
      {},
      'conv-1',
    )
    expect('profileArn' in request).toBe(false)
  })

  it('prepends the system prompt to the earliest user turn', () => {
    const request = serialize([user('first'), assistant('answer'), user('second')], { system: 'PERSONA' })
    const first = history(request)[0]
    expect(first).toMatchObject({ userInputMessage: { content: 'PERSONA\n\nfirst' } })
    // The later turn stays clean: the prompt belongs at one place in the prefix.
    expect(currentOf(request).content).toBe('second')
  })

  it('prepends the system prompt to currentMessage when there is no history', () => {
    const request = serialize([user('only')], { system: 'PERSONA' })
    expect(currentOf(request).content).toBe('PERSONA\n\nonly')
  })

  it('carries thinking markers with the resolved effort budget', () => {
    const request = serialize([user('hi')], { system: 'PERSONA' }, { reasoningEffort: 'high' })
    expect(currentOf(request).content).toBe(
      '<thinking_mode>enabled</thinking_mode><max_thinking_length>24000</max_thinking_length>\nPERSONA\n\nhi',
    )
  })

  it('omits thinking markers at effort off', () => {
    const request = serialize([user('hi')], {}, { reasoningEffort: 'off' })
    expect(currentOf(request).content).toBe('hi')
  })

  it.each([['low', 4000], ['medium', 12000], ['high', 24000]] as const)(
    'publishes the %s effort budget as %i tokens',
    (effort, budget) => {
      const request = serialize([user('hi')], {}, { reasoningEffort: effort })
      expect(currentOf(request).content).toContain(`<max_thinking_length>${budget}</max_thinking_length>`)
    },
  )

  it('forces a session title to spend its budget on visible text', () => {
    const request = serialize([user('hi')], { purpose: 'session-title' }, { reasoningEffort: 'high' })
    expect(currentOf(request).content).toBe('hi')
  })

  it('refuses an effort the adapter does not publish', () => {
    expect(() => serialize([user('hi')], { reasoningEffort: 'ultra' as never }))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('refuses to enable thinking against a deployment that disabled it', () => {
    expect(() => serialize([user('hi')], { reasoningEffort: 'high' as never }, { thinking: 'disabled' }))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('sends tool schemas on the current turn', () => {
    const request = serialize([user('weather?')], {
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } }],
    })
    expect(currentOf(request).userInputMessageContext?.tools).toEqual([{
      toolSpecification: {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { json: { type: 'object', properties: {} } },
      },
    }])
  })

  it('refuses a tool name the service rejects', () => {
    expect(() => serialize([user('hi')], {
      tools: [{ name: 'get-weather', description: 'd', parameters: {} }],
    })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_TOOL_NAME' }))
  })

  it('pairs a tool result with the call its history issued', () => {
    const request = serialize([
      user('weather?'),
      assistant('checking', [{ id: 'call-1', name: 'get_weather', args: '{"city":"Beijing"}' }]),
      toolResult('call-1', 'sunny'),
    ])
    expect(history(request).at(-1)).toMatchObject({
      assistantResponseMessage: {
        toolUses: [{ toolUseId: 'call-1', name: 'get_weather', input: { city: 'Beijing' } }],
      },
    })
    expect(currentOf(request).userInputMessageContext?.toolResults).toEqual([
      { toolUseId: 'call-1', content: [{ text: 'sunny' }], status: 'success' },
    ])
    expect(currentOf(request).content).toBe('Tool results provided.')
  })

  it('marks a failed tool result as an error', () => {
    const request = serialize([
      user('weather?'),
      assistant('checking', [{ id: 'call-1', name: 'get_weather', args: '{}' }]),
      toolResult('call-1', 'boom', true),
    ])
    expect(currentOf(request).userInputMessageContext?.toolResults?.[0]?.status).toBe('error')
  })

  it('degrades a tool result with no issuing call to text', () => {
    // Compaction can drop the assistant turn that issued a call while keeping
    // its result. Kiro rejects the orphan, so the output reaches the model as text.
    const request = serialize([user('do it'), toolResult('call-gone', 'output text')])
    expect(currentOf(request).userInputMessageContext?.toolResults).toBeUndefined()
    expect(currentOf(request).content).toContain('[Output for tool call call-gone]:\noutput text')
  })

  it('replaces unparsable tool arguments with an empty object', () => {
    const request = serialize([
      user('go'),
      assistant('calling', [{ id: 'call-1', name: 'run', args: '{"truncated' }]),
      toolResult('call-1', 'ok'),
    ])
    expect(history(request).at(-1)).toMatchObject({
      assistantResponseMessage: { toolUses: [{ input: {} }] },
    })
  })

  it('sends empty tool output as a placeholder the wire accepts', () => {
    const request = serialize([
      user('go'),
      assistant('calling', [{ id: 'call-1', name: 'run', args: '{}' }]),
      toolResult('call-1', ''),
    ])
    expect(currentOf(request).userInputMessageContext?.toolResults?.[0]?.content)
      .toEqual([{ text: '(no output)' }])
  })

  it('merges consecutive same-role turns to keep history alternating', () => {
    const request = serialize([
      user('one'),
      user('two'),
      assistant('a'),
      assistant('b'),
      user('three'),
    ])
    expect(history(request)).toEqual([
      { userInputMessage: { content: 'one\n\ntwo', modelId: 'claude-sonnet-4.5', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'a\n\nb' } },
    ])
    expect(currentOf(request).content).toBe('three')
  })

  it('appends a continuation turn when the conversation ends on the assistant', () => {
    // A resumed session replays history whose last entry is the assistant's;
    // Kiro still needs a user turn to answer.
    const request = serialize([user('hi'), assistant('done')])
    expect(currentOf(request).content).toBe('[system: conversation continues]')
    expect(history(request)).toEqual([
      { userInputMessage: { content: 'hi', modelId: 'claude-sonnet-4.5', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'done' } },
    ])
  })

  it('keeps history ending on the assistant', () => {
    const request = serialize([user('one'), assistant('a'), user('two'), user('three')])
    expect(history(request)).toHaveLength(2)
    expect(history(request).at(-1)).toHaveProperty('assistantResponseMessage')
    expect(currentOf(request).content).toBe('two\n\nthree')
  })

  it('treats a mid-conversation system message as user content', () => {
    const system = createMessage({ role: 'system', content: [{ type: 'text', text: 'RULE' }], source: SOURCE })
    const request = serialize([system, user('hi')])
    expect(currentOf(request).content).toBe('RULE\n\nhi')
  })

  it('gives a text-less assistant turn a continuation placeholder', () => {
    const request = serialize([
      user('go'),
      assistant('', [{ id: 'call-1', name: 'run', args: '{}' }]),
      toolResult('call-1', 'ok'),
    ])
    expect(history(request).at(-1)).toMatchObject({
      assistantResponseMessage: { content: '[system: conversation continues]' },
    })
  })

  it('refuses image content instead of silently dropping it', () => {
    const message = createUserMessage({
      content: [{
        type: 'image',
        attachment: { id: 'a', mediaType: 'image/png', byteLength: 1, width: 1, height: 1 },
      }],
      source: SOURCE,
    } as never)
    expect(() => serialize([message]))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('refuses a request with no messages', () => {
    expect(() => serialize([])).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
})
