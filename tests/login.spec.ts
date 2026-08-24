import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTokenCache, resolveTokenFromDirectories } from '../src/auth.ts'
import {
  credentialSummary,
  deleteDeviceCredentials,
  pollDeviceLogin,
  saveDeviceCredentials,
  startDeviceLogin,
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
    })
    expect(request.mock.calls[0]?.[0]).toBe('https://oidc.us-east-1.amazonaws.com/client/register')
    expect(request.mock.calls[0]?.[1]).toMatchObject({ clientName: 'Kiro', clientType: 'public' })
    expect(request.mock.calls[1]?.[0]).toBe('https://oidc.us-east-1.amazonaws.com/device_authorization')
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
