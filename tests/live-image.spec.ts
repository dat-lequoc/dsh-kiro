/**
 * Live probe: does Kiro accept `userInputMessage.images`, and does the model
 * actually see the picture?
 *
 * The service model declares `ImageBlock { format, source }` with `ImageSource`
 * a bytes union, and the catalog declares `supportedInputTypes` per model — but
 * neither says the request path works. This sends a generated image whose
 * content is unguessable from the prompt, so a correct answer can only come from
 * having looked at it.
 *
 * Runs with `KIRO_LIVE=1`, optionally `KIRO_MODEL`.
 */
import { describe, expect, it } from 'vitest'
import { conversationIdFor, kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn, KiroModelDiscovery } from '../src/discovery.ts'
import { decodeFrames } from '../src/eventstream.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { post, postForm, postJson } from '../src/transport.ts'

/**
 * Build a PNG of solid colour blocks by hand, so the probe needs no image
 * library and the expected answer is fixed by construction.
 * @param blocks - one RGB triple per horizontal band.
 * @returns PNG bytes.
 */
function solidPng(blocks: readonly [number, number, number][]): Uint8Array {
  const size = 64
  const bandHeight = Math.floor(size / blocks.length)
  const raw: number[] = []
  for (let y = 0; y < size; y += 1) {
    raw.push(0) // PNG filter byte: none
    const band = blocks[Math.min(blocks.length - 1, Math.floor(y / bandHeight))] ?? [0, 0, 0]
    for (let x = 0; x < size; x += 1) raw.push(band[0], band[1], band[2])
  }
  const crcTable = Array.from({ length: 256 }, (_unused, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ value >>> 1 : value >>> 1
    return value >>> 0
  })
  const crc = (bytes: Uint8Array): number => {
    let value = 0xFFFFFFFF
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xFF]! ^ value >>> 8
    return (value ^ 0xFFFFFFFF) >>> 0
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(body), 0)
    return Buffer.concat([head.subarray(0, 8), Buffer.from(data), tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib')
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', new Uint8Array()),
  ])
}

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro image request', () => {
  it('accepts a wire image and answers from what it shows', async () => {
    const model = process.env.KIRO_MODEL ?? 'claude-sonnet-4.5'
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
    console.log('model', model, 'inputModalities', JSON.stringify(selected?.inputModalities))

    // Two bands the prompt never names: green over red.
    const png = solidPng([[0, 200, 0], [220, 0, 0]])
    const body = {
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: conversationIdFor('image-probe'),
        currentMessage: {
          userInputMessage: {
            content: 'This image has two horizontal colour bands.'
              + ' Reply with only the top colour then the bottom colour, lowercase, space separated.',
            modelId: model,
            origin: 'AI_EDITOR',
            images: [{ format: 'png', source: { bytes: Buffer.from(png).toString('base64') } }],
          },
        },
      },
      profileArn: token.profileArn,
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
    console.log('http', response.status, 'png bytes', png.length)
    if (response.status !== 200) {
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body) chunks.push(chunk)
      console.log('error body', Buffer.concat(chunks).toString('utf8').slice(0, 400))
      expect(response.status).toBe(200)
      return
    }
    let answer = ''
    for await (const frame of decodeFrames(response.body)) {
      if (frame.headers[':event-type'] !== 'assistantResponseEvent') continue
      const payload = JSON.parse(new TextDecoder().decode(frame.payload)) as { content?: unknown }
      if (typeof payload.content === 'string') answer += payload.content
    }
    console.log('answer:', JSON.stringify(answer.trim().slice(0, 120)))
    expect(response.status).toBe(200)
    // The colours are only knowable from the pixels.
    expect(answer.toLowerCase()).toContain('green')
    expect(answer.toLowerCase()).toContain('red')
  }, 200_000)
})
