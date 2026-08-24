import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTokenCache, resolveTokenFromDirectories } from '../src/auth.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  clearTokenCache()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function credentialDirectory(value: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-auth-'))
  temporaryDirectories.push(directory)
  await writeFile(join(directory, 'kiro-auth-token.json'), JSON.stringify(value), { mode: 0o600 })
  return directory
}

describe('Kiro token resolution', () => {
  it('discovers and persists profile ARN for a managed current token', async () => {
    const directory = await credentialDirectory({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'us-east-1',
      authMethod: 'builder-id',
    })
    const resolveProfileArn = vi.fn().mockResolvedValue(
      'arn:aws:codewhisperer:us-east-1:123456789012:profile/default',
    )
    await expect(resolveTokenFromDirectories([directory], {
      expiryBufferMs: 0,
      fetchJson: vi.fn(),
      resolveProfileArn,
      writableDirectories: [directory],
    })).resolves.toMatchObject({
      accessToken: 'access',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/default',
    })
    const saved = JSON.parse(await readFile(join(directory, 'kiro-auth-token.json'), 'utf8')) as Record<string, unknown>
    expect(saved.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123456789012:profile/default')
  })

  it('refreshes imported tokens through Kiro and persists token rotation', async () => {
    const directory = await credentialDirectory({
      refreshToken: 'old-refresh',
      expiresAt: new Date(0).toISOString(),
      region: 'us-east-1',
      authMethod: 'imported',
    })
    const fetchJson = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 3600,
        profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/imported',
      },
    })
    await expect(resolveTokenFromDirectories([directory], {
      expiryBufferMs: 0,
      fetchJson,
      writableDirectories: [directory],
    })).resolves.toMatchObject({ accessToken: 'new-access', authMethod: 'imported' })
    expect(fetchJson.mock.calls[0]?.[0]).toBe('https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
    const saved = JSON.parse(await readFile(join(directory, 'kiro-auth-token.json'), 'utf8')) as Record<string, unknown>
    expect(saved.refreshToken).toBe('new-refresh')
    expect(saved.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123456789012:profile/imported')
  })

  it('refreshes Microsoft external IdP tokens as a form on the approved endpoint', async () => {
    const directory = await credentialDirectory({
      accessToken: 'expired-access',
      refreshToken: 'refresh',
      expiresAt: new Date(0).toISOString(),
      region: 'eu-central-1',
      authMethod: 'external_idp',
      clientId: 'client',
      tokenEndpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      scope: 'openid profile',
      profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/external',
    })
    const fetchForm = vi.fn().mockResolvedValue({
      status: 200,
      body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 },
    })
    await expect(resolveTokenFromDirectories([directory], {
      expiryBufferMs: 0,
      fetchJson: vi.fn(),
      fetchForm,
      writableDirectories: [directory],
    })).resolves.toMatchObject({ accessToken: 'new-access', authMethod: 'external_idp' })
    expect(fetchForm.mock.calls[0]?.[0]).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/token')
    expect(fetchForm.mock.calls[0]?.[1].get('refresh_token')).toBe('refresh')
  })

  it('treats a managed API key as long-lived without attempting refresh', async () => {
    const directory = await credentialDirectory({
      accessToken: 'api-key',
      expiresAt: new Date(0).toISOString(),
      region: 'us-east-1',
      authMethod: 'api_key',
    })
    const fetchJson = vi.fn()
    await expect(resolveTokenFromDirectories([directory], {
      expiryBufferMs: 0,
      fetchJson,
    })).resolves.toMatchObject({ accessToken: 'api-key', authMethod: 'api_key' })
    expect(fetchJson).not.toHaveBeenCalled()
  })
})
