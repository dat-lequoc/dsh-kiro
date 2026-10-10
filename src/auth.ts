/** Resolve, refresh, and normalize every Kiro credential shape supported by the plugin. */

import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { KiroAccountStore } from './accounts.ts'
import { assertMicrosoftTokenEndpoint } from './external-idp.ts'
import { assertKiroProfileArn } from './profile.ts'
import { assertKiroRegion } from './region.ts'

const SSO_CACHE_DIR = ['.aws', 'sso', 'cache']
const TOKEN_FILE = 'kiro-auth-token.json'
const SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'
const NON_EXPIRING = Number.MAX_SAFE_INTEGER
export const DEFAULT_REGION = 'us-east-1'

/**
 * Authentication variants compatible with Kiro and 9Router credential records.
 *
 * `social` is Kiro IDE/CLI's own spelling for a Google or GitHub sign-in. It
 * matters because a fresh install has no plugin-owned credential and falls back
 * to Kiro's SSO cache, where this is the value on disk.
 */
export type KiroAuthMethod =
  | 'builder-id'
  | 'idc'
  | 'google'
  | 'github'
  | 'social'
  | 'imported'
  | 'api_key'
  | 'external_idp'

/**
 * Methods whose refresh needs nothing but the refresh token, because Kiro's own
 * desktop auth service issues them. Kiro refreshes its `social` tokens exactly
 * this way, with no client registration involved.
 */
const KIRO_SERVICE_METHODS = new Set<KiroAuthMethod>(['imported', 'google', 'github', 'social'])

/** Directory holding Kiro IDE/CLI's shared SSO cache. */
export function kiroCredentialDirectory(): string {
  return join(homedir(), ...SSO_CACHE_DIR)
}

interface TokenFile {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
  clientIdHash?: string
  clientId?: string
  tokenEndpoint?: string
  scope?: string
  region?: string
  profileArn?: string
  authMethod: KiroAuthMethod
  startUrl?: string
  raw: Record<string, unknown>
}

interface RegistrationFile {
  clientId?: string
  clientSecret?: string
}

interface RefreshResponse {
  accessToken?: string
  access_token?: string
  refreshToken?: string
  refresh_token?: string
  expiresIn?: number
  expires_in?: number
  profileArn?: string
  profile_arn?: string
}

/** One usable credential and its request-routing metadata. */
export interface KiroToken {
  accessToken: string
  region: string
  expiresAt: number
  authMethod: KiroAuthMethod
  profileArn?: string
}

/** Everything token resolution needs, including injectable transports for tests and proxies. */
export interface TokenSourceOptions {
  cacheDir?: string
  expiryBufferMs: number
  fetchJson: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>
  fetchForm?: (url: string, body: URLSearchParams) => Promise<{ status: number; body: unknown }>
  resolveProfileArn?: (accessToken: string, region: string, authMethod: KiroAuthMethod) => Promise<string | undefined>
  /** Persist rotated managed tokens; never enable this for Kiro IDE-owned cache files. */
  persistRefresh?: boolean
}

export interface DirectoryTokenSourceOptions extends Omit<TokenSourceOptions, 'cacheDir' | 'persistRefresh'> {
  writableDirectories?: readonly string[]
}

/**
 * One credential location a resolve may read, and refresh into when this
 * plugin owns it.
 */
interface TokenSource {
  /** Token-cache key: one resolved token per account, not per directory. */
  key: string
  /** Directory holding this credential device registration, when it needs one. */
  directory: string
  /** Read the raw credential record. */
  read: () => Promise<Record<string, unknown>>
  /** Persist a refreshed record; absent for a credential this plugin does not own. */
  write?: (next: Record<string, unknown>) => Promise<void>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Classify one credential file's authentication method.
 *
 * Two vocabularies land here: this plugin's own, and Kiro IDE/CLI's, which is
 * what a fresh install reads from the shared SSO cache. Kiro writes `social`,
 * `IdC`, and `external_idp` — the same three its own refresher switches on — so
 * those are recognized rather than guessed at, because the guess decides both
 * the refresh endpoint and the upstream request surface.
 * @param value - the file's recorded method, if any.
 * @param source - the whole credential record, for provenance fallbacks.
 * @returns the normalized method.
 */
function inferAuthMethod(value: unknown, source: Record<string, unknown>): KiroAuthMethod {
  if (value === 'builder-id' || value === 'idc' || value === 'google' || value === 'github'
    || value === 'social' || value === 'imported' || value === 'api_key'
    || value === 'external_idp') return value
  // Kiro's own spellings, compared case-insensitively: `IdC` is its Identity
  // Center value, and treating it as Builder ID would pick the wrong endpoint.
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'idc') return 'idc'
    if (normalized === 'social') return 'social'
    if (normalized === 'builderid' || normalized === 'builder_id') return 'builder-id'
    if (normalized === 'apikey' || normalized === 'api-key') return 'api_key'
    if (normalized === 'externalidp' || normalized === 'external-idp') return 'external_idp'
  }
  if (source.tokenEndpoint !== undefined || source.token_endpoint !== undefined) return 'external_idp'
  if (source.tokenType === 'API_KEY' || source.token_type === 'API_KEY') return 'api_key'
  const configuredStartUrl = text(source.startUrl ?? source.start_url)
  if (source.clientIdHash !== undefined || source.client_id_hash !== undefined) {
    return configuredStartUrl === undefined || configuredStartUrl === 'https://view.awsapps.com/start'
      ? 'builder-id'
      : 'idc'
  }
  if (configuredStartUrl !== undefined && configuredStartUrl !== 'https://view.awsapps.com/start') return 'idc'
  return 'builder-id'
}

/**
 * Normalize any credential record's recorded method into the vocabulary this
 * adapter acts on. Exported so surfaces report the method that actually decides
 * refresh and endpoint selection, instead of the raw string on disk.
 * @param value - the file's recorded method, if any.
 * @param source - the whole credential record, for provenance fallbacks.
 * @returns the normalized method.
 */
export function kiroAuthMethod(
  value: unknown,
  source: Record<string, unknown> = {},
): KiroAuthMethod {
  return inferAuthMethod(value, source)
}

function normalizeTokenFile(value: unknown): TokenFile {
  const source = record(value)
  if (source === undefined) throw new LlmError('Kiro token file is not a JSON object', 'INVALID_CREDENTIAL')
  const accessToken = text(source.accessToken ?? source.access_token)
  const refreshToken = text(source.refreshToken ?? source.refresh_token)
  const expiresAt = text(source.expiresAt ?? source.expires_at ?? source.expired)
  const clientIdHash = text(source.clientIdHash ?? source.client_id_hash)
  const clientId = text(source.clientId ?? source.client_id)
  const tokenEndpoint = text(source.tokenEndpoint ?? source.token_endpoint)
  const scope = Array.isArray(source.scopes)
      ? source.scopes.map(text).filter(item => item !== undefined).join(' ')
      : text(source.scope ?? source.scopes)
  const region = text(source.region)
  const profileArn = text(source.profileArn ?? source.profile_arn)
  const startUrl = text(source.startUrl ?? source.start_url)
  return {
    ...accessToken === undefined ? {} : { accessToken },
    ...refreshToken === undefined ? {} : { refreshToken },
    ...expiresAt === undefined ? {} : { expiresAt },
    ...clientIdHash === undefined ? {} : { clientIdHash },
    ...clientId === undefined ? {} : { clientId },
    ...tokenEndpoint === undefined ? {} : { tokenEndpoint },
    ...scope === undefined || scope.length === 0 ? {} : { scope },
    ...region === undefined ? {} : { region },
    ...profileArn === undefined ? {} : { profileArn },
    authMethod: inferAuthMethod(source.authMethod ?? source.auth_method, source),
    ...startUrl === undefined ? {} : { startUrl },
    raw: source,
  }
}

async function readJsonFile(path: string, what: string): Promise<unknown> {
  let value: string
  try {
    value = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LlmError(`Kiro ${what} not found at ${path}`, 'MISSING_CREDENTIAL', { cause: error })
    }
    throw new LlmError(`Kiro ${what} at ${path} could not be read`, 'INVALID_CREDENTIAL', { cause: error })
  }
  try {
    return JSON.parse(value) as unknown
  } catch (error: unknown) {
    throw new LlmError(`Kiro ${what} at ${path} is not valid JSON`, 'INVALID_CREDENTIAL', { cause: error })
  }
}

const cached = new Map<string, KiroToken>()

export function clearTokenCache(): void {
  cached.clear()
}

function refreshDetail(body: unknown, status: number): string {
  const value = record(body)
  return text(value?.error_description ?? value?.errorDescription ?? value?.message ?? value?.error)
    ?? `HTTP ${status}`
}

function parseRefresh(body: unknown, fallbackRefreshToken: string): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  profileArn?: string
} {
  const value = record(body) as RefreshResponse | undefined
  const accessToken = text(value?.accessToken ?? value?.access_token)
  if (accessToken === undefined) throw new LlmError('Kiro token refresh returned no access token', 'AUTH')
  const lifetime = Math.max(1, numeric(value?.expiresIn ?? value?.expires_in) ?? 3600)
  const rawProfile = text(value?.profileArn ?? value?.profile_arn)
  return {
    accessToken,
    refreshToken: text(value?.refreshToken ?? value?.refresh_token) ?? fallbackRefreshToken,
    expiresAt: Date.now() + lifetime * 1000,
    ...rawProfile === undefined ? {} : { profileArn: assertKiroProfileArn(rawProfile) },
  }
}

async function registration(directory: string, hash: string): Promise<RegistrationFile> {
  const value = record(await readJsonFile(join(directory, `${hash}.json`), 'device registration'))
  const clientId = text(value?.clientId ?? value?.client_id)
  const clientSecret = text(value?.clientSecret ?? value?.client_secret)
  if (clientId === undefined || clientSecret === undefined) {
    throw new LlmError('Kiro device registration is missing its client id or secret', 'INVALID_CREDENTIAL')
  }
  return { clientId, clientSecret }
}

async function refresh(
  token: TokenFile,
  directory: string,
  region: string,
  options: TokenSourceOptions,
): Promise<{ token: KiroToken; refreshToken: string }> {
  const refreshToken = token.refreshToken
  if (refreshToken === undefined) {
    throw new LlmError('Kiro credential has expired and carries no refresh token', 'INVALID_CREDENTIAL')
  }
  let response: { status: number; body: unknown }
  if (token.authMethod === 'external_idp') {
    if (token.clientId === undefined || token.tokenEndpoint === undefined || token.scope === undefined) {
      throw new LlmError('Kiro external IdP credential is missing client, endpoint, or scopes', 'INVALID_CREDENTIAL')
    }
    if (options.fetchForm === undefined) {
      throw new LlmError('Kiro external IdP refresh transport is unavailable', 'INVALID_CREDENTIAL')
    }
    response = await options.fetchForm(
      assertMicrosoftTokenEndpoint(token.tokenEndpoint),
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: token.clientId,
        refresh_token: refreshToken,
        scope: token.scope,
      }),
    )
  } else if (token.clientIdHash !== undefined) {
    const client = await registration(directory, token.clientIdHash)
    response = await options.fetchJson(`https://oidc.${region}.amazonaws.com/token`, {
      refreshToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      grantType: 'refresh_token',
    })
  } else if (KIRO_SERVICE_METHODS.has(token.authMethod)) {
    // Kiro's desktop auth service issues these and refreshes them from the
    // refresh token alone; there is no client registration to look for.
    response = await options.fetchJson(SOCIAL_REFRESH_URL, { refreshToken })
  } else {
    throw new LlmError(
      `Kiro ${token.authMethod} credential cannot be refreshed without its client registration; `
      + 'sign in through the Kiro settings page to store a refreshable credential',
      'INVALID_CREDENTIAL',
    )
  }
  if (response.status !== 200) {
    throw new LlmError(`Kiro token refresh failed: ${refreshDetail(response.body, response.status)}`, 'AUTH', {
      status: response.status,
    })
  }
  const parsed = parseRefresh(response.body, refreshToken)
  const existingProfile = token.profileArn === undefined ? undefined : assertKiroProfileArn(token.profileArn)
  const refreshedProfile = parsed.profileArn ?? existingProfile
  return {
    refreshToken: parsed.refreshToken,
    token: {
      accessToken: parsed.accessToken,
      region,
      expiresAt: parsed.expiresAt,
      authMethod: token.authMethod,
      ...refreshedProfile === undefined ? {} : { profileArn: refreshedProfile },
    },
  }
}

async function atomicTokenFile(directory: string, value: Record<string, unknown>): Promise<void> {
  const path = join(directory, TOKEN_FILE)
  const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/**
 * The record a refreshed token writes back, preserving every other field the
 * credential arrived with.
 */
function credentialRecord(
  file: TokenFile,
  token: KiroToken,
  refreshToken: string | undefined,
): Record<string, unknown> {
  return {
    ...file.raw,
    accessToken: token.accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: new Date(token.expiresAt).toISOString(),
    region: token.region,
    authMethod: token.authMethod,
    ...token.profileArn === undefined ? {} : { profileArn: token.profileArn },
  }
}

async function withProfile(
  result: KiroToken,
  file: TokenFile,
  source: TokenSource,
  options: TokenSourceOptions,
  refreshToken?: string,
): Promise<KiroToken> {
  if (result.profileArn !== undefined || result.authMethod === 'api_key' || options.resolveProfileArn === undefined) {
    return result
  }
  let profileArn: string | undefined
  try {
    profileArn = await options.resolveProfileArn(result.accessToken, result.region, result.authMethod)
  } catch {
    return result
  }
  if (profileArn === undefined) return result
  const enriched = { ...result, profileArn: assertKiroProfileArn(profileArn) }
  cached.set(source.key, enriched)
  if (source.write !== undefined) {
    await source.write(credentialRecord(file, enriched, refreshToken ?? file.refreshToken))
  }
  return enriched
}

/** Resolve a usable token from one credential source, refreshing and persisting as needed. */
async function resolveFromSource(source: TokenSource, options: TokenSourceOptions): Promise<KiroToken> {
  const now = Date.now()
  const cachedToken = cached.get(source.key)
  if (cachedToken !== undefined && now < cachedToken.expiresAt - options.expiryBufferMs) return cachedToken
  const file = normalizeTokenFile(await source.read())
  let region: string
  try {
    region = assertKiroRegion(file.region ?? DEFAULT_REGION)
  } catch (error: unknown) {
    throw new LlmError('Kiro token file contains an invalid AWS region', 'INVALID_CREDENTIAL', { cause: error })
  }
  let profileArn: string | undefined
  try {
    profileArn = file.profileArn === undefined ? undefined : assertKiroProfileArn(file.profileArn)
  } catch (error: unknown) {
    throw new LlmError('Kiro token file contains an invalid profile ARN', 'INVALID_CREDENTIAL', { cause: error })
  }
  const fileExpiry = file.authMethod === 'api_key'
    ? NON_EXPIRING
    : file.expiresAt === undefined ? 0 : Date.parse(file.expiresAt)
  if (file.accessToken !== undefined && Number.isFinite(fileExpiry) && now < fileExpiry - options.expiryBufferMs) {
    const current: KiroToken = {
      accessToken: file.accessToken,
      region,
      expiresAt: fileExpiry,
      authMethod: file.authMethod,
      ...profileArn === undefined ? {} : { profileArn },
    }
    const result = await withProfile(current, file, source, options)
    cached.set(source.key, result)
    return result
  }
  const refreshed = await refresh(file, source.directory, region, options)
  let result = refreshed.token
  if (source.write !== undefined) await source.write(credentialRecord(file, result, refreshed.refreshToken))
  result = await withProfile(result, file, source, options, refreshed.refreshToken)
  cached.set(source.key, result)
  return result
}

/** Resolve a currently usable token from one credential directory. */
export async function resolveToken(options: TokenSourceOptions): Promise<KiroToken> {
  const directory = options.cacheDir ?? kiroCredentialDirectory()
  return resolveFromSource({
    key: directory,
    directory,
    read: async () => {
      const value = await readJsonFile(join(directory, TOKEN_FILE), 'token file')
      return value as Record<string, unknown>
    },
    ...options.persistRefresh === true
      ? { write: async (next: Record<string, unknown>) => { await atomicTokenFile(directory, next) } }
      : {},
  }, options)
}

/** Resolve the first present source, preferring DSH-managed credentials over Kiro's cache. */
export async function resolveTokenFromDirectories(
  directories: readonly string[],
  options: DirectoryTokenSourceOptions,
): Promise<KiroToken> {
  const unique = [...new Set(directories)]
  const writable = new Set(options.writableDirectories ?? [])
  const { writableDirectories: _writableDirectories, ...resolveOptions } = options
  let lastMissing: unknown
  for (const cacheDir of unique) {
    const store = new KiroAccountStore(cacheDir)
    // A written document is authoritative for its directory: an installation
    // whose accounts were all signed out must not silently fall back to the
    // single-file credential it migrated from.
    if (await store.exists()) {
      try {
        return await resolveTokenFromStore(store, resolveOptions)
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code !== 'MISSING_CREDENTIAL') throw error
        lastMissing = error
        continue
      }
    }
    try {
      return await resolveToken({
        ...resolveOptions,
        cacheDir,
        persistRefresh: writable.has(cacheDir),
      })
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'MISSING_CREDENTIAL') throw error
      lastMissing = error
    }
  }
  if (lastMissing !== undefined) throw lastMissing
  throw new LlmError('No Kiro credential sources were configured', 'MISSING_CREDENTIAL')
}

/**
 * Resolve a usable token for one stored account.
 * @param store - the multi-account store to read.
 * @param options - refresh transports and the profile expiry buffer.
 * @param accountId - the account to use; the active one when omitted.
 * @returns the token requests and discovery authenticate with.
 * @throws LlmError('MISSING_CREDENTIAL') when the store holds no such account.
 */
export async function resolveTokenFromStore(
  store: KiroAccountStore,
  options: Omit<TokenSourceOptions, 'cacheDir' | 'persistRefresh'>,
  accountId?: string,
): Promise<KiroToken> {
  const captured = await store.capture(accountId)
  if (captured === null) {
    throw new LlmError('Kiro has no signed-in account; add one in Settings, Kiro', 'MISSING_CREDENTIAL')
  }
  return resolveFromSource({
    key: store.directory + '\u0000' + captured.accountId,
    directory: store.directory,
    read: async () => {
      const credential = await captured.read()
      if (credential === undefined) {
        throw new LlmError('Kiro account ' + captured.accountId + ' is no longer stored', 'MISSING_CREDENTIAL')
      }
      return credential
    },
    // The refresh is written back into the account it came from, and a login
    // that landed meanwhile keeps its result instead of being overwritten.
    write: async (next: Record<string, unknown>) => {
      await captured.modify(() => next)
    },
  }, options)
}
