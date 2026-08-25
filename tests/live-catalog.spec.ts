/**
 * Live probe: the paginated catalog walk must cost one request against the real
 * endpoint, which advertises `nextToken: ""` on every page while repeating the
 * same models. Runs with KIRO_LIVE=1.
 */
import { describe, expect, it } from 'vitest'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn, KiroModelDiscovery } from '../src/discovery.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { getJson, postForm, postJson } from '../src/transport.ts'
import type { KiroConnectionOptions } from '../src/adapter.ts'

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro catalog walk', () => {
  it('reads the whole catalog without over-requesting', async () => {
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(120_000)
    const resolveToken = (conn: KiroConnectionOptions, abort: AbortSignal) =>
      resolveTokenFromDirectories([managed, kiroCredentialDirectory()], {
        expiryBufferMs: conn.tokenExpiryBufferMs,
        fetchJson: (url: string, value: unknown) => postJson(url, value, conn.proxyUrl, abort),
        fetchForm: (url: string, value: URLSearchParams) => postForm(url, value, conn.proxyUrl, abort),
        resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
          discoverKiroProfileArn(conn, {
            accessToken,
            region,
            authMethod,
            expiresAt: Date.now() + 60_000,
          }, abort),
        writableDirectories: [managed],
      })
    const urls: string[] = []
    const discovery = new KiroModelDiscovery({
      resolveToken,
      requestJson: (url, headers, proxyUrl, abort) => {
        urls.push(url)
        return getJson(url, headers, proxyUrl, abort)
      },
    })
    const models = await discovery.list(connection, signal)
    console.log(`requests=${urls.length} models=${models.length}`)
    console.log('advertised caps:', models
      .filter(model => model.maxTokensBounds !== undefined)
      .map(model => `${model.id}=${JSON.stringify(model.maxTokensBounds)}`)
      .join(' '))
    expect(models.length).toBeGreaterThan(1)
    // One page holds this account's catalog and the advertised continuation is
    // empty, so a second request would be pure waste.
    expect(urls.length).toBe(1)
    expect(models.some(model => model.maxTokensBounds !== undefined)).toBe(true)
  }, 130_000)
})
