import { describe, expect, it } from 'vitest'
import { KIRO_CLIENT_VERSION, kiroUserAgent, refreshKiroClientVersion } from '../src/client-id.ts'

describe('Kiro client version', () => {
  it('keeps the pinned version unless the feed returns a plain dotted version', async () => {
    expect(kiroUserAgent()).toBe(`aws-sdk-js/3.738.0 KiroIDE-${KIRO_CLIENT_VERSION}`)
    await refreshKiroClientVersion(undefined, async () => { throw new Error('offline') })
    await refreshKiroClientVersion(undefined, async () => ({ status: 403, body: { currentRelease: '9.9.9' } }))
    await refreshKiroClientVersion(undefined, async () => ({ status: 200, body: { currentRelease: '9.9.9\r\nx-evil: 1' } }))
    await refreshKiroClientVersion(undefined, async () => ({ status: 200, body: null }))
    expect(kiroUserAgent()).toBe(`aws-sdk-js/3.738.0 KiroIDE-${KIRO_CLIENT_VERSION}`)

    await refreshKiroClientVersion(undefined, async () => ({ status: 200, body: { currentRelease: '1.5.0' } }))
    expect(kiroUserAgent()).toBe('aws-sdk-js/3.738.0 KiroIDE-1.5.0')
  })
})
