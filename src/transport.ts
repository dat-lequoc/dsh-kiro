/**
 * HTTPS transport with optional HTTP-proxy egress.
 *
 * `fetch` cannot be pointed at a proxy without a custom undici dispatcher, and
 * this adapter needs one: Kiro authorizes Claude models by request egress, so
 * the Claude routes are reachable only through a permitted exit. Node's
 * `http`/`tls` modules already express that directly — a `CONNECT` tunnel with
 * TLS negotiated inside it — so the proxy support costs no dependency, and
 * proxy and direct requests differ only in how the socket is obtained.
 *
 * @module dsh-kiro/transport
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import type { Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Default port for each supported proxy scheme. */
const PROXY_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

/** One HTTPS response: status, headers, and the undecoded body byte stream. */
export interface TransportResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** Body chunks in arrival order; iterate to completion or abort the request signal. */
  body: AsyncIterable<Uint8Array>
}

/** One POST through this transport. */
export interface TransportRequest {
  /** Absolute `https:` URL. */
  url: string
  headers: Record<string, string>
  /** Already-serialized request body. */
  body: string
  /** Caller cancellation; aborts the tunnel, TLS handshake, and body read alike. */
  signal: AbortSignal
  /**
   * Proxy egress as `scheme://[user:pass@]host:port`, or `undefined` for a
   * direct connection.
   */
  proxyUrl?: string
}

interface WireRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
  proxyUrl?: string
}

/**
 * Validate a proxy URL at its configuration boundary.
 * @param raw - the configured proxy URL.
 * @returns the parsed URL.
 * @throws when the value is not a URL, or names a scheme this transport cannot open.
 */
export function parseProxyUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (error: unknown) {
    throw new Error(`llm-kiro: proxyUrl "${raw}" is not a valid URL`, { cause: error })
  }
  if (!(url.protocol in PROXY_PORTS)) {
    throw new Error(
      `llm-kiro: proxyUrl scheme "${url.protocol}" is not supported; use http:// or https://`,
    )
  }
  if (url.hostname.length === 0) {
    throw new Error(`llm-kiro: proxyUrl "${raw}" names no host`)
  }
  return url
}

/**
 * Open a `CONNECT` tunnel to `host:port` through an HTTP proxy.
 * @param proxy - the validated proxy URL.
 * @param host - target hostname.
 * @param port - target port.
 * @param signal - caller cancellation.
 * @returns the tunneled socket, ready for TLS.
 * @throws `LlmError('TRANSPORT')` when the proxy refuses or the connection fails.
 */
function openTunnel(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const open = proxy.protocol === 'https:' ? httpsRequest : httpRequest
    const request = open({
      host: proxy.hostname,
      port: proxy.port.length > 0 ? Number(proxy.port) : PROXY_PORTS[proxy.protocol],
      method: 'CONNECT',
      path: `${host}:${port}`,
      signal,
      headers: {
        host: `${host}:${port}`,
        ...proxy.username.length > 0
          ? {
            'proxy-authorization': `Basic ${Buffer
              .from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`)
              .toString('base64')}`,
          }
          : {},
      },
    })
    request.once('connect', (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new LlmError(
          `Kiro proxy ${proxy.host} refused CONNECT with HTTP ${String(response.statusCode)}`,
          'TRANSPORT',
        ))
        return
      }
      resolve(socket)
    })
    request.once('error', (error: Error) => {
      reject(new LlmError(`Kiro proxy ${proxy.host} connection failed`, 'TRANSPORT', { cause: error }))
    })
    request.end()
  })
}

/**
 * POST one request and resolve as soon as response headers arrive, so the
 * caller streams the body itself.
 * @param options - target, headers, body, cancellation, and optional proxy.
 * @returns status, headers, and the body byte stream.
 * @throws `LlmError('TRANSPORT')` on a pre-response transport failure, or
 *   `LlmError('ABORTED')` when the caller cancelled first.
 */
async function send(options: WireRequest): Promise<TransportResponse> {
  const target = new URL(options.url)
  const port = target.port.length > 0 ? Number(target.port) : 443
  const tunnel = options.proxyUrl === undefined
    ? undefined
    : await openTunnel(parseProxyUrl(options.proxyUrl), target.hostname, port, options.signal)

  return new Promise<TransportResponse>((resolve, reject) => {
    const request = httpsRequest({
      host: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      signal: options.signal,
      // A tunneled socket is already connected to the target, so TLS must be
      // negotiated over it explicitly with the target's SNI — the proxy never
      // sees the plaintext.
      ...tunnel === undefined
        ? {}
        : { createConnection: () => tlsConnect({ socket: tunnel, servername: target.hostname }) },
      headers: {
        ...options.headers,
        ...options.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(options.body)) },
      },
    }, (response: IncomingMessage) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
      })
    })
    request.once('error', (error: Error) => {
      tunnel?.destroy()
      if (options.signal.aborted) {
        reject(new LlmError('Kiro request aborted by caller', 'ABORTED', { cause: error }))
        return
      }
      reject(new LlmError(`Kiro request to ${target.host} failed`, 'TRANSPORT', { cause: error }))
    })
    request.end(options.body)
  })
}

export function post(options: TransportRequest): Promise<TransportResponse> {
  return send({ ...options, method: 'POST' })
}

async function responseJson(response: TransportResponse): Promise<{ status: number; body: unknown }> {
  const chunks: Uint8Array[] = []
  for await (const chunk of response.body) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: undefined }
  }
}

/**
 * POST JSON and read the whole response, for the small non-streaming calls
 * (token refresh) that share this transport's egress.
 * @param url - absolute `https:` URL.
 * @param body - value serialized as the JSON request body.
 * @param proxyUrl - optional proxy egress.
 * @param signal - caller cancellation.
 * @returns the status and parsed JSON body; an unparsable body resolves as `undefined`.
 */
export async function postJson(
  url: string,
  body: unknown,
  proxyUrl: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  return postJsonWithHeaders(url, body, {}, proxyUrl, signal)
}

/**
 * POST and parse JSON while supplying operation-specific headers.
 * @param url - absolute HTTPS URL.
 * @param body - JSON request value.
 * @param headers - extra request headers such as Kiro authorization.
 * @param proxyUrl - optional proxy egress.
 * @param signal - caller cancellation.
 * @returns status and parsed response body.
 */
export async function postJsonWithHeaders(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  proxyUrl: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const response = await post({
    url,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
    ...proxyUrl === undefined ? {} : { proxyUrl },
  })
  return responseJson(response)
}

/** POST an OAuth form and parse its small JSON response. */
export async function postForm(
  url: string,
  body: URLSearchParams,
  proxyUrl: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const response = await post({
    url,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
    signal,
    ...proxyUrl === undefined ? {} : { proxyUrl },
  })
  return responseJson(response)
}

/**
 * GET and parse a small JSON response through the same optional proxy.
 * @param url - absolute HTTPS URL.
 * @param headers - request headers.
 * @param proxyUrl - optional proxy egress.
 * @param signal - caller cancellation.
 * @returns status and parsed response body.
 */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  proxyUrl: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const response = await send({
    url,
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    signal,
    ...proxyUrl === undefined ? {} : { proxyUrl },
  })
  return responseJson(response)
}
