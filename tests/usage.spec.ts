import { describe, expect, it, vi } from 'vitest'
import type { KiroConnectionOptions } from '../src/adapter.ts'
import { KiroUsageService, parseKiroUsage } from '../src/usage.ts'

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

const response = {
  subscriptionInfo: { subscriptionTitle: 'Kiro Pro' },
  nextDateReset: 1_800_000_000,
  usageBreakdownList: [{
    resourceType: 'CREDIT',
    displayNamePlural: 'Credits',
    currentUsageWithPrecision: 12.5,
    usageLimitWithPrecision: 100,
    freeTrialInfo: {
      freeTrialStatus: 'ACTIVE',
      currentUsageWithPrecision: 2,
      usageLimitWithPrecision: 20,
      freeTrialExpiry: 1_800_086_400,
    },
  }],
}

describe('Kiro usage', () => {
  it('parses plan, precision credits, reset dates, and active welcome bonuses', () => {
    expect(parseKiroUsage(response, 1_700_000_000_000)).toEqual({
      plan: 'Kiro Pro',
      fetchedAt: 1_700_000_000_000,
      resetAt: '2027-01-15T08:00:00.000Z',
      rows: [
        {
          id: 'credit', label: 'Credits', used: 12.5, limit: 100, remaining: 87.5,
          usedPercent: 12.5, remainingPercent: 87.5,
          resetAt: '2027-01-15T08:00:00.000Z', kind: 'subscription',
        },
        {
          id: 'credit-welcome-bonus', label: 'Welcome bonus', used: 2, limit: 20, remaining: 18,
          usedPercent: 10, remainingPercent: 90,
          resetAt: '2027-01-16T08:00:00.000Z', kind: 'bonus',
        },
      ],
    })
  })

  it('uses refreshed auth, the known GET shape, proxy egress, and a five-minute cache', async () => {
    const getRequest = vi.fn().mockResolvedValue({ status: 200, body: response })
    const service = new KiroUsageService({
      resolveToken: async () => ({
        accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod: 'google',
      }),
      getRequest,
    })
    const signal = new AbortController().signal
    await service.get(connection, signal)
    await service.get(connection, signal)
    expect(getRequest).toHaveBeenCalledTimes(1)
    const [url, headers, proxy] = getRequest.mock.calls[0] as [string, Record<string, string>, string]
    expect(url).toContain('codewhisperer.us-east-1.amazonaws.com/getUsageLimits?')
    expect(url).toContain('resourceType=AGENTIC_REQUEST')
    expect(url).not.toContain('profileArn=')
    expect(headers.authorization).toBe('Bearer access')
    expect(headers['x-amz-user-agent']).toContain('KiroIDE')
    expect(proxy).toBe('http://proxy.example:8080')
    expect(service.current({ ...connection, profileArn: undefined })).toMatchObject({ plan: 'Kiro Pro' })
  })

  it('falls back to the AWS JSON operation and preserves the last successful cache', async () => {
    const getRequest = vi.fn()
      .mockResolvedValueOnce({ status: 403, body: {} })
      .mockResolvedValue({ status: 503, body: {} })
    const postRequest = vi.fn().mockResolvedValueOnce({ status: 200, body: response })
      .mockResolvedValue({ status: 503, body: {} })
    const service = new KiroUsageService({
      resolveToken: async () => ({
        accessToken: 'key', region: 'us-east-1', expiresAt: Number.MAX_SAFE_INTEGER, authMethod: 'api_key',
      }),
      getRequest,
      postRequest,
    })
    const signal = new AbortController().signal
    await expect(service.get(connection, signal)).resolves.toMatchObject({ plan: 'Kiro Pro' })
    const [, body, headers] = postRequest.mock.calls[0] as [string, Record<string, unknown>, Record<string, string>]
    expect(body.profileArn).toBe(connection.profileArn)
    expect(headers.TokenType).toBe('API_KEY')
    await expect(service.get(connection, signal, true)).rejects.toThrow(/temporarily unavailable/u)
    expect(service.current(connection)).toMatchObject({ plan: 'Kiro Pro' })
  })

  it('rejects malformed quota responses', () => {
    expect(() => parseKiroUsage({ usageBreakdownList: [] })).toThrow(/no usable usage rows/u)
    expect(() => parseKiroUsage({})).toThrow(/no usage breakdown/u)
  })
})
