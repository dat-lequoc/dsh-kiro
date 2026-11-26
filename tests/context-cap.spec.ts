import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { KiroAdapter } from '../src/adapter.ts'
import type { KiroConnectionOptions } from '../src/adapter.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { FileModelSettingsStore } from '../src/model-settings.ts'
import { registerWebApi } from '../src/web.ts'
import type { WebDependencies } from '../src/web.ts'

/** One connection whose catalog declares capacity per model. */
function connection(overrides: Partial<KiroConnectionOptions> = {}): KiroConnectionOptions {
  return {
    region: 'us-east-1',
    defaults: {},
    defaultContextWindow: 200_000,
    models: [
      { id: 'huge', name: 'Huge', contextWindow: 1_000_000, maxTokens: 128_000, thinking: false },
      { id: 'small', name: 'Small', contextWindow: 100_000, thinking: false },
      { id: 'undeclared', name: 'Undeclared', thinking: false },
    ],
    streamIdleTimeoutMs: 300_000,
    tokenExpiryBufferMs: 300_000,
    retryPolicy: {},
    ...overrides,
  } as KiroConnectionOptions
}

function adapter(options: KiroConnectionOptions): KiroAdapter {
  return new KiroAdapter({
    options: () => options,
    resolveToken: async () => ({
      accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
    }),
  })
}

describe('maxContextWindow', () => {
  it('is absent unless the deployment sets one', () => {
    expect(resolveAdapterOptions({})).not.toHaveProperty('maxContextWindow')
    expect(resolveAdapterOptions({ maxContextWindow: 300_000 }).maxContextWindow).toBe(300_000)
  })

  it('refuses a ceiling that is not a positive integer', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveAdapterOptions({ maxContextWindow: value }))
        .toThrow('llm-kiro: maxContextWindow must be a positive integer')
    }
  })

  it('lowers the capacity the adapter publishes, and never raises it', async () => {
    const capped = adapter(connection({ maxContextWindow: 300_000 }))
    expect((await capped.resolveModel('kiro', 'huge')).context).toEqual({ contextWindow: 300_000 })
    // A model already inside the ceiling keeps its own smaller value.
    expect((await capped.resolveModel('kiro', 'small')).context).toEqual({ contextWindow: 100_000 })
    // A model that declares nothing falls back to the default, then the ceiling.
    expect((await capped.resolveModel('kiro', 'undeclared')).context).toEqual({ contextWindow: 200_000 })
  })

  it('caps the fallback default as well', async () => {
    const capped = adapter(connection({ maxContextWindow: 150_000 }))
    expect((await capped.resolveModel('kiro', 'undeclared')).context).toEqual({ contextWindow: 150_000 })
  })

  it('publishes the raw catalog capacity when no ceiling is set', async () => {
    const plain = adapter(connection())
    expect((await plain.resolveModel('kiro', 'huge')).context).toEqual({ contextWindow: 1_000_000 })
  })
})

describe('the capped capacity the settings page shows', () => {
  /** Drive one request through the registered Kiro API handler. */
  async function payload(maxContextWindow?: number): Promise<any> {
    let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> = async () => undefined
    const ctx = {
      emit: () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
      inject: (_names: string[], use: (scope: unknown) => void) => {
        use({
          effect: (run: () => unknown) => run(),
          webServer: {
            register: (options: { handler: typeof handler }) => {
              handler = options.handler
              return () => undefined
            },
          },
        })
      },
    }
    const dependencies = {
      managedDirectory: '/tmp/dsh-kiro-context-cap',
      options: () => resolveAdapterOptions({
        region: 'us-east-1',
        models: [
          { id: 'huge', name: 'Huge', contextWindow: 1_000_000, thinking: false },
          { id: 'small', name: 'Small', contextWindow: 100_000, thinking: false },
        ],
        ...maxContextWindow === undefined ? {} : { maxContextWindow },
      }),
      discovery: { current: () => undefined, clear: () => undefined, list: async () => [] },
      catalog: { peek: async () => undefined, snapshot: () => undefined, invalidate: () => undefined, refresh: async () => { throw new Error('no discovery in this test') } },
      modelSettings: new FileModelSettingsStore('/tmp/dsh-kiro-context-cap/model-settings.json'),
      usage: { current: () => undefined, clear: () => undefined, get: async () => ({}) },
      resolveToken: async () => { throw new Error('not used by these routes') },
    } as unknown as WebDependencies
    registerWebApi(ctx as never, dependencies)
    const request = { method: 'GET', url: '/kiro/api/models', async *[Symbol.asyncIterator]() {} } as unknown as IncomingMessage
    let body = ''
    const response = {
      writeHead: () => undefined,
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handler(request, response)
    return JSON.parse(body).value
  }

  it('reports the capacity requests are actually held to', async () => {
    const shown = await payload(300_000)
    const byId = Object.fromEntries(shown.models.map((model: { id: string; contextWindow?: number }) => [model.id, model.contextWindow]))
    expect(byId).toEqual({ huge: 300_000, small: 100_000 })
  })

  it('reports what the catalog declares when no ceiling is set', async () => {
    const shown = await payload()
    const byId = Object.fromEntries(shown.models.map((model: { id: string; contextWindow?: number }) => [model.id, model.contextWindow]))
    expect(byId).toEqual({ huge: 1_000_000, small: 100_000 })
  })
})

describe('setting the ceiling from the settings page', () => {
  /**
   * Mount the API with a fake configuration editor.
   *
   * The fake persists into the same value `options()` reads, so the status the
   * route returns is the status the Loader would produce after reconciling the
   * write — which is what the page renders from.
   */
  async function mount(options?: { entries?: unknown[] }): Promise<{
    call: (method: string, path: string, body?: unknown) => Promise<{ status: number; value: any }>
    edits: Record<string, unknown>[]
  }> {
    let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> = async () => undefined
    const edits: Record<string, unknown>[] = []
    let cap: number | undefined
    const editor = options === undefined ? undefined : {
      entries: () => options.entries ?? [{ options: { id: 'llm-kiro', name: 'dsh-kiro' } }],
      edit: async (_entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>) => {
        const next = change({ region: 'us-east-1' })
        edits.push(next)
        cap = typeof next['maxContextWindow'] === 'number' ? next['maxContextWindow'] : undefined
      },
    }
    const ctx = {
      emit: () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
      get: (name: string) => name === 'configEditor' ? editor : undefined,
      inject: (_names: string[], use: (scope: unknown) => void) => {
        use({
          effect: (run: () => unknown) => run(),
          webServer: {
            register: (registered: { handler: typeof handler }) => {
              handler = registered.handler
              return () => undefined
            },
          },
        })
      },
    }
    const dependencies = {
      managedDirectory: '/tmp/dsh-kiro-context-set',
      options: () => resolveAdapterOptions({ region: 'us-east-1', ...cap === undefined ? {} : { maxContextWindow: cap } }),
      discovery: { current: () => undefined, clear: () => undefined, list: async () => [] },
      catalog: { peek: async () => undefined, snapshot: () => undefined, invalidate: () => undefined, refresh: async () => { throw new Error('no discovery in this test') } },
      modelSettings: new FileModelSettingsStore('/tmp/dsh-kiro-context-set/model-settings.json'),
      usage: { current: () => undefined, clear: () => undefined, get: async () => ({}) },
      resolveToken: async () => { throw new Error('not used by these routes') },
    } as unknown as WebDependencies
    registerWebApi(ctx as never, dependencies)
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; value: any }> => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      const request = {
        method, url: path,
        async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
      } as unknown as IncomingMessage
      let status = 0
      let payload = ''
      const response = {
        writeHead: (code: number) => { status = code },
        end: (value: string) => { payload = value },
      } as unknown as ServerResponse
      await handler(request, response)
      return { status, value: payload.length === 0 ? undefined : JSON.parse(payload) }
    }
    return { call, edits }
  }

  it('writes the ceiling onto the plugin row and leaves its other fields alone', async () => {
    const { call, edits } = await mount({})
    const result = await call('POST', '/kiro/api/context', { maxContextWindow: 600000 })
    expect(result.status).toBe(200)
    expect(edits).toEqual([{ region: 'us-east-1', maxContextWindow: 600000 }])
    // The page re-renders from this payload, so it must already carry the write.
    expect(result.value.value.contextWindowCap).toBe(600000)
  })

  it('clears the ceiling, so each model speaks for itself again', async () => {
    const { call, edits } = await mount({})
    const applied = await call('POST', '/kiro/api/context', { maxContextWindow: 600000 })
    expect(applied.value.value.contextWindowCap).toBe(600000)
    const cleared = await call('POST', '/kiro/api/context', { maxContextWindow: null })
    expect(cleared.status).toBe(200)
    expect(edits).toEqual([{ region: 'us-east-1', maxContextWindow: 600000 }, { region: 'us-east-1' }])
    expect(cleared.value.value.contextWindowCap).toBeUndefined()
  })

  it('refuses a ceiling that is not a positive whole number', async () => {
    const { call, edits } = await mount({})
    for (const bad of [0, -1, 1.5, 'lots']) {
      const result = await call('POST', '/kiro/api/context', { maxContextWindow: bad })
      expect(result.status).toBe(500)
      expect(result.value.error).toContain('positive whole number')
    }
    expect(edits).toEqual([])
  })

  it('says where to set it when the deployment has no configuration editor', async () => {
    const { call } = await mount(undefined)
    const result = await call('POST', '/kiro/api/context', { maxContextWindow: 300000 })
    expect(result.status).toBe(500)
    expect(result.value.error).toContain('cordis.patch.yml')
  })

  it('says where to set it when the profile row is not addressable', async () => {
    const { call } = await mount({ entries: [] })
    const result = await call('POST', '/kiro/api/context', { maxContextWindow: 300000 })
    expect(result.status).toBe(500)
    expect(result.value.error).toContain('not addressable')
  })
})
