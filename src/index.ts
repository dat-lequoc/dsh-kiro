/**
 * Register a {@link KiroAdapter} for the `kiro` provider route on `ctx.llm`,
 * with connection facts resolved per request instead of frozen at load: the
 * plugin layers its `cordis.yml` entry config under the optional `llm-kiro`
 * user-settings section (`ctx.settings`), so a changed proxy, profile, or
 * catalog reaches the very next request without restarting anything, while an
 * in-flight stream keeps the facts it started with. The one
 * registration-captured fact — the retry policy — re-registers the route in
 * place when it changes.
 *
 * Credentials are not configured here. Builder ID login writes a DSH-owned
 * credential directory; when absent, Kiro IDE/CLI's SSO cache is the fallback.
 *
 * @module dsh-kiro
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  KiroAdapter,
} from './adapter.ts'
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from './auth.ts'
import { discoverKiroProfileArn, KiroModelDiscovery } from './discovery.ts'
import { credentialDirectory } from './paths.ts'
import { FileModelSettingsStore } from './model-settings.ts'
import { assertKiroProfileArn } from './profile.ts'
import { assertKiroRegion } from './region.ts'
import { parseProxyUrl, postForm, postJson } from './transport.ts'
import { registerWebApi } from './web.ts'
import { KiroUsageService } from './usage.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  KiroAdapter,
  httpErrorCode,
} from './adapter.ts'
export type { KiroAdapterOptions, KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
export {
  clearTokenCache,
  DEFAULT_REGION,
  kiroCredentialDirectory,
  resolveToken,
  resolveTokenFromDirectories,
} from './auth.ts'
export type { KiroToken, TokenSourceOptions } from './auth.ts'
export type { DirectoryTokenSourceOptions, KiroAuthMethod } from './auth.ts'
export {
  discoverKiroProfileArn,
  KiroModelDiscovery,
  modelPageToken,
  modelSupportsThinking,
  parseAvailableModels,
  parseEffortSchema,
  parseMaxTokensBounds,
} from './discovery.ts'
export {
  compareKiroModels,
  FileModelSettingsStore,
  modelSelection,
  modelSettingsPath,
} from './model-settings.ts'
export type { KiroModelSettings } from './model-settings.ts'
export { assertMicrosoftTokenEndpoint, normalizeExternalIdpCredentials } from './external-idp.ts'
export {
  BUILDER_START_URL,
  credentialSummary,
  deleteDeviceCredentials,
  importApiKey,
  importExternalIdp,
  importRefreshToken,
  pollDeviceLogin,
  pollSocialDeviceLogin,
  resolveRefreshTokenOrigin,
  saveDeviceCredentials,
  saveManagedCredentials,
  startDeviceLogin,
  startSocialDeviceLogin,
} from './login.ts'
export type {
  DeviceCredentials,
  DeviceLoginOptions,
  DeviceLoginPoll,
  DeviceLoginSession,
  ManagedCredentials,
  RefreshTokenOrigin,
  SocialDeviceLoginPoll,
  SocialDeviceLoginSession,
} from './login.ts'
export { credentialDirectory } from './paths.ts'
export { assertKiroProfileArn, profileRegion } from './profile.ts'
export { assertKiroRegion } from './region.ts'
export { getJson, parseProxyUrl, postForm, postJson, postJsonWithHeaders } from './transport.ts'
export { KiroUsageService, parseKiroUsage } from './usage.ts'
export type { KiroUsage, KiroUsageRow, KiroUsageServiceOptions } from './usage.ts'
export { buildModelRequestFields } from './serialize.ts'
export type { ModelLimits, RequestDefaults } from './serialize.ts'
export type * from './types.ts'

export const name = 'dsh-kiro'
export const inject = ['llm']

const NS = settingsNamespace('llm-kiro')
/** The single provider route this plugin owns. */
const PROVIDER = 'kiro'
/** Refresh a token this long before its actual expiry. */
const DEFAULT_TOKEN_EXPIRY_BUFFER_MS = 300_000

/** Long-context Claude variants Kiro publishes with a 1M window. */
const CONTEXT_1M = 1_000_000

/**
 * Models this account tier reaches, each verified against the live service.
 * Claude entries need authorized egress; the open-weight entries answer from
 * any. `minimax-m2.1` is absent because the service reports it temporarily
 * unavailable, and the `-1m` variants of Sonnet 4.5, Sonnet 5, and Opus 4.8
 * are absent because it refuses them as unknown ids — an unlisted id still
 * passes through, so a tier that serves them needs no code change.
 */
const DEFAULT_MODELS: KiroCatalogModel[] = [
  { id: 'auto', name: 'Auto', thinking: false },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', thinking: false },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', thinking: true },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-sonnet-4.6-1m', name: 'Claude Sonnet 4.6 (1M)', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', thinking: true },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-opus-4.6-1m', name: 'Claude Opus 4.6 (1M)', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: CONTEXT_1M, thinking: true },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', thinking: false },
  { id: 'deepseek-3.2', name: 'DeepSeek 3.2', thinking: true },
  { id: 'glm-5', name: 'GLM-5', thinking: true },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', thinking: true },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', thinking: false },
]

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-kiro` settings-section shape. Every field is optional in yml: an
 * absent Kiro sign-in fails at the first request with `MISSING_CREDENTIAL`
 * rather than at plugin load, and an omitted region follows the token file.
 */
export interface Config {
  /**
   * Proxy egress for every Kiro request as `scheme://[user:pass@]host:port`
   * (`http://` or `https://`). Kiro authorizes Claude models by request
   * egress: a deployment whose own egress is unauthorized reaches the
   * `claude-*` models only through a permitted proxy, while the open-weight
   * models answer without one. An invalid value fails plugin loading.
   */
  proxyUrl?: string
  /** Region selecting the endpoint; omitted follows the signed-in token file. */
  region?: string
  /** CodeWhisperer profile ARN; omitted uses the account default. */
  profileArn?: string
  /** Deployment thinking policy; `disabled` suppresses model reasoning. */
  thinking?: 'enabled' | 'disabled'
  /** Optional provider-wide override; omission follows each model's live default. */
  reasoningEffort?: 'none' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Positive context capacity used when the selected model has no exact value (default 200,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to the verified account tier. */
  models?: KiroCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Refresh the access token this long before expiry (default five minutes). */
  tokenExpiryBufferMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<KiroCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  thinking: z.boolean(),
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string(),
  effortSchemaPath: z.union(['output_config', 'reasoning']),
  maxTokensBounds: z.object({
    minimum: z.number().step(1).min(1),
    maximum: z.number().step(1).min(1),
  }),
})

export const Config: z<Config> = z.object({
  proxyUrl: z.string(),
  region: z.string(),
  profileArn: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max']),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  tokenExpiryBufferMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TOKEN_EXPIRY_BUFFER_MS),
  retryPolicy: RetryPolicySchema,
})

/**
 * One resolution's complete request facts. Connection, proxy, and token-policy
 * facts are one value on purpose: a snapshot the resolver rejects keeps the
 * whole previous generation, so a request can never pair a stale endpoint with
 * a newer egress.
 */
export type ResolvedKiroOptions = KiroConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly KiroCatalogModel[] | undefined): KiroCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    // Schemastery materializes an omitted optional array as `[]`; normalize it
    // back to absence so legacy/fallback catalog rows remain valid.
    const reasoningEfforts = model.reasoningEfforts?.length === 0
      ? undefined
      : model.reasoningEfforts
    if (model.id.length === 0) throw new Error('llm-kiro: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-kiro: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-kiro: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-kiro: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (reasoningEfforts !== undefined
      && (reasoningEfforts.some(effort => effort.length === 0)
        || new Set(reasoningEfforts).size !== reasoningEfforts.length)) {
      throw new Error(`llm-kiro: catalog model "${model.id}" reasoningEfforts must be unique non-empty ids`)
    }
    if (model.defaultReasoningEffort !== undefined
      && !reasoningEfforts?.includes(model.defaultReasoningEffort)) {
      throw new Error(`llm-kiro: catalog model "${model.id}" default reasoning effort is not advertised`)
    }
    if ((model.effortSchemaPath === undefined) !== (reasoningEfforts === undefined)) {
      throw new Error(`llm-kiro: catalog model "${model.id}" needs both reasoningEfforts and effortSchemaPath`)
    }
    // Schemastery materializes an omitted optional object as `{}`; a bound pair
    // is only usable when both ends are present and ordered.
    const bounds = model.maxTokensBounds
    const maxTokensBounds = bounds === undefined
      || bounds.minimum === undefined
      || bounds.maximum === undefined
      ? undefined
      : bounds
    if (maxTokensBounds !== undefined
      && (!Number.isInteger(maxTokensBounds.minimum)
        || !Number.isInteger(maxTokensBounds.maximum)
        || maxTokensBounds.minimum < 1
        || maxTokensBounds.maximum < maxTokensBounds.minimum)) {
      throw new Error(
        `llm-kiro: catalog model "${model.id}" maxTokensBounds must be ordered positive integers`,
      )
    }
    if (maxTokensBounds !== undefined && model.effortSchemaPath === undefined) {
      // The bounds come from the same live schema as the effort branch, and the
      // whole member is refused by a model that advertises no schema.
      throw new Error(
        `llm-kiro: catalog model "${model.id}" maxTokensBounds requires the live request-field schema`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-kiro: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.thinking === undefined ? {} : { thinking: model.thinking },
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts: [...reasoningEfforts] },
      ...model.defaultReasoningEffort === undefined
        ? {}
        : { defaultReasoningEffort: model.defaultReasoningEffort },
      ...model.effortSchemaPath === undefined ? {} : { effortSchemaPath: model.effortSchemaPath },
      ...maxTokensBounds === undefined ? {} : { maxTokensBounds: { ...maxTokensBounds } },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load
 * (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 * @throws when a field is present but unusable (a malformed proxy URL, a
 *   duplicate catalog id, an out-of-range timeout).
 */
export function resolveAdapterOptions(config: Config): ResolvedKiroOptions {
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off'
    && config.reasoningEffort !== 'none') {
    throw new Error('llm-kiro: only reasoningEffort "off" or "none" can be configured when thinking is disabled')
  }
  if (config.proxyUrl !== undefined) parseProxyUrl(config.proxyUrl)
  const region = config.region === undefined ? undefined : assertKiroRegion(config.region)
  const profileArn = config.profileArn === undefined ? undefined : assertKiroProfileArn(config.profileArn)
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-kiro: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-kiro: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const tokenExpiryBufferMs = config.tokenExpiryBufferMs ?? DEFAULT_TOKEN_EXPIRY_BUFFER_MS
  if (!Number.isFinite(tokenExpiryBufferMs)
    || tokenExpiryBufferMs < 0
    || tokenExpiryBufferMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-kiro: tokenExpiryBufferMs must be a non-negative finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    ...config.proxyUrl === undefined ? {} : { proxyUrl: config.proxyUrl },
    ...region === undefined ? {} : { region },
    ...profileArn === undefined ? {} : { profileArn },
    defaults: {
      thinking: config.thinking,
      ...config.thinking === 'disabled'
        ? { reasoningEffort: config.reasoningEffort ?? 'off' }
        : config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    },
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    tokenExpiryBufferMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-kiro: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedKiroOptions | undefined
  const options = (): ResolvedKiroOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-kiro: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const managedDirectory = credentialDirectory()
  const tokenResolver = (connection: KiroConnectionOptions, signal: AbortSignal) =>
    resolveTokenFromDirectories([
      managedDirectory,
      kiroCredentialDirectory(),
    ], {
      expiryBufferMs: connection.tokenExpiryBufferMs,
      fetchJson: (url, body) => postJson(url, body, connection.proxyUrl, signal),
      fetchForm: (url, body) => postForm(url, body, connection.proxyUrl, signal),
      ...connection.profileArn === undefined
        ? { resolveProfileArn: (accessToken, region, authMethod) => discoverKiroProfileArn(
          connection,
          { accessToken, region, authMethod, expiresAt: Date.now() + 60_000 },
          signal,
        ) }
        : {},
      writableDirectories: [managedDirectory],
    })
  const discovery = new KiroModelDiscovery({ resolveToken: tokenResolver })
  const modelSettings = new FileModelSettingsStore()
  const usage = new KiroUsageService({ resolveToken: tokenResolver })
  const adapter = new KiroAdapter({
    options,
    resolveToken: tokenResolver,
    discoverModels: async (connection, signal) => {
      try {
        const models = await discovery.list(connection, signal)
        await modelSettings.mergeCatalog(models)
        return models
      } catch (error: unknown) {
        ctx.logger.warn('dsh-kiro: live model discovery failed; using the configured catalog')
        ctx.logger.warn(error)
        return connection.models
      }
    },
    currentModels: connection => discovery.current(connection),
    selectModels: models => modelSettings.enabledModels(models),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Kiro', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section, with no window where the route is absent.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
  registerWebApi(ctx, {
    managedDirectory,
    options,
    discovery,
    modelSettings,
    usage,
    resolveToken: tokenResolver,
  })
}
