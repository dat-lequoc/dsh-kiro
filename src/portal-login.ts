/** Kiro portal login: work email → organization → the company's own SSO. */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ManagedCredentials } from './login.ts'
import { assertKiroRegion } from './region.ts'

/** Kiro's own sign-in portal; the IDE can override it through `kiroAuthConfig.portalUrl`. */
export const DEFAULT_PORTAL_URL = 'https://app.kiro.dev'

/**
 * The loopback ports Kiro's IDE listens on for this same flow. Reusing them
 * keeps one set of redirect URIs registered with the portal and the IdPs.
 */
export const CALLBACK_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153] as const

/** The portal appends its own callback path, so both registered shapes must answer. */
const PORTAL_CALLBACK_PATHS = new Set(['/oauth/callback', '/signin/callback'])

/** The company IdP redirects to the redirect URI this login registers itself. */
const IDP_CALLBACK_PATH = '/callback'

const AUTHORIZATION_TIMEOUT_MS = 600_000

export type PortalJsonTransport = (
  url: string,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>

export type PortalFormTransport = (
  url: string,
  form: URLSearchParams,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>

/** The organization the portal resolved an email to. */
export type PortalOrganization =
  | {
    kind: 'external-idp'
    issuerUrl: string
    clientId: string
    region: string
    scopes: string
    loginHint?: string
    audience?: string
  }
  | { kind: 'social'; provider: 'google' | 'github'; code: string; region: string }
  | {
    kind: 'identity-center'
    provider: 'builderid' | 'awsidc' | 'internal'
    startUrl: string
    region: string
  }

/** Discovery document fields this login needs. */
export interface IdpDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
  /** Present when the IdP offers the RFC 8628 device grant. */
  deviceAuthorizationEndpoint?: string
}

export interface PortalLoginOptions {
  portalUrl?: string
  ports?: readonly number[]
  timeoutMs?: number
  /** Host the portal and the IdP redirect back to; loopback by default. */
  redirectHost?: string
}

export interface ExternalIdpSignIn {
  /**
   * Device grant: the page the user types the code into. Authorization code
   * grant: the IdP authorization URL.
   */
  authUrl: string
  /** Device grant only: the code the user types at `authUrl`. */
  userCode?: string
  /** Resolves with Kiro-shaped credentials once the IdP hands them over. */
  credentials: Promise<ManagedCredentials>
}

export interface PortalLogin {
  /** Open this so the user can type a work email. */
  portalUrl: string
  /** Base redirect URI handed to the portal (`http://host:port`). */
  redirectUri: string
  port: number
  /** Resolves when the portal reports the organization behind that email. */
  organization: Promise<PortalOrganization>
  /** Sign in through the organization's own IdP, for `external-idp` answers. */
  beginExternalIdp(
    organization: Extract<PortalOrganization, { kind: 'external-idp' }>,
    options?: {
      /**
       * Which grant to use. `auto` takes the device grant when the IdP offers
       * it and falls back to a loopback authorization code, the only route that
       * works for apps that registered no loopback redirect.
       */
      mode?: 'auto' | 'device' | 'loopback'
      /** Form transport for the IdP token endpoint. */
      request?: PortalFormTransport
      /** JSON transport for the IdP discovery document. */
      discoveryRequest?: PortalJsonTransport
      signal?: AbortSignal
    },
  ): Promise<ExternalIdpSignIn>
  close(): Promise<void>
}

interface PendingIdpCallback {
  state: string
  resolve(code: string): void
  reject(error: Error): void
}

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

/** RFC 7636 verifier/challenge pair; the portal and the IdP each get one. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

/** Build the portal URL the IDE opens for the email sign-in form. */
export function portalSigninUrl(input: {
  portalUrl: string
  state: string
  codeChallenge: string
  redirectUri: string
}): string {
  const base = input.portalUrl.endsWith('/') ? input.portalUrl : `${input.portalUrl}/`
  const url = new URL('signin', base)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('redirect_from', 'KiroIDE')
  return url.toString()
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function portalError(params: URLSearchParams): string {
  return text(params.get('error_message'))
    ?? text(params.get('error_description'))
    ?? text(params.get('error'))
    ?? 'Kiro portal sign-in failed'
}

function regionOf(params: URLSearchParams, ...names: string[]): string {
  for (const name of names) {
    const candidate = text(params.get(name))
    if (candidate !== undefined) return assertKiroRegion(candidate)
  }
  return 'us-east-1'
}

/**
 * Translate the portal callback into how its organization must be signed into.
 *
 * The portal resolves the email to an organization server-side and hands the
 * client only what that organization needs: an external IdP descriptor, a
 * social authorization code, or an IAM Identity Center start URL.
 */
export function parsePortalOrganization(params: URLSearchParams, expectedState: string): PortalOrganization {
  const state = text(params.get('state'))
  if (state !== expectedState) throw new Error('Kiro portal callback state does not match this login')
  if (params.has('error') || params.has('error_message')) throw new Error(portalError(params))
  const loginOption = text(params.get('login_option'))
  if (loginOption === 'external_idp') {
    const issuerUrl = text(params.get('issuer_url'))
    const clientId = text(params.get('client_id'))
    const scopes = text(params.get('scopes'))
    if (issuerUrl === undefined || clientId === undefined || scopes === undefined) {
      throw new Error('Kiro portal external IdP callback is missing its issuer, client, or scopes')
    }
    const loginHint = text(params.get('login_hint'))
    const audience = text(params.get('audience'))
    return {
      kind: 'external-idp',
      issuerUrl,
      clientId,
      region: regionOf(params, 'external_idp_region', 'idc_region'),
      scopes,
      ...loginHint === undefined ? {} : { loginHint },
      ...audience === undefined ? {} : { audience },
    }
  }
  if (loginOption === 'google' || loginOption === 'github') {
    const code = text(params.get('code'))
    if (code === undefined) throw new Error('Kiro portal social callback carried no authorization code')
    return { kind: 'social', provider: loginOption, code, region: regionOf(params) }
  }
  if (loginOption === 'builderid' || loginOption === 'awsidc' || loginOption === 'internal') {
    const startUrl = text(params.get('issuer_url')) ?? text(params.get('start_url'))
    if (startUrl === undefined) throw new Error('Kiro portal Identity Center callback carried no start URL')
    return {
      kind: 'identity-center',
      provider: loginOption,
      startUrl,
      region: regionOf(params, 'idc_region'),
    }
  }
  throw new Error(`Kiro portal returned an unsupported login option: ${loginOption ?? '(none)'}`)
}

/** Read an IdP's OIDC discovery document. */
export async function discoverIdp(
  issuerUrl: string,
  request: PortalJsonTransport,
  signal: AbortSignal,
): Promise<IdpDiscovery> {
  const url = `${issuerUrl.replace(/\/$/u, '')}/.well-known/openid-configuration`
  const response = await request(url, signal)
  const body = typeof response.body === 'object' && response.body !== null
    ? response.body as Record<string, unknown>
    : undefined
  const authorizationEndpoint = typeof body?.authorization_endpoint === 'string'
    ? body.authorization_endpoint
    : undefined
  const tokenEndpoint = typeof body?.token_endpoint === 'string' ? body.token_endpoint : undefined
  if (response.status !== 200 || authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    throw new Error('Kiro external IdP discovery did not return its authorization and token endpoints')
  }
  const deviceAuthorizationEndpoint = typeof body?.device_authorization_endpoint === 'string'
    ? body.device_authorization_endpoint
    : undefined
  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...deviceAuthorizationEndpoint === undefined ? {} : { deviceAuthorizationEndpoint },
  }
}

/** Read the tokens a successful IdP answer carries into Kiro's credential shape. */
function credentialsFromToken(
  body: Record<string, unknown> | undefined,
  organization: Extract<PortalOrganization, { kind: 'external-idp' }>,
  tokenEndpoint: string,
): ManagedCredentials {
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : undefined
  if (accessToken === undefined) throw new Error('Kiro external IdP token response carried no access token')
  const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : undefined
  const expiresIn = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    region: organization.region,
    authMethod: 'external_idp',
    clientId: organization.clientId,
    tokenEndpoint,
    scope: organization.scopes,
  }
}

/** The IdP's OpenID error code for a token answer that is not an answer yet. */
function errorCodeOf(body: Record<string, unknown> | undefined): string | undefined {
  return typeof body?.error === 'string' ? body.error : undefined
}

function errorDetailOf(response: { status: number; body: unknown }): string {
  const body = typeof response.body === 'object' && response.body !== null
    ? response.body as Record<string, unknown>
    : undefined
  return typeof body?.error_description === 'string'
    ? body.error_description
    : typeof body?.error === 'string' ? body.error : `status ${String(response.status)}`
}

/**
 * Name the way forward for the two identity-provider answers no setting can fix.
 *
 * An organization whose IdP trusts only the Kiro IDE callback refuses this
 * plugin's loopback redirect (`AADSTS50011`), and an app registered as a
 * confidential client refuses a device-code exchange without its secret
 * (`AADSTS7000218`). Either way the plugin cannot mint the token itself, but the
 * Kiro CLI or IDE on this machine already holds one.
 * @param detail - the identity provider's error text.
 * @returns a sentence to append, or an empty string when the cause is elsewhere.
 */
function ssoGuidance(detail: string): string {
  if (!/AADSTS50011|AADSTS7000218/u.test(detail)) return ''
  return '; this organization’s identity provider does not accept the plugin’s own callback,'
    + ' so reuse the sign-in the Kiro CLI already stored (--method local) instead'
}

/**
 * Build the company IdP authorization URL.
 *
 * Kiro registers `kiro://kiro.oauth/callback` for the IDE; the same IdP
 * registrations accept a loopback URI, which lets a plugin finish the flow
 * without installing a URL-scheme handler.
 */
export function externalIdpAuthorizationUrl(input: {
  organization: Extract<PortalOrganization, { kind: 'external-idp' }>
  discovery: IdpDiscovery
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(input.discovery.authorizationEndpoint)
  url.searchParams.set('client_id', input.organization.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.organization.scopes)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (input.organization.loginHint !== undefined) {
    url.searchParams.set('login_hint', input.organization.loginHint)
  }
  if (input.organization.audience !== undefined) {
    url.searchParams.set('audience', input.organization.audience)
  }
  // The IdP only issues a refresh token after consent, which Kiro always asks for.
  if (input.organization.scopes.split(/\s+/u).includes('offline_access')) {
    url.searchParams.set('prompt', 'consent')
  }
  return url.toString()
}

/** Trade the IdP authorization code for the tokens Kiro itself would store. */
export async function completeExternalIdpLogin(input: {
  organization: Extract<PortalOrganization, { kind: 'external-idp' }>
  discovery: IdpDiscovery
  code: string
  codeVerifier: string
  redirectUri: string
  request: PortalFormTransport
  signal: AbortSignal
}): Promise<ManagedCredentials> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.organization.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    scope: input.organization.scopes,
  })
  const response = await input.request(input.discovery.tokenEndpoint, form, input.signal)
  const body = typeof response.body === 'object' && response.body !== null
    ? response.body as Record<string, unknown>
    : undefined
  if (response.status !== 200 || typeof body?.access_token !== 'string') {
    throw new Error(`Kiro external IdP token exchange failed: ${errorDetailOf(response)}${ssoGuidance(errorDetailOf(response))}`)
  }
  return credentialsFromToken(body, input.organization, input.discovery.tokenEndpoint)
}

/** What the IdP's device authorization endpoint hands back. */
export interface IdpDeviceAuthorization {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: string
  intervalSeconds: number
}

/**
 * Ask the IdP for a device code.
 *
 * This is the route that works for company apps registered with a vendor URL
 * scheme (`kiro://…`) and no loopback redirect: nothing has to be registered
 * on the machine, the user types a short code instead.
 */
export async function startIdpDeviceAuthorization(input: {
  organization: Extract<PortalOrganization, { kind: 'external-idp' }>
  discovery: IdpDiscovery
  request: PortalFormTransport
  signal: AbortSignal
}): Promise<IdpDeviceAuthorization & { deviceCode: string }> {
  const endpoint = input.discovery.deviceAuthorizationEndpoint
  if (endpoint === undefined) throw new Error('Kiro external IdP discovery offered no device authorization endpoint')
  const form = new URLSearchParams({
    client_id: input.organization.clientId,
    scope: input.organization.scopes,
  })
  const response = await input.request(endpoint, form, input.signal)
  const body = typeof response.body === 'object' && response.body !== null
    ? response.body as Record<string, unknown>
    : undefined
  const deviceCode = typeof body?.device_code === 'string' ? body.device_code : undefined
  const userCode = typeof body?.user_code === 'string' ? body.user_code : undefined
  const verificationUri = typeof body?.verification_uri === 'string'
    ? body.verification_uri
    : typeof body?.verification_url === 'string' ? body.verification_url : undefined
  if (response.status !== 200 || deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new Error(`Kiro external IdP device authorization failed: ${errorDetailOf(response)}`)
  }
  const verificationUriComplete = typeof body?.verification_uri_complete === 'string'
    ? body.verification_uri_complete
    : undefined
  const expiresIn = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 900
  const interval = typeof body?.interval === 'number' && body.interval > 0 ? body.interval : 5
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...verificationUriComplete === undefined ? {} : { verificationUriComplete },
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    intervalSeconds: interval,
  }
}

/** Wait out one poll interval, giving an abort a chance to win. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Kiro company SSO login cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Poll the IdP's token endpoint until the user finishes the device sign-in. */
export async function pollIdpDeviceAuthorization(input: {
  organization: Extract<PortalOrganization, { kind: 'external-idp' }>
  discovery: IdpDiscovery
  deviceCode: string
  intervalSeconds: number
  expiresAt: string
  request: PortalFormTransport
  signal: AbortSignal
}): Promise<ManagedCredentials> {
  const deadline = Date.parse(input.expiresAt)
  let interval = input.intervalSeconds * 1000
  for (;;) {
    if (input.signal.aborted) throw new Error('Kiro company SSO login cancelled')
    if (Date.now() >= deadline) throw new Error('Kiro company SSO device code expired')
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: input.organization.clientId,
      device_code: input.deviceCode,
    })
    const response = await input.request(input.discovery.tokenEndpoint, form, input.signal)
    const body = typeof response.body === 'object' && response.body !== null
      ? response.body as Record<string, unknown>
      : undefined
    if (response.status === 200 && typeof body?.access_token === 'string') {
      return credentialsFromToken(body, input.organization, input.discovery.tokenEndpoint)
    }
    const code = errorCodeOf(body)
    if (code === 'authorization_pending') {
      await pause(Math.min(interval, Math.max(0, deadline - Date.now())), input.signal)
      continue
    }
    if (code === 'slow_down') {
      interval += 5_000
      await pause(Math.min(interval, Math.max(0, deadline - Date.now())), input.signal)
      continue
    }
    if (code === 'expired_token' || code === 'code_expired') {
      throw new Error('Kiro company SSO device code expired')
    }
    if (code === 'access_denied' || code === 'authorization_declined') {
      throw new Error('Kiro company SSO sign-in was declined in the browser')
    }
    throw new Error(`Kiro external IdP device sign-in failed: ${errorDetailOf(response)}${ssoGuidance(errorDetailOf(response))}`)
  }
}

/** Listen on one loopback address, resolving with the port the OS assigned. */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Kiro portal callback server did not expose a port'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // A browser keeps its callback connection alive; without dropping it the
    // server never finishes closing and the caller hangs instead of returning.
    server.closeAllConnections()
    server.close(() => { resolve() })
  })
}

function isMissingIpv6(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'EPROTO'
}

/**
 * Claim a loopback port for both address families.
 *
 * `localhost` resolves to ::1 or 127.0.0.1 depending on the browser, so a port
 * another process holds on either address would otherwise answer the callback
 * with someone else's state and fail the login.
 */
async function bind(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  ports: readonly number[],
): Promise<{ servers: Server[]; port: number }> {
  let lastError: unknown
  for (const port of ports) {
    const servers: Server[] = []
    try {
      const ipv4 = createServer(handler)
      const bound = await listen(ipv4, port, '127.0.0.1')
      servers.push(ipv4)
      const ipv6 = createServer(handler)
      try {
        await listen(ipv6, bound, '::1')
        servers.push(ipv6)
      } catch (error: unknown) {
        ipv6.close()
        // IPv6 is optional; a host without it still signs in over IPv4.
        if (!isMissingIpv6(error)) throw error
      }
      return { servers, port: bound }
    } catch (error: unknown) {
      await Promise.all(servers.map(closeServer))
      lastError = error
    }
  }
  throw new Error('dsh-kiro: no loopback port was available for the Kiro portal login', {
    cause: lastError,
  })
}

function respond(response: ServerResponse, title: string, detail: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + '<body style="font-family:system-ui,sans-serif;padding:32px;line-height:1.5">'
    + `<h2>${title}</h2><p>${detail}</p></body></html>`)
}

/** Default JSON transport for discovery lookups. */
export async function defaultJsonTransport(
  url: string,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { signal })
  const raw = await response.text()
  try {
    return { status: response.status, body: JSON.parse(raw) as unknown }
  } catch {
    // Discovery is JSON; keep the raw text so a failure names what came back.
    return { status: response.status, body: raw }
  }
}

/** Default form transport for the external IdP token endpoint. */
export async function defaultFormTransport(
  url: string,
  form: URLSearchParams,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal,
  })
  const raw = await response.text()
  try {
    return { status: response.status, body: JSON.parse(raw) as unknown }
  } catch {
    return { status: response.status, body: raw }
  }
}

/** Start the loopback listener the portal and the company IdP both call back on. */
export async function startPortalLogin(
  options: PortalLoginOptions = {},
  transport: PortalJsonTransport = defaultJsonTransport,
  signal?: AbortSignal,
): Promise<PortalLogin> {
  const portalUrl = options.portalUrl ?? DEFAULT_PORTAL_URL
  const redirectHost = options.redirectHost ?? 'localhost'
  const timeoutMs = options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS
  const state = randomUUID()
  const portalPkce = pkcePair()

  let resolveOrganization: (value: PortalOrganization) => void = () => {}
  let rejectOrganization: (error: Error) => void = () => {}
  const organization = new Promise<PortalOrganization>((resolve, reject) => {
    resolveOrganization = resolve
    rejectOrganization = reject
  })
  // Rejections are observed by whoever awaits; this keeps an unused flow quiet.
  organization.catch(() => {})

  let pending: PendingIdpCallback | undefined
  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', `http://${redirectHost}:0`)
    if (PORTAL_CALLBACK_PATHS.has(url.pathname)) {
      try {
        const resolved = parsePortalOrganization(url.searchParams, state)
        resolveOrganization(resolved)
        respond(response, 'Kiro 登录继续完成', '组织已识别，回到设置页或终端继续完成公司 SSO 登录。')
      } catch (error: unknown) {
        const failure = error instanceof Error ? error : new Error(String(error))
        rejectOrganization(failure)
        respond(response, 'Kiro 登录失败', '登录回调校验未通过，请回到设置页重试。')
      }
      return
    }
    if (url.pathname === IDP_CALLBACK_PATH) {
      const expected = pending
      const callbackState = text(url.searchParams.get('state'))
      const failure = text(url.searchParams.get('error_description'))
        ?? text(url.searchParams.get('error'))
      if (expected === undefined || callbackState !== expected.state) {
        expected?.reject(new Error('Kiro company SSO callback state does not match this login'))
        respond(response, 'Kiro 登录失败', '公司 SSO 回调 state 校验未通过，请重试。')
        return
      }
      if (failure !== undefined) {
        expected.reject(new Error(`Kiro company SSO returned an error: ${failure}${ssoGuidance(failure)}`))
        respond(response, 'Kiro 登录失败', '公司 SSO 返回错误，请回到设置页重试。')
        return
      }
      const code = text(url.searchParams.get('code'))
      if (code === undefined) {
        expected.reject(new Error('Kiro company SSO callback carried no authorization code'))
        respond(response, 'Kiro 登录失败', '公司 SSO 未返回授权码，请重试。')
        return
      }
      expected.resolve(code)
      respond(response, 'Kiro 登录完成', '公司 SSO 已授权，可以关闭此页面回到设置页。')
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  }

  const { servers, port } = await bind(handleRequest, options.ports ?? CALLBACK_PORTS)
  const redirectUri = `http://${redirectHost}:${String(port)}`

  const timer = setTimeout(() => {
    rejectOrganization(new Error('Kiro portal login timed out before the browser returned'))
    pending?.reject(new Error('Kiro company SSO login timed out'))
  }, timeoutMs)
  timer.unref()

  const onAbort = (): void => {
    rejectOrganization(new Error('Kiro portal login cancelled'))
    pending?.reject(new Error('Kiro company SSO login cancelled'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    await Promise.all(servers.map(closeServer))
  }

  return {
    portalUrl: portalSigninUrl({
      portalUrl,
      state,
      codeChallenge: portalPkce.challenge,
      redirectUri,
    }),
    redirectUri,
    port,
    organization,
    async beginExternalIdp(organizationValue, idpOptions = {}): Promise<ExternalIdpSignIn> {
      const idpSignal = idpOptions.signal ?? signal ?? new AbortController().signal
      const discovery = await discoverIdp(
        organizationValue.issuerUrl,
        idpOptions.discoveryRequest ?? transport,
        idpSignal,
      )
      const mode = idpOptions.mode ?? 'auto'
      const deviceEndpoint = discovery.deviceAuthorizationEndpoint
      const tryDevice = mode === 'device' || (mode === 'auto' && deviceEndpoint !== undefined)
      if (tryDevice) {
        try {
          const authorization = await startIdpDeviceAuthorization({
            organization: organizationValue,
            discovery,
            request: idpOptions.request ?? defaultFormTransport,
            signal: idpSignal,
          })
          return {
            authUrl: authorization.verificationUriComplete ?? authorization.verificationUri,
            userCode: authorization.userCode,
            credentials: pollIdpDeviceAuthorization({
              organization: organizationValue,
              discovery,
              deviceCode: authorization.deviceCode,
              intervalSeconds: authorization.intervalSeconds,
              expiresAt: authorization.expiresAt,
              request: idpOptions.request ?? defaultFormTransport,
              signal: idpSignal,
            }),
          }
        } catch (error: unknown) {
          // A registered app may advertise the grant but refuse it; the loopback
          // code flow is the only way left for those.
          if (mode === 'device') throw error
        }
      }
      const pair = pkcePair()
      const idpState = randomUUID()
      const redirect = `${redirectUri}${IDP_CALLBACK_PATH}`
      const code = new Promise<string>((resolve, reject) => {
        pending = { state: idpState, resolve, reject }
      })
      const credentials = code.then(async authorizationCode => await completeExternalIdpLogin({
        organization: organizationValue,
        discovery,
        code: authorizationCode,
        codeVerifier: pair.verifier,
        redirectUri: redirect,
        request: idpOptions.request ?? defaultFormTransport,
        signal: idpSignal,
      }))
      return {
        authUrl: externalIdpAuthorizationUrl({
          organization: organizationValue,
          discovery,
          redirectUri: redirect,
          state: idpState,
          codeChallenge: pair.challenge,
        }),
        credentials,
      }
    },
    close,
  }
}