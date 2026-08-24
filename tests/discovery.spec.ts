import { describe, expect, it, vi } from 'vitest'
import type { KiroConnectionOptions } from '../src/adapter.ts'
import { KiroModelDiscovery, modelSupportsThinking, parseAvailableModels } from '../src/discovery.ts'

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
        },
        { modelId: 'claude-haiku-4.5', modelName: 'Claude Haiku 4.5' },
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
      },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', thinking: false },
    ])
    expect(modelSupportsThinking('glm-5')).toBe(true)
    expect(modelSupportsThinking('claude-sonnet-4.5')).toBe(true)
    expect(modelSupportsThinking('claude-sonnet-4')).toBe(false)
    expect(modelSupportsThinking('qwen3-coder-next')).toBe(false)
  })

  it('calls ListAvailableModels with auth and profile, then caches the account catalog', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { models: [{ modelId: 'claude-opus-4.8', modelName: 'Claude Opus 4.8' }] },
    })
    const discovery = new KiroModelDiscovery({
      resolveToken: async () => ({ accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000 }),
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
      resolveToken: async () => ({ accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000 }),
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

  it('fails loudly when Kiro returns no usable model ids', () => {
    expect(() => parseAvailableModels({ models: [{ modelName: 'missing id' }] }))
      .toThrow(/no usable model ids/u)
  })
})
