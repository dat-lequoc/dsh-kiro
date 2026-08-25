/**
 * Live probe: find out what makes `generateAssistantResponse` emit its
 * `metadataEvent`, which is the only carrier of exact token usage.
 *
 * The wire schema declares `MetadataEvent { tokenUsage, stopReason, stopDetails }`
 * and `TokenUsage { uncachedInputTokens, outputTokens, totalTokens,
 * cacheReadInputTokens, cacheWriteInputTokens, contextUsagePercentage,
 * normalizedTokenUsage }`, so usage is part of the contract — but this account's
 * default request never receives it. This probe varies the endpoint, the
 * agent-mode header, the origin, and the model, one factor at a time, and reports
 * which frames each variant produces. Prompts are one word to keep credit use
 * minimal. Runs with KIRO_LIVE=1.
 */
import { describe, expect, it } from 'vitest'
import { conversationIdFor, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn } from '../src/discovery.ts'
import { decodeFrames } from '../src/eventstream.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { post, postForm, postJson } from '../src/transport.ts'
import type { KiroToken } from '../src/auth.ts'

const CODEWHISPERER_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'
const AGENT = 'aws-sdk-js/3.738.0 KiroIDE'

interface Variant {
  label: string
  host: 'q' | 'codewhisperer'
  agentMode?: string
  origin?: string
  model?: string
  chatTriggerType?: string
}

const VARIANTS: Variant[] = [
  { label: 'baseline q + vibe', host: 'q' },
  { label: 'q, no agent-mode header', host: 'q', agentMode: undefined },
  { label: 'q + agent-mode spec', host: 'q', agentMode: 'spec' },
  { label: 'q + origin IDE', host: 'q', origin: 'IDE' },
  { label: 'q + chatTriggerType DIAGNOSTIC', host: 'q', chatTriggerType: 'DIAGNOSTIC' },
  { label: 'codewhisperer surface', host: 'codewhisperer' },
  { label: 'q + gpt-5.6-sol', host: 'q', model: 'gpt-5.6-sol' },
]

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro usage-event discovery', () => {
  it('reports which request shape yields a metadataEvent', async () => {
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(600_000)
    const token: KiroToken = await resolveTokenFromDirectories(
      [managed, kiroCredentialDirectory()],
      {
        expiryBufferMs: connection.tokenExpiryBufferMs,
        fetchJson: (url: string, value: unknown) => postJson(url, value, connection.proxyUrl, signal),
        fetchForm: (url: string, value: URLSearchParams) =>
          postForm(url, value, connection.proxyUrl, signal),
        resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
          discoverKiroProfileArn(connection, {
            accessToken,
            region,
            authMethod,
            expiresAt: Date.now() + 60_000,
          }, signal),
        writableDirectories: [managed],
      },
    )
    const region = token.region

    const results: string[] = []
    for (const variant of VARIANTS) {
      const model = variant.model ?? 'claude-sonnet-4.5'
      const url = variant.host === 'codewhisperer'
        ? `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`
        : `https://q.${region}.amazonaws.com/generateAssistantResponse`
      const body = {
        ...token.profileArn === undefined ? {} : { profileArn: token.profileArn },
        conversationState: {
          chatTriggerType: variant.chatTriggerType ?? 'MANUAL',
          conversationId: conversationIdFor(`usage-${variant.label}`),
          currentMessage: {
            userInputMessage: {
              content: 'Reply with only: ok',
              modelId: model,
              origin: variant.origin ?? 'AI_EDITOR',
            },
          },
        },
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/vnd.amazon.eventstream',
        authorization: `Bearer ${token.accessToken}`,
        ...kiroTokenTypeHeaders(token),
        'user-agent': AGENT,
        'x-amz-user-agent': AGENT,
        ...variant.host === 'codewhisperer' ? { 'x-amz-target': CODEWHISPERER_TARGET } : {},
        ...'agentMode' in variant && variant.agentMode === undefined
          ? {}
          : { 'x-amzn-kiro-agent-mode': variant.agentMode ?? 'vibe' },
      }
      let line: string
      try {
        const response = await post({ url, headers, body: JSON.stringify(body), signal })
        if (response.status !== 200) {
          const chunks: Uint8Array[] = []
          for await (const chunk of response.body) chunks.push(chunk)
          line = `${variant.label}: HTTP ${response.status} ${Buffer.concat(chunks).toString('utf8').slice(0, 110)}`
        } else {
          const seen = new Map<string, number>()
          let metadata = ''
          let context = ''
          for await (const frame of decodeFrames(response.body)) {
            const type = frame.headers[':event-type'] ?? frame.headers[':exception-type'] ?? '?'
            seen.set(type, (seen.get(type) ?? 0) + 1)
            const text = new TextDecoder().decode(frame.payload)
            if (type === 'metadataEvent') metadata = text.slice(0, 220)
            if (type === 'contextUsageEvent') context = text.slice(0, 80)
          }
          line = `${variant.label}: ${[...seen].map(([k, v]) => `${k}x${v}`).join(' ')}`
            + `${context.length > 0 ? ` | context=${context}` : ''}`
            + `${metadata.length > 0 ? ` | METADATA=${metadata}` : ' | no metadataEvent'}`
        }
      } catch (error: unknown) {
        line = `${variant.label}: threw ${(error as Error).message.slice(0, 90)}`
      }
      console.log(line)
      results.push(line)
    }
    expect(results.length).toBe(VARIANTS.length)
  }, 620_000)
})
