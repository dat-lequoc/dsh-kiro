import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The Kiro endpoints an import and a refresh touch, answered locally. */
const wire = vi.hoisted(() => {
  const state = {
    /** Access tokens the fake ListAvailableModels endpoint accepts. */
    keys: new Set<string>(),
    /** Refresh tokens the fake token endpoint mints from. */
    refreshes: [] as string[],
  }
  const route = async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => {
    if (url.includes('/ListAvailableModels')) {
      const authorization = String(init?.headers?.['authorization'] ?? '')
      const key = authorization.replace(/^Bearer /u, '')
      if (!state.keys.has(key)) return { status: 401, body: { message: 'unknown api key' } }
      return { status: 200, body: { models: [{ modelId: 'claude-sonnet-5' }] } }
    }
    if (url.endsWith('/token') || url.endsWith('/refreshToken')) {
      const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams()
      const grant = typeof init?.body === 'string' ? init.body : ''
      const body = (init?.body ?? {}) as Record<string, unknown>
      const refresh = form.get('refresh_token')
        ?? (/refreshtoken["':=\s]+([A-Za-z0-9._-]+)/iu.exec(grant)?.[1])
        ?? (typeof body['refreshToken'] === 'string' ? body['refreshToken'] : undefined)
        ?? 'unknown'
      state.refreshes.push(refresh)
      return {
        status: 200,
        body: {
          accessToken: 'access-for-' + refresh,
          refreshToken: refresh,
          expiresIn: 3600,
        },
      }
    }
    return { status: 404, body: { message: 'unexpected ' + url } }
  }
  return { state, route }
})

vi.mock('../src/transport.ts', () => ({
  getJson: (url: string, headers: Record<string, string>) => wire.route(url, { headers }),
  postJson: (url: string, body: unknown) => wire.route(url, { body }),
  postForm: (url: string, body: URLSearchParams) => wire.route(url, { body }),
  postJsonWithHeaders: (url: string, body: unknown, headers: Record<string, string>) => wire.route(url, { headers, body }),
  parseProxyUrl: (raw: string) => new URL(raw),
}))

const { KiroAccountStore } = await import('../src/accounts.ts')
const { clearTokenCache, resolveTokenFromDirectories } = await import('../src/auth.ts')
const { resolveAdapterOptions } = await import('../src/index.ts')
const { FileModelSettingsStore } = await import('../src/model-settings.ts')
const { registerWebApi } = await import('../src/web.ts')
type WebDependencies = import('../src/web.ts').WebDependencies

let home: string
let directory: string
let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>

/** Drive one request through the registered Kiro API handler. */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; value: any }> {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
  let status = 0
  let payload = ''
  const response = {
    writeHead: (code: number) => { status = code },
    end: (value: string) => { payload = value },
  } as unknown as ServerResponse
  await handler(request, response)
  return { status, value: payload.length === 0 ? undefined : JSON.parse(payload) }
}

/** Resolve the token the adapter would send for the next Kiro request. */
async function requestToken(): Promise<string> {
  const token = await resolveTokenFromDirectories([directory], {
    expiryBufferMs: 300_000,
    fetchJson: (url, body) => wire.route(url, { body }),
    fetchForm: (url, body) => wire.route(url, { body }),
    writableDirectories: [directory],
  })
  return token.accessToken
}

/** Import one API key as a new account and return its identifier. */
async function importKey(key: string, label: string): Promise<string> {
  wire.state.keys.add(key)
  const result = await call('POST', '/kiro/api/credentials/import', {
    method: 'api-key',
    apiKey: key,
    region: 'us-east-1',
    label,
  })
  expect(result.status).toBe(200)
  return result.value.value.activeAccountId
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-kiro-workflow-'))
  process.env.DSH_HOME = home
  directory = join(home, 'storages', 'kiro-auth')
  wire.state.keys.clear()
  wire.state.refreshes.length = 0
  clearTokenCache()
  const ctx = {
    emit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
    inject: (_names: string[], use: (scope: unknown) => void) => {
      use({
        effect: (run: () => unknown) => run(),
        webServer: {
          register: (options: { handler: typeof handler }) => {
            handler = options.handler
            return () => undefined
          },
        },
      })
    },
  }
  const dependencies = {
    managedDirectory: directory,
    options: () => resolveAdapterOptions({ region: 'us-east-1' }),
    discovery: { current: () => undefined, clear: () => undefined, list: async () => [] },
    catalog: { peek: async () => undefined, snapshot: () => undefined, invalidate: () => undefined, refresh: async () => { throw new Error('no discovery in this test') } },
    modelSettings: new FileModelSettingsStore(),
    usage: { current: () => undefined, clear: () => undefined, get: async () => ({}) },
    resolveToken: async () => { throw new Error('not used by these routes') },
  } as unknown as WebDependencies
  registerWebApi(ctx as never, dependencies)
})

afterEach(async () => {
  clearTokenCache()
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('several Kiro accounts and the one requests use', () => {
  it('keeps every imported account and selects the one just added', async () => {
    const first = await importKey('key-one', 'Work')
    const second = await importKey('key-two', 'Personal')
    const status = await call('GET', '/kiro/api/status')
    const accounts = status.value.value.accounts.accounts
    expect(accounts).toHaveLength(2)
    expect(accounts.map((account: { label: string }) => account.label).sort()).toEqual(['Personal', 'Work'])
    expect(first).not.toBe(second)
    expect(status.value.value.activeAccountId).toBe(second)
  })

  it('sends requests with the account the page selected', async () => {
    const first = await importKey('key-one', 'Work')
    await importKey('key-two', 'Personal')
    expect(await requestToken()).toBe('key-two')

    const switched = await call('POST', '/kiro/api/accounts/activate', { accountId: first })
    expect(switched.status).toBe(200)
    expect(switched.value.value.activeAccountId).toBe(first)
    expect(await requestToken()).toBe('key-one')
  })

  it('mirrors the selected credential into the file the CLI reads', async () => {
    const first = await importKey('key-one', 'Work')
    await importKey('key-two', 'Personal')
    const mirror = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(directory, 'kiro-auth-token.json'), 'utf8')) as Record<string, unknown>
    expect(await mirror()).toMatchObject({ accessToken: 'key-two' })
    await call('POST', '/kiro/api/accounts/activate', { accountId: first })
    expect(await mirror()).toMatchObject({ accessToken: 'key-one' })
  })

  it('re-authenticates a named account without moving the selection', async () => {
    const first = await importKey('key-one', 'Work')
    const second = await importKey('key-two', 'Personal')
    wire.state.keys.add('key-one-rotated')
    const again = await call('POST', '/kiro/api/credentials/import', {
      method: 'api-key',
      apiKey: 'key-one-rotated',
      region: 'us-east-1',
      accountId: first,
    })
    expect(again.status).toBe(200)
    expect(again.value.value.activeAccountId).toBe(second)
    const accounts = again.value.value.accounts.accounts
    expect(accounts).toHaveLength(2)
    expect(accounts.find((account: { id: string }) => account.id === first).label).toBe('Work')
    expect(await requestToken()).toBe('key-two')
  })

  it('hands the selection to the replacement when the active account is removed', async () => {
    const first = await importKey('key-one', 'Work')
    const second = await importKey('key-two', 'Personal')
    const removed = await call('POST', '/kiro/api/accounts/remove', {
      accountId: second,
      replacementId: first,
    })
    expect(removed.status).toBe(200)
    expect(removed.value.value.activeAccountId).toBe(first)
    expect(removed.value.value.accounts.accounts).toHaveLength(1)
    expect(await requestToken()).toBe('key-one')
  })

  it('signs every account out so no request can resolve a token', async () => {
    await importKey('key-one', 'Work')
    await importKey('key-two', 'Personal')
    const signedOut = await call('POST', '/kiro/api/logout')
    expect(signedOut.status).toBe(200)
    expect(signedOut.value.value.accounts.accounts).toEqual([])
    expect(signedOut.value.value.authenticated).toBe(false)
    await expect(requestToken()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    // The store stays authoritative, so the removed credential cannot come back
    // through the file it was mirrored into.
    const store = new KiroAccountStore(directory)
    expect(await store.exists()).toBe(true)
    expect(await readFile(join(directory, 'kiro-auth-token.json'), 'utf8').catch(() => null)).toBeNull()
  })

  it('imports a legacy single-file install as the account that keeps working', async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'legacy-key',
      refreshToken: 'legacy-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'us-east-1',
      authMethod: 'imported',
    }, null, 2), { mode: 0o600 })
    const before = await call('GET', '/kiro/api/status')
    expect(before.value.value.accounts).toMatchObject({ migrated: true })
    expect(before.value.value.accounts.accounts).toHaveLength(1)
    expect(await requestToken()).toBe('legacy-key')

    // The first write turns the legacy credential into a stored account and
    // leaves the file the CLI owns alone.
    const added = await importKey('key-two', 'Personal')
    const after = await call('GET', '/kiro/api/status')
    expect(after.value.value.accounts.migrated).toBe(false)
    expect(after.value.value.accounts.accounts).toHaveLength(2)
    expect(after.value.value.activeAccountId).toBe(added)
    const legacy = JSON.parse(await readFile(join(directory, 'kiro-auth-token.json'), 'utf8')) as Record<string, unknown>
    expect(legacy.accessToken).toBe('key-two')
  })

  it('keeps a device registration that a remaining account still refreshes through', async () => {
    const hash = createHash('sha256').update('shared-client').digest('hex')
    const one = await call('POST', '/kiro/api/credentials/import', {
      method: 'refresh-token',
      refreshToken: 'shared-one',
      region: 'us-east-1',
      startUrl: 'https://example.awsapps.com/start',
      clientId: 'shared-client',
      clientSecret: 'shared-secret',
      label: 'One',
    })
    expect(one.status).toBe(200)
    const two = await call('POST', '/kiro/api/credentials/import', {
      method: 'refresh-token',
      refreshToken: 'shared-two',
      region: 'us-east-1',
      startUrl: 'https://example.awsapps.com/start',
      clientId: 'shared-client',
      clientSecret: 'shared-secret',
      label: 'Two',
    })
    expect(two.status).toBe(200)
    // The registration belongs to the OIDC client, which both accounts share.
    await stat(join(directory, hash + '.json'))

    const removed = await call('POST', '/kiro/api/accounts/remove', {
      // Each import activated its own account, so `one` is now the inactive one.
      accountId: one.value.value.activeAccountId,
    })
    expect(removed.status).toBe(200)

    // The survivor still refreshes, which needs the registration this removal
    // would otherwise have deleted.
    const store = new KiroAccountStore(directory)
    const survivor = two.value.value.activeAccountId
    const captured = await store.capture(survivor)
    await captured?.modify(current => ({ ...current, expiresAt: new Date(Date.now() - 1_000).toISOString() }))
    wire.state.refreshes.length = 0
    clearTokenCache()
    expect(await requestToken()).toBe('access-for-shared-two')
    expect(wire.state.refreshes).toEqual(['shared-two'])
  })

  it('keeps the CLI mirror in step with a credential the plugin rotated', async () => {
    const result = await call('POST', '/kiro/api/credentials/import', {
      method: 'refresh-token',
      refreshToken: 'refresh-one',
      region: 'us-east-1',
      credentialSource: 'imported',
      label: 'Work',
    })
    const accountId = result.value.value.activeAccountId
    const store = new KiroAccountStore(directory)
    const captured = await store.capture(accountId)
    await captured?.modify(current => ({ ...current, expiresAt: new Date(Date.now() - 1_000).toISOString() }))
    // A mirror that drifted, the way one left behind by an earlier rotation is.
    await writeFile(join(directory, 'kiro-auth-token.json'), JSON.stringify({
      accessToken: 'stale-mirror',
      refreshToken: 'rotated-away',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'us-east-1',
      authMethod: 'imported',
    }), { mode: 0o600 })
    clearTokenCache()

    expect(await requestToken()).toBe('access-for-refresh-one')
    // The provider rotates refresh tokens, so a mirror left behind would hold a
    // refresh token that no longer works for the CLI and older tooling.
    const mirror = JSON.parse(await readFile(join(directory, 'kiro-auth-token.json'), 'utf8')) as {
      accessToken: string
      refreshToken: string
      expiresAt: string
    }
    expect(mirror.accessToken).toBe('access-for-refresh-one')
    expect(mirror.refreshToken).toBe('refresh-one')
    expect(Date.parse(mirror.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('leaves a directory that is not this plugin own unwritten', async () => {
    const foreign = join(home, 'kiro-ide-cache')
    await mkdir(foreign, { recursive: true, mode: 0o700 })
    const result = await call('POST', '/kiro/api/credentials/import', {
      method: 'refresh-token',
      refreshToken: 'refresh-foreign',
      region: 'us-east-1',
      credentialSource: 'imported',
    })
    const accountId = result.value.value.activeAccountId
    // Move the document to a directory this plugin does not own, the way a
    // shared or IDE-managed cache would look.
    await rename(join(directory, 'accounts.json'), join(foreign, 'accounts.json'))
    const store = new KiroAccountStore(foreign)
    const captured = await store.capture(accountId)
    await captured?.modify(current => ({ ...current, expiresAt: new Date(Date.now() - 1_000).toISOString() }))
    const before = await captured?.read()
    const revision = (await store.snapshot()).accounts[0]?.credentialRevision
    clearTokenCache()

    const token = await resolveTokenFromDirectories([foreign], {
      expiryBufferMs: 300_000,
      fetchJson: (url, body) => wire.route(url, { body }),
      fetchForm: (url, body) => wire.route(url, { body }),
      writableDirectories: [],
    })
    expect(token.accessToken).toBe('access-for-refresh-foreign')
    // The credential is served, but the foreign directory keeps the record it
    // had: a refreshed Kiro-owned token stays in memory only.
    const after = await captured?.read()
    expect(after?.accessToken).toBe(before?.accessToken)
    expect(after?.expiresAt).toBe(before?.expiresAt)
    expect((await store.snapshot()).accounts[0]?.credentialRevision).toBe(revision)
    await expect(stat(join(foreign, 'kiro-auth-token.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refreshes the selected account only, and stores the rotated token back', async () => {
    const result = await call('POST', '/kiro/api/credentials/import', {
      method: 'refresh-token',
      refreshToken: 'refresh-one',
      region: 'us-east-1',
      credentialSource: 'imported',
      label: 'Work',
    })
    expect(result.status).toBe(200)
    const accountId = result.value.value.activeAccountId
    // The import already exchanged the token once; make the stored credential
    // expire so the next resolve has to refresh it.
    const store = new KiroAccountStore(directory)
    const captured = await store.capture(accountId)
    await captured?.modify(current => ({ ...current, expiresAt: new Date(Date.now() - 1_000).toISOString() }))
    wire.state.refreshes.length = 0
    clearTokenCache()

    expect(await requestToken()).toBe('access-for-refresh-one')
    expect(wire.state.refreshes).toEqual(['refresh-one'])
    // The rotated credential is what a later resolve reads, without refreshing again.
    clearTokenCache()
    expect(await requestToken()).toBe('access-for-refresh-one')
    expect(wire.state.refreshes).toEqual(['refresh-one'])
  })
})
