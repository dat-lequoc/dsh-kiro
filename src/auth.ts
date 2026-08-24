/**
 * Resolve a usable Kiro bearer token from managed or Kiro-owned credentials.
 *
 * Kiro's IDE sign-in writes `~/.aws/sso/cache/kiro-auth-token.json` (the
 * access and refresh tokens) plus a sibling `<clientIdHash>.json` (the OIDC
 * device-registration client id and secret). The two files are one credential:
 * refreshing requires the client pair that issued the refresh token, so a
 * token file naming a registration that is absent cannot be refreshed.
 *
 * Refreshed access tokens are cached in memory only. This avoids racing Kiro
 * IDE when its cache is the selected source, while the refresh token remains
 * sufficient to derive another access token after restart.
 *
 * @module dsh-kiro/auth
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { assertKiroRegion } from './region.ts'

/** Directory holding Kiro's SSO token and device-registration files. */
const SSO_CACHE_DIR = ['.aws', 'sso', 'cache']
/** File Kiro writes its access and refresh tokens to. */
const TOKEN_FILE = 'kiro-auth-token.json'
/** Region used when the token file names none. */
export const DEFAULT_REGION = 'us-east-1'

/**
 * Return Kiro IDE/CLI's shared SSO cache directory.
 * @returns an absolute directory below the current user's home.
 */
export function kiroCredentialDirectory(): string {
  return join(homedir(), ...SSO_CACHE_DIR)
}

/** Kiro's on-disk token file. */
interface TokenFile {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
  /** Basename of the sibling device-registration file holding the client pair. */
  clientIdHash?: string
  region?: string
}

/** Kiro's on-disk device-registration file. */
interface RegistrationFile {
  clientId?: string
  clientSecret?: string
}

/** The OIDC token endpoint's success body; field spelling varies by endpoint version. */
interface RefreshResponse {
  accessToken?: string
  access_token?: string
  expiresIn?: number
  expires_in?: number
}

/** One usable bearer token and the region whose endpoint accepts it. */
export interface KiroToken {
  /** Bearer value for the `authorization` header. */
  accessToken: string
  /** Region selecting the `q.<region>.amazonaws.com` endpoint. */
  region: string
  /** Epoch milliseconds after which this token stops being accepted. */
  expiresAt: number
}

/** Everything {@link resolveToken} needs, so tests can supply files and clock. */
export interface TokenSourceOptions {
  /** Directory holding the token and registration files; defaults to the user's SSO cache. */
  cacheDir?: string
  /** Refresh this many milliseconds before actual expiry. */
  expiryBufferMs: number
  /** HTTP transport for the refresh call, so a configured proxy applies to it too. */
  fetchJson: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>
}

/**
 * Read and parse one JSON file from the SSO cache.
 * @param path - absolute file path.
 * @param what - human name used in the failure message.
 * @returns the parsed contents.
 * @throws `LlmError('MISSING_CREDENTIAL')` when absent, `LlmError('INVALID_CREDENTIAL')` when unparsable.
 */
async function readJsonFile<T>(path: string, what: string): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LlmError(
        `Kiro ${what} not found at ${path}; sign in with the Kiro IDE or kiro-cli first`,
        'MISSING_CREDENTIAL',
        { cause: error },
      )
    }
    throw new LlmError(`Kiro ${what} at ${path} could not be read`, 'INVALID_CREDENTIAL', { cause: error })
  }
  try {
    return JSON.parse(text) as T
  } catch (error: unknown) {
    throw new LlmError(`Kiro ${what} at ${path} is not valid JSON`, 'INVALID_CREDENTIAL', { cause: error })
  }
}

/** Last refreshed token per credential source, reused until it approaches expiry. */
const cached = new Map<string, KiroToken>()

/** Discard the cached access token; tests and credential rotation start clean. */
export function clearTokenCache(): void {
  cached.clear()
}

/**
 * Exchange the stored refresh token for a fresh access token.
 * @param refreshToken - the stored refresh token.
 * @param registration - the client pair that issued it.
 * @param region - OIDC region.
 * @param options - transport and clock configuration.
 * @returns the fresh token.
 * @throws `LlmError('AUTH')` when the endpoint refuses the grant.
 */
async function refresh(
  refreshToken: string,
  registration: RegistrationFile,
  region: string,
  options: TokenSourceOptions,
): Promise<KiroToken> {
  if (registration.clientId === undefined || registration.clientSecret === undefined) {
    throw new LlmError(
      'Kiro device registration is missing its client id or secret; sign in again',
      'INVALID_CREDENTIAL',
    )
  }
  const { status, body } = await options.fetchJson(`https://oidc.${region}.amazonaws.com/token`, {
    refreshToken,
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    grantType: 'refresh_token',
  })
  if (status !== 200) {
    const detail = typeof body === 'object' && body !== null && 'error_description' in body
      ? String((body as { error_description: unknown }).error_description)
      : `HTTP ${status}`
    throw new LlmError(`Kiro token refresh failed: ${detail}`, 'AUTH', { status })
  }
  const parsed = body as RefreshResponse
  const accessToken = parsed.accessToken ?? parsed.access_token
  if (accessToken === undefined || accessToken.length === 0) {
    throw new LlmError('Kiro token refresh returned no access token', 'AUTH', { status })
  }
  const lifetimeSeconds = parsed.expiresIn ?? parsed.expires_in ?? 3600
  return { accessToken, region, expiresAt: Date.now() + lifetimeSeconds * 1000 }
}

/**
 * Resolve a bearer token that is valid now.
 *
 * The in-memory token is preferred, then the token Kiro has on disk, and only
 * a request that finds neither usable spends an OIDC refresh — so a session
 * running beside the Kiro IDE normally reuses the IDE's own fresh token.
 * @param options - file location, expiry buffer, and refresh transport.
 * @returns a token whose remaining lifetime exceeds the configured buffer.
 * @throws `LlmError` with `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, or `AUTH`.
 */
export async function resolveToken(options: TokenSourceOptions): Promise<KiroToken> {
  const now = Date.now()
  const directory = options.cacheDir ?? kiroCredentialDirectory()
  const cachedToken = cached.get(directory)
  if (cachedToken !== undefined && now < cachedToken.expiresAt - options.expiryBufferMs) return cachedToken
  const token = await readJsonFile<TokenFile>(join(directory, TOKEN_FILE), 'token file')
  let region: string
  try {
    region = assertKiroRegion(token.region ?? DEFAULT_REGION)
  } catch (error: unknown) {
    throw new LlmError('Kiro token file contains an invalid AWS region', 'INVALID_CREDENTIAL', { cause: error })
  }
  const fileExpiry = token.expiresAt === undefined ? 0 : Date.parse(token.expiresAt)
  if (token.accessToken !== undefined
    && Number.isFinite(fileExpiry)
    && now < fileExpiry - options.expiryBufferMs) {
    return { accessToken: token.accessToken, region, expiresAt: fileExpiry }
  }

  if (token.refreshToken === undefined || token.clientIdHash === undefined) {
    throw new LlmError(
      'Kiro token file has expired and carries no refresh token or client registration; sign in again',
      'INVALID_CREDENTIAL',
    )
  }
  const registration = await readJsonFile<RegistrationFile>(
    join(directory, `${token.clientIdHash}.json`),
    'device registration',
  )
  const refreshed = await refresh(token.refreshToken, registration, region, options)
  cached.set(directory, refreshed)
  return refreshed
}

/**
 * Resolve the first present credential source in priority order.
 * @param directories - managed directory first, Kiro IDE/CLI cache second.
 * @param options - token refresh configuration shared by every source.
 * @returns a usable token from the first existing source.
 */
export async function resolveTokenFromDirectories(
  directories: readonly string[],
  options: Omit<TokenSourceOptions, 'cacheDir'>,
): Promise<KiroToken> {
  const unique = [...new Set(directories)]
  let lastMissing: unknown
  for (const cacheDir of unique) {
    try {
      return await resolveToken({ ...options, cacheDir })
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'MISSING_CREDENTIAL') throw error
      lastMissing = error
    }
  }
  if (lastMissing !== undefined) throw lastMissing
  throw new LlmError('No Kiro credential sources were configured', 'MISSING_CREDENTIAL')
}
