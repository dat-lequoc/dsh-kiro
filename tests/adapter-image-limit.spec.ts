/**
 * Kiro's many-image validation bounds a single side (3000 px) rather than the
 * pixel product, so a wide screenshot cannot be sized by area alone: 6000x216
 * is 1.3 MP, far inside the 8000x8000 ceiling, and still refused. These tests
 * pin both halves of the contract — the request is sized by long edge once the
 * image count crosses the threshold, and a rejection the service returns anyway
 * becomes the harness's image-offload recovery code instead of a generic
 * invalid request.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { TransportRequest, TransportResponse } from '../src/transport.ts'

const posted: TransportRequest[] = []
let respond: () => TransportResponse

vi.mock('../src/transport.ts', () => ({
  post: (options: TransportRequest) => {
    posted.push(options)
    return Promise.resolve(respond())
  },
}))

const { KiroAdapter } = await import('../src/adapter.ts')
const { join, textFrame } = await import('./frames.ts')
type KiroConnectionOptions = import('../src/adapter.ts').KiroConnectionOptions

const SOURCE = { kind: 'plugin' as const, plugin: 'test' }

/** One user message carrying `count` image references of the given source size. */
function imageMessage(count: number, width = 6000, height = 216): Message {
  return createUserMessage({
    content: [
      { type: 'text' as const, text: 'what are these?' },
      ...Array.from({ length: count }, (_, index) => ({
        type: 'image' as const,
        attachment: { attachmentId: `att-${index}`, mediaType: 'image/png' as const, bytes: 3, width, height },
      })),
    ],
    source: SOURCE,
  } as never)
}

function connection(): KiroConnectionOptions {
  return {
    region: 'us-east-1',
    defaults: {},
    defaultContextWindow: 200_000,
    models: [{
      id: 'claude-opus-5.5',
      name: 'Claude Opus 5.5',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      thinking: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'medium',
      effortSchemaPath: 'output_config',
      maxTokensBounds: { minimum: 1024, maximum: 64_000 },
      inputModalities: ['text', 'image'],
    }],
    streamIdleTimeoutMs: 300_000,
    tokenExpiryBufferMs: 300_000,
    retryPolicy: {},
  } as KiroConnectionOptions
}

interface Harness {
  targets: unknown[]
  chunks: { type: string }[]
  failure: unknown
}

/** Run one turn, recording the target dimensions the store was asked for. */
async function run(messages: Message[]): Promise<Harness> {
  const targets: unknown[] = []
  const chunks: { type: string }[] = []
  const instance = new KiroAdapter({
    options: () => connection(),
    resolveToken: () => Promise.resolve({
      accessToken: 'access',
      region: 'us-east-1',
      expiresAt: Date.now() + 60_000,
      authMethod: 'builder-id' as const,
    }),
    resolveAttachments: () => ({
      readImageRequest: async (_ref: unknown, target: unknown) => {
        targets.push(target)
        return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const }
      },
    }),
  } as never)
  let failure: unknown
  try {
    for await (const chunk of instance.stream({
      provider: 'kiro',
      model: 'claude-opus-5.5',
      messages,
    } as GenerateOptions)) chunks.push(chunk as { type: string })
  } catch (error) {
    failure = error
  }
  return { targets, chunks, failure }
}

/** One 400 whose body carries the service's own explanation. */
function rejected(message: string): TransportResponse {
  return {
    status: 400,
    headers: {},
    body: (async function* body() {
      yield new TextEncoder().encode(JSON.stringify({ message }))
    })(),
  }
}

describe('Kiro many-image request sizing and recovery', () => {
  beforeEach(() => {
    posted.length = 0
    respond = () => ({ status: 200, headers: {}, body: (async function* body() { yield join(textFrame('ok')) })() })
  })

  it('bounds each side of a many-image request by long edge', async () => {
    const result = await run([imageMessage(21)])
    // 21 images crosses Kiro's many-image validation: 6000x216 becomes 3000x108.
    expect(result.targets).toHaveLength(21)
    expect(result.targets.every((target) => (target as { width: number }).width === 3000)).toBe(true)
    expect(result.targets.every((target) => (target as { height: number }).height === 108)).toBe(true)
    expect(result.targets.every((target) => (target as { maxBytes: number }).maxBytes === 3_750_000)).toBe(true)
  })

  it('keeps the pixel budget below the many-image threshold', async () => {
    const result = await run([imageMessage(20)])
    // 20 images is still a normal request: the pixel product fits, so the
    // source dimensions pass through untouched.
    expect(result.targets).toHaveLength(20)
    expect(result.targets.every((target) => (target as { width: number }).width === 6000)).toBe(true)
    expect(result.targets.every((target) => (target as { height: number }).height === 216)).toBe(true)
  })

  it('turns the many-image rejection into the image-offload recovery code', async () => {
    respond = () => rejected('At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels')
    const result = await run([imageMessage(21)])
    expect(result.failure).toMatchObject({
      code: 'IMAGE_OFFLOAD_REQUIRED',
      failure: { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 2, status: 400 },
    })
  })

  it('keeps an unrelated 400 a plain invalid request', async () => {
    respond = () => rejected('Input is not valid')
    const result = await run([imageMessage(1)])
    expect(result.failure).toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
