/**
 * Live probe: send a deliberately oversized request and check how the adapter
 * classifies the provider's rejection. Diagnostic only; runs with KIRO_LIVE=1.
 */
import { describe, expect, it } from 'vitest'
import { conversationIdFor, httpErrorCode, kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn } from '../src/discovery.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { serializeRequest } from '../src/serialize.ts'
import { post, postForm, postJson } from '../src/transport.ts'

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro overflow classification', () => {
  it('maps the provider rejection of an oversized request', async () => {
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(180_000)
    const token = await resolveTokenFromDirectories([managed, kiroCredentialDirectory()], {
      expiryBufferMs: connection.tokenExpiryBufferMs,
      fetchJson: (url: string, body: unknown) => postJson(url, body, connection.proxyUrl, signal),
      fetchForm: (url: string, body: URLSearchParams) => postForm(url, body, connection.proxyUrl, signal),
      resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
        discoverKiroProfileArn(connection, {
          accessToken,
          region,
          authMethod,
          expiresAt: Date.now() + 60_000,
        }, signal),
      writableDirectories: [managed],
    })
    // Well past the ~576 KB request the audit saw rejected.
    const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(30_000)
    const body = serializeRequest(
      {
        provider: 'kiro',
        model: 'claude-sonnet-4.5',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `${filler}\n\nReply with only: ok` }],
          source: { kind: 'plugin', plugin: 'overflow' },
        }],
      } as never,
      connection.defaults,
      conversationIdFor('overflow-probe'),
      token.profileArn,
    )
    const serialized = JSON.stringify(body)
    console.log('request bytes', Buffer.byteLength(serialized))
    const response = await post({
      url: kiroRequestEndpoint(token, token.region),
      headers: {
        'content-type': 'application/json',
        accept: 'application/vnd.amazon.eventstream',
        authorization: `Bearer ${token.accessToken}`,
        ...kiroTokenTypeHeaders(token),
        'x-amzn-kiro-agent-mode': 'vibe',
        'user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
        'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
      },
      body: serialized,
      signal,
    })
    const chunks: Uint8Array[] = []
    for await (const chunk of response.body) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    console.log('http', response.status)
    console.log('body', text.slice(0, 300))
    console.log('classified as', httpErrorCode(response.status, text))
    if (response.status === 400) {
      expect(httpErrorCode(response.status, text)).toBe('CONTEXT_WINDOW_EXCEEDED')
    }
  }, 200_000)
})
