import { createHash } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Keep the existing Kiro wire constraint without imposing it on DSH tools. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export interface ToolNames {
  toWire(name: string): string
  fromWire(name: string): string
}

/** One mapping for the declarations, history, and streamed calls of a request. */
export function createToolNames({ tools, messages }: Pick<GenerateOptions, 'tools' | 'messages'>): ToolNames {
  const declared = new Set(tools?.map(tool => tool.name))
  const names = new Set(declared)
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') names.add(block.name)
    }
  }

  // Reserve verbatim names first, even if one already looks like an alias.
  const occupied = new Set([...names].filter(name => TOOL_NAME_PATTERN.test(name)))
  const aliases = new Map<string, string>()
  const originals = new Map<string, string>()
  for (const name of [...names].sort()) {
    if (TOOL_NAME_PATTERN.test(name)) continue
    const stem = name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30)
    let alias: string
    let attempt = 0
    do {
      const digest = createHash('sha256').update(JSON.stringify([name, attempt++])).digest('hex').slice(0, 24)
      alias = `kiro_${stem}_${digest}`
    } while (occupied.has(alias))
    occupied.add(alias)
    aliases.set(name, alias)
    // An alias used only in history must not be turned into a callable tool.
    if (declared.has(name)) originals.set(alias, name)
  }
  return {
    toWire: name => aliases.get(name) ?? name,
    fromWire: name => originals.get(name) ?? name,
  }
}
