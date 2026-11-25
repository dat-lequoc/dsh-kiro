import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KiroCreditLedger } from '../src/credits.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { FileModelSettingsStore } from '../src/model-settings.ts'
import { registerWebApi } from '../src/web.ts'
import type { WebDependencies } from '../src/web.ts'

let home: string
let directory: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-kiro-credits-'))
  directory = join(home, 'kiro-credits')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('KiroCreditLedger', () => {
  it('sums only the charges inside the window', async () => {
    const ledger = new KiroCreditLedger(directory)
    await ledger.record('session-1', 0.25, 1_000)
    await ledger.record('session-1', 0.5, 2_000)
    await ledger.record('session-1', 4, 3_000)
    await ledger.record('session-2', 9, 2_000)
    expect(await ledger.sum('session-1', 1_000, 2_000)).toEqual({ credits: 0.75, calls: 2 })
    expect(await ledger.sum('session-1', 0, 999)).toEqual({ credits: 0, calls: 0 })
    expect(await ledger.sum('session-2', 0, 10_000)).toEqual({ credits: 9, calls: 1 })
  })

  it('reads an unknown session as no charge', async () => {
    expect(await new KiroCreditLedger(directory).sum('never-seen', 0, Date.now())).toEqual({ credits: 0, calls: 0 })
  })

  it('refuses a session id that would leave the directory', async () => {
    const ledger = new KiroCreditLedger(directory)
    await expect(ledger.sum('../escape', 0, 1)).rejects.toThrow('invalid sessionId')
    await expect(ledger.sum('..', 0, 1)).rejects.toThrow('invalid sessionId')
    await ledger.record('../escape', 1, 1)
    await expect(stat(join(home, 'escape.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores invalid charges and torn lines', async () => {
    const ledger = new KiroCreditLedger(directory)
    await ledger.record('session-1', Number.NaN, 1)
    await ledger.record('session-1', -2, 1)
    await ledger.record('session-1', 1, 1)
    await writeFile(join(directory, 'session-1.jsonl'), '{"t":1,"c":', { flag: 'a' })
    expect(await ledger.sum('session-1', 0, 10)).toEqual({ credits: 1, calls: 1 })
  })

  it('keeps the ledger private to its owner', async () => {
    const ledger = new KiroCreditLedger(directory)
    await ledger.record('session-1', 1, 1)
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'session-1.jsonl'))).mode & 0o777).toBe(0o600)
    }
    expect(await readFile(join(directory, 'session-1.jsonl'), 'utf8')).toBe('{"t":1,"c":1}\n')
  })
})

describe('turn-credits route', () => {
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>

  async function get(path: string): Promise<{ status: number; value: any }> {
    const request = { method: 'GET', url: path, async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
    let status = 0
    let payload = ''
    const response = {
      writeHead: (code: number) => { status = code },
      end: (value: string) => { payload = value },
    } as unknown as ServerResponse
    await handler(request, response)
    return { status, value: JSON.parse(payload) }
  }

  beforeEach(() => {
    const ledger = new KiroCreditLedger(directory)
    const ctx = {
      emit: () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
      inject: (_names: string[], use: (scope: unknown) => void) => {
        use({
          effect: (run: () => unknown) => run(),
          webServer: { register: (options: { handler: typeof handler }) => { handler = options.handler; return () => undefined } },
        })
      },
    }
    registerWebApi(ctx as never, {
      managedDirectory: join(home, 'kiro-auth'),
      options: () => resolveAdapterOptions({ region: 'us-east-1' }),
      discovery: { current: () => undefined, clear: () => undefined, list: async () => [] },
      modelSettings: new FileModelSettingsStore(),
      usage: { current: () => undefined, clear: () => undefined, get: async () => ({}) },
      credits: ledger,
      resolveToken: async () => { throw new Error('not used') },
    } as unknown as WebDependencies)
    return ledger.record('session-1', 0.125, 1_500)
  })

  it('returns the credits a session spent inside the window', async () => {
    const result = await get('/kiro/api/turn-credits?sessionId=session-1&from=1000&to=2000')
    expect(result).toEqual({ status: 200, value: { ok: true, value: { credits: 0.125, calls: 1 } } })
  })

  it('rejects a malformed query', async () => {
    for (const query of ['sessionId=../x&from=0&to=1', 'sessionId=s&from=a&to=1', 'sessionId=s&from=5&to=1']) {
      const result = await get(`/kiro/api/turn-credits?${query}`)
      expect(result.status).toBe(400)
      expect(result.value).toEqual({ ok: false, error: 'invalid-query' })
    }
  })
})
