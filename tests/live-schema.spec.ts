/**
 * Live probe: dump each model's `additionalModelRequestFieldsSchema`, which is
 * the authoritative statement of what generation controls the operation accepts.
 * Runs with KIRO_LIVE=1.
 */
import { describe, expect, it } from 'vitest'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn } from '../src/discovery.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { getJson, postForm, postJson } from '../src/transport.ts'

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro model request schema', () => {
  it('reports the advertised request-field schema per model', async () => {
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(120_000)
    const token = await resolveTokenFromDirectories([managed, kiroCredentialDirectory()], {
      expiryBufferMs: connection.tokenExpiryBufferMs,
      fetchJson: (url: string, value: unknown) => postJson(url, value, connection.proxyUrl, signal),
      fetchForm: (url: string, value: URLSearchParams) => postForm(url, value, connection.proxyUrl, signal),
      resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
        discoverKiroProfileArn(connection, {
          accessToken,
          region,
          authMethod,
          expiresAt: Date.now() + 60_000,
        }, signal),
      writableDirectories: [managed],
    })
    const url = new URL('https://codewhisperer.us-east-1.amazonaws.com/ListAvailableModels')
    url.searchParams.set('origin', 'AI_EDITOR')
    url.searchParams.set('maxResults', '50')
    if (token.profileArn !== undefined) url.searchParams.set('profileArn', token.profileArn)
    const response = await getJson(url.toString(), {
      authorization: `Bearer ${token.accessToken}`,
      'user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
      'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
      'x-amzn-codewhisperer-optout': 'true',
    }, connection.proxyUrl, signal)
    expect(response.status).toBe(200)
    const body = response.body as {
      models?: {
        modelId?: string
        tokenLimits?: unknown
        additionalModelRequestFieldsSchema?: unknown
      }[]
      nextToken?: string
    }
    console.log('nextToken present:', body.nextToken !== undefined)
    for (const model of body.models ?? []) {
      console.log(`${model.modelId}: limits=${JSON.stringify(model.tokenLimits)} schema=${JSON.stringify(model.additionalModelRequestFieldsSchema)}`)
    }

    // Walk the continuation the response advertises: a catalog truncated at the
    // first page is the failure mode the paginated walk exists to prevent.
    const seen = new Set((body.models ?? []).map(model => model.modelId))
    let pageToken = body.nextToken
    for (let page = 2; page <= 5 && pageToken !== undefined; page += 1) {
      url.searchParams.set('nextToken', pageToken)
      const next = await getJson(url.toString(), {
        authorization: `Bearer ${token.accessToken}`,
        'user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
        'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
        'x-amzn-codewhisperer-optout': 'true',
      }, connection.proxyUrl, signal)
      const parsed = next.body as { models?: { modelId?: string }[]; nextToken?: string }
      const ids = (parsed.models ?? []).map(model => model.modelId)
      const fresh = ids.filter(id => id !== undefined && !seen.has(id))
      for (const id of ids) if (id !== undefined) seen.add(id)
      console.log(`page ${page}: status=${next.status} models=${ids.length} new=${fresh.length} ${JSON.stringify(fresh)} tokenRepeats=${parsed.nextToken === pageToken} tokenLength=${parsed.nextToken?.length ?? 0}`)
      pageToken = parsed.nextToken
    }
    console.log('total distinct models across pages:', seen.size)
  }, 130_000)
})
