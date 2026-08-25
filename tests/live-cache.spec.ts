/**
 * Live probe: does Kiro's `cachePoint` request member do anything observable?
 *
 * The service model declares `CachePoint { type }` with `CachePointType.DEFAULT
 * = 'default'`, and declares `cachePoint` as a member of `UserInputMessage` and
 * `AssistantResponseMessage` and as a union arm of `Tool` — the Bedrock Converse
 * prompt-caching shape. The installed Kiro client never populates it on this
 * endpoint, so whether the service honours it is only answerable by asking.
 *
 * Three questions, in order:
 * 1. Is a request carrying cache points accepted at all?
 * 2. Does it make the service report `metadataEvent.tokenUsage` (the only
 *    channel that could carry `cacheReadInputTokens`)?
 * 3. Does a repeat of the same large prefix look different — in metering,
 *    context percentage, or latency?
 *
 * Prints shapes, statuses and counts only, never content or credentials.
 * Runs with `KIRO_LIVE=1`.
 */
import { describe, expect, it } from 'vitest'
import { conversationIdFor, kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn } from '../src/discovery.ts'
import { decodeFrames } from '../src/eventstream.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { post, postForm, postJson } from '../src/transport.ts'

interface Observed {
  status: number
  error?: string
  frames: Map<string, number>
  metadata: unknown[]
  contextPercentages: number[]
  metering: unknown[]
  elapsedMs: number
  contentCharacters: number
}

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro cache-point probe', () => {
  it('reports whether cache points are accepted and whether they unlock usage', async () => {
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(220_000)
    const token = await resolveTokenFromDirectories(
      [managed, kiroCredentialDirectory()],
      {
        expiryBufferMs: connection.tokenExpiryBufferMs,
        fetchJson: (url: string, body: unknown) => postJson(url, body, connection.proxyUrl, signal),
        fetchForm: (url: string, body: URLSearchParams) =>
          postForm(url, body, connection.proxyUrl, signal),
        resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
          discoverKiroProfileArn(
            connection,
            { accessToken, region, authMethod, expiresAt: Date.now() + 60_000 },
            signal,
          ),
        writableDirectories: [managed],
      },
    )

    // A prefix long enough to be worth caching: Bedrock's minimum cacheable
    // prefix is in the low thousands of tokens, so stay comfortably above it.
    // Each arm gets its own nonce, because prompt caching keys on the prefix
    // itself: sharing one prefix across arms would let the first arm warm the
    // cache the second arm is being measured for.
    const nonce = Math.random().toString(36).slice(2, 10)
    const prefixFor = (arm: string) =>
      `Reference material ${nonce}-${arm}, section ${'A'.repeat(60)}.\n`.repeat(400)
    const tools = [{
      toolSpecification: {
        name: 'lookup',
        description: 'Look a term up in the reference material.',
        inputSchema: { json: { type: 'object', properties: { term: { type: 'string' } } } },
      },
    }]

    async function ask(label: string, arm: string, withCachePoints: boolean): Promise<Observed> {
      const prefix = prefixFor(arm)
      const history = [
        {
          userInputMessage: {
            content: `${prefix}\nAcknowledge with one word.`,
            modelId: 'claude-sonnet-4.5',
            origin: 'AI_EDITOR',
            ...withCachePoints ? { cachePoint: { type: 'default' } } : {},
          },
        },
        {
          assistantResponseMessage: {
            content: 'Acknowledged.',
            ...withCachePoints ? { cachePoint: { type: 'default' } } : {},
          },
        },
      ]
      const body = {
        conversationState: {
          chatTriggerType: 'MANUAL',
          conversationId: conversationIdFor(`cache-probe-${arm}`),
          history,
          currentMessage: {
            userInputMessage: {
              content: 'Reply with only the word ok.',
              modelId: 'claude-sonnet-4.5',
              origin: 'AI_EDITOR',
              userInputMessageContext: {
                // The union arm: a trailing cache point marks the tool list as
                // cacheable, exactly as Bedrock Converse does.
                tools: withCachePoints ? [...tools, { cachePoint: { type: 'default' } }] : tools,
              },
              ...withCachePoints ? { cachePoint: { type: 'default' } } : {},
            },
          },
        },
        profileArn: token.profileArn,
      }
      const started = Date.now()
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
      const observed: Observed = {
        status: response.status,
        frames: new Map(),
        metadata: [],
        contextPercentages: [],
        metering: [],
        elapsedMs: 0,
        contentCharacters: 0,
      }
      if (response.status !== 200) {
        const chunks: Uint8Array[] = []
        for await (const chunk of response.body) chunks.push(chunk)
        observed.error = Buffer.concat(chunks).toString('utf8').slice(0, 300)
        observed.elapsedMs = Date.now() - started
        console.log(`${label} http ${observed.status} body ${observed.error}`)
        return observed
      }
      for await (const frame of decodeFrames(response.body)) {
        const type = frame.headers[':event-type'] ?? frame.headers[':exception-type'] ?? 'unknown'
        observed.frames.set(type, (observed.frames.get(type) ?? 0) + 1)
        try {
          const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>
          if (type === 'metadataEvent') observed.metadata.push(payload)
          if (type === 'meteringEvent') observed.metering.push(payload)
          if (type === 'contextUsageEvent' && typeof payload.contextUsagePercentage === 'number') {
            observed.contextPercentages.push(payload.contextUsagePercentage)
          }
          if (type === 'assistantResponseEvent' && typeof payload.content === 'string') {
            observed.contentCharacters += payload.content.length
          }
        } catch { /* shape probe only */ }
      }
      observed.elapsedMs = Date.now() - started
      console.log(
        `${label} http ${observed.status}`,
        `frames ${[...observed.frames].map(([k, v]) => `${k}x${v}`).join(' ')}`,
        `metadata ${JSON.stringify(observed.metadata)}`,
        `context% ${JSON.stringify(observed.contextPercentages)}`,
        `metering ${JSON.stringify(observed.metering)}`,
        `chars ${observed.contentCharacters}`,
        `${observed.elapsedMs}ms`,
      )
      return observed
    }

    // A 2x2: each arm called twice with its own prefix. If cache points cause a
    // cache read, the second call of the cache-point arm is the cheap one. If
    // they only change how the request is priced, both of its calls are cheap.
    const settle = () => new Promise(resolve => setTimeout(resolve, 12_000))
    const plainCold = await ask('plain  cold', 'plain', false)
    await settle()
    const plainWarm = await ask('plain  warm', 'plain', false)
    await settle()
    const cacheCold = await ask('cached cold', 'cached', true)
    await settle()
    const cacheWarm = await ask('cached warm', 'cached', true)

    const credits = (run: Observed) =>
      (run.metering[0] as { usage?: number } | undefined)?.usage
    console.log('accepted with cache points:', cacheCold.status === 200)
    console.log('tokenUsage ever present:', [plainCold, plainWarm, cacheCold, cacheWarm]
      .some(run => run.metadata.some(entry => (entry as { tokenUsage?: unknown }).tokenUsage !== undefined)))
    console.log('status  plain cold/warm:', plainCold.status, plainWarm.status,
      plainWarm.error ?? '')
    console.log('status  cache cold/warm:', cacheCold.status, cacheWarm.status,
      cacheWarm.error ?? '')
    console.log('credits plain cold/warm:', credits(plainCold), credits(plainWarm))
    console.log('credits cache cold/warm:', credits(cacheCold), credits(cacheWarm))
    console.log('latency plain cold/warm:', plainCold.elapsedMs, plainWarm.elapsedMs)
    console.log('latency cache cold/warm:', cacheCold.elapsedMs, cacheWarm.elapsedMs)

    // The question this probe answers is whether the member is accepted; a
    // rejection is a real answer and must not read as a broken test.
    expect([200, 400, 402, 429]).toContain(cacheCold.status)
  }, 240_000)
})
