import { connect } from 'node:net'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  completeExternalIdpLogin,
  discoverIdp,
  externalIdpAuthorizationUrl,
  parsePortalOrganization,
  pkcePair,
  pollIdpDeviceAuthorization,
  portalSigninUrl,
  startIdpDeviceAuthorization,
  startPortalLogin,
} from '../src/portal-login.ts'
import type { PortalFormTransport, PortalJsonTransport } from '../src/portal-login.ts'

const STATE = 'portal-state'
const ISSUER = 'https://login.microsoftonline.com/tenant/v2.0'
const SCOPES = 'api://client/codewhisperer:conversations api://client/codewhisperer:completions offline_access'

/** The callback the portal really sent for a work email it resolved to an external IdP. */
const PORTAL_CALLBACK = [
  'login_option=external_idp',
  'login_hint=r.shi%40trip.com',
  `issuer_url=${encodeURIComponent(ISSUER)}`,
  'client_id=client-id',
  `state=${STATE}`,
  `scopes=${encodeURIComponent(SCOPES)}`,
  'external_idp_region=us-east-1',
].join('&')

const DISCOVERY = {
  authorization_endpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
}

function discoveryTransport(): PortalJsonTransport {
  return vi.fn(async () => ({ status: 200, body: DISCOVERY }))
}

describe('portal sign-in URL', () => {
  it('carries the PKCE challenge and the loopback redirect Kiro uses', () => {
    const url = new URL(portalSigninUrl({
      portalUrl: 'https://app.kiro.dev',
      state: STATE,
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3128',
    }))
    expect(url.origin + url.pathname).toBe('https://app.kiro.dev/signin')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: STATE,
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      redirect_uri: 'http://localhost:3128',
      redirect_from: 'KiroIDE',
    })
  })

  it('keeps a portal URL that already carries a path', () => {
    const url = new URL(portalSigninUrl({
      portalUrl: 'https://portal.example/kiro/',
      state: STATE,
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3128',
    }))
    expect(url.pathname).toBe('/kiro/signin')
  })
})

describe('portal organization parsing', () => {
  it('reads the external IdP descriptor the portal returns for a work email', () => {
    expect(parsePortalOrganization(new URLSearchParams(PORTAL_CALLBACK), STATE)).toEqual({
      kind: 'external-idp',
      issuerUrl: ISSUER,
      clientId: 'client-id',
      region: 'us-east-1',
      scopes: SCOPES,
      loginHint: 'r.shi@trip.com',
    })
  })

  it('reads a social answer with its authorization code', () => {
    expect(parsePortalOrganization(
      new URLSearchParams({ login_option: 'google', code: 'abc', state: STATE }),
      STATE,
    )).toEqual({ kind: 'social', provider: 'google', code: 'abc', region: 'us-east-1' })
  })

  it('reads an Identity Center answer with its start URL and region', () => {
    expect(parsePortalOrganization(new URLSearchParams({
      login_option: 'awsidc',
      issuer_url: 'https://tripsso.awsapps.com/start',
      idc_region: 'ap-southeast-1',
      state: STATE,
    }), STATE)).toEqual({
      kind: 'identity-center',
      provider: 'awsidc',
      startUrl: 'https://tripsso.awsapps.com/start',
      region: 'ap-southeast-1',
    })
  })

  it('refuses a callback that belongs to another login', () => {
    expect(() => parsePortalOrganization(new URLSearchParams(PORTAL_CALLBACK), 'other-state'))
      .toThrow(/state does not match/u)
  })

  it('surfaces the portal error message', () => {
    expect(() => parsePortalOrganization(new URLSearchParams({
      state: STATE,
      error_message: 'That email is not part of an organization',
    }), STATE)).toThrow(/That email is not part of an organization/u)
  })

  it('rejects an external IdP answer without a client', () => {
    expect(() => parsePortalOrganization(new URLSearchParams({
      login_option: 'external_idp',
      issuer_url: ISSUER,
      scopes: SCOPES,
      state: STATE,
    }), STATE)).toThrow(/missing its issuer, client, or scopes/u)
  })
})

describe('external IdP authorization', () => {
  const organization = {
    kind: 'external-idp' as const,
    issuerUrl: ISSUER,
    clientId: 'client-id',
    region: 'us-east-1',
    scopes: SCOPES,
    loginHint: 'r.shi@trip.com',
  }

  it('asks for consent only when the scopes can yield a refresh token', () => {
    const url = new URL(externalIdpAuthorizationUrl({
      organization,
      discovery: { authorizationEndpoint: DISCOVERY.authorization_endpoint, tokenEndpoint: DISCOVERY.token_endpoint },
      redirectUri: 'http://localhost:3128/callback',
      state: 'idp-state',
      codeChallenge: 'challenge',
    }))
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('login_hint')).toBe('r.shi@trip.com')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe(SCOPES)
  })

  it('reads the endpoints out of the discovery document', async () => {
    expect(await discoverIdp(ISSUER, discoveryTransport(), AbortSignal.timeout(1000)))
      .toEqual({ authorizationEndpoint: DISCOVERY.authorization_endpoint, tokenEndpoint: DISCOVERY.token_endpoint })
  })

  it('turns the authorization code into Kiro-shaped credentials', async () => {
    const request: PortalFormTransport = vi.fn(async () => ({
      status: 200,
      body: { access_token: 'access', refresh_token: 'refresh', expires_in: 1800 },
    }))
    const credentials = await completeExternalIdpLogin({
      organization,
      discovery: { authorizationEndpoint: DISCOVERY.authorization_endpoint, tokenEndpoint: DISCOVERY.token_endpoint },
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:3128/callback',
      request,
      signal: AbortSignal.timeout(1000),
    })
    expect(request).toHaveBeenCalledWith(
      DISCOVERY.token_endpoint,
      expect.any(URLSearchParams),
      expect.any(AbortSignal),
    )
    const form = (request as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as URLSearchParams
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-id',
      code: 'code',
      redirect_uri: 'http://localhost:3128/callback',
      code_verifier: 'verifier',
      scope: SCOPES,
    })
    expect(credentials).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      authMethod: 'external_idp',
      clientId: 'client-id',
      tokenEndpoint: DISCOVERY.token_endpoint,
      scope: SCOPES,
      region: 'us-east-1',
    })
  })

  it('points at the local sign-in when the IdP refuses this callback', async () => {
    const refusal = 'AADSTS50011: The redirect URI \'http://localhost:3128/callback\' specified in the request'
      + ' does not match the redirect URIs configured for the application \'client-id\'.'
    const request: PortalFormTransport = vi.fn(async () => ({
      status: 400,
      body: { error: 'invalid_request', error_description: refusal },
    }))

    await expect(completeExternalIdpLogin({
      organization,
      discovery: { authorizationEndpoint: DISCOVERY.authorization_endpoint, tokenEndpoint: DISCOVERY.token_endpoint },
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:3128/callback',
      request,
      signal: AbortSignal.timeout(2_000),
    })).rejects.toThrow(/AADSTS50011[\s\S]*--method local/u)
  })

  it('names what the IdP said when the exchange fails', async () => {
    const request: PortalFormTransport = vi.fn(async () => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'AADSTS70008: expired' },
    }))
    await expect(completeExternalIdpLogin({
      organization,
      discovery: { authorizationEndpoint: DISCOVERY.authorization_endpoint, tokenEndpoint: DISCOVERY.token_endpoint },
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://localhost:3128/callback',
      request,
      signal: AbortSignal.timeout(1000),
    })).rejects.toThrow(/AADSTS70008/u)
  })
})

describe('loopback login session', () => {
  it('resolves the organization from the portal callback, then the credentials from the IdP', async () => {
    const session = await startPortalLogin({ ports: [0] }, discoveryTransport())
    try {
      const portal = new URL(session.portalUrl)
      expect(portal.searchParams.get('redirect_uri')).toBe(session.redirectUri)
      const portalState = portal.searchParams.get('state')

      const callback = new URL(`${session.redirectUri}/signin/callback?${PORTAL_CALLBACK}`)
      callback.searchParams.set('state', String(portalState))
      const answer = await fetch(callback)
      expect(answer.status).toBe(200)

      const organization = await session.organization
      expect(organization.kind).toBe('external-idp')

      const request: PortalFormTransport = vi.fn(async () => ({
        status: 200,
        body: { access_token: 'access', refresh_token: 'refresh', expires_in: 1800 },
      }))
      const idp = await session.beginExternalIdp(
        organization as Extract<typeof organization, { kind: 'external-idp' }>,
        { request, discoveryRequest: discoveryTransport() },
      )
      const authorize = new URL(idp.authUrl)
      const idpState = authorize.searchParams.get('state')
      expect(authorize.searchParams.get('redirect_uri')).toBe(`${session.redirectUri}/callback`)

      await fetch(`${session.redirectUri}/callback?code=idp-code&state=${String(idpState)}`)
      await expect(idp.credentials).resolves.toMatchObject({ accessToken: 'access', authMethod: 'external_idp' })
    } finally {
      await session.close()
    }
  })

  it('rejects the organization when the user cancels', async () => {
    const controller = new AbortController()
    const session = await startPortalLogin({ ports: [0] }, discoveryTransport(), controller.signal)
    try {
      controller.abort()
      await expect(session.organization).rejects.toThrow(/cancelled/u)
    } finally {
      await session.close()
    }
  })

  it('closes even while a browser still holds its keep-alive connection', async () => {
    const session = await startPortalLogin({ ports: [0] }, discoveryTransport())
    const port = new URL(session.redirectUri).port
    const socket = connect({ host: '127.0.0.1', port: Number(port) })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => { resolve() })
      socket.once('error', reject)
    })
    try {
      await expect(session.close()).resolves.toBeUndefined()
    } finally {
      socket.destroy()
    }
  })

  it('skips a port another process already holds on one address family', async () => {
    const squatter = createServer((_request, response) => { response.end('not kiro') })
    const taken = await new Promise<number>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(0, '127.0.0.1', () => {
        const address = squatter.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    const session = await startPortalLogin({ ports: [taken, 0] }, discoveryTransport())
    try {
      expect(new URL(session.redirectUri).port).not.toBe(String(taken))
      // The callback must still reach this login, not whoever holds that port.
      const portal = new URL(session.portalUrl)
      const callback = new URL(`${session.redirectUri}/signin/callback?${PORTAL_CALLBACK}`)
      callback.searchParams.set('state', String(portal.searchParams.get('state')))
      expect((await fetch(callback)).status).toBe(200)
      await expect(session.organization).resolves.toMatchObject({ kind: 'external-idp' })
    } finally {
      await session.close()
      await new Promise<void>(resolve => { squatter.close(() => { resolve() }) })
    }
  })
})

describe('company IdP device sign-in', () => {
  const ORGANIZATION = {
    kind: 'external-idp',
    issuerUrl: ISSUER,
    clientId: 'client-id',
    region: 'us-east-1',
    scopes: SCOPES,
  } as const
  const DEVICE_DISCOVERY = {
    ...DISCOVERY,
    device_authorization_endpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/devicecode',
  }
  /** The same document, already read into discovery fields. */
  const DEVICE_FIELDS = {
    authorizationEndpoint: DISCOVERY.authorization_endpoint,
    tokenEndpoint: DISCOVERY.token_endpoint,
    deviceAuthorizationEndpoint: DEVICE_DISCOVERY.device_authorization_endpoint,
  }

  function deviceDiscovery(): PortalJsonTransport {
    return vi.fn(async () => ({ status: 200, body: DEVICE_DISCOVERY }))
  }

  /** A form transport that answers the device endpoints in a scripted order. */
  function deviceTransport(answers: { status: number; body: unknown }[]): PortalFormTransport {
    return vi.fn(async (_url: string, form: URLSearchParams) => {
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        return answers.shift() ?? { status: 400, body: { error: 'authorization_pending' } }
      }
      return {
        status: 200,
        body: {
          device_code: 'device-code',
          user_code: 'SH478SLVN',
          verification_uri: 'https://login.microsoft.com/device',
          verification_uri_complete: 'https://login.microsoft.com/device?code=SH478SLVN',
          expires_in: 900,
          interval: 1,
        },
      }
    })
  }

  it('reads the device code the IdP hands back', async () => {
    const request = deviceTransport([])
    const authorization = await startIdpDeviceAuthorization({
      organization: ORGANIZATION,
      discovery: DEVICE_FIELDS,
      request,
      signal: AbortSignal.timeout(2_000),
    })
    expect(authorization).toMatchObject({ userCode: 'SH478SLVN', intervalSeconds: 1 })
    expect(authorization.verificationUriComplete).toBe('https://login.microsoft.com/device?code=SH478SLVN')
    const form = (request as unknown as { mock: { calls: [string, URLSearchParams][] } }).mock.calls[0]![1]
    expect(form.get('client_id')).toBe('client-id')
    expect(form.get('scope')).toBe(SCOPES)
  })

  it('polls through authorization_pending and stops at the token', async () => {
    const request = deviceTransport([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'access', refresh_token: 'refresh', expires_in: 1800 } },
    ])
    const authorization = await startIdpDeviceAuthorization({
      organization: ORGANIZATION,
      discovery: DEVICE_FIELDS,
      request,
      signal: AbortSignal.timeout(2_000),
    })
    const credentials = await pollIdpDeviceAuthorization({
      organization: ORGANIZATION,
      discovery: DEVICE_FIELDS,
      deviceCode: authorization.deviceCode,
      intervalSeconds: 0,
      expiresAt: authorization.expiresAt,
      request,
      signal: AbortSignal.timeout(2_000),
    })
    expect(credentials).toMatchObject({ accessToken: 'access', authMethod: 'external_idp', clientId: 'client-id' })
  })

  it('reports a declined sign-in and an expired code', async () => {
    for (const [error, message] of [['access_denied', /declined/u], ['expired_token', /expired/u]] as const) {
      const request = deviceTransport([{ status: 400, body: { error } }])
      await expect(pollIdpDeviceAuthorization({
        organization: ORGANIZATION,
        discovery: DEVICE_FIELDS,
        deviceCode: 'device-code',
        intervalSeconds: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        request,
        signal: AbortSignal.timeout(2_000),
      })).rejects.toThrow(message)
    }
  })

  it('takes the device grant when the IdP offers it, without a loopback callback', async () => {
    const session = await startPortalLogin({ ports: [0] }, deviceDiscovery())
    try {
      const signIn = await session.beginExternalIdp(ORGANIZATION, {
        request: deviceTransport([{ status: 200, body: { access_token: 'access', expires_in: 60 } }]),
        discoveryRequest: deviceDiscovery(),
      })
      expect(signIn.userCode).toBe('SH478SLVN')
      expect(signIn.authUrl).toBe('https://login.microsoft.com/device?code=SH478SLVN')
      await expect(signIn.credentials).resolves.toMatchObject({ accessToken: 'access' })
    } finally {
      await session.close()
    }
  })

  it('falls back to the loopback grant when the IdP refuses the device grant', async () => {
    const request: PortalFormTransport = vi.fn(async (_url: string, form: URLSearchParams) => {
      if (form.get('client_id') !== undefined && form.get('device_code') === null
        && form.get('grant_type') === null && form.get('scope') !== null) {
        return { status: 400, body: { error: 'invalid_client', error_description: 'AADSTS7000218' } }
      }
      return { status: 200, body: { access_token: 'access', expires_in: 60 } }
    })
    const session = await startPortalLogin({ ports: [0] }, deviceDiscovery())
    try {
      const signIn = await session.beginExternalIdp(ORGANIZATION, { request, discoveryRequest: deviceDiscovery() })
      expect(signIn.userCode).toBeUndefined()
      expect(signIn.authUrl).toContain('/authorize?')
      const authorize = new URL(signIn.authUrl)
      await fetch(`${session.redirectUri}/callback?code=idp-code&state=${String(authorize.searchParams.get('state'))}`)
      await expect(signIn.credentials).resolves.toMatchObject({ accessToken: 'access' })
    } finally {
      await session.close()
    }
  })
})

describe('PKCE pair', () => {
  it('is a base64url verifier with a SHA-256 challenge', () => {
    const pair = pkcePair()
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(pair.challenge).not.toBe(pair.verifier)
  })
})