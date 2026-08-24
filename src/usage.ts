/** Cached Kiro account usage retrieval through the control-plane API. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { KiroConnectionOptions } from './adapter.ts'
import type { KiroAuthMethod, KiroToken } from './auth.ts'
import { getJson, postJsonWithHeaders } from './transport.ts'

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const KIRO_USER_AGENT = 'aws-sdk-js/3.738.0 KiroIDE'

export interface KiroUsageRow {
  id: string
  label: string
  used: number
  limit: number
  remaining: number
  usedPercent: number
  remainingPercent: number
  resetAt?: string
  kind: 'subscription' | 'bonus'
}

export interface KiroUsage {
  plan: string
  fetchedAt: number
  resetAt?: string
  rows: readonly KiroUsageRow[]
}

export type UsageGetRequest = typeof getJson
export type UsagePostRequest = typeof postJsonWithHeaders

export interface KiroUsageServiceOptions {
  resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>
  getRequest?: UsageGetRequest
  postRequest?: UsagePostRequest
  cacheTtlMs?: number
}

interface CacheEntry {
  expiresAt: number
  usage: KiroUsage
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numeric(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

function timestamp(value: unknown): string | undefined {
  let milliseconds: number
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 10_000_000_000 ? value * 1000 : value
  } else if (typeof value === 'string' && value.length > 0) {
    const asNumber = Number(value)
    milliseconds = Number.isFinite(asNumber)
      ? (asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber)
      : Date.parse(value)
  } else {
    return undefined
  }
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined
}

function percentage(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10
}

function row(
  id: string,
  label: string,
  used: number,
  limit: number,
  resetAt: string | undefined,
  kind: KiroUsageRow['kind'],
): KiroUsageRow {
  const remaining = Math.max(0, limit - used)
  const usedPercent = limit > 0 ? percentage(used / limit * 100) : 0
  return {
    id,
    label,
    used,
    limit,
    remaining,
    usedPercent,
    remainingPercent: limit > 0 ? percentage(remaining / limit * 100) : 0,
    ...resetAt === undefined ? {} : { resetAt },
    kind,
  }
}

/** Normalize the public quota response without retaining account identity fields. */
export function parseKiroUsage(value: unknown, now = Date.now()): KiroUsage {
  const root = record(value)
  const breakdowns = root?.usageBreakdownList
  if (!Array.isArray(breakdowns)) throw new Error('Kiro GetUsageLimits returned no usage breakdown')
  const resetAt = timestamp(root?.nextDateReset ?? root?.resetDate)
  const rows: KiroUsageRow[] = []
  for (const raw of breakdowns) {
    const item = record(raw)
    if (item === undefined) continue
    const resourceType = text(item.resourceType) ?? `usage-${rows.length + 1}`
    const label = text(item.displayNamePlural) ?? text(item.displayName) ?? resourceType
    rows.push(row(
      resourceType.toLowerCase(),
      label,
      numeric(item.currentUsageWithPrecision, item.currentUsage),
      numeric(item.usageLimitWithPrecision, item.usageLimit),
      resetAt,
      'subscription',
    ))
    const trial = record(item.freeTrialInfo)
    const trialExpiry = timestamp(trial?.freeTrialExpiry)
    if (trial !== undefined
      && trial.freeTrialStatus !== 'EXPIRED'
      && (numeric(trial.usageLimitWithPrecision, trial.usageLimit) > 0
        || (trialExpiry !== undefined && Date.parse(trialExpiry) > now))) {
      rows.push(row(
        `${resourceType.toLowerCase()}-welcome-bonus`,
        'Welcome bonus',
        numeric(trial.currentUsageWithPrecision, trial.currentUsage),
        numeric(trial.usageLimitWithPrecision, trial.usageLimit),
        trialExpiry ?? resetAt,
        'bonus',
      ))
    }
  }
  if (rows.length === 0) throw new Error('Kiro GetUsageLimits returned no usable usage rows')
  const subscription = record(root?.subscriptionInfo)
  return {
    plan: text(subscription?.subscriptionTitle) ?? 'Kiro',
    fetchedAt: now,
    ...resetAt === undefined ? {} : { resetAt },
    rows,
  }
}

function tokenTypeHeaders(authMethod: KiroAuthMethod): Record<string, string> {
  if (authMethod === 'api_key') return { TokenType: 'API_KEY' }
  if (authMethod === 'external_idp') return { TokenType: 'EXTERNAL_IDP' }
  return {}
}

function headers(token: KiroToken): Record<string, string> {
  return {
    authorization: `Bearer ${token.accessToken}`,
    'user-agent': KIRO_USER_AGENT,
    'x-amz-user-agent': KIRO_USER_AGENT,
    ...tokenTypeHeaders(token.authMethod),
  }
}

/** Account-scoped five-minute usage cache with forced refresh support. */
export class KiroUsageService {
  private readonly getRequest: UsageGetRequest
  private readonly postRequest: UsagePostRequest
  private readonly cacheTtlMs: number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly options: KiroUsageServiceOptions) {
    this.getRequest = options.getRequest ?? getJson
    this.postRequest = options.postRequest ?? postJsonWithHeaders
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  private key(connection: KiroConnectionOptions, token: KiroToken): string {
    return `${connection.region ?? token.region}\u0000${connection.profileArn ?? token.profileArn ?? ''}\u0000${connection.proxyUrl ?? ''}`
  }

  clear(): void {
    this.cache.clear()
  }

  current(connection: KiroConnectionOptions): KiroUsage | undefined {
    const suffix = `\u0000${connection.proxyUrl ?? ''}`
    const prefix = connection.region === undefined ? undefined : `${connection.region}\u0000`
    for (const [key, entry] of this.cache) {
      if (key.endsWith(suffix) && (prefix === undefined || key.startsWith(prefix))) return entry.usage
    }
    return undefined
  }

  async get(
    connection: KiroConnectionOptions,
    signal: AbortSignal,
    force = false,
  ): Promise<KiroUsage> {
    const token = await this.options.resolveToken(connection, signal)
    const key = this.key(connection, token)
    const cached = this.cache.get(key)
    if (!force && cached !== undefined && cached.expiresAt > Date.now()) return cached.usage

    const region = connection.region ?? token.region
    const profileArn = connection.profileArn ?? token.profileArn
    const codeWhispererQuery = new URLSearchParams({
      isEmailRequired: 'true',
      origin: 'AI_EDITOR',
      resourceType: 'AGENTIC_REQUEST',
    })
    const qQuery = new URLSearchParams({
      origin: 'AI_EDITOR',
      resourceType: 'AGENTIC_REQUEST',
      ...profileArn === undefined ? {} : { profileArn },
    })
    const commonHeaders = headers(token)
    const attempts: (() => Promise<{ status: number; body: unknown }>)[] = [
      () => this.getRequest(
        `https://codewhisperer.${region}.amazonaws.com/getUsageLimits?${codeWhispererQuery.toString()}`,
        commonHeaders,
        connection.proxyUrl,
        signal,
      ),
      () => this.postRequest(
        `https://codewhisperer.${region}.amazonaws.com`,
        { origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST', ...profileArn === undefined ? {} : { profileArn } },
        {
          ...commonHeaders,
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': 'AmazonCodeWhispererService.GetUsageLimits',
        },
        connection.proxyUrl,
        signal,
      ),
      () => this.getRequest(
        `https://q.${region}.amazonaws.com/getUsageLimits?${qQuery.toString()}`,
        commonHeaders,
        connection.proxyUrl,
        signal,
      ),
    ]
    let lastStatus = 0
    let lastError: unknown
    for (const attempt of attempts) {
      try {
        const response = await attempt()
        lastStatus = response.status
        if (response.status !== 200) continue
        const usage = parseKiroUsage(response.body)
        this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, usage })
        return usage
      } catch (error: unknown) {
        if (signal.aborted) throw error
        lastError = error
      }
    }
    const code = lastStatus === 401 ? 'AUTH'
      : lastStatus === 403 ? 'FORBIDDEN'
        : lastStatus === 429 ? 'RATE_LIMIT'
          : lastStatus >= 500 ? 'SERVER'
            : 'TRANSPORT'
    throw new LlmError(
      lastStatus > 0
        ? `Kiro usage is temporarily unavailable (HTTP ${lastStatus})`
        : 'Kiro usage is temporarily unavailable',
      code,
      { ...lastStatus > 0 ? { status: lastStatus } : {}, ...lastError === undefined ? {} : { cause: lastError } },
    )
  }
}
