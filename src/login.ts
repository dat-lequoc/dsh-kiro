/** Multi-method Kiro login and DSH-owned credential persistence. */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clearTokenCache, kiroAuthMethod } from './auth.ts'
import type { KiroAuthMethod } from './auth.ts'
import { normalizeExternalIdpCredentials } from './external-idp.ts'
import { assertKiroProfileArn } from './profile.ts'
import { assertKiroRegion } from './region.ts'

const TOKEN_FILE = 'kiro-auth-token.json'
export const BUILDER_START_URL = 'https://view.awsapps.com/start'
const KIRO_ISSUER_URL = 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6'
const KIRO_AUTH_SERVICE = 'https://prod.us-east-1.auth.desktop.kiro.dev'
const SOCIAL_CLIENT_ID = 'kiro-cli'
const SOCIAL_DEVICE_AUTHORIZE_URL = `${KIRO_AUTH_SERVICE}/oauth/device/authorization`
const SOCIAL_DEVICE_POLL_URL = `${KIRO_AUTH_SERVICE}/oauth/device/poll`
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
]

export type LoginJsonTransport = (
  url: string,
  body: unknown,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>

export type LoginGetTransport = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>

export interface DeviceLoginOptions {
  authMethod?: 'builder-id' | 'idc'
  startUrl?: string
}

export interface DeviceLoginSession {
  clientId: string
  clientSecret: string
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresAt: number
  region: string
  authMethod: 'builder-id' | 'idc'
  startUrl: string
}

export type DeviceLoginPoll =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'completed'; credentials: ManagedCredentials }

export interface SocialDeviceLoginSession {
  provider: 'google' | 'github'
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresAt: number
}

export type SocialDeviceLoginPoll =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'completed'; credentials: ManagedCredentials }

export interface ManagedCredentials {
  accessToken: string
  refreshToken?: string
  expiresAt: string
  region: string
  authMethod: KiroAuthMethod
  profileArn?: string
  clientId?: string
  clientSecret?: string
  startUrl?: string
  tokenEndpoint?: string
  scope?: string
}

/** Backward-compatible name for device-flow credentials. */
export type DeviceCredentials = ManagedCredentials

export interface CredentialSummary {
  authenticated: boolean
  expiresAt?: string
  region?: string
  authMethod?: KiroAuthMethod
  profileArn?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: Record<string, unknown>, camel: string, snake?: string): string | undefined {
  const candidate = value[camel] ?? (snake === undefined ? undefined : value[snake])
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined
}

function numberField(value: Record<string, unknown>, camel: string, snake?: string): number | undefined {
  const candidate = value[camel] ?? (snake === undefined ? undefined : value[snake])
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function providerError(body: unknown, fallback: string): string {
  const value = record(body)
  if (value === undefined) return fallback
  return stringField(value, 'error_description')
    ?? stringField(value, 'errorDescription')
    ?? stringField(value, 'message')
    ?? stringField(value, 'error')
    ?? fallback
}

function startUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch (error: unknown) {
    throw new Error('Kiro IAM Identity Center start URL is invalid', { cause: error })
  }
  if (parsed.protocol !== 'https:'
    || !(parsed.hostname === 'view.awsapps.com' || parsed.hostname.endsWith('.awsapps.com'))
    || (parsed.pathname !== '/start' && parsed.pathname !== '/start/')) {
    throw new Error('Kiro IAM Identity Center start URL must be an https://*.awsapps.com/start URL')
  }
  return parsed.toString().replace(/\/$/u, '')
}

/**
 * Begin Kiro's coded device authorization for a free or IAM Identity Center account.
 */
export async function startDeviceLogin(
  region: string,
  requestJson: LoginJsonTransport,
  signal: AbortSignal,
  options: DeviceLoginOptions = {},
): Promise<DeviceLoginSession> {
  const selectedRegion = assertKiroRegion(region.trim() || 'us-east-1')
  const authMethod = options.authMethod === 'idc' ? 'idc' : 'builder-id'
  const selectedStartUrl = startUrl(authMethod === 'idc'
    ? options.startUrl ?? ''
    : BUILDER_START_URL)
  const oidcBase = `https://oidc.${selectedRegion}.amazonaws.com`
  const registration = await requestJson(`${oidcBase}/client/register`, {
    clientName: 'kiro-oauth-client',
    clientType: 'public',
    scopes: SCOPES,
    grantTypes: [DEVICE_GRANT, 'refresh_token'],
    issuerUrl: KIRO_ISSUER_URL,
  }, signal)
  if (registration.status !== 200) {
    throw new Error(`Kiro client registration failed: ${providerError(registration.body, `HTTP ${registration.status}`)}`)
  }
  const registered = record(registration.body)
  const clientId = registered === undefined ? undefined : stringField(registered, 'clientId', 'client_id')
  const clientSecret = registered === undefined ? undefined : stringField(registered, 'clientSecret', 'client_secret')
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error('Kiro client registration returned no client id or secret')
  }

  const authorization = await requestJson(`${oidcBase}/device_authorization`, {
    clientId,
    clientSecret,
    startUrl: selectedStartUrl,
  }, signal)
  if (authorization.status !== 200) {
    throw new Error(`Kiro device authorization failed: ${providerError(authorization.body, `HTTP ${authorization.status}`)}`)
  }
  const authorized = record(authorization.body)
  if (authorized === undefined) throw new Error('Kiro device authorization returned an invalid response')
  const deviceCode = stringField(authorized, 'deviceCode', 'device_code')
  const userCode = stringField(authorized, 'userCode', 'user_code')
  const verificationUri = stringField(authorized, 'verificationUriComplete', 'verification_uri_complete')
    ?? stringField(authorized, 'verificationUri', 'verification_uri')
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new Error('Kiro device authorization returned incomplete login details')
  }
  const verificationUrl = new URL(verificationUri)
  if (verificationUrl.protocol !== 'https:'
    || !(verificationUrl.hostname.endsWith('.amazonaws.com')
      || verificationUrl.hostname.endsWith('.awsapps.com')
      || verificationUrl.hostname.endsWith('.signin.aws'))) {
    throw new Error(`Kiro returned an unsafe verification URL host: ${verificationUrl.hostname}`)
  }
  const intervalSeconds = Math.max(1, numberField(authorized, 'interval') ?? 5)
  const expiresIn = Math.max(1, numberField(authorized, 'expiresIn', 'expires_in') ?? 600)
  return {
    clientId,
    clientSecret,
    deviceCode,
    userCode,
    verificationUri: verificationUrl.toString(),
    intervalSeconds,
    expiresAt: Date.now() + expiresIn * 1000,
    region: selectedRegion,
    authMethod,
    startUrl: selectedStartUrl,
  }
}

/** Poll one device authorization once. */
export async function pollDeviceLogin(
  session: DeviceLoginSession,
  requestJson: LoginJsonTransport,
  signal: AbortSignal,
): Promise<DeviceLoginPoll> {
  if (Date.now() >= session.expiresAt) throw new Error('Kiro device authorization expired; start login again')
  const response = await requestJson(`https://oidc.${session.region}.amazonaws.com/token`, {
    clientId: session.clientId,
    clientSecret: session.clientSecret,
    grantType: DEVICE_GRANT,
    deviceCode: session.deviceCode,
  }, signal)
  const body = record(response.body)
  if (response.status === 400) {
    const code = body === undefined ? undefined : stringField(body, 'error')
    if (code === 'authorization_pending') return { status: 'pending', intervalSeconds: session.intervalSeconds }
    if (code === 'slow_down') return { status: 'pending', intervalSeconds: session.intervalSeconds + 5 }
    if (code === 'access_denied') throw new Error('Kiro device authorization was denied')
    if (code === 'expired_token') throw new Error('Kiro device authorization expired; start login again')
  }
  if (response.status !== 200 || body === undefined) {
    throw new Error(`Kiro token request failed: ${providerError(response.body, `HTTP ${response.status}`)}`)
  }
  const accessToken = stringField(body, 'accessToken', 'access_token')
  const refreshToken = stringField(body, 'refreshToken', 'refresh_token')
  if (accessToken === undefined || refreshToken === undefined) {
    throw new Error('Kiro token response returned incomplete credentials')
  }
  const expiresIn = Math.max(1, numberField(body, 'expiresIn', 'expires_in') ?? 3600)
  const profileArn = stringField(body, 'profileArn', 'profile_arn')
  return {
    status: 'completed',
    credentials: {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      region: session.region,
      authMethod: session.authMethod,
      startUrl: session.startUrl,
      ...profileArn === undefined ? {} : { profileArn: assertKiroProfileArn(profileArn) },
    },
  }
}

/** Begin Kiro's headless Google or GitHub device authorization. */
export async function startSocialDeviceLogin(
  provider: 'google' | 'github',
  requestJson: LoginJsonTransport,
  signal: AbortSignal,
): Promise<SocialDeviceLoginSession> {
  const loginProvider = provider === 'google' ? 'Google' : 'Github'
  const response = await requestJson(SOCIAL_DEVICE_AUTHORIZE_URL, {
    clientId: SOCIAL_CLIENT_ID,
    loginProvider,
  }, signal)
  if (response.status !== 200) {
    throw new Error(`Kiro social device authorization failed: ${providerError(response.body, `HTTP ${response.status}`)}`)
  }
  const body = record(response.body)
  const deviceCode = body === undefined ? undefined : stringField(body, 'deviceCode', 'device_code')
  const userCode = body === undefined ? undefined : stringField(body, 'userCode', 'user_code')
  const verificationUri = body === undefined
    ? undefined
    : stringField(body, 'verificationUriComplete', 'verification_uri_complete')
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new Error('Kiro social device authorization returned incomplete login details')
  }
  const verificationUrl = new URL(verificationUri)
  if (verificationUrl.protocol !== 'https:'
    || verificationUrl.hostname !== 'app.kiro.dev'
    || verificationUrl.pathname !== '/account/device'
    || verificationUrl.searchParams.get('user_code') !== userCode
    || verificationUrl.searchParams.get('login_provider') !== loginProvider) {
    throw new Error('Kiro returned an unexpected social verification URL')
  }
  const intervalMilliseconds = Math.max(1, body === undefined
    ? 5000
    : numberField(body, 'intervalInMilliseconds', 'interval_in_milliseconds') ?? 5000)
  const expiresInMilliseconds = Math.max(1, body === undefined
    ? 300_000
    : numberField(body, 'expiresInMilliseconds', 'expires_in_milliseconds') ?? 300_000)
  return {
    provider,
    deviceCode,
    userCode,
    verificationUri: verificationUrl.toString(),
    intervalSeconds: Math.max(1, Math.ceil(intervalMilliseconds / 1000)),
    expiresAt: Date.now() + expiresInMilliseconds,
  }
}

/** Poll one Kiro Google/GitHub device authorization once. */
export async function pollSocialDeviceLogin(
  session: SocialDeviceLoginSession,
  requestJson: LoginJsonTransport,
  signal: AbortSignal,
): Promise<SocialDeviceLoginPoll> {
  if (Date.now() >= session.expiresAt) throw new Error('Kiro social device authorization expired; start login again')
  const response = await requestJson(SOCIAL_DEVICE_POLL_URL, {
    clientId: SOCIAL_CLIENT_ID,
    deviceCode: session.deviceCode,
  }, signal)
  const body = record(response.body)
  const progress = body === undefined
    ? undefined
    : stringField(body, 'error') ?? stringField(body, 'status')
  if (progress === 'authorization_pending') {
    return { status: 'pending', intervalSeconds: session.intervalSeconds }
  }
  if (progress === 'slow_down') {
    return { status: 'pending', intervalSeconds: session.intervalSeconds + 5 }
  }
  if (response.status !== 200 || body === undefined) {
    throw new Error(`Kiro social device token request failed: ${providerError(response.body, `HTTP ${response.status}`)}`)
  }
  const accessToken = stringField(body, 'accessToken', 'access_token')
  const refreshToken = stringField(body, 'refreshToken', 'refresh_token')
  if (accessToken === undefined || refreshToken === undefined) {
    throw new Error(`Kiro social device token request failed: ${progress ?? 'incomplete token response'}`)
  }
  const expiresIn = Math.max(1, numberField(body, 'expiresIn', 'expires_in') ?? 3600)
  const profileArn = stringField(body, 'profileArn', 'profile_arn')
  return {
    status: 'completed',
    credentials: {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      region: 'us-east-1',
      authMethod: session.provider,
      ...profileArn === undefined ? {} : { profileArn: assertKiroProfileArn(profileArn) },
    },
  }
}

/**
 * Where an imported refresh token came from. The origin decides the refresh
 * endpoint and the recorded auth method, and the recorded method decides which
 * upstream request surface every later turn uses, so it cannot be guessed from
 * the presence of client credentials alone: AWS Builder ID and IAM Identity
 * Center credentials both carry a client id and secret.
 */
export type RefreshTokenOrigin = 'builder-id' | 'idc' | 'imported'

/**
 * Resolve the credential origin for one refresh-token import.
 * @param requested - the explicit origin the caller named, if any.
 * @param hasClientCredentials - whether an OIDC client id and secret were supplied.
 * @param resolvedStartUrl - the normalized start URL, if any.
 * @returns the origin to record.
 * @throws when the named origin contradicts the supplied credentials.
 */
export function resolveRefreshTokenOrigin(
  requested: RefreshTokenOrigin | undefined,
  hasClientCredentials: boolean,
  resolvedStartUrl: string | undefined,
): RefreshTokenOrigin {
  if (requested === 'imported' && hasClientCredentials) {
    throw new Error(
      'Kiro refresh-token import: an imported Kiro token refreshes against Kiro\'s own service '
      + 'and takes no OIDC client id or secret',
    )
  }
  if ((requested === 'builder-id' || requested === 'idc') && !hasClientCredentials) {
    throw new Error(
      `Kiro refresh-token import: ${requested} credentials refresh through AWS OIDC and require `
      + 'their client id and client secret',
    )
  }
  if (requested === 'idc' && resolvedStartUrl === undefined) {
    throw new Error(
      'Kiro refresh-token import: IAM Identity Center credentials require their start URL',
    )
  }
  if (requested !== undefined) return requested
  // Derivation of last resort, matching how a stored token file is classified
  // when it is re-read: no client credentials means Kiro's own service issued
  // it, and among AWS credentials only an organization start URL distinguishes
  // Identity Center from Builder ID.
  if (!hasClientCredentials) return 'imported'
  return resolvedStartUrl !== undefined && resolvedStartUrl !== BUILDER_START_URL
    ? 'idc'
    : 'builder-id'
}

/** Validate and refresh an imported Kiro refresh token. */
export async function importRefreshToken(
  input: {
    refreshToken: string
    region?: string
    profileArn?: string
    clientId?: string
    clientSecret?: string
    startUrl?: string
    /** Explicit credential origin; omitted falls back to derivation. */
    authMethod?: RefreshTokenOrigin
  },
  requestJson: LoginJsonTransport,
  signal: AbortSignal,
): Promise<ManagedCredentials> {
  const refreshToken = input.refreshToken.trim()
  if (refreshToken.length === 0) throw new Error('Kiro refresh token is required')
  if ((input.clientId === undefined) !== (input.clientSecret === undefined)) {
    throw new Error('Kiro client id and client secret must be provided together')
  }
  const region = assertKiroRegion(input.region?.trim() || 'us-east-1')
  const hasClientCredentials = input.clientId !== undefined && input.clientSecret !== undefined
  const resolvedStartUrl = input.startUrl === undefined || input.startUrl.trim().length === 0
    ? undefined
    : startUrl(input.startUrl)
  const origin = resolveRefreshTokenOrigin(input.authMethod, hasClientCredentials, resolvedStartUrl)
  const viaAwsOidc = origin === 'builder-id' || origin === 'idc'
  const response = await requestJson(
    viaAwsOidc ? `https://oidc.${region}.amazonaws.com/token` : `${KIRO_AUTH_SERVICE}/refreshToken`,
    viaAwsOidc
      ? {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        refreshToken,
        grantType: 'refresh_token',
      }
      : { refreshToken },
    signal,
  )
  if (response.status !== 200) {
    throw new Error(`Kiro refresh-token import failed: ${providerError(response.body, `HTTP ${response.status}`)}`)
  }
  const body = record(response.body)
  const accessToken = body === undefined ? undefined : stringField(body, 'accessToken', 'access_token')
  if (accessToken === undefined) throw new Error('Kiro refresh-token import returned no access token')
  const rotated = body === undefined ? undefined : stringField(body, 'refreshToken', 'refresh_token')
  const expiresIn = Math.max(1, body === undefined ? 3600 : numberField(body, 'expiresIn', 'expires_in') ?? 3600)
  const responseProfile = body === undefined ? undefined : stringField(body, 'profileArn', 'profile_arn')
  const selectedProfile = input.profileArn?.trim() || responseProfile
  return {
    accessToken,
    refreshToken: rotated ?? refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    region,
    authMethod: origin,
    ...viaAwsOidc ? {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      // Recorded so re-reading the stored file classifies the credential the
      // same way this import did, instead of re-deriving a different method.
      startUrl: resolvedStartUrl ?? BUILDER_START_URL,
    } : {},
    ...selectedProfile === undefined ? {} : { profileArn: assertKiroProfileArn(selectedProfile) },
  }
}

/** Validate a long-lived Kiro API key against its actual model catalog. */
export async function importApiKey(
  apiKey: string,
  regionValue: string | undefined,
  requestGet: LoginGetTransport,
  signal: AbortSignal,
): Promise<ManagedCredentials> {
  const accessToken = apiKey.trim()
  if (accessToken.length === 0) throw new Error('Kiro API key is required')
  const region = assertKiroRegion(regionValue?.trim() || 'us-east-1')
  const url = new URL(`https://q.${region}.amazonaws.com/ListAvailableModels`)
  url.searchParams.set('origin', 'AI_EDITOR')
  const response = await requestGet(url.toString(), {
    authorization: `Bearer ${accessToken}`,
    TokenType: 'API_KEY',
    'user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
    'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
  }, signal)
  const models = record(response.body)?.models
  if (response.status !== 200 || !Array.isArray(models) || models.length === 0) {
    throw new Error('Kiro API key validation failed')
  }
  return {
    accessToken,
    expiresAt: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    region,
    authMethod: 'api_key',
  }
}

/** Convert CLIProxyAPI-compatible Microsoft external-IdP JSON into managed credentials. */
export function importExternalIdp(raw: unknown): ManagedCredentials {
  return normalizeExternalIdpCredentials(raw)
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/** Save any normalized credential beneath DSH home with private permissions. */
export async function saveManagedCredentials(directory: string, credentials: ManagedCredentials): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let clientIdHash: string | undefined
  if (credentials.clientId !== undefined && credentials.clientSecret !== undefined) {
    clientIdHash = createHash('sha256').update(credentials.clientId).digest('hex')
    await atomicJson(join(directory, `${clientIdHash}.json`), {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    })
  }
  await atomicJson(join(directory, TOKEN_FILE), {
    accessToken: credentials.accessToken,
    ...credentials.refreshToken === undefined ? {} : { refreshToken: credentials.refreshToken },
    expiresAt: credentials.expiresAt,
    region: credentials.region,
    authMethod: credentials.authMethod,
    ...credentials.profileArn === undefined ? {} : { profileArn: assertKiroProfileArn(credentials.profileArn) },
    ...clientIdHash === undefined ? {} : { clientIdHash },
    ...credentials.clientId === undefined || credentials.clientSecret !== undefined
      ? {}
      : { clientId: credentials.clientId },
    ...credentials.startUrl === undefined ? {} : { startUrl: credentials.startUrl },
    ...credentials.tokenEndpoint === undefined ? {} : { tokenEndpoint: credentials.tokenEndpoint },
    ...credentials.scope === undefined ? {} : { scope: credentials.scope },
  })
  clearTokenCache()
}

export function saveDeviceCredentials(directory: string, credentials: DeviceCredentials): Promise<void> {
  return saveManagedCredentials(directory, credentials)
}

/** Read only non-secret managed credential metadata for the status API. */
export async function credentialSummary(directory: string): Promise<CredentialSummary> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(directory, TOKEN_FILE), 'utf8'))
  } catch {
    return { authenticated: false }
  }
  const value = record(parsed)
  if (value === undefined) return { authenticated: false }
  const accessToken = stringField(value, 'accessToken', 'access_token')
  const refreshToken = stringField(value, 'refreshToken', 'refresh_token')
  const expiresAt = stringField(value, 'expiresAt', 'expires_at')
  const region = stringField(value, 'region')
  // Report the method the adapter will actually act on: Kiro IDE/CLI writes its
  // own vocabulary (`social`, `IdC`), and showing the raw value would describe a
  // credential differently from how it is refreshed and routed.
  const recorded = stringField(value, 'authMethod', 'auth_method')
  const method = recorded === undefined ? undefined : kiroAuthMethod(recorded, value)
  const profileArn = stringField(value, 'profileArn', 'profile_arn')
  return {
    authenticated: accessToken !== undefined || refreshToken !== undefined,
    ...expiresAt === undefined ? {} : { expiresAt },
    ...region === undefined ? {} : { region },
    ...method === undefined ? {} : { authMethod: method },
    ...profileArn === undefined ? {} : { profileArn },
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Delete only credentials owned by this plugin, leaving Kiro IDE files intact. */
export async function deleteDeviceCredentials(directory: string): Promise<void> {
  let clientIdHash: string | undefined
  try {
    const parsed = record(JSON.parse(await readFile(join(directory, TOKEN_FILE), 'utf8')))
    const candidate = parsed === undefined ? undefined : stringField(parsed, 'clientIdHash')
    if (candidate !== undefined && /^[a-f0-9]{64}$/u.test(candidate)) clientIdHash = candidate
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  await unlinkIfPresent(join(directory, TOKEN_FILE))
  if (clientIdHash !== undefined) await unlinkIfPresent(join(directory, `${clientIdHash}.json`))
  clearTokenCache()
}
