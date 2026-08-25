import { describe, expect, it, vi } from 'vitest'
import type { KiroConnectionOptions } from '../src/adapter.ts'
import {
  KiroModelDiscovery,
  modelSupportsThinking,
  parseAvailableModels,
  parseEffortSchema,
  parseMaxTokensBounds,
} from '../src/discovery.ts'

const connection = {
  region: 'us-east-1',
  proxyUrl: 'http://proxy.example:8080',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test',
  defaults: {},
  defaultContextWindow: 200_000,
  models: [],
  streamIdleTimeoutMs: 300_000,
  tokenExpiryBufferMs: 300_000,
  retryPolicy: {},
} as unknown as KiroConnectionOptions

describe('Kiro model discovery', () => {
  it('parses live model names, token limits, and reasoning capability', () => {
    expect(parseAvailableModels({
      models: [
        {
          modelId: 'claude-opus-4.8',
          modelName: 'Claude Opus 4.8',
          description: 'Most capable',
          tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
          additionalModelRequestFieldsSchema: {
            properties: {
              output_config: {
                properties: {
                  effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'xhigh' },
                },
              },
            },
          },
        },
        {
          modelId: 'gpt-5.6-sol',
          modelName: 'GPT-5.6 Sol',
          additionalModelRequestFieldsSchema: {
            properties: {
              reasoning: {
                properties: {
                  effort: { enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
                },
              },
            },
          },
        },
        {
          modelId: 'claude-haiku-4.5',
          modelName: 'Claude Haiku 4.5',
          additionalModelRequestFieldsSchema: null,
        },
        { modelId: 'claude-opus-4.8', modelName: 'duplicate' },
      ],
    })).toEqual([
      {
        id: 'claude-opus-4.8',
        name: 'Claude Opus 4.8',
        description: 'Most capable',
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        thinking: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'xhigh',
        effortSchemaPath: 'output_config',
      },
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        thinking: true,
        reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
        effortSchemaPath: 'reasoning',
      },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', thinking: false },
    ])
    expect(modelSupportsThinking('glm-5')).toBe(true)
    expect(modelSupportsThinking('claude-sonnet-4.5')).toBe(true)
    expect(modelSupportsThinking('claude-sonnet-4')).toBe(false)
    expect(modelSupportsThinking('qwen3-coder-next')).toBe(false)
  })

  it('ignores malformed effort entries and only accepts a default in the enum', () => {
    expect(parseEffortSchema({
      properties: {
        reasoning: { properties: { effort: { enum: ['low', 1, 'low', 'max'], default: 'other' } } },
      },
    })).toEqual({ levels: ['low', 'max'], schemaPath: 'reasoning' })
  })

  it('calls ListAvailableModels with auth and profile, then caches the account catalog', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { models: [{ modelId: 'claude-opus-4.8', modelName: 'Claude Opus 4.8' }] },
    })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
    })
    const signal = new AbortController().signal
    await expect(discovery.list(connection, signal)).resolves.toHaveLength(1)
    await expect(discovery.list(connection, signal)).resolves.toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(1)
    const [url, headers, proxy] = request.mock.calls[0] as [string, Record<string, string>, string]
    expect(url).toContain('https://codewhisperer.us-east-1.amazonaws.com/ListAvailableModels?')
    expect(url).toContain('profileArn=arn%3Aaws%3Acodewhisperer')
    expect(headers.authorization).toBe('Bearer access')
    expect(headers['user-agent']).toContain('KiroIDE')
    expect(proxy).toBe('http://proxy.example:8080')
    expect(discovery.current(connection)?.[0]?.id).toBe('claude-opus-4.8')
  })

  it('discovers a default profile before listing models when none is configured', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { models: [{ modelId: 'claude-opus-4.8' }] },
    })
    const profiles = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        profiles: [{ arn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/default' }],
      },
    })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
      profileRequestJson: profiles,
    })
    const withoutProfile = { ...connection, profileArn: undefined } as unknown as KiroConnectionOptions
    await discovery.list(withoutProfile, new AbortController().signal)
    expect(profiles.mock.calls[0]?.[0]).toBe(
      'https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles',
    )
    expect(request.mock.calls[0]?.[0]).toContain('https://q.eu-central-1.amazonaws.com/ListAvailableModels?')
    expect(request.mock.calls[0]?.[0]).toContain('profileArn=arn%3Aaws%3Acodewhisperer%3Aeu-central-1')
  })

  it('reads the advertised max_tokens bounds from the live schema', () => {
    // Observed live for claude-opus-5: the schema declares an integer
    // `max_tokens` with a floor and a ceiling, and forbids extra properties.
    const schema = {
      type: 'object',
      properties: {
        thinking: { type: 'object', properties: { type: { type: 'string', enum: ['adaptive', 'disabled'] } } },
        output_config: { type: 'object', properties: { effort: { type: 'string', enum: ['low', 'high'], default: 'high' } } },
        max_tokens: { type: 'integer', minimum: 1024, maximum: 128_000 },
      },
      additionalProperties: false,
    }
    expect(parseMaxTokensBounds(schema)).toEqual({ minimum: 1024, maximum: 128_000 })
    const models = parseAvailableModels({
      models: [
        { modelId: 'claude-opus-5', additionalModelRequestFieldsSchema: schema },
        { modelId: 'gpt-5.6-sol', additionalModelRequestFieldsSchema: {
          type: 'object',
          properties: { reasoning: { type: 'object', properties: { effort: { type: 'string', enum: ['low', 'high'] } } } },
          additionalProperties: false,
        } },
        { modelId: 'claude-sonnet-4.5', additionalModelRequestFieldsSchema: null },
      ],
    })
    expect(models[0]?.maxTokensBounds).toEqual({ minimum: 1024, maximum: 128_000 })
    // A model whose schema omits the field, and one with no schema at all, must
    // carry no bounds: the request member is refused in both cases.
    expect(models[1]?.maxTokensBounds).toBeUndefined()
    expect(models[2]?.maxTokensBounds).toBeUndefined()
  })

  it('ignores a malformed or inverted max_tokens declaration', () => {
    expect(parseMaxTokensBounds({ properties: { max_tokens: { type: 'string' } } })).toBeUndefined()
    expect(parseMaxTokensBounds({ properties: { max_tokens: { type: 'integer' } } })).toBeUndefined()
    expect(parseMaxTokensBounds({
      properties: { max_tokens: { type: 'integer', minimum: 4096, maximum: 1024 } },
    })).toBeUndefined()
    expect(parseMaxTokensBounds({
      properties: { max_tokens: { type: 'integer', maximum: 64_000 } },
    })).toEqual({ minimum: 1, maximum: 64_000 })
  })

  it('fails loudly when Kiro returns no usable model ids', () => {
    expect(() => parseAvailableModels({ models: [{ modelName: 'missing id' }] }))
      .toThrow(/no usable model ids/u)
  })

  it('follows the continuation token so a large catalog is not truncated', async () => {
    // ListAvailableModels declares nextToken on both its request and response;
    // a catalog larger than one page arrives split across them.
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { models: [{ modelId: 'claude-opus-5' }], nextToken: 'page-2' },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { models: [{ modelId: 'claude-sonnet-5' }, { modelId: 'claude-opus-5' }] },
      })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
    })
    const models = await discovery.list(connection, new AbortController().signal)
    // The duplicate id from the second page is dropped, not repeated.
    expect(models.map(model => model.id)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[0]).not.toContain('nextToken')
    expect(request.mock.calls[1]?.[0]).toContain('nextToken=page-2')
  })

  it('stops instead of replaying a repeated continuation token', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { models: [{ modelId: 'claude-opus-5' }], nextToken: 'same' },
    })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
    })
    await expect(discovery.list(connection, new AbortController().signal))
      .resolves.toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('treats an empty continuation token as the end of the catalog', async () => {
    // The live endpoint returns `nextToken: ""` on every page while repeating
    // the same models, so an empty token must not be followed even once.
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { models: [{ modelId: 'claude-opus-5' }], nextToken: '' },
    })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
    })
    await expect(discovery.list(connection, new AbortController().signal))
      .resolves.toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stops when a continuation page adds no new model', async () => {
    // A paginator that keeps handing out fresh tokens while repeating its
    // contents would otherwise be walked to the page cap on every discovery.
    let issued = 0
    const request = vi.fn().mockImplementation(() => {
      issued += 1
      return Promise.resolve({
        status: 200,
        body: { models: [{ modelId: 'claude-opus-5' }], nextToken: `token-${issued}` },
      })
    })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
    })
    await expect(discovery.list(connection, new AbortController().signal))
      .resolves.toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps the pages it already read when a later page fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { models: [{ modelId: 'claude-opus-5' }], nextToken: 'page-2' },
      })
      .mockResolvedValueOnce({ status: 500, body: {} })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
    })
    await expect(discovery.list(connection, new AbortController().signal))
      .resolves.toEqual([expect.objectContaining({ id: 'claude-opus-5' })])
  })

  it('still fails when the first page fails', async () => {
    const request = vi.fn().mockResolvedValue({ status: 403, body: { message: 'nope' } })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'builder-id',
      }),
      requestJson: request,
    })
    await expect(discovery.list(connection, new AbortController().signal))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
