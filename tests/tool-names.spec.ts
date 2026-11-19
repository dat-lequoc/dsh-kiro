import { describe, expect, it } from 'vitest'
import { createToolNames } from '../src/tool-names.ts'

const tool = (name: string) => ({ name, description: name, parameters: {} })
const mcpName = 'mcp__context7__query-docs'
const namesFor = (...names: string[]) => createToolNames({ messages: [], tools: names.map(tool) })

describe('Kiro wire tool names', () => {
  it('produces bounded, distinct, order-independent aliases and leaves valid names unchanged', () => {
    const valid = 'get_weather'
    const originals = [valid, 'get-weather', 'get.weather', mcpName, `mcp_${'long'.repeat(24)}`, '2lookup']
    const names = namesFor(...originals)
    const reordered = namesFor(...[...originals].reverse())
    const wire = originals.map(names.toWire)
    expect(names.toWire(valid)).toBe(valid)
    expect(wire).toEqual(originals.map(reordered.toWire))
    expect(new Set(wire).size).toBe(originals.length)
    for (const alias of wire) expect(alias).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
    expect(wire.map(names.fromWire)).toEqual(originals)
    expect(namesFor().fromWire(names.toWire(mcpName))).toBe(names.toWire(mcpName))
  })

  it('reserves existing tool names even when one looks like a generated alias', () => {
    const occupied = namesFor(mcpName).toWire(mcpName)
    const names = namesFor(mcpName, occupied)
    expect(names.toWire(occupied)).toBe(occupied)
    expect(names.fromWire(occupied)).toBe(occupied)
    const alternate = names.toWire(mcpName)
    expect(alternate).not.toBe(occupied)
    expect(names.fromWire(alternate)).toBe(mcpName)
  })
})
