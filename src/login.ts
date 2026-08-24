/** AWS Builder ID device login and DSH-owned credential persistence. */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clearTokenCache } from './auth.ts'
import { assertKiroRegion } from './region.ts'

const TOKEN_FILE = 'kiro-auth-token.json'
const START_URL = 'https://view.awsapps.com/start'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
  'codewhisperer:transformations',
  'codewhisperer:taskassist',
]

/** JSON transport used by device authorization and polling. */
export type LoginJsonTransport = (
  url: string,
  body: unknown,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>

/** In-memory secret state for one device authorization. */
export interface DeviceLoginSession {
  clientId: string
  clientSecret: string
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresAt: number
  region: string
}

/** Result of one device-token poll. */
export type DeviceLoginPoll =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'completed'; credentials: DeviceCredentials }

/** Complete credential material returned after device authorization. */
export interface DeviceCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: string
  clientId: string
  clientSecret: string
  region: string
}

/** Non-secret information suitable for a status API. */
export interface CredentialSummary {
  authenticated: boolean
  expiresAt?: string
  region?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: Record<string, unknown>, camel: string, snake?: string): string | undefined {
  const candidate = value[camel] ?? (snake === undefined ? undefined : value[snake])
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
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

/**
 * Begin an AWS Builder ID device authorization.
 * @param region - AWS OIDC region.
 * @param requestJson - JSON transport, normally sharing the configured Kiro proxy.
 * @param signal - caller cancellation.
 * @returns the device session and browser verification URL.
 */
export async function startDeviceLogin(
  region: string,
  requestJson: LoginJsonTransport,
  signal: AbortSignal,
): Promise<DeviceLoginSession> {
  const selectedRegion = assertKiroRegion(region.trim() || 'us-east-1')
  const oidcBase = `https://oidc.${selectedRegion}.amazonaws.com`
  const registration = await requestJson(`${oidcBase}/client/register`, {
    clientName: 'Kiro',
    clientType: 'public',
    scopes: SCOPES,
    grantTypes: [DEVICE_GRANT, 'refresh_token'],
    issuerUrl: START_URL,
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
    startUrl: START_URL,
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
      || verificationUrl.hostname.endsWith('.awsapps.com'))) {
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
  }
}

/**
 * Poll one Builder ID device authorization once.
 * @param session - state returned by {@link startDeviceLogin}.
 * @param requestJson - JSON transport.
 * @param signal - caller cancellation.
 * @returns pending state or complete credentials.
 */
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
    if (code === 'authorization_pending') {
      return { status: 'pending', intervalSeconds: session.intervalSeconds }
    }
    if (code === 'slow_down') {
      return { status: 'pending', intervalSeconds: session.intervalSeconds + 5 }
    }
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
  return {
    status: 'completed',
    credentials: {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      region: session.region,
    },
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Save a completed device authorization beneath DSH home.
 * @param directory - managed credential directory.
 * @param credentials - complete device credentials.
 */
export async function saveDeviceCredentials(directory: string, credentials: DeviceCredentials): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const clientIdHash = createHash('sha256').update(credentials.clientId).digest('hex')
  await atomicJson(join(directory, `${clientIdHash}.json`), {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  })
  await atomicJson(join(directory, TOKEN_FILE), {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    clientIdHash,
    region: credentials.region,
    startUrl: START_URL,
  })
  clearTokenCache()
}

/**
 * Read non-secret managed credential status.
 * @param directory - credential directory to inspect.
 * @returns authentication metadata, or an unauthenticated summary when absent.
 */
export async function credentialSummary(directory: string): Promise<CredentialSummary> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(directory, TOKEN_FILE), 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { authenticated: false }
    return { authenticated: false }
  }
  const value = record(parsed)
  if (value === undefined) return { authenticated: false }
  const accessToken = stringField(value, 'accessToken', 'access_token')
  const refreshToken = stringField(value, 'refreshToken', 'refresh_token')
  const expiresAt = stringField(value, 'expiresAt', 'expires_at')
  const region = stringField(value, 'region')
  return {
    authenticated: accessToken !== undefined || refreshToken !== undefined,
    ...expiresAt === undefined ? {} : { expiresAt },
    ...region === undefined ? {} : { region },
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Delete only credentials owned by this plugin, leaving Kiro IDE files intact.
 * @param directory - managed credential directory.
 */
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
