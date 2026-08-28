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

  it('uses the Kiro home region instead of an IDC credential region', async () => {
    const getRequest = vi.fn().mockResolvedValue({ status: 200, body: response })
    const service = new KiroUsageService({
      resolveToken: async () => ({
        accessToken: 'access', region: 'ap-southeast-1', expiresAt: Date.now() + 60_000, authMethod: 'idc',
      }),
      getRequest,
    })
    await service.get(
      { ...connection, region: undefined, profileArn: undefined },
      new AbortController().signal,
    )
    expect(getRequest.mock.calls[0]?.[0])
      .toContain('codewhisperer.us-east-1.amazonaws.com/getUsageLimits?')
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

  it('omits a trial the provider does not call active', () => {
    const usage = parseKiroUsage({
      usageBreakdownList: [{
        resourceType: 'CREDIT',
        currentUsage: 1,
        usageLimit: 100,
        // Not expired, but not usable either: the provider has not activated it.
        freeTrialInfo: { freeTrialStatus: 'PENDING', usageLimit: 20, freeTrialExpiry: 1_900_000_000 },
      }],
    }, 1_700_000_000_000)
    expect(usage.rows.map(entry => entry.kind)).toEqual(['subscription'])
  })

  it('omits an expired trial even when it still reports a limit', () => {
    const usage = parseKiroUsage({
      usageBreakdownList: [{
        resourceType: 'CREDIT',
        currentUsage: 1,
        usageLimit: 100,
        freeTrialInfo: {
          freeTrialStatus: 'EXPIRED',
          currentUsage: 5,
          usageLimit: 20,
          freeTrialExpiry: 1_600_000_000,
        },
      }],
    }, 1_700_000_000_000)
    expect(usage.rows.map(entry => entry.kind)).toEqual(['subscription'])
  })

  it('publishes named bonus grants, including exhausted ones', () => {
    const usage = parseKiroUsage({
      usageBreakdownList: [{
        resourceType: 'CREDIT',
        currentUsage: 5,
        usageLimit: 100,
        bonuses: [
          { displayName: 'Launch bonus', status: 'ACTIVE', currentUsage: 3, usageLimit: 50, expiresAt: 1_800_086_400 },
          { displayName: 'Spent bonus', status: 'EXHAUSTED', currentUsage: 25, usageLimit: 25 },
          { displayName: 'Revoked bonus', status: 'REVOKED', currentUsage: 0, usageLimit: 10 },
        ],
      }],
    }, 1_700_000_000_000)
    expect(usage.rows.map(entry => entry.label))
      .toEqual(['CREDIT', 'Launch bonus', 'Spent bonus'])
    expect(usage.rows[1]).toMatchObject({
      id: 'credit-bonus-launch-bonus', kind: 'bonus', used: 3, limit: 50, remaining: 47,
    })
    expect(usage.rows[2]).toMatchObject({ kind: 'bonus', remaining: 0, remainingPercent: 0 })
  })

  it('publishes unexpired overage credit packs as add-on rows', () => {
    const usage = parseKiroUsage({
      usageBreakdownList: [{
        resourceType: 'CREDIT',
        currentUsage: 5,
        usageLimit: 100,
        overageCredits: [
          { currentUsage: 10, usageLimit: 100, expiresAt: 1_800_086_400 },
          { currentUsage: 100, usageLimit: 100, expiresAt: 1_600_000_000 },
        ],
      }],
    }, 1_700_000_000_000)
    expect(usage.rows.filter(entry => entry.kind === 'addon')).toEqual([{
      id: 'credit-addon-1',
      label: 'Add-on credits',
      used: 10,
      limit: 100,
      remaining: 90,
      usedPercent: 10,
      remainingPercent: 90,
      resetAt: '2027-01-16T08:00:00.000Z',
      kind: 'addon',
    }])
  })

  it('marks an unlimited plan instead of inventing a percentage', () => {
    // 999999 is Kiro's no-limit sentinel; a zero limit is equally unbounded.
    const usage = parseKiroUsage({
      usageBreakdownList: [
        { resourceType: 'CREDIT', currentUsage: 4200, usageLimit: 999_999 },
        { resourceType: 'REQUEST', currentUsage: 7, usageLimit: 0 },
      ],
    }, 1_700_000_000_000)
    expect(usage.rows).toEqual([
      {
        id: 'credit', label: 'CREDIT', used: 4200, limit: 999_999, remaining: 0,
        usedPercent: 0, remainingPercent: 0, kind: 'subscription', unlimited: true,
      },
      {
        id: 'request', label: 'REQUEST', used: 7, limit: 0, remaining: 0,
        usedPercent: 0, remainingPercent: 0, kind: 'subscription', unlimited: true,
      },
    ])
  })

  it('keeps a bounded plan free of the unlimited flag', () => {
    const usage = parseKiroUsage({
      usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: 25, usageLimit: 200 }],
    }, 1_700_000_000_000)
    expect(usage.rows[0]?.unlimited).toBeUndefined()
    expect(usage.rows[0]).toMatchObject({ usedPercent: 12.5, remainingPercent: 87.5 })
  })
})
