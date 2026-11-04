import { describe, expect, it } from 'vitest'
import { KiroAdapter } from '../src/adapter.ts'
import type { KiroCatalogModel, KiroConnectionOptions } from '../src/adapter.ts'
import { mergeCliCatalog } from '../src/cli-discovery.ts'

const apiOpus: KiroCatalogModel = {
  id: 'claude-opus-5.5',
  name: 'Claude Opus 5.5',
  contextWindow: 1_000_000,
  thinking: true,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultReasoningEffort: 'medium',
  effortSchemaPath: 'output_config',
}
const cliOpus: KiroCatalogModel = { id: 'claude-opus-5.5', name: 'claude-opus-5.5', contextWindow: 1_000_000, thinking: true }
const cliOnly: KiroCatalogModel = { id: 'cli-only-model', thinking: false }

describe('merging the API and CLI catalogs', () => {
  it('keeps the API entry, with its effort schema, for models both sources list', () => {
    expect(mergeCliCatalog([apiOpus], [cliOpus])).toEqual([apiOpus])
  })

  it('appends models only the CLI lists, after the API order', () => {
    expect(mergeCliCatalog([apiOpus], [cliOnly, cliOpus]).map(model => model.id))
      .toEqual(['claude-opus-5.5', 'cli-only-model'])
  })

  it('returns the API catalog unchanged when the CLI is unavailable', () => {
    expect(mergeCliCatalog([apiOpus], undefined)).toEqual([apiOpus])
  })

  it('publishes the merged model’s native efforts, including xHigh and Max', async () => {
    const catalog = mergeCliCatalog([apiOpus], [cliOpus, cliOnly])
    const connection = {
      region: 'us-east-1',
      defaults: {},
      defaultContextWindow: 200_000,
      models: [],
      streamIdleTimeoutMs: 300_000,
      tokenExpiryBufferMs: 300_000,
      retryPolicy: {},
    } as unknown as KiroConnectionOptions
    const adapter = new KiroAdapter({
      options: () => connection,
      resolveToken: async () => ({ accessToken: 'a', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'idc' }),
      currentModels: () => catalog,
    })
    const reasoning = (await adapter.resolveModel('kiro', 'claude-opus-5.5')).reasoning
    expect(reasoning?.efforts.map(effort => effort.name)).toEqual(['Low', 'Medium', 'High', 'xHigh', 'Max'])
    expect(reasoning?.defaultEffort).toBe('medium')
  })
})
