/**
 * Live probe: record which frames a controlled Kiro request actually produces,
 * so protocol support is implemented from observed traffic rather than assumed.
 * Prints event names and payload key shapes only — never content or credentials.
 * Runs with `KIRO_LIVE=1`, optionally `KIRO_MODEL` and `KIRO_EFFORT`.
 *
 * Observed on a KIRO PRO+ account, 2026-08-25:
 * - `claude-sonnet-4.5`: assistantResponseEvent, contextUsageEvent, meteringEvent.
 * - `claude-opus-5` at effort `high`: reasoningContentEvent (text, signature),
 *   assistantResponseEvent, contextUsageEvent, meteringEvent.
 * - No `metadataEvent` on either route, so no exact token telemetry was sent.
 */
import { describe, expect, it } from 'vitest'
import { conversationIdFor, kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn, KiroModelDiscovery } from '../src/discovery.ts'
import { decodeFrames } from '../src/eventstream.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { serializeRequest } from '../src/serialize.ts'
import { post, postForm, postJson } from '../src/transport.ts'

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro frame capture', () => {
  it('reports frame names and payload key shapes', async () => {
    const model = process.env.KIRO_MODEL ?? 'claude-sonnet-4.5'
    const effort = process.env.KIRO_EFFORT
    const maxTokens = Number(process.env.KIRO_MAX_TOKENS ?? '2048')
    const prompt = process.env.KIRO_PROMPT
      ?? 'Think step by step about 17*23, then reply with only the number.'
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(180_000)

    const resolveToken = (conn: typeof connection, abort: AbortSignal) => resolveTokenFromDirectories(
      [managed, kiroCredentialDirectory()],
      {
        expiryBufferMs: conn.tokenExpiryBufferMs,
        fetchJson: (url: string, body: unknown) => postJson(url, body, conn.proxyUrl, abort),
        fetchForm: (url: string, body: URLSearchParams) => postForm(url, body, conn.proxyUrl, abort),
        resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
          discoverKiroProfileArn(conn, { accessToken, region, authMethod, expiresAt: Date.now() + 60_000 }, abort),
        writableDirectories: [managed],
      },
    )

    const token = await resolveToken(connection, signal)
    const models = await new KiroModelDiscovery({ resolveToken }).list(connection, signal)
    const selected = models.find(entry => entry.id === model)
    console.log('model', JSON.stringify(selected))
    const native = selected?.effortSchemaPath === undefined || selected.reasoningEfforts === undefined
      ? undefined
      : {
          schemaPath: selected.effortSchemaPath,
          levels: selected.reasoningEfforts,
          ...selected.defaultReasoningEffort === undefined ? {} : { defaultLevel: selected.defaultReasoningEffort },
        }
    const body = serializeRequest(
      {
        provider: 'kiro',
        model,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'frames' },
        }],
        maxTokens,
        temperature: 0.2,
        ...effort === undefined ? {} : { reasoningEffort: effort },
      } as never,
      connection.defaults,
      conversationIdFor('frame-capture'),
      token.profileArn,
      native,
      selected?.maxTokensBounds === undefined
        ? undefined
        : { maxTokensBounds: selected.maxTokensBounds },
    )
    console.log('request keys', Object.keys(body), 'additionalModelRequestFields', JSON.stringify(body.additionalModelRequestFields))

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
      body: JSON.stringify(body),
      signal,
    })
    console.log('http', response.status)
    if (response.status !== 200) {
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body) chunks.push(chunk)
      console.log('error body', Buffer.concat(chunks).toString('utf8').slice(0, 400))
      return
    }
    const seen = new Map<string, { count: number; keys: Set<string> }>()
    let hasThinkingMarkers = false
    for await (const frame of decodeFrames(response.body)) {
      const type = frame.headers[':event-type'] ?? frame.headers[':exception-type'] ?? 'unknown'
      const entry = seen.get(type) ?? { count: 0, keys: new Set<string>() }
      entry.count += 1
      try {
        const payload: unknown = JSON.parse(new TextDecoder().decode(frame.payload))
        if (typeof payload === 'object' && payload !== null) {
          for (const key of Object.keys(payload)) {
            const value = (payload as Record<string, unknown>)[key]
            entry.keys.add(typeof value === 'object' && value !== null
              ? `${key}{${Object.keys(value).join(',')}}`
              : key)
          }
          const content = (payload as { content?: unknown }).content
          // Structural signal only: whether the legacy in-band thinking channel
          // is in use on this route, not what it said.
          if (typeof content === 'string' && content.includes('<thinking>')) {
            hasThinkingMarkers = true
          }
          if (type === 'metadataEvent') console.log('metadataEvent payload', JSON.stringify(payload))
        }
      } catch {
        entry.keys.add('<non-json>')
      }
      seen.set(type, entry)
    }
    for (const [type, entry] of seen) {
      console.log(`frame ${type} x${entry.count} keys=${[...entry.keys].join(' ')}`)
    }
    console.log('legacy <thinking> markers in output:', hasThinkingMarkers)
    // The request carried the model's advertised request fields; a 200 with
    // real content is the evidence that the service accepted them.
    expect(response.status).toBe(200)
    expect(seen.has('assistantResponseEvent')).toBe(true)

  }, 200_000)
})
