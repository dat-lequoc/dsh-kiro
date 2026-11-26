import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAdapterOptions } from '../src/index.ts'
import type { KiroCatalogSnapshot } from '../src/model-catalog.ts'
import { FileModelSettingsStore } from '../src/model-settings.ts'
import { registerWebApi } from '../src/web.ts'
import type { WebDependencies } from '../src/web.ts'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** Mount the Web API over a stored catalog and return a request driver. */
async function mount(stored: KiroCatalogSnapshot | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-web-models-'))
  temporaryDirectories.push(directory)
  const settingsFile = join(directory, 'model-settings.json')
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
    managedDirectory: directory,
    // The configured fallback deliberately shares no ids with the stored catalog.
    options: () => resolveAdapterOptions({ region: 'us-east-1', models: [{ id: 'configured-only' }] }),
    discovery: { current: () => undefined, clear: () => undefined, list: async () => [] },
    catalog: {
      peek: async () => stored,
      snapshot: () => stored,
      invalidate: () => undefined,
      refresh: async () => { throw new Error('not used') },
    },
    modelSettings: new FileModelSettingsStore(settingsFile),
    usage: { current: () => undefined, clear: () => undefined, get: async () => ({}) },
    resolveToken: async () => { throw new Error('not used') },
  } as unknown as WebDependencies
  registerWebApi(ctx as never, dependencies)

  const call = async (method: string, url: string, body?: unknown): Promise<any> => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const request = {
      method, url, headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield* chunks },
    } as unknown as IncomingMessage
    let text = ''
    const response = { writeHead: () => undefined, end: (value: string) => { text = value } } as unknown as ServerResponse
    await handler(request, response)
    return JSON.parse(text).value
  }
  return { call, settingsFile }
}

const stored: KiroCatalogSnapshot = {
  fetchedAt: 1_700_000_000_000,
  models: [{ id: 'claude-opus-5.5', name: 'Claude Opus 5.5' }, { id: 'auto', name: 'Auto' }],
}

describe('Kiro model endpoints over the stored catalog', () => {
  it('shows the stored catalog with its own fetch time instead of the configured fallback', async () => {
    const { call } = await mount(stored)
    const models = await call('GET', '/kiro/api/models')
    expect(models.source).toBe('live')
    expect(models.fetchedAt).toBe(stored.fetchedAt)
    expect(models.models.map((model: { id: string }) => model.id).sort()).toEqual(['auto', 'claude-opus-5.5'])
  })

  it('saves a checkbox change against the stored catalog, keeping every known id', async () => {
    const { call, settingsFile } = await mount(stored)
    await call('POST', '/kiro/api/models', { enabledModelIds: ['claude-opus-5.5'] })
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(settings.knownModelIds).toEqual(['claude-opus-5.5', 'auto'])
    expect(settings.enabledModelIds).toEqual(['claude-opus-5.5'])
  })

  it('labels the configured catalog as such when nothing has been discovered', async () => {
    const { call } = await mount(undefined)
    const models = await call('GET', '/kiro/api/models')
    expect(models.source).toBe('configured')
    expect(models.models.map((model: { id: string }) => model.id)).toEqual(['configured-only'])
  })
})
