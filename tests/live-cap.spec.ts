/**
 * Live probe: establish where `generateAssistantResponse` actually accepts an
 * output cap. The official request shape declares only `conversationState`,
 * `profileArn`, `agentMode`, `additionalModelRequestFields`, and `systemPrompt`,
 * and each model's advertised schema is `additionalProperties: false`, so this
 * probe checks three placements against the real service. Runs with KIRO_LIVE=1.
 */
import { describe, expect, it } from 'vitest'
import { conversationIdFor, kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn } from '../src/discovery.ts'
import { decodeFrames } from '../src/eventstream.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { post, postForm, postJson } from '../src/transport.ts'
import type { KiroToken } from '../src/auth.ts'

const PROMPT = 'Write a detailed 800 word essay about the history of the bicycle.'

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro output-cap placement', () => {
  it('reports which placement the service honors', async () => {
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(300_000)
    const token: KiroToken = await resolveTokenFromDirectories([managed, kiroCredentialDirectory()], {
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

    /** Post one hand-built request body and summarize what came back. */
    async function attempt(label: string, extra: Record<string, unknown>, model = 'claude-opus-5') {
      const body = {
        ...token.profileArn === undefined ? {} : { profileArn: token.profileArn },
        ...extra,
        conversationState: {
          chatTriggerType: 'MANUAL',
          conversationId: conversationIdFor(`cap-${label}`),
          currentMessage: {
            userInputMessage: { content: PROMPT, modelId: model, origin: 'AI_EDITOR' },
          },
        },
      }
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
      if (response.status !== 200) {
        const chunks: Uint8Array[] = []
        for await (const chunk of response.body) chunks.push(chunk)
        const text = Buffer.concat(chunks).toString('utf8')
        console.log(`${label}: HTTP ${response.status} ${text.slice(0, 200)}`)
        return { status: response.status, characters: 0, events: new Map<string, number>() }
      }
      let characters = 0
      const events = new Map<string, number>()
      for await (const frame of decodeFrames(response.body)) {
        const type = frame.headers[':event-type'] ?? frame.headers[':exception-type'] ?? 'unknown'
        events.set(type, (events.get(type) ?? 0) + 1)
        if (type === 'assistantResponseEvent') {
          const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as { content?: string }
          characters += payload.content?.length ?? 0
        }
        if (type === 'metadataEvent') {
          console.log(`${label}: metadataEvent ${new TextDecoder().decode(frame.payload).slice(0, 200)}`)
        }
      }
      console.log(`${label}: HTTP 200 chars=${characters} frames=${[...events]}`)
      return { status: response.status, characters, events }
    }

    const baseline = await attempt('no-cap', {})
    const legacy = await attempt('top-level-inferenceConfig', { inferenceConfig: { maxTokens: 1024 } })
    const native = await attempt('additionalModelRequestFields.max_tokens', {
      additionalModelRequestFields: { max_tokens: 1024 },
    })
    const unadvertised = await attempt('additionalModelRequestFields.temperature', {
      additionalModelRequestFields: { temperature: 0.2 },
    })
    // A model whose ListAvailableModels entry carries no schema at all: sending
    // the field anyway is what the serializer must avoid if it is rejected.
    const noSchema = await attempt('no-schema-model.max_tokens', {
      additionalModelRequestFields: { max_tokens: 1024 },
    }, 'claude-sonnet-4.5')

    console.log(JSON.stringify({
      baseline: baseline.characters,
      legacy: legacy.characters,
      native: native.characters,
      unadvertisedStatus: unadvertised.status,
      noSchemaStatus: noSchema.status,
    }))
    // Only assert what the probe is for: the advertised placement must at least
    // be accepted by the service.
    expect(native.status).toBe(200)
  }, 300_000)
})
