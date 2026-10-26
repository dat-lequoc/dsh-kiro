/**
 * Kiro's CodeWhisperer surface accepts only `^[A-Za-z][A-Za-z0-9_]{0,63}$` tool
 * names, while harness tool names are unconstrained — MCP servers commonly
 * publish kebab-case names such as `mcp__context7__query-docs`. Refusing the
 * whole request over one such name failed every Kiro turn for a profile that
 * mounts one of those servers, so the serializer translates the name onto a
 * wire-safe one and the translator maps the answer back.
 */

import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeRequest, wireToolName } from '../src/serialize.ts'

/** The pattern the service enforces, quoted in its own error message. */
const WIRE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const SOURCE = { kind: 'plugin' as const, plugin: 'test' }

function tool(name: string): NonNullable<GenerateOptions['tools']>[number] {
  return { name, description: name, parameters: { type: 'object', properties: {} } }
}

/** Serialize one user turn carrying the given tool schemas. */
function serialize(names: string[]) {
  return serializeRequest(
    {
      provider: 'kiro',
      model: 'claude-sonnet-4.5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: SOURCE })],
      tools: names.map(tool),
    },
    {},
    'conv-1',
  )
}

/** Wire tool names in the current turn's tool schemas. */
function wireNames(names: string[]): string[] {
  const tools = serialize(names).conversationState.currentMessage.userInputMessage
    .userInputMessageContext?.tools ?? []
  return tools.map(entry => entry.toolSpecification.name)
}

describe('tool names the service rejects', () => {
  it('translates an MCP name carrying hyphens instead of refusing the request', () => {
    const [wire] = wireNames(['mcp__context7__query-docs'])
    expect(wire).toMatch(WIRE_TOOL_NAME)
    expect(wire).not.toBe('mcp__context7__query-docs')
  })

  it('leaves a name the service already accepts untouched', () => {
    expect(wireNames(['get_weather'])).toEqual(['get_weather'])
  })

  it('maps two distinct harness names onto two distinct wire names', () => {
    const [dashed, underscored] = wireNames(['a-b', 'a_b'])
    expect(underscored).toBe('a_b')
    expect(dashed).toMatch(WIRE_TOOL_NAME)
    expect(dashed).not.toBe(underscored)
  })

  it('fits a long name inside the service limit', () => {
    const wire = wireToolName(`mcp__${'x'.repeat(120)}__query-docs`)
    expect(wire).toMatch(WIRE_TOOL_NAME)
    expect(wire.length).toBeLessThanOrEqual(64)
  })

  it('replays a past call under the same wire name the tool list offers', () => {
    // Replayed history and the current tool schemas are serialized by different
    // code paths; a name that disagrees between them leaves the model seeing a
    // tool it cannot call.
    const harnessName = 'mcp__context7__query-docs'
    const request = serializeRequest(
      {
        provider: 'kiro',
        model: 'claude-sonnet-4.5',
        messages: [
          createUserMessage({ content: [{ type: 'text', text: 'search' }], source: SOURCE }),
          createAssistantMessage({
            content: [{
              type: 'tool-call',
              id: ToolCallId('call-1'),
              name: harnessName,
              arguments: '{"query":"dsh"}',
            }],
            source: { provider: 'kiro', model: 'claude-sonnet-4.5' },
          }),
          createToolResultMessage({ callId: ToolCallId('call-1'), content: [{ type: 'text', text: 'ok' }] }),
        ],
        tools: [tool(harnessName)],
      },
      {},
      'conv-1',
    )
    const listed = request.conversationState.currentMessage.userInputMessage
      .userInputMessageContext?.tools?.[0]?.toolSpecification.name
    const replayed = request.conversationState.history?.at(-1)
    expect(replayed !== undefined && 'assistantResponseMessage' in replayed
      ? replayed.assistantResponseMessage.toolUses?.[0]?.name
      : undefined).toBe(listed)
    expect(listed).toMatch(WIRE_TOOL_NAME)
  })
})
