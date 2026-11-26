import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKiroStore, removeKiroStores } from './kiro-store.ts'

/**
 * The device-authorization endpoints, answered locally so the login flow can be
 * driven end to end without reaching AWS.
 */
const wire = vi.hoisted(() => {
  const state = {
    /** Every URL the flow asked for, in order. */
    urls: [] as string[],
    /** Polls of the OIDC token endpoint that have already happened. */
    tokenPolls: 0,
  }
  /** Route one login request to the fake provider. */
  const route = async (url: string): Promise<{ status: number; body: unknown }> => {
    state.urls.push(url)
    if (url.endsWith('/client/register')) {
      return { status: 200, body: { clientId: 'test-client', clientSecret: 'test-secret' } }
    }
    if (url.endsWith('/device_authorization')) {
      return {
        status: 200,
        body: {
          deviceCode: 'device-code',
          userCode: 'ABCD-EFGH',
          verificationUriComplete: 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH',
          interval: 1,
          expiresIn: 600,
        },
      }
    }
    if (url.endsWith('/token')) {
      state.tokenPolls += 1
      if (state.tokenPolls === 1) return { status: 400, body: { error: 'authorization_pending' } }
      return {
        status: 200,
        body: { accessToken: 'access-token', refreshToken: 'refresh-token', expiresIn: 3600 },
      }
    }
    if (url.endsWith('/ListAvailableProfiles')) {
      return {
        status: 200,
        body: { profiles: [{ profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST' }] },
      }
    }
    return { status: 404, body: { message: 'unexpected ' + url } }
  }
  return { state, route }
})

vi.mock('../src/transport.ts', () => ({
  getJson: (_url: string) => wire.route(_url),
  postJson: (_url: string) => wire.route(_url),
  postForm: (_url: string) => wire.route(_url),
  postJsonWithHeaders: (_url: string) => wire.route(_url),
  parseProxyUrl: (raw: string) => new URL(raw),
}))

const { KiroAccountStore } = await import('../src/accounts.ts')
const { resolveTokenFromDirectories } = await import('../src/auth.ts')
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

/** Wait until the background login poll has stored an account. */
async function settled(timeoutMs = 8_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await call('GET', '/kiro/api/status')
    const login = status.value.value.login
    if (login.status === 'complete' || login.status === 'error') return status.value.value
    if (Date.now() >= deadline) throw new Error('login did not settle: ' + JSON.stringify(login))
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-kiro-login-'))
  process.env.DSH_HOME = home
  directory = join(home, 'storages', 'kiro-auth')
  wire.state.urls.length = 0
  wire.state.tokenPolls = 0
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
  delete process.env.DSH_HOME
  await removeKiroStores()
  await rm(home, { recursive: true, force: true })
})

describe('Kiro device login through the Web API', () => {
  it('answers a Builder ID sign-in with the pending flow the page has to display', async () => {
    const started = await call('POST', '/kiro/api/login', { method: 'builder-id' })
    expect(started.status).toBe(200)
    expect(started.value.value).toMatchObject({
      status: 'pending',
      kind: 'device',
      method: 'builder-id',
      userCode: 'ABCD-EFGH',
      authUrl: 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH',
    })
    // The page polls /status for the code; the pending flow must be there too.
    const status = await call('GET', '/kiro/api/status')
    expect(status.value.value.login).toMatchObject({ status: 'pending', userCode: 'ABCD-EFGH' })
  })

  it('answers an IAM Identity Center sign-in with its pending flow', async () => {
    const started = await call('POST', '/kiro/api/login', {
      method: 'idc',
      startUrl: 'https://example.awsapps.com/start',
    })
    expect(started.status).toBe(200)
    expect(started.value.value).toMatchObject({ status: 'pending', method: 'idc', userCode: 'ABCD-EFGH' })
    expect((await call('GET', '/kiro/api/status')).value.value.login)
      .toMatchObject({ status: 'pending', method: 'idc' })
  })

  it('stores and activates the account the completed login produced', async () => {
    await call('POST', '/kiro/api/login', { method: 'builder-id' })
    const status = await settled()
    expect(status.authenticated).toBe(true)
    expect(status.accounts.accounts).toHaveLength(1)
    expect(status.activeAccountId).toBe(status.accounts.accounts[0].id)
    expect(status.login).toMatchObject({ status: 'complete', accountId: status.activeAccountId })

    const resolved = await resolveTokenFromDirectories([directory], {
      expiryBufferMs: 300_000,
      fetchJson: async () => { throw new Error('a fresh token needs no refresh') },
      fetchForm: async () => { throw new Error('a fresh token needs no refresh') },
      writableDirectories: [directory],
    })
    expect(resolved).toMatchObject({ accessToken: 'access-token', authMethod: 'builder-id' })
  })

  it('imports the sign-in the local Kiro CLI already stored', async () => {
    const file = await createKiroStore({
      'kirocli:odic:token': {
        access_token: 'local-access-token',
        refresh_token: 'local-refresh-token',
        expires_at: '2099-01-01T00:00:00Z',
        region: 'ap-southeast-1',
        start_url: 'https://tripsso.awsapps.com/start',
        profile_arn: 'arn:aws:codewhisperer:ap-southeast-1:319585546877:profile/HDYWH4GRKMUY',
        scopes: ['codewhisperer:completions'],
      },
      'kirocli:odic:device-registration': {
        client_id: 'local-client',
        client_secret: 'local-secret',
        region: 'ap-southeast-1',
      },
    })

    const started = await call('POST', '/kiro/api/login', { method: 'local', dataFile: file })

    expect(started.status).toBe(200)
    expect(started.value.value).toMatchObject({ status: 'complete', kind: 'local', method: 'local' })
    const status = (await call('GET', '/kiro/api/status')).value.value
    expect(status).toMatchObject({ authenticated: true, authMethod: 'idc', region: 'ap-southeast-1' })
  })

  it('reports a missing local store instead of leaving the page pending', async () => {
    const started = await call('POST', '/kiro/api/login', {
      method: 'local',
      dataFile: join(home, 'missing', 'data.sqlite3'),
    })

    expect(started.status).toBe(200)
    expect(started.value.value).toMatchObject({ status: 'error', kind: 'local', method: 'local' })
    expect(started.value.value.error).toMatch(/KIRO_CLI_DATA_FILE/u)
    expect((await call('GET', '/kiro/api/status')).value.value.login.status).toBe('error')
  })

  it('answers a work-email sign-in with the portal URL the page must open', async () => {
    const started = await call('POST', '/kiro/api/login', { method: 'email' })
    expect(started.status).toBe(200)
    expect(started.value.value).toMatchObject({ status: 'pending', kind: 'portal', method: 'email' })
    const portal = new URL(started.value.value.authUrl)
    expect(portal.origin + portal.pathname).toBe('https://app.kiro.dev/signin')
    expect(portal.searchParams.get('redirect_from')).toBe('KiroIDE')
    expect(portal.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+$/u)
    expect((await call('GET', '/kiro/api/status')).value.value.login)
      .toMatchObject({ status: 'pending', kind: 'portal', method: 'email' })
    await call('POST', '/kiro/api/login/cancel')
  })

  it('cancels a pending login so the page stops showing its code', async () => {
    await call('POST', '/kiro/api/login', { method: 'builder-id' })
    expect((await call('GET', '/kiro/api/status')).value.value.login.status).toBe('pending')
    const cancelled = await call('POST', '/kiro/api/login/cancel')
    expect(cancelled.status).toBe(200)
    expect(cancelled.value.value.login).toEqual({ status: 'idle' })
    expect((await call('GET', '/kiro/api/status')).value.value.login).toEqual({ status: 'idle' })
  })
})
