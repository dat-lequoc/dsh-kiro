/** Kiro Microsoft external-IdP credential normalization and refresh safety. */

import { assertKiroProfileArn } from './profile.ts'
import { assertKiroRegion } from './region.ts'

const MICROSOFT_TOKEN_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.windows.net',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function scopes(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const result = value.map(text).filter(item => item !== undefined).join(' ')
    return result.length > 0 ? result : undefined
  }
  return text(value)
}

/** Restrict imported token endpoints to Microsoft's real login hosts. */
export function assertMicrosoftTokenEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch (error: unknown) {
    throw new Error('dsh-kiro: external IdP token endpoint is not a valid URL', { cause: error })
  }
  if (url.protocol !== 'https:' || !MICROSOFT_TOKEN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('dsh-kiro: external IdP token endpoint must use an approved Microsoft login host')
  }
  return url.toString()
}

function jwtExpiry(accessToken: string): string | undefined {
  try {
    const part = accessToken.split('.')[1]
    if (part === undefined) return undefined
    const payload = record(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')))
    const expiry = payload?.exp
    return typeof expiry === 'number' && Number.isFinite(expiry)
      ? new Date(expiry * 1000).toISOString()
      : undefined
  } catch {
    return undefined
  }
}

/** Normalized external-IdP credential accepted from CLIProxyAPI-compatible JSON. */
export interface ExternalIdpCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: string
  region: string
  profileArn: string
  clientId: string
  tokenEndpoint: string
  scope: string
  authMethod: 'external_idp'
}

/** Parse snake_case or camelCase CLIProxyAPI Kiro auth JSON. */
export function normalizeExternalIdpCredentials(raw: unknown): ExternalIdpCredentials {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error: unknown) {
      throw new Error('dsh-kiro: external IdP credential JSON is invalid', { cause: error })
    }
  }
  const value = record(parsed)
  if (value === undefined) throw new Error('dsh-kiro: external IdP credential JSON is required')
  const method = text(value.authMethod ?? value.auth_method)
  if (method !== undefined && method !== 'external_idp') {
    throw new Error('dsh-kiro: imported credential is not external_idp auth')
  }
  const accessToken = text(value.accessToken ?? value.access_token)
  const refreshToken = text(value.refreshToken ?? value.refresh_token)
  const clientId = text(value.clientId ?? value.client_id)
  const tokenEndpoint = text(value.tokenEndpoint ?? value.token_endpoint)
  const profileArn = text(value.profileArn ?? value.profile_arn)
  const scope = scopes(value.scope ?? value.scopes)
  if (accessToken === undefined) throw new Error('dsh-kiro: external IdP access_token is required')
  if (refreshToken === undefined) throw new Error('dsh-kiro: external IdP refresh_token is required')
  if (clientId === undefined) throw new Error('dsh-kiro: external IdP client_id is required')
  if (tokenEndpoint === undefined) throw new Error('dsh-kiro: external IdP token_endpoint is required')
  if (profileArn === undefined) throw new Error('dsh-kiro: external IdP profile_arn is required')
  if (scope === undefined) throw new Error('dsh-kiro: external IdP scopes are required')
  const explicitExpiry = text(value.expiresAt ?? value.expires_at ?? value.expired)
  const expiresIn = Number(value.expiresIn ?? value.expires_in)
  const expiresAt = explicitExpiry !== undefined && Number.isFinite(Date.parse(explicitExpiry))
    ? new Date(explicitExpiry).toISOString()
    : Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : jwtExpiry(accessToken) ?? new Date(Date.now() + 3_600_000).toISOString()
  return {
    accessToken,
    refreshToken,
    expiresAt,
    region: assertKiroRegion(text(value.region) ?? 'us-east-1'),
    profileArn: assertKiroProfileArn(profileArn),
    clientId,
    tokenEndpoint: assertMicrosoftTokenEndpoint(tokenEndpoint),
    scope,
    authMethod: 'external_idp',
  }
}
