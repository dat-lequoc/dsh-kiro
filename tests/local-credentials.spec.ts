import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localKiroCredentialFiles, readLocalKiroCredentials, refreshLocalKiroCredentials, writeLocalKiroToken } from '../src/local-credentials.ts'
import { createKiroStore as storeWith, removeKiroStores } from './kiro-store.ts'

afterEach(removeKiroStores)

const REGISTRATION = {
  client_id: 'KQG1rbfwJI2io8FxWOth7WFwLXNvdXRoZWFzdC0x',
  client_secret: 'secret-jwt',
  client_secret_expires_at: '2027-02-02T08:51:38Z',
  region: 'ap-southeast-1',
  oauth_flow: 'PKCE',
  scopes: ['codewhisperer:completions', 'codewhisperer:conversations'],
}

const TOKEN = {
  access_token: 'access-value',
  refresh_token: 'refresh-value',
  expires_at: '2026-11-25T16:50:37Z',
  region: 'ap-southeast-1',
  start_url: 'https://tripsso.awsapps.com/start',
  oauth_flow: 'PKCE',
  scopes: ['codewhisperer:completions', 'codewhisperer:conversations'],
}

describe('readLocalKiroCredentials', () => {
  it('reads the identity-center sign-in a Kiro CLI stored', async () => {
    const file = await storeWith({
      'kirocli:odic:token': TOKEN,
      'kirocli:odic:device-registration': REGISTRATION,
    })

    const found = await readLocalKiroCredentials({ file })

    expect(found.key).toBe('kirocli:odic:token')
    expect(found.file).toBe(file)
    expect(found.credentials).toEqual({
      accessToken: 'access-value',
      refreshToken: 'refresh-value',
      expiresAt: '2026-11-25T16:50:37.000Z',
      region: 'ap-southeast-1',
      authMethod: 'idc',
      clientId: REGISTRATION.client_id,
      clientSecret: 'secret-jwt',
      startUrl: 'https://tripsso.awsapps.com/start',
      scope: 'codewhisperer:completions codewhisperer:conversations',
      storeFile: file,
      storeKey: 'kirocli:odic:token',
    })
  })

  it('reports a Builder ID sign-in as builder-id', async () => {
    const file = await storeWith({
      'kirocli:odic:token': { ...TOKEN, start_url: 'https://view.awsapps.com/start' },
    })

    const found = await readLocalKiroCredentials({ file })

    expect(found.credentials.authMethod).toBe('builder-id')
    expect(found.credentials.startUrl).toBe('https://view.awsapps.com/start')
  })

  it('keeps the profile ARN the CLI stored, so no lookup is needed', async () => {
    const profileArn = 'arn:aws:codewhisperer:us-east-1:319585546877:profile/HDYWH4GRKMUY'
    const file = await storeWith({
      'kirocli:odic:token': { ...TOKEN, profile_arn: profileArn },
    })

    const found = await readLocalKiroCredentials({ file })

    expect(found.credentials.profileArn).toBe(profileArn)
  })

  it('turns an epoch-second expiry into an ISO timestamp', async () => {
    const file = await storeWith({
      'kirocli:odic:token': { ...TOKEN, expires_at: 1_800_000_000 },
    })

    const found = await readLocalKiroCredentials({ file })

    expect(found.credentials.expiresAt).toBe(new Date(1_800_000_000_000).toISOString())
  })

  it('keeps an external IdP token on the endpoint it was issued for', async () => {
    const file = await storeWith({
      'kirocli:external_idp:token': {
        access_token: 'access-value',
        refresh_token: 'refresh-value',
        expires_at: '2026-11-25T16:50:37Z',
        region: 'us-east-1',
        token_endpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
        client_id: 'client-id',
        scopes: ['api://client/codewhisperer:conversations'],
      },
    })

    const found = await readLocalKiroCredentials({ file })

    expect(found.credentials.authMethod).toBe('external_idp')
    expect(found.credentials.tokenEndpoint).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/token')
    expect(found.credentials.clientId).toBe('client-id')
  })

  it('names the probed stores when none exists', async () => {
    const missing = join(tmpdir(), 'dsh-kiro-missing', 'data.sqlite3')

    await expect(readLocalKiroCredentials({ file: missing })).rejects.toThrow(/KIRO_CLI_DATA_FILE/u)
  })

  it('refuses a store that only holds a registration', async () => {
    const file = await storeWith({ 'kirocli:odic:device-registration': REGISTRATION })

    await expect(readLocalKiroCredentials({ file })).rejects.toThrow(/kiro-cli login/u)
  })
})

describe('localKiroCredentialFiles', () => {
  it('honours KIRO_CLI_DATA_FILE over the platform probe', () => {
    expect(localKiroCredentialFiles({ KIRO_CLI_DATA_FILE: 'D:/custom/data.sqlite3' }))
      .toEqual(['D:/custom/data.sqlite3'])
  })

  it('probes the per-platform Kiro CLI stores otherwise', () => {
    const files = localKiroCredentialFiles({ LOCALAPPDATA: 'C:/Users/tester/AppData/Local' })

    expect(files.length).toBeGreaterThan(0)
    if (process.platform === 'win32') {
      expect(files).toContain(join('C:/Users/tester/AppData/Local', 'Kiro-Cli', 'data.sqlite3'))
    }
  })
})
describe('refreshLocalKiroCredentials', () => {
  const signal = AbortSignal.timeout(2_000)

  it('refreshes a stale IdC token against the region it came from', async () => {
    const file = await storeWith({
      'kirocli:odic:token': { ...TOKEN, expires_at: '2020-01-01T00:00:00Z' },
      'kirocli:odic:device-registration': REGISTRATION,
    })
    const found = await readLocalKiroCredentials({ file })
    const request = vi.fn(async () => ({
      status: 200,
      body: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresIn: 3600 },
    }))

    const refreshed = await refreshLocalKiroCredentials(found.credentials, request, signal)

    expect(request).toHaveBeenCalledWith('https://oidc.ap-southeast-1.amazonaws.com/token', expect.objectContaining({
      clientId: REGISTRATION.client_id,
      clientSecret: 'secret-jwt',
      refreshToken: 'refresh-value',
      grantType: 'refresh_token',
    }), signal)
    expect(refreshed).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh', authMethod: 'idc' })
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('leaves a token that is still fresh alone', async () => {
    const file = await storeWith({
      'kirocli:odic:token': { ...TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    })
    const found = await readLocalKiroCredentials({ file })
    const request = vi.fn()

    const credentials = await refreshLocalKiroCredentials(found.credentials, request, signal)

    expect(request).not.toHaveBeenCalled()
    expect(credentials).toEqual(found.credentials)
  })

  it('leaves an external IdP token to the resolver that owns its endpoint', async () => {
    const found = {
      credentials: {
        accessToken: 'access-value',
        refreshToken: 'refresh-value',
        expiresAt: '2020-01-01T00:00:00.000Z',
        region: 'us-east-1',
        authMethod: 'external_idp' as const,
        clientId: 'client-id',
        tokenEndpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      },
      file: 'unused',
      key: 'kirocli:external_idp:token',
    }
    const request = vi.fn()

    expect(await refreshLocalKiroCredentials(found.credentials, request, signal)).toBe(found.credentials)
    expect(request).not.toHaveBeenCalled()
  })

  it('leaves a token with nothing to refresh alone', async () => {
    const file = await storeWith({
      'kirocli:odic:token': { ...TOKEN, expires_at: '2020-01-01T00:00:00Z', refresh_token: undefined },
    })
    const found = await readLocalKiroCredentials({ file })
    const request = vi.fn()

    const credentials = await refreshLocalKiroCredentials(found.credentials, request, signal)

    expect(request).not.toHaveBeenCalled()
    expect(credentials.accessToken).toBe('access-value')
  })
})
const EXTERNAL_IDP_TOKEN = {
  access_token: 'old-access',
  refresh_token: 'old-refresh',
  expires_at: '2026-11-26T07:45:27.000Z',
  issuer_url: 'https://login.microsoftonline.com/tenant/v2.0',
  token_endpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
  client_id: 'client-id',
  scopes: 'api://client-id/codewhisperer:conversations offline_access',
}

describe('writeLocalKiroToken', () => {
  it('mirrors a rotation back into the store it was imported from', async () => {
    const file = await storeWith({ 'kirocli:external-idp:token': EXTERNAL_IDP_TOKEN })
    const rotated = '2026-11-26T09:00:00.000Z'

    await writeLocalKiroToken({
      file,
      key: 'kirocli:external-idp:token',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: rotated,
    })

    const found = await readLocalKiroCredentials({ file })
    expect(found.credentials).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: rotated,
      authMethod: 'external_idp',
      clientId: 'client-id',
      tokenEndpoint: EXTERNAL_IDP_TOKEN.token_endpoint,
      scope: EXTERNAL_IDP_TOKEN.scopes,
    })
  })

  it('keeps an array of scopes an array while replacing it', async () => {
    const file = await storeWith({ 'kirocli:odic:token': TOKEN })

    await writeLocalKiroToken({
      file,
      key: 'kirocli:odic:token',
      accessToken: 'new-access',
      expiresAt: '2026-11-26T09:00:00.000Z',
      scope: 'codewhisperer:completions codewhisperer:analysis',
    })

    const found = await readLocalKiroCredentials({ file })
    expect(found.credentials.scope).toBe('codewhisperer:completions codewhisperer:analysis')
    expect(found.credentials.accessToken).toBe('new-access')
  })

  it('names the row it can no longer find', async () => {
    const file = await storeWith({ 'kirocli:odic:token': TOKEN })

    await expect(writeLocalKiroToken({
      file,
      key: 'kirocli:missing:token',
      accessToken: 'new-access',
      expiresAt: '2026-11-26T09:00:00.000Z',
    })).rejects.toThrow(/no longer holds kirocli:missing:token/u)
  })
})

describe('refreshLocalKiroCredentials for an external IdP sign-in', () => {
  const signal = AbortSignal.timeout(2_000)

  it('refreshes the stale token as a form and mirrors the rotation back', async () => {
    const file = await storeWith({
      'kirocli:external-idp:token': { ...EXTERNAL_IDP_TOKEN, expires_at: '2020-01-01T00:00:00.000Z' },
    })
    const found = await readLocalKiroCredentials({ file })
    const request = vi.fn()
    const form = vi.fn().mockResolvedValue({
      status: 200,
      body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    })

    const credentials = await refreshLocalKiroCredentials(found.credentials, request, signal, form)

    expect(request).not.toHaveBeenCalled()
    expect(form.mock.calls[0]?.[0]).toBe(EXTERNAL_IDP_TOKEN.token_endpoint)
    const sent = form.mock.calls[0]?.[1] as URLSearchParams
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('client_id')).toBe('client-id')
    expect(sent.get('refresh_token')).toBe('old-refresh')
    expect(credentials).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      authMethod: 'external_idp',
    })
    const stored = await readLocalKiroCredentials({ file })
    expect(stored.credentials).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
  })

  it('reports a rejected refresh instead of reusing a dead token', async () => {
    const file = await storeWith({
      'kirocli:external-idp:token': { ...EXTERNAL_IDP_TOKEN, expires_at: '2020-01-01T00:00:00.000Z' },
    })
    const found = await readLocalKiroCredentials({ file })
    const form = vi.fn().mockResolvedValue({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired.' },
    })

    await expect(refreshLocalKiroCredentials(found.credentials, vi.fn(), signal, form))
      .rejects.toThrow(/AADSTS70008/u)
  })

  it('leaves an external IdP token alone when no form transport is available', async () => {
    const file = await storeWith({
      'kirocli:external-idp:token': { ...EXTERNAL_IDP_TOKEN, expires_at: '2020-01-01T00:00:00.000Z' },
    })
    const found = await readLocalKiroCredentials({ file })

    const credentials = await refreshLocalKiroCredentials(found.credentials, vi.fn(), signal)

    expect(credentials).toBe(found.credentials)
  })
})
