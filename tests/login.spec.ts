import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTokenCache, resolveTokenFromDirectories } from '../src/auth.ts'
import {
  BUILDER_START_URL,
  credentialSummary,
  deleteDeviceCredentials,
  importApiKey,
  importExternalIdp,
  importRefreshToken,
  pollDeviceLogin,
  pollSocialDeviceLogin,
  resolveRefreshTokenOrigin,
  saveDeviceCredentials,
  startDeviceLogin,
  startSocialDeviceLogin,
} from '../src/login.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  clearTokenCache()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-test-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Builder ID login', () => {
  it('registers a Kiro client and starts device authorization', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { clientId: 'client', clientSecret: 'secret' } })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          deviceCode: 'device',
          userCode: 'ABCD-EFGH',
          verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
          interval: 2,
          expiresIn: 600,
        },
      })
    const session = await startDeviceLogin('us-east-1', request, new AbortController().signal)
    expect(session).toMatchObject({
      clientId: 'client',
      deviceCode: 'device',
      userCode: 'ABCD-EFGH',
      intervalSeconds: 2,
      region: 'us-east-1',
      authMethod: 'builder-id',
      startUrl: 'https://view.awsapps.com/start',
    })
    expect(request.mock.calls[0]?.[0]).toBe('https://oidc.us-east-1.amazonaws.com/client/register')
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      clientName: 'kiro-oauth-client',
      clientType: 'public',
      issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6',
    })
    expect(request.mock.calls[1]?.[0]).toBe('https://oidc.us-east-1.amazonaws.com/device_authorization')
  })

  it('uses a custom IAM Identity Center start URL', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { clientId: 'client', clientSecret: 'secret' } })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          deviceCode: 'device',
          userCode: 'code',
          verificationUri: 'https://device.sso.eu-central-1.amazonaws.com/',
        },
      })
    const session = await startDeviceLogin('eu-central-1', request, new AbortController().signal, {
      authMethod: 'idc',
      startUrl: 'https://company.awsapps.com/start',
    })
    expect(session).toMatchObject({ authMethod: 'idc', region: 'eu-central-1' })
    expect(request.mock.calls[1]?.[1]).toMatchObject({ startUrl: 'https://company.awsapps.com/start' })
  })

  it('rejects a verification URL outside AWS', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { clientId: 'client', clientSecret: 'secret' } })
      .mockResolvedValueOnce({
        status: 200,
        body: { deviceCode: 'device', userCode: 'code', verificationUri: 'https://evil.example/login' },
      })
    await expect(startDeviceLogin('us-east-1', request, new AbortController().signal))
      .rejects.toThrow(/unsafe verification URL/u)
  })

  it('rejects a region that could redirect OIDC away from AWS', async () => {
    await expect(startDeviceLogin('us-east-1/../../evil.example', vi.fn(), new AbortController().signal))
      .rejects.toThrow(/invalid AWS region/u)
  })

  it('handles pending, slow-down, and completed token polls', async () => {
    const session = {
      clientId: 'client',
      clientSecret: 'secret',
      deviceCode: 'device',
      userCode: 'code',
      verificationUri: 'https://device.sso.us-east-1.amazonaws.com/',
      intervalSeconds: 2,
      expiresAt: Date.now() + 60_000,
      region: 'us-east-1',
      authMethod: 'builder-id' as const,
      startUrl: 'https://view.awsapps.com/start',
    }
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 400, body: { error: 'authorization_pending' } })
      .mockResolvedValueOnce({ status: 400, body: { error: 'slow_down' } })
      .mockResolvedValueOnce({
        status: 200,
        body: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 },
      })
    const signal = new AbortController().signal
    await expect(pollDeviceLogin(session, request, signal)).resolves.toEqual({
      status: 'pending', intervalSeconds: 2,
    })
    await expect(pollDeviceLogin(session, request, signal)).resolves.toEqual({
      status: 'pending', intervalSeconds: 7,
    })
    await expect(pollDeviceLogin(session, request, signal)).resolves.toMatchObject({
      status: 'completed',
      credentials: { accessToken: 'access', refreshToken: 'refresh', region: 'us-east-1' },
    })
  })
})

describe('managed credentials', () => {
  it('writes private files, reports status, resolves them, and deletes only those files', async () => {
    const directory = await temporary()
    await saveDeviceCredentials(directory, {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client',
      clientSecret: 'secret',
      region: 'eu-central-1',
      authMethod: 'builder-id',
    })
    await expect(credentialSummary(directory)).resolves.toMatchObject({
      authenticated: true,
      region: 'eu-central-1',
    })
    const tokenFile = join(directory, 'kiro-auth-token.json')
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600)
    await expect(resolveTokenFromDirectories([directory], {
      expiryBufferMs: 0,
      fetchJson: async () => { throw new Error('refresh should not run') },
    })).resolves.toMatchObject({ accessToken: 'access', region: 'eu-central-1' })
    const parsed = JSON.parse(await readFile(tokenFile, 'utf8')) as { clientIdHash: string }
    const unrelated = join(directory, 'keep.json')
    await writeFile(unrelated, '{}')
    await deleteDeviceCredentials(directory)
    await expect(credentialSummary(directory)).resolves.toEqual({ authenticated: false })
    await expect(readFile(join(directory, `${parsed.clientIdHash}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('{}')
  })

  it('falls back to Kiro IDE credentials only when managed credentials are absent', async () => {
    const root = await temporary()
    const managed = join(root, 'managed')
    const external = join(root, 'external')
    await mkdir(external)
    await writeFile(join(external, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'external-access',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'us-east-1',
    }))
    await expect(resolveTokenFromDirectories([managed, external], {
      expiryBufferMs: 0,
      fetchJson: async () => { throw new Error('refresh should not run') },
    })).resolves.toMatchObject({ accessToken: 'external-access' })
  })
})

describe('additional Kiro auth methods', () => {
  it('starts Google login through Kiro\'s coded device flow', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        deviceCode: 'device',
        userCode: 'XWIS-WIJO',
        verificationUri: 'https://app.kiro.dev/account/device',
        verificationUriComplete: 'https://app.kiro.dev/account/device?user_code=XWIS-WIJO&login_provider=Google',
        expiresInMilliseconds: 300_000,
        intervalInMilliseconds: 5000,
      },
    })
    const signal = new AbortController().signal
    const session = await startSocialDeviceLogin('google', request, signal)

    expect(session).toMatchObject({
      provider: 'google',
      userCode: 'XWIS-WIJO',
      verificationUri: 'https://app.kiro.dev/account/device?user_code=XWIS-WIJO&login_provider=Google',
      intervalSeconds: 5,
    })
    expect(request.mock.calls[0]).toEqual([
      'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization',
      { clientId: 'kiro-cli', loginProvider: 'Google' },
      signal,
    ])

    const poll = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        body: {
          accessToken: null,
          refreshToken: null,
          profileArn: null,
          status: 'authorization_pending',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          accessToken: 'access',
          refreshToken: 'refresh',
          profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/social',
          status: 'success',
        },
      })
    await expect(pollSocialDeviceLogin(session, poll, signal)).resolves.toEqual({
      status: 'pending', intervalSeconds: 5,
    })
    await expect(pollSocialDeviceLogin(session, poll, signal)).resolves.toMatchObject({
      status: 'completed',
      credentials: {
        authMethod: 'google',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/social',
      },
    })
    expect(poll.mock.calls[0]).toEqual([
      'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/poll',
      { clientId: 'kiro-cli', deviceCode: 'device' },
      signal,
    ])
  })

  it('rejects a Kiro social device URL outside app.kiro.dev', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        deviceCode: 'device',
        userCode: 'ABCD-EFGH',
        verificationUriComplete: 'https://evil.example/account/device?user_code=ABCD-EFGH',
      },
    })
    await expect(startSocialDeviceLogin('github', request, new AbortController().signal))
      .rejects.toThrow(/unexpected social verification URL/u)
  })

  it('validates API keys on the Amazon Q surface with TokenType', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { models: [{ modelId: 'claude-sonnet' }] },
    })
    // The import now reports what it verified alongside the credential, so the
    // page can confirm the key works rather than only that it was stored.
    await expect(importApiKey(' api-key ', 'us-west-2', request, new AbortController().signal))
      .resolves.toMatchObject({
        credentials: { accessToken: 'api-key', authMethod: 'api_key', region: 'us-west-2' },
        models: 1,
      })
    expect(request.mock.calls[0]?.[0]).toContain('https://q.us-east-1.amazonaws.com/ListAvailableModels')
    expect(request.mock.calls[0]?.[1]).toMatchObject({ TokenType: 'API_KEY' })
  })

  it('normalizes external IdP JSON and rejects arbitrary refresh hosts', () => {
    const valid = {
      access_token: 'access',
      refresh_token: 'refresh',
      client_id: 'client',
      token_endpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      scopes: ['openid', 'profile'],
      profile_arn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/external',
      region: 'eu-central-1',
    }
    expect(importExternalIdp(JSON.stringify(valid))).toMatchObject({
      authMethod: 'external_idp',
      scope: 'openid profile',
      region: 'eu-central-1',
    })
    expect(() => importExternalIdp({ ...valid, token_endpoint: 'https://evil.example/token' }))
      .toThrow(/approved Microsoft login host/u)
  })
})

describe('refresh-token import by credential origin', () => {
  const refreshed = {
    status: 200,
    body: { accessToken: 'access', refreshToken: 'rotated', expiresIn: 3600 },
  }

  /** One import against a stubbed token endpoint. */
  async function importToken(input: Parameters<typeof importRefreshToken>[0]) {
    const request = vi.fn().mockResolvedValue(refreshed)
    const credentials = await importRefreshToken(input, request, new AbortController().signal)
    return { credentials, url: request.mock.calls[0]?.[0] as string, body: request.mock.calls[0]?.[1] }
  }

  it('refreshes a bare Kiro token against Kiro’s own service', async () => {
    const { credentials, url, body } = await importToken({ refreshToken: 'kiro-refresh' })
    expect(url).toBe('https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
    expect(body).toEqual({ refreshToken: 'kiro-refresh' })
    expect(credentials).toMatchObject({ authMethod: 'imported', refreshToken: 'rotated' })
    expect(credentials.clientId).toBeUndefined()
  })

  it('records an explicit Builder ID origin instead of guessing Identity Center', async () => {
    // Builder ID credentials carry a client id and secret too, so presence of
    // client credentials cannot decide the origin: guessing `idc` would send
    // every later turn to the wrong upstream surface.
    const { credentials, url } = await importToken({
      refreshToken: 'aws-refresh',
      clientId: 'client',
      clientSecret: 'secret',
      authMethod: 'builder-id',
    })
    expect(url).toBe('https://oidc.us-east-1.amazonaws.com/token')
    expect(credentials).toMatchObject({
      authMethod: 'builder-id',
      clientId: 'client',
      startUrl: BUILDER_START_URL,
    })
  })

  it('records an Identity Center origin with its start URL', async () => {
    const { credentials, url } = await importToken({
      refreshToken: 'aws-refresh',
      clientId: 'client',
      clientSecret: 'secret',
      startUrl: 'https://example.awsapps.com/start',
      authMethod: 'idc',
    })
    expect(url).toBe('https://oidc.us-east-1.amazonaws.com/token')
    expect(credentials).toMatchObject({
      authMethod: 'idc',
      startUrl: 'https://example.awsapps.com/start',
    })
  })

  it('derives Builder ID for AWS client credentials with no organization start URL', async () => {
    const { credentials } = await importToken({
      refreshToken: 'aws-refresh',
      clientId: 'client',
      clientSecret: 'secret',
    })
    expect(credentials.authMethod).toBe('builder-id')
  })

  it('derives Identity Center only from an organization start URL', async () => {
    const { credentials } = await importToken({
      refreshToken: 'aws-refresh',
      clientId: 'client',
      clientSecret: 'secret',
      startUrl: 'https://example.awsapps.com/start',
    })
    expect(credentials.authMethod).toBe('idc')
    expect(resolveRefreshTokenOrigin(undefined, true, BUILDER_START_URL)).toBe('builder-id')
  })

  it('rejects mixed credentials instead of choosing an endpoint for them', () => {
    expect(() => resolveRefreshTokenOrigin('imported', true, undefined))
      .toThrow(/takes no OIDC client id or secret/u)
    expect(() => resolveRefreshTokenOrigin('builder-id', false, undefined))
      .toThrow(/require their client id and client secret/u)
    expect(() => resolveRefreshTokenOrigin('idc', true, undefined))
      .toThrow(/require their start URL/u)
  })

  it('still refuses a half-supplied client credential pair', async () => {
    await expect(importRefreshToken(
      { refreshToken: 'token', clientId: 'client' },
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow(/must be provided together/u)
  })
})
