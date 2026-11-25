/**
 * Per-turn Kiro credit ledger.
 *
 * Kiro reports what each model call cost in a `meteringEvent`
 * (`{ usage, unit: "credit" }`) inside the response stream. DSH's usage schema
 * has no credit vocabulary, so the adapter hands each charge to this ledger
 * keyed by the request's session, and the settings client sums the charges
 * that landed inside one Turn's start/end window to show "X credits" on that
 * Turn's reply. Every charge is timestamped when its event arrives, which is
 * always between the owning Turn's `turn/start` and `turn/end`.
 *
 * One append-only JSONL file per session, `{"t":<epoch ms>,"c":<credits>}` per
 * line, so a write is one `appendFile` and a crash can lose at most the line it
 * was writing. The ledger never throws into the stream: a failed write only
 * means that call's charge is not shown.
 */

import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Session identifiers the ledger accepts; anything else would escape the directory. */
export const CREDIT_SESSION_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/u

/** Largest ledger file a sum reads, so a runaway file cannot stall a request. */
const LEDGER_READ_LIMIT = 4 * 1024 * 1024

/** Credits charged inside one window. `calls` is zero when nothing was recorded. */
export interface KiroCreditSum {
  credits: number
  calls: number
}

/** Record and sum per-session Kiro credit charges. */
export class KiroCreditLedger {
  private ready: Promise<void> | undefined

  /** @param directory - private directory holding one ledger file per session. */
  constructor(private readonly directory: string) {}

  private fileFor(sessionId: string): string | undefined {
    if (sessionId === '.' || sessionId === '..') return undefined
    return CREDIT_SESSION_PATTERN.test(sessionId) ? join(this.directory, `${sessionId}.jsonl`) : undefined
  }

  /**
   * Append one charge. Fire-and-forget: the returned promise settles once the
   * line is written and never rejects, so callers in the stream may ignore it.
   * @param sessionId - DSH session that issued the request.
   * @param credits - non-negative credits the call consumed.
   * @param time - arrival time of the metering event.
   */
  record(sessionId: string, credits: number, time = Date.now()): Promise<void> {
    const file = this.fileFor(sessionId)
    if (file === undefined || !Number.isFinite(credits) || credits < 0) return Promise.resolve()
    this.ready ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined)
    return this.ready
      .then(() => appendFile(file, JSON.stringify({ t: time, c: credits }) + '\n', { mode: 0o600 }))
      .catch(() => {
        // A charge that cannot be stored is simply not shown; never fail the turn.
        this.ready = undefined
      })
  }

  /**
   * Sum the charges recorded for one session inside `[from, to]`.
   * @throws Error when `sessionId` is not a safe ledger name.
   */
  async sum(sessionId: string, from: number, to: number): Promise<KiroCreditSum> {
    const file = this.fileFor(sessionId)
    if (file === undefined) throw new Error('invalid sessionId')
    let text: string
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > LEDGER_READ_LIMIT) return { credits: 0, calls: 0 }
      text = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { credits: 0, calls: 0 }
      throw error
    }
    let credits = 0
    let calls = 0
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        // A torn final line from an interrupted write carries no charge.
        continue
      }
      const { t, c } = (entry ?? {}) as { t?: unknown; c?: unknown }
      if (typeof t !== 'number' || typeof c !== 'number' || !Number.isFinite(c)) continue
      if (t < from || t > to) continue
      credits += c
      calls += 1
    }
    return { credits, calls }
  }
}
