import { describe, expect, it } from 'vitest'
import { KiroAdapter } from '../src/adapter.ts'
import type { KiroConnectionOptions } from '../src/adapter.ts'
import { resolveAdapterOptions } from '../src/index.ts'

function connection(overrides: Partial<KiroConnectionOptions> = {}): KiroConnectionOptions {
  return {
    region: 'us-east-1',
    defaults: {},
    defaultContextWindow: 200_000,
    models: [
      {
        id: 'thinking',
        name: 'Thinking',
        thinking: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'xhigh',
        effortSchemaPath: 'output_config',
      },
      { id: 'plain', name: 'Plain', thinking: false },
    ],
    streamIdleTimeoutMs: 300_000,
    tokenExpiryBufferMs: 300_000,
    retryPolicy: {},
    ...overrides,
  } as KiroConnectionOptions
}

function adapter(options = connection(), selectModels?: (models: KiroConnectionOptions['models']) => Promise<KiroConnectionOptions['models']>): KiroAdapter {
  return new KiroAdapter({
    options: () => options,
    resolveToken: async () => ({
      accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
    }),
    ...selectModels === undefined ? {} : { selectModels },
  })
}

describe('Kiro model publication', () => {
  it('normalizes Schemastery’s empty optional effort array on fallback models', () => {
    expect(resolveAdapterOptions({
      models: [{ id: 'auto', thinking: false, reasoningEfforts: [] }],
    }).models).toEqual([{ id: 'auto', thinking: false }])
  })

  it('advertises each model’s live efforts and provider default', async () => {
    const reasoning = (await adapter().resolveModel('kiro', 'thinking')).reasoning
    expect(reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(reasoning?.efforts.map(effort => effort.name)).toContain('xHigh')
    expect(reasoning?.defaultEffort).toBe('xhigh')
    expect((await adapter().resolveModel('kiro', 'plain')).reasoning).toMatchObject({
      efforts: [{ id: 'off' }],
      defaultEffort: 'off',
    })
  })

  it('honors an explicit provider default and publishes only enabled models', async () => {
    const instance = adapter(
      connection({ defaults: { reasoningEffort: 'medium' } }),
      async models => models.filter(model => model.id === 'thinking'),
    )
    expect((await instance.resolveModel('kiro', 'thinking')).reasoning?.defaultEffort).toBe('medium')
    await expect(instance.listModels('kiro')).resolves.toEqual([expect.objectContaining({ id: 'thinking' })])
    await expect(instance.resolveModel('kiro', 'plain')).resolves.toMatchObject({ id: 'plain' })
  })

  it('implements the prepared-call contract required by current DSH hosts', async () => {
    const prepared = await adapter().prepareCall('kiro', 'thinking')
    expect(prepared.model).toMatchObject({ provider: 'kiro', id: 'thinking' })
    expect(prepared.stream).toBeTypeOf('function')
  })
})
