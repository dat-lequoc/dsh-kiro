/**
 * Wire names for the tools a request declares.
 *
 * Kiro accepts tool names that match {@link KIRO_TOOL_NAME} only, and rejects
 * the whole request otherwise. Harness names are wider: an MCP tool arrives as
 * `mcp__<server>__<tool>`, and both halves routinely carry hyphens. Encoding
 * here keeps one naming contract shared by the request that declares the tools
 * and the stream that reports which one the model called.
 *
 * @module dsh-kiro/tool-names
 */
import { createHash } from 'node:crypto'

/** Tool names Kiro accepts verbatim. */
export const KIRO_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** Longest tool name Kiro accepts. */
const MAX_NAME_LENGTH = 64

/** Hex characters of the digest that keeps encoded names unique. */
const DIGEST_LENGTH = 8

/** One request's tool names, in both directions. */
export interface ToolNames {
  /**
   * The name Kiro must receive for one harness tool.
   * @param name - the harness tool name.
   * @returns a name matching {@link KIRO_TOOL_NAME}.
   */
  wire: (name: string) => string
  /**
   * The harness tool a wire name refers to.
   * @param name - the name Kiro streamed back.
   * @returns the harness name, or the input when it names no declared tool.
   */
  harness: (name: string) => string
}

/**
 * Digest identifying one harness name.
 * @param name - the harness tool name.
 * @returns {@link DIGEST_LENGTH} lowercase hex characters.
 */
function digestOf(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, DIGEST_LENGTH)
}

/**
 * Rewrite one out-of-contract name into the shape Kiro accepts.
 *
 * Every character Kiro refuses becomes `_`, a name that opens on a digit gains
 * a `t_` prefix, and an over-long name keeps its readable head followed by a
 * digest of the original, so the rewrite stays reversible through
 * {@link ToolNames.harness}.
 * @param name - the harness tool name.
 * @returns a name matching {@link KIRO_TOOL_NAME}.
 */
function encode(name: string): string {
  const replaced = name.replace(/[^A-Za-z0-9_]/gu, '_')
  const headed = /^[A-Za-z]/u.test(replaced) ? replaced : `t_${replaced}`
  // The head leaves room for `_` plus the digest, so appending never overflows.
  const head = headed.slice(0, MAX_NAME_LENGTH - DIGEST_LENGTH - 1)
  return headed === head ? head : `${head}_${digestOf(name)}`
}

/**
 * Resolve the wire names one request declares.
 *
 * The mapping is a pure function of the name list, sorted internally: the same
 * tool set always yields the same wire names, so Kiro's prefix cache survives
 * across turns. Two harness names that encode alike — `a-b` and `a_b` — are
 * separated by a digest rather than by order, so one tool gaining or losing a
 * neighbour never renames the rest.
 * @param names - every harness tool name the request declares.
 * @returns the mapping used to declare the tools and to read the answer back.
 */
export function toolNames(names: readonly string[]): ToolNames {
  const wire = new Map<string, string>()
  const harness = new Map<string, string>()
  // A conforming name is sent verbatim, so it reserves its own spelling.
  const taken = new Set(names.filter(name => KIRO_TOOL_NAME.test(name)))
  for (const name of [...names].sort()) {
    if (KIRO_TOOL_NAME.test(name)) {
      wire.set(name, name)
      harness.set(name, name)
      continue
    }
    const encoded = encode(name)
    let candidate = encoded
    let digest = digestOf(name)
    while (taken.has(candidate)) {
      digest = digestOf(`${name}#${digest}`)
      candidate = `${encode(name).slice(0, MAX_NAME_LENGTH - DIGEST_LENGTH - 1)}_${digest}`
    }
    taken.add(candidate)
    wire.set(name, candidate)
    harness.set(candidate, name)
  }
  return {
    // A history-only name — a tool this turn no longer declares — still has to
    // reach the wire in a shape Kiro accepts.
    wire: name => wire.get(name) ?? encode(name),
    harness: name => harness.get(name) ?? name,
  }
}