/**
 * Contract for importing a credential from the settings page.
 *
 * The reported failure: pasting an API key left the dialog open, gave no sign
 * that the key had been checked, and left the usage card showing the previous
 * account. The cause was that both the close and the usage re-read hung off
 * `status.authenticated`, which does not change when a Kiro IDE credential is
 * already present — the exact case a first-time import happens in.
 *
 * These assertions read the shipped client source. The settings panel needs the
 * host's React and settings shell to render, which no unit environment provides,
 * so the invariants are pinned where they live rather than not at all.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importApiKey } from '../src/login.ts'

const source = readFileSync(new URL('../client/index.cjs', import.meta.url), 'utf8')

describe('settings page: importing a credential', () => {
  it('keys the close and the usage re-read on which credential is in force', () => {
    // Not on whether one exists: that is the bug this replaces.
    expect(source).toContain('const credentialKey = status?.authenticated')
    expect(source).toContain('[status.credentialSource, status.authMethod, status.expiresAt].join')
    const effectDependencies = [...source.matchAll(/\}, \[(credentialKey|status\?\.authenticated)\]\)/gu)]
      .map(match => match[1])
    expect(effectDependencies).toContain('credentialKey')
    expect(effectDependencies).not.toContain('status?.authenticated')
  })

  it('closes the dialog on the import itself, not on a derived change', () => {
    const importBranch = source.slice(
      source.indexOf("await api('/credentials/import'"),
      source.indexOf('const flow = await api(\'/login\''),
    )
    expect(importBranch).toContain('setAuthOpen(false)')
    expect(importBranch).toContain('setSelectedMethod(null)')
    expect(importBranch).toContain('await refreshUsage()')
    expect(importBranch).toContain('setNotice(noticeFor(next))')
  })

  it('drops the pasted secret from the page once the server holds it', () => {
    const importBranch = source.slice(
      source.indexOf("await api('/credentials/import'"),
      source.indexOf('const flow = await api(\'/login\''),
    )
    for (const secret of ['apiKey', 'refreshToken', 'clientSecret', 'credentials']) {
      expect(importBranch).toContain(`${secret}: ''`)
    }
  })

  it('confirms only what the server actually verified', () => {
    // A method that checked nothing on the wire must not claim verification.
    expect(source).toContain("if (next?.verified?.refreshed) return t('verified')")
    expect(source).toContain("return t('savedCredential')")
    for (const key of ['verified', 'verifiedModels', 'savedCredential']) {
      expect(source).toContain(`${key}:`)
    }
    // Both shipped locales, so neither reads as a missing string.
    const zhSection = source.slice(source.indexOf('const zh ='))
    for (const key of ['verified', 'verifiedModels', 'savedCredential']) {
      expect(zhSection).toContain(`${key}:`)
    }
  })

  it('lets the confirmation expire and cleans up its timer', () => {
    expect(source).toContain('window.setTimeout(() => setNotice(\'\'), 8000)')
    expect(source).toContain('return () => window.clearTimeout(timer)')
  })
})

describe('API key import reports its evidence', () => {
  const listing = {
    status: 200,
    body: { models: [{ modelId: 'claude-sonnet-4.5' }, { modelId: 'claude-opus-5' }] },
  }

  it('returns the credential together with the models that proved it works', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const verified = await importApiKey(
      '  key-value  ',
      'us-west-2',
      async (url: string, headers: Record<string, string>) => {
        seen.push({ url, headers })
        return listing
      },
      new AbortController().signal,
    )
    expect(verified.models).toBe(2)
    expect(verified.credentials.accessToken).toBe('key-value')
    expect(verified.credentials.authMethod).toBe('api_key')
    expect(verified.credentials.region).toBe('us-west-2')
    // The check is a real catalog call carrying the key as an API-key token.
    expect(seen[0]?.url).toContain('q.us-west-2.amazonaws.com/ListAvailableModels')
    expect(seen[0]?.headers.TokenType).toBe('API_KEY')
  })

  it('refuses a key the catalog does not accept', async () => {
    await expect(importApiKey(
      'bad-key',
      'us-east-1',
      async () => ({ status: 403, body: { message: 'denied' } }),
      new AbortController().signal,
    )).rejects.toThrow('Kiro API key validation failed')
  })

  it('refuses a key the catalog accepts with an empty model list', async () => {
    // A 200 with nothing in it is not evidence the key can be used.
    await expect(importApiKey(
      'empty-key',
      'us-east-1',
      async () => ({ status: 200, body: { models: [] } }),
      new AbortController().signal,
    )).rejects.toThrow('Kiro API key validation failed')
  })
})
