/**
 * Replay the real recorded sessions through the serializer.
 *
 * The audit found the legacy continuation marker persisted as assistant output
 * in recorded Kiro sessions, then replayed back into every later request. This
 * probe rebuilds requests from those exact stored messages and asserts the
 * marker reaches neither the wire nor the model's context. Runs with
 * `DSH_SESSIONS=1`; skipped otherwise, because it reads the local session store.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { LEGACY_CONTINUATION, serializeRequest } from '../src/serialize.ts'
import type { WireHistoryEntry, WireRequest } from '../src/types.ts'

const SESSION_ROOT = '/root/.dsh/sessions'

/** Every recorded session transcript under the local DSH session store. */
function transcripts(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string, depth: number): void => {
    if (depth > 3) return
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (entry === 'session.jsonl.zstd') {
        found.push(path)
        continue
      }
      if (statSync(path).isDirectory()) walk(path, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

/** Decode one transcript into its JSON records. */
function records(path: string): Record<string, unknown>[] {
  const text = execFileSync('zstdcat', [path], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  const parsed: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // A transcript truncated by a crash still yields every complete record.
    }
  }
  return parsed
}

/** Rebuild the conversation the loop would replay from one transcript. */
function conversation(rows: Record<string, unknown>[]): Message[] {
  const messages: Message[] = []
  for (const row of rows) {
    const data = row.data as Record<string, unknown> | undefined
    if (data === undefined) continue
    if (row.type === 'user/message') {
      messages.push(data as unknown as Message)
      continue
    }
    if (row.type === 'assistant/message' || row.type === 'tool/result') {
      const message = data.message as Message | undefined
      if (message !== undefined) messages.push(message)
    }
  }
  return messages
}

/** Every text Kiro would receive for one serialized request. */
function wireTexts(request: WireRequest): string[] {
  const history: WireHistoryEntry[] = request.conversationState.history ?? []
  return [
    request.conversationState.currentMessage.userInputMessage.content,
    ...history.map(entry =>
      'userInputMessage' in entry
        ? entry.userInputMessage.content
        : entry.assistantResponseMessage.content),
  ]
}

/** Count exact marker text blocks stored in a conversation. */
function storedMarkers(messages: readonly Message[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() === LEGACY_CONTINUATION) count += 1
    }
  }
  return count
}

describe.runIf(process.env.DSH_SESSIONS === '1' && existsSync(SESSION_ROOT))(
  'recorded-session replay',
  () => {
    it('never replays a persisted continuation marker back to Kiro', () => {
      const contaminated: { path: string; stored: number; replayed: number }[] = []
      let scanned = 0
      for (const path of transcripts(SESSION_ROOT)) {
        const messages = conversation(records(path))
        if (messages.length === 0) continue
        scanned += 1
        const stored = storedMarkers(messages)
        if (stored === 0) continue
        // Text-only routes: the Kiro serializer refuses image content, and a
        // recorded multimodal session is not what this probe is about.
        if (messages.some(message => message.content.some(block => block.type === 'image'))) continue
        const request = serializeRequest(
          { provider: 'kiro', model: 'claude-opus-5', messages } as GenerateOptions,
          {},
          'replay',
        )
        const replayed = wireTexts(request)
          .filter(text => text.includes(LEGACY_CONTINUATION)).length
        contaminated.push({ path, stored, replayed })
      }
      console.log(`scanned ${scanned} transcripts`)
      for (const entry of contaminated) {
        console.log(`stored=${entry.stored} replayed=${entry.replayed} ${entry.path}`)
      }
      // The store must actually contain the contamination, or this proves nothing.
      expect(contaminated.length).toBeGreaterThan(0)
      expect(contaminated.reduce((sum, entry) => sum + entry.stored, 0)).toBeGreaterThan(0)
      expect(contaminated.every(entry => entry.replayed === 0)).toBe(true)
    }, 300_000)
  },
)
