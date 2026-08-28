/** Cached Kiro account usage retrieval through the control-plane API. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { kiroServiceRegion } from './adapter.ts'
import type { KiroConnectionOptions } from './adapter.ts'
import type { KiroAuthMethod, KiroToken } from './auth.ts'
import { getJson, postJsonWithHeaders } from './transport.ts'

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const KIRO_USER_AGENT = 'aws-sdk-js/3.738.0 KiroIDE'
/**
 * Limit value Kiro publishes for a plan with no usable bound. The installed
 * client treats a limit at or above it as "no limit" rather than a quota, so
 * converting it into a percentage would invent a ceiling the account does not have.
 */
const NO_LIMIT_SENTINEL = 999_999
/** Bonus states that still describe real, displayable balance. */
const DISPLAYABLE_BONUS_STATES = new Set(['ACTIVE', 'EXHAUSTED'])

export interface KiroUsageRow {
  id: string
  label: string
  used: number
  limit: number
  remaining: number
  usedPercent: number
  remainingPercent: number
  resetAt?: string
  kind: 'subscription' | 'bonus' | 'addon'
  /**
   * True when the provider reports no usable bound for this row — Kiro's
   * no-limit sentinel or an absent limit. Percentages are meaningless for such
   * a row and are published as zero, so surfaces must branch on this flag
   * instead of rendering a fabricated ceiling.
   */
  unlimited?: boolean
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

/**
 * Build one usage row, treating an absent or sentinel limit as unbounded.
 * @param id - stable row identifier.
 * @param label - display label.
 * @param used - amount consumed.
 * @param limit - reported bound, possibly Kiro's no-limit sentinel.
 * @param resetAt - when the bound resets or the grant expires.
 * @param kind - which balance this row describes.
 * @returns the normalized row.
 */
function row(
  id: string,
  label: string,
  used: number,
  limit: number,
  resetAt: string | undefined,
  kind: KiroUsageRow['kind'],
): KiroUsageRow {
  const bounded = limit > 0 && limit < NO_LIMIT_SENTINEL
  const remaining = bounded ? Math.max(0, limit - used) : 0
  return {
    id,
    label,
    used,
    limit,
    remaining,
    usedPercent: bounded ? percentage(used / limit * 100) : 0,
    remainingPercent: bounded ? percentage(remaining / limit * 100) : 0,
    ...resetAt === undefined ? {} : { resetAt },
    kind,
    ...bounded ? {} : { unlimited: true },
  }
}

/** Slug one label into a stable row-id fragment. */
function slug(value: string, fallback: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  return cleaned.length === 0 ? fallback : cleaned
}

/**
 * Normalize the public quota response without retaining account identity fields.
 *
 * Every structure the installed Kiro client reads is covered: subscription
 * breakdowns, the welcome trial (only while the provider calls it `ACTIVE`),
 * named bonus grants, and purchased overage credit packs. Unknown or unbounded
 * limits are marked, never converted into a percentage.
 * @param value - the decoded GetUsageLimits response.
 * @param now - current epoch milliseconds, injectable for tests.
 * @returns the normalized usage snapshot.
 */
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
    const prefix = resourceType.toLowerCase()
    const label = text(item.displayNamePlural) ?? text(item.displayName) ?? resourceType
    rows.push(row(
      prefix,
      label,
      numeric(item.currentUsageWithPrecision, item.currentUsage),
      numeric(item.usageLimitWithPrecision, item.usageLimit),
      resetAt,
      'subscription',
    ))
    const trial = record(item.freeTrialInfo)
    // An unexpired trial is not necessarily a usable one: the provider's own
    // client requires the active state, so a paused or pending trial is not
    // presented as available balance.
    if (trial !== undefined && text(trial.freeTrialStatus) === 'ACTIVE') {
      rows.push(row(
        `${prefix}-welcome-bonus`,
        'Welcome bonus',
        numeric(trial.currentUsageWithPrecision, trial.currentUsage),
        numeric(trial.usageLimitWithPrecision, trial.usageLimit),
        timestamp(trial.freeTrialExpiry) ?? resetAt,
        'bonus',
      ))
    }
    if (Array.isArray(item.bonuses)) {
      for (const [index, rawBonus] of item.bonuses.entries()) {
        const bonus = record(rawBonus)
        if (bonus === undefined) continue
        const status = text(bonus.status)
        if (status !== undefined && !DISPLAYABLE_BONUS_STATES.has(status)) continue
        const name = text(bonus.displayName) ?? 'Bonus'
        rows.push(row(
          `${prefix}-bonus-${slug(name, String(index + 1))}`,
          name,
          numeric(bonus.currentUsageWithPrecision, bonus.currentUsage),
          numeric(bonus.usageLimitWithPrecision, bonus.usageLimit),
          timestamp(bonus.expiresAt) ?? resetAt,
          'bonus',
        ))
      }
    }
    if (Array.isArray(item.overageCredits)) {
      for (const [index, rawPack] of item.overageCredits.entries()) {
        const pack = record(rawPack)
        if (pack === undefined) continue
        const expiresAt = timestamp(pack.expiresAt)
        // An expired pack carries no balance; keep undated packs, since the
        // provider omits the date for grants that do not expire.
        if (expiresAt !== undefined && Date.parse(expiresAt) <= now) continue
        rows.push(row(
          `${prefix}-addon-${index + 1}`,
          text(pack.displayName) ?? 'Add-on credits',
          numeric(pack.currentUsageWithPrecision, pack.currentUsage),
          numeric(pack.usageLimitWithPrecision, pack.usageLimit),
          expiresAt ?? resetAt,
          'addon',
        ))
      }
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
    return `${kiroServiceRegion(connection, token)}\u0000${connection.profileArn ?? token.profileArn ?? ''}\u0000${connection.proxyUrl ?? ''}`
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

    const region = kiroServiceRegion(connection, token)
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
