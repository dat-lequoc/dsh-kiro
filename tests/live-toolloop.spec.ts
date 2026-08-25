/**
 * Live probe: two-turn tool loop, so the neutral history padding this build
 * sends (`Continue`, `understood`) is exercised against the real service.
 * Diagnostic only; runs with KIRO_LIVE=1.
 */
import { describe, expect, it } from 'vitest'
import { KiroAdapter } from '../src/adapter.ts'
import type { KiroCatalogModel, KiroConnectionOptions } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn, KiroModelDiscovery } from '../src/discovery.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { postForm, postJson } from '../src/transport.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro tool loop', () => {
  it('completes a call and replays its result through the new padding', async () => {
    const model = process.env.KIRO_MODEL ?? 'claude-sonnet-4.5'
    const connection = resolveAdapterOptions({ region: 'us-east-1' })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(180_000)
    const resolveToken = (conn: KiroConnectionOptions, abort: AbortSignal) =>
      resolveTokenFromDirectories([managed, kiroCredentialDirectory()], {
        expiryBufferMs: conn.tokenExpiryBufferMs,
        fetchJson: (url: string, body: unknown) => postJson(url, body, conn.proxyUrl, abort),
        fetchForm: (url: string, body: URLSearchParams) => postForm(url, body, conn.proxyUrl, abort),
        resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
          discoverKiroProfileArn(conn, {
            accessToken,
            region,
            authMethod,
            expiresAt: Date.now() + 60_000,
          }, abort),
        writableDirectories: [managed],
      })
    let models: readonly KiroCatalogModel[] = []
    models = await new KiroModelDiscovery({ resolveToken }).list(connection, signal)
    const adapter = new KiroAdapter({
      options: () => connection,
      resolveToken,
      currentModels: () => models,
    })
    const tools = [{
      name: 'get_time',
      description: 'Return the current time in a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }]
    const source = { kind: 'plugin' as const, plugin: 'toolloop' }
    const first: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'kiro',
      model,
      sessionId: 'toolloop-session',
      system: 'Use the provided tool when a question needs it.',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'What time is it in Paris? Use the tool.' }],
        source,
      }],
      tools,
      maxTokens: 1024,
    } as never as GenerateOptions)) {
      first.push(chunk)
    }
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    console.log('turn 1 finish', JSON.stringify(first.at(-1)))
    expect(call).toBeDefined()
    if (call?.type !== 'block-end' || call.block.type !== 'tool-call') return
    console.log('turn 1 call', call.block.name, call.block.arguments)

    // Turn two replays a text-less assistant turn (tool call only) plus its
    // result: the exact history shape that used to carry the leaked marker.
    const second: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'kiro',
      model,
      sessionId: 'toolloop-session',
      system: 'Use the provided tool when a question needs it.',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'What time is it in Paris? Use the tool.' }],
          source,
        },
        {
          role: 'assistant',
          content: [call.block],
          source: { provider: 'kiro', model },
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: call.block.id,
            content: [{ type: 'text', text: '14:05 CET' }],
          }],
          source,
        },
      ],
      tools,
      maxTokens: 1024,
    } as never as GenerateOptions)) {
      second.push(chunk)
    }
    const text = second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    console.log('turn 2 finish', JSON.stringify(second.at(-1)))
    console.log('turn 2 text', JSON.stringify(text.slice(0, 200)))
    expect(text).not.toContain('[system: conversation continues]')
    expect(text).not.toContain('understood')
    expect(text.length).toBeGreaterThan(0)
  }, 200_000)
})
