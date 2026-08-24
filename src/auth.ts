/** Resolve, refresh, and normalize every Kiro credential shape supported by the plugin. */

import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { assertMicrosoftTokenEndpoint } from './external-idp.ts'
import { assertKiroProfileArn } from './profile.ts'
import { assertKiroRegion } from './region.ts'

const SSO_CACHE_DIR = ['.aws', 'sso', 'cache']
const TOKEN_FILE = 'kiro-auth-token.json'
const SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'
const NON_EXPIRING = Number.MAX_SAFE_INTEGER
export const DEFAULT_REGION = 'us-east-1'

/** Authentication variants compatible with Kiro and 9Router credential records. */
export type KiroAuthMethod =
  | 'builder-id'
  | 'idc'
  | 'google'
  | 'github'
  | 'imported'
  | 'api_key'
  | 'external_idp'

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

function inferAuthMethod(value: unknown, source: Record<string, unknown>): KiroAuthMethod {
  if (value === 'builder-id' || value === 'idc' || value === 'google' || value === 'github'
    || value === 'imported' || value === 'api_key' || value === 'external_idp') return value
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
  } else if (token.authMethod === 'imported' || token.authMethod === 'google' || token.authMethod === 'github') {
    response = await options.fetchJson(SOCIAL_REFRESH_URL, { refreshToken })
  } else {
    throw new LlmError('Kiro credential cannot be refreshed without its client registration', 'INVALID_CREDENTIAL')
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

async function persist(
  directory: string,
  source: TokenFile,
  token: KiroToken,
  refreshToken: string | undefined,
): Promise<void> {
  await atomicTokenFile(directory, {
    ...source.raw,
    accessToken: token.accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: new Date(token.expiresAt).toISOString(),
    region: token.region,
    authMethod: token.authMethod,
    ...token.profileArn === undefined ? {} : { profileArn: token.profileArn },
  })
}

async function withProfile(
  result: KiroToken,
  source: TokenFile,
  directory: string,
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
  cached.set(directory, enriched)
  if (options.persistRefresh === true) await persist(directory, source, enriched, refreshToken ?? source.refreshToken)
  return enriched
}

/** Resolve a currently usable token from one credential directory. */
export async function resolveToken(options: TokenSourceOptions): Promise<KiroToken> {
  const now = Date.now()
  const directory = options.cacheDir ?? kiroCredentialDirectory()
  const cachedToken = cached.get(directory)
  if (cachedToken !== undefined && now < cachedToken.expiresAt - options.expiryBufferMs) return cachedToken
  const source = normalizeTokenFile(await readJsonFile(join(directory, TOKEN_FILE), 'token file'))
  let region: string
  try {
    region = assertKiroRegion(source.region ?? DEFAULT_REGION)
  } catch (error: unknown) {
    throw new LlmError('Kiro token file contains an invalid AWS region', 'INVALID_CREDENTIAL', { cause: error })
  }
  let profileArn: string | undefined
  try {
    profileArn = source.profileArn === undefined ? undefined : assertKiroProfileArn(source.profileArn)
  } catch (error: unknown) {
    throw new LlmError('Kiro token file contains an invalid profile ARN', 'INVALID_CREDENTIAL', { cause: error })
  }
  const fileExpiry = source.authMethod === 'api_key'
    ? NON_EXPIRING
    : source.expiresAt === undefined ? 0 : Date.parse(source.expiresAt)
  if (source.accessToken !== undefined && Number.isFinite(fileExpiry) && now < fileExpiry - options.expiryBufferMs) {
    const current: KiroToken = {
      accessToken: source.accessToken,
      region,
      expiresAt: fileExpiry,
      authMethod: source.authMethod,
      ...profileArn === undefined ? {} : { profileArn },
    }
    const result = await withProfile(current, source, directory, options)
    cached.set(directory, result)
    return result
  }
  const refreshed = await refresh(source, directory, region, options)
  let result = refreshed.token
  if (options.persistRefresh === true) await persist(directory, source, result, refreshed.refreshToken)
  result = await withProfile(result, source, directory, options, refreshed.refreshToken)
  cached.set(directory, result)
  return result
}

/** Resolve the first present source, preferring DSH-managed credentials over Kiro's cache. */
export async function resolveTokenFromDirectories(
  directories: readonly string[],
  options: DirectoryTokenSourceOptions,
): Promise<KiroToken> {
  const unique = [...new Set(directories)]
  const writable = new Set(options.writableDirectories ?? [])
  let lastMissing: unknown
  for (const cacheDir of unique) {
    try {
      return await resolveToken({
        ...options,
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
