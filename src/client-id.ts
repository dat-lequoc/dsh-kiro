/**
 * Kiro enforces a minimum client version. The plugin follows the update feed
 * and falls back to this pin. Bump the pin if requests fail with "no longer supported".
 */

import { getJson } from './transport.ts'

export const KIRO_CLIENT_VERSION = '1.4.121'
const RELEASE_METADATA_URL = 'https://prod.download.desktop.kiro.dev/stable/metadata-darwin-arm64-stable.json'

let clientVersion = KIRO_CLIENT_VERSION

export function kiroUserAgent(): string {
  return `aws-sdk-js/3.738.0 KiroIDE-${clientVersion}`
}

export async function refreshKiroClientVersion(
  proxyUrl: string | undefined,
  request: typeof getJson = getJson,
): Promise<void> {
  try {
    const { status, body } = await request(RELEASE_METADATA_URL, {}, proxyUrl, AbortSignal.timeout(5_000))
    const latest = (body as { currentRelease?: unknown } | null)?.currentRelease
    // The value lands in a request header, so accept only a plain dotted version.
    if (status === 200 && typeof latest === 'string' && /^\d+(\.\d+){1,3}$/.test(latest)) clientVersion = latest
  } catch {}
}
