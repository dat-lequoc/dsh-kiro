/** Reuse the credential a Kiro CLI or Kiro IDE sign-in already stored. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LoginJsonTransport, ManagedCredentials } from './login.ts'
import { BUILDER_START_URL, importRefreshToken } from './login.ts'
import { assertMicrosoftTokenEndpoint } from './external-idp.ts'
import { assertKiroRegion } from './region.ts'

const DATA_FILE = 'data.sqlite3'
const TOKEN_KEY = 'kirocli:odic:token'
const REGISTRATION_KEY = 'kirocli:odic:device-registration'

/** The credential one local Kiro installation already holds. */
export interface LocalKiroCredentials {
  credentials: ManagedCredentials
  /** The store the credential was read from. */
  file: string
  /** The `auth_kv` row that held the token. */
  key: string
}

/** Where a local Kiro installation keeps its sign-in state. */
export interface LocalKiroCredentialOptions {
  /** Read this store instead of probing the platform locations. */
  file?: string
  /** Environment the probe reads; defaults to the process environment. */
  env?: NodeJS.ProcessEnv
}

interface KvRow {
  key: string
  value: string
}

interface SqliteStatement {
  all: () => unknown[]
  get: (key: string) => unknown
  run: (...parameters: string[]) => unknown
}

interface SqliteModule {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
    prepare: (sql: string) => SqliteStatement
    close: () => void
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function objectOf(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** The stores to probe, in the order a machine is most likely to have one. */
export function localKiroCredentialFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = text(env.KIRO_CLI_DATA_FILE)
  if (configured !== undefined) return [configured]
  const home = homedir()
  const localAppData = text(env.LOCALAPPDATA)
  const shared = join(home, '.local', 'share', 'kiro-cli', DATA_FILE)
  if (process.platform === 'win32') {
    return [
      ...localAppData === undefined ? [] : [join(localAppData, 'Kiro-Cli', DATA_FILE)],
      shared,
    ]
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Kiro-Cli', DATA_FILE), shared]
  }
  return [shared, join(home, '.config', 'kiro-cli', DATA_FILE)]
}

/** `expires_at` is an ISO string in current stores and epoch seconds in older ones. */
function isoExpiry(value: unknown): string | undefined {
  if (typeof value === 'number') {
    const millis = value > 1e11 ? value : value * 1000
    return new Date(millis).toISOString()
  }
  const raw = text(value)
  if (raw === undefined) return undefined
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString()
}

function scopeOf(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map(text).filter((part): part is string => part !== undefined)
    return parts.length === 0 ? undefined : parts.join(' ')
  }
  return text(value)
}

function credentialsOf(
  token: Record<string, unknown>,
  registration: Record<string, unknown> | undefined,
  origin: { file: string, key: string },
): ManagedCredentials {
  const accessToken = text(token.access_token) ?? text(token.accessToken)
  if (accessToken === undefined) {
    throw new Error('The Kiro CLI store holds a token row without an access token')
  }
  const region = assertKiroRegion(text(token.region) ?? text(token.idc_region) ?? 'us-east-1')
  const startUrl = text(token.start_url) ?? text(token.startUrl)
  const clientId = text(registration?.client_id) ?? text(registration?.clientId) ?? text(token.client_id)
  const clientSecret = text(registration?.client_secret) ?? text(registration?.clientSecret)
  const tokenEndpoint = text(token.token_endpoint) ?? text(token.tokenEndpoint)
  const profileArn = text(token.profile_arn) ?? text(token.profileArn)
  const refreshToken = text(token.refresh_token) ?? text(token.refreshToken)
  const scope = scopeOf(token.scopes) ?? scopeOf(token.scope) ?? scopeOf(registration?.scopes)
  const authMethod = tokenEndpoint !== undefined
    ? 'external_idp'
    : startUrl === undefined || startUrl === BUILDER_START_URL ? 'builder-id' : 'idc'
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: isoExpiry(token.expires_at ?? token.expiresAt) ?? new Date().toISOString(),
    region,
    authMethod,
    ...profileArn === undefined ? {} : { profileArn },
    ...clientId === undefined ? {} : { clientId },
    ...clientSecret === undefined ? {} : { clientSecret },
    ...startUrl === undefined ? {} : { startUrl },
    ...tokenEndpoint === undefined ? {} : { tokenEndpoint },
    ...scope === undefined ? {} : { scope },
    storeFile: origin.file,
    storeKey: origin.key,
  }
}

async function readRows(file: string): Promise<KvRow[]> {
  const { DatabaseSync } = await import('node:sqlite') as unknown as SqliteModule
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('select key, value from auth_kv').all().flatMap(row => {
      const record = row as { key?: unknown; value?: unknown }
      const key = text(record.key)
      const value = typeof record.value === 'string' ? record.value : undefined
      return key === undefined || value === undefined ? [] : [{ key, value }]
    })
  } finally {
    db.close()
  }
}

/**
 * Read the credential a local Kiro CLI or Kiro IDE sign-in already stored.
 *
 * Organizations whose identity provider only trusts the Kiro IDE callback
 * cannot be signed into from this plugin: the browser lands back in the IDE,
 * which then holds the refreshable credential. Reusing that credential keeps
 * the login possible instead of asking the user to paste tokens by hand.
 * @param options - an explicit store path, or the environment to probe.
 * @returns the normalized credential plus where it was read from.
 */
export async function readLocalKiroCredentials(
  options: LocalKiroCredentialOptions = {},
): Promise<LocalKiroCredentials> {
  const files = options.file === undefined
    ? localKiroCredentialFiles(options.env ?? process.env)
    : [options.file]
  const existing = files.find(file => existsSync(file))
  if (existing === undefined) {
    throw new Error(
      'No local Kiro credential store was found; sign in with the Kiro CLI or Kiro IDE first, '
      + `or point KIRO_CLI_DATA_FILE at one of: ${files.join(', ')}`,
    )
  }
  const rows = await readRows(existing)
  const byKey = new Map(rows.map(row => [row.key, row.value]))
  const tokenKey = byKey.has(TOKEN_KEY)
    ? TOKEN_KEY
    : rows.map(row => row.key).find(key => key.endsWith(':token'))
  if (tokenKey === undefined) {
    throw new Error(
      `The local Kiro credential store ${existing} holds no sign-in; run kiro-cli login or sign in through the Kiro IDE first`,
    )
  }
  const token = objectOf(byKey.get(tokenKey) ?? '')
  if (token === undefined) {
    throw new Error(`The local Kiro credential store ${existing} holds an unreadable ${tokenKey} row`)
  }
  const registrationValue = byKey.get(REGISTRATION_KEY)
    ?? byKey.get(tokenKey.replace(/:token$/u, ':device-registration'))
  const registration = registrationValue === undefined ? undefined : objectOf(registrationValue)
  return {
    credentials: credentialsOf(token, registration, { file: existing, key: tokenKey }),
    file: existing,
    key: tokenKey,
  }
}
/** How close to expiry a reused token may sit before it is refreshed. */
const REFRESH_MARGIN_MS = 300_000

/** An OAuth form POST, matching the transport the rest of the plugin uses. */
export type LocalKiroFormTransport = (
  url: string,
  form: URLSearchParams,
  signal: AbortSignal,
) => Promise<{ status: number, body: unknown }>

/**
 * Refresh a reused sign-in that the Kiro CLI left close to expiry.
 *
 * A CLI store is written when its owner signs in, so by the time the plugin
 * reuses it the access token is often already stale — but the refresh token
 * beside it still works. An external-IdP token refreshes as a form on the
 * endpoint that issued it; the identity-centre variants refresh through AWS
 * OIDC with the registration the store keeps beside the token.
 * @param credentials - what `readLocalKiroCredentials` read.
 * @param requestJson - transport for the provider's token endpoint.
 * @param signal - aborts the refresh.
 * @param requestForm - form transport, required to refresh an external IdP token.
 * @returns the same credential, or a refreshed copy when it was near expiry.
 */
export async function refreshLocalKiroCredentials(
  credentials: ManagedCredentials,
  requestJson: LoginJsonTransport,
  signal: AbortSignal,
  requestForm?: LocalKiroFormTransport,
): Promise<ManagedCredentials> {
  const expiresAt = Date.parse(credentials.expiresAt)
  const stale = !Number.isFinite(expiresAt) || expiresAt - Date.now() < REFRESH_MARGIN_MS
  const { refreshToken, clientId, clientSecret } = credentials
  if (!stale || refreshToken === undefined) return credentials
  if (credentials.authMethod === 'external_idp') {
    return refreshExternalIdp(credentials, refreshToken, requestForm, signal)
  }
  // Without the registration the store cannot refresh; the resolver reports that
  // when it needs the token, which keeps this reuse honest about what it can do.
  if (clientId === undefined || clientSecret === undefined) return credentials
  const refreshed = await importRefreshToken({
    refreshToken,
    region: credentials.region,
    ...credentials.startUrl === undefined ? {} : { startUrl: credentials.startUrl },
    ...clientId === undefined ? {} : { clientId, clientSecret },
    authMethod: credentials.authMethod === 'builder-id' ? 'builder-id' : 'idc',
  }, requestJson, signal)
  return {
    ...refreshed,
    ...credentials.profileArn === undefined ? {} : { profileArn: credentials.profileArn },
  }
}
/** The rotated token fields a shared store has to learn about. */
export interface LocalKiroTokenUpdate {
  /** The store the credential was imported from. */
  file: string
  /** The `auth_kv` row that holds the token. */
  key: string
  accessToken: string
  refreshToken?: string
  expiresAt: string
  scope?: string
}

/**
 * Write a rotated token back into the store it was imported from.
 *
 * Reusing a sign-in makes the plugin and the Kiro CLI share one refresh token,
 * and a Microsoft refresh rotates it: whichever side refreshes first would
 * otherwise invalidate the other. Keeping the store current makes the reuse
 * safe in both directions.
 * @param update - the store row and the token fields to replace.
 */
export async function writeLocalKiroToken(update: LocalKiroTokenUpdate): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite') as unknown as SqliteModule
  const db = new DatabaseSync(update.file)
  try {
    const row = db.prepare('select value from auth_kv where key = ?').get(update.key) as
      | { value?: unknown }
      | undefined
    const current = objectOf(text(row?.value) ?? '')
    if (current === undefined) {
      throw new Error(`The local Kiro credential store ${update.file} no longer holds ${update.key}`)
    }
    const scopes = update.scope === undefined
      ? current.scopes
      : Array.isArray(current.scopes) ? update.scope.split(' ') : update.scope
    db.prepare('update auth_kv set value = ? where key = ?').run(JSON.stringify({
      ...current,
      access_token: update.accessToken,
      ...update.refreshToken === undefined ? {} : { refresh_token: update.refreshToken },
      expires_at: update.expiresAt,
      ...scopes === undefined ? {} : { scopes },
    }), update.key)
  } finally {
    db.close()
  }
}

/**
 * Refresh an external-IdP token against the endpoint that issued it.
 *
 * Microsoft returns a rotated refresh token for this grant, so the result is
 * mirrored into the store the credential came from; otherwise the CLI would
 * keep a token the identity provider has already retired.
 * @param credentials - the imported credential.
 * @param refreshToken - the refresh token to spend.
 * @param requestForm - form transport; without it the token is left as-is.
 * @param signal - aborts the refresh.
 * @returns the refreshed credential, or the original when it cannot refresh here.
 */
async function refreshExternalIdp(
  credentials: ManagedCredentials,
  refreshToken: string,
  requestForm: LocalKiroFormTransport | undefined,
  signal: AbortSignal,
): Promise<ManagedCredentials> {
  const { clientId, tokenEndpoint, scope, storeFile, storeKey } = credentials
  if (clientId === undefined || tokenEndpoint === undefined || scope === undefined || requestForm === undefined) {
    // Nothing to talk to: the resolver refreshes it at use time instead.
    return credentials
  }
  const response = await requestForm(
    assertMicrosoftTokenEndpoint(tokenEndpoint),
    new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope }),
    signal,
  )
  const body = typeof response.body === 'object' && response.body !== null
    ? response.body as Record<string, unknown>
    : {}
  const accessToken = text(body.access_token)
  if (response.status !== 200 || accessToken === undefined) {
    const detail = text(body.error_description) ?? text(body.error) ?? `HTTP ${response.status}`
    throw new Error(`Kiro external IdP refresh failed: ${detail}`)
  }
  const lifetime = Number(body.expires_in)
  const rotatedRefresh = text(body.refresh_token) ?? refreshToken
  const expiresAt = new Date(Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000)
    .toISOString()
  const refreshed: ManagedCredentials = {
    ...credentials,
    accessToken,
    refreshToken: rotatedRefresh,
    expiresAt,
  }
  if (storeFile !== undefined && storeKey !== undefined) {
    try {
      await writeLocalKiroToken({ file: storeFile, key: storeKey, accessToken, refreshToken: rotatedRefresh, expiresAt, scope })
    } catch (error: unknown) {
      // The fresh token still works for this login; the store catches up on the
      // next `kiro-cli login`, so a failed mirror must not fail the import.
      console.warn(
        'Kiro could not keep the local CLI store in sync:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return refreshed
}
