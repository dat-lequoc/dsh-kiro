import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTokenCache, resolveTokenFromDirectories } from '../src/auth.ts'
import {
  completeSocialLogin,
  credentialSummary,
  deleteDeviceCredentials,
  importApiKey,
  importExternalIdp,
  pollDeviceLogin,
  saveDeviceCredentials,
  startDeviceLogin,
  startSocialLogin,
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
  it('binds social login to its PKCE state and exchanges the callback code', async () => {
    const session = startSocialLogin('github')
    const authUrl = new URL(session.authUrl)
    expect(authUrl.searchParams.get('idp')).toBe('Github')
    expect(authUrl.searchParams.get('state')).toBe(session.state)
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        accessToken: 'social-access',
        refreshToken: 'social-refresh',
        expiresIn: 3600,
        profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/social',
      },
    })
    const callback = `kiro://kiro.kiroAgent/authenticate-success?code=code&state=${session.state}`
    await expect(completeSocialLogin(callback, session, request, new AbortController().signal))
      .resolves.toMatchObject({
        accessToken: 'social-access',
        authMethod: 'github',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/social',
      })
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      code: 'code',
      code_verifier: session.codeVerifier,
    })
    await expect(completeSocialLogin(
      'kiro://kiro.kiroAgent/authenticate-success?code=code&state=wrong',
      session,
      request,
      new AbortController().signal,
    )).rejects.toThrow(/state does not match/u)
  })

  it('validates API keys on the Amazon Q surface with TokenType', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: { models: [{ modelId: 'claude-sonnet' }] },
    })
    await expect(importApiKey(' api-key ', 'us-west-2', request, new AbortController().signal))
      .resolves.toMatchObject({ accessToken: 'api-key', authMethod: 'api_key', region: 'us-west-2' })
    expect(request.mock.calls[0]?.[0]).toContain('https://q.us-west-2.amazonaws.com/ListAvailableModels')
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
