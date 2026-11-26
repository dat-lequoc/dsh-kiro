import { describe, expect, it } from 'vitest'
import { KIRO_TOOL_NAME, toolNames } from '../src/tool-names.ts'

describe('tool names', () => {
  it('sends a conforming name verbatim', () => {
    const names = toolNames(['get_weather'])
    expect(names.wire('get_weather')).toBe('get_weather')
    expect(names.harness('get_weather')).toBe('get_weather')
  })

  it('encodes the MCP names DSH hands over, hyphens included', () => {
    const original = 'mcp__bat-mcp-oauth-function__bat-agg-metrics'
    const names = toolNames([original])
    const wire = names.wire(original)
    expect(wire).toBe('mcp__bat_mcp_oauth_function__bat_agg_metrics')
    expect(KIRO_TOOL_NAME.test(wire)).toBe(true)
    expect(names.harness(wire)).toBe(original)
  })

  it('prefixes a name that would start on a digit', () => {
    const names = toolNames(['2fast'])
    expect(names.wire('2fast')).toBe('t_2fast')
    expect(names.harness('t_2fast')).toBe('2fast')
  })

  it('trims an over-long name to the 64-character cap and keeps it reversible', () => {
    const original = `tool-${'x'.repeat(80)}`
    const wire = toolNames([original]).wire(original)
    expect(wire).toHaveLength(64)
    expect(KIRO_TOOL_NAME.test(wire)).toBe(true)
    expect(toolNames([original]).harness(wire)).toBe(original)
  })

  it('keeps two names that encode alike distinct', () => {
    const names = toolNames(['a-b', 'a_b'])
    const dashed = names.wire('a-b')
    const underscored = names.wire('a_b')
    // The conforming name keeps its own spelling; the encoded one steps aside.
    expect(underscored).toBe('a_b')
    expect(dashed).toMatch(/^a_b_[0-9a-f]{8}$/u)
    expect(names.harness(dashed)).toBe('a-b')
    expect(names.harness(underscored)).toBe('a_b')
  })

  it('yields the same names whatever order the tools arrive in', () => {
    const forward = toolNames(['a-b', 'get_weather', 'x.y'])
    const backward = toolNames(['x.y', 'get_weather', 'a-b'])
    for (const name of ['a-b', 'get_weather', 'x.y']) {
      expect(backward.wire(name)).toBe(forward.wire(name))
    }
  })

  it('passes an unknown wire name through unchanged', () => {
    expect(toolNames(['get_weather']).harness('some_other_tool')).toBe('some_other_tool')
  })

  it('encodes a history-only name the request no longer declares', () => {
    const wire = toolNames(['get_weather']).wire('mcp__a-b__c-d')
    expect(KIRO_TOOL_NAME.test(wire)).toBe(true)
    expect(wire).toBe('mcp__a_b__c_d')
  })
})