import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KiroAccountStore, MAX_KIRO_ACCOUNTS } from '../src/accounts.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-kiro-accounts-'))
  temporaryDirectories.push(path)
  return path
}

/** One credential record shaped like the adapter's own token file. */
function credential(accessToken: string, refreshToken?: string): Record<string, unknown> {
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    region: 'us-east-1',
    authMethod: 'builder-id',
  }
}

describe('KiroAccountStore', () => {
  it('adds a first account and activates it without being asked', async () => {
    const store = new KiroAccountStore(await directory())
    const added = await store.upsert({ credential: credential('a', 'r'), authMethod: 'builder-id' })
    const snapshot = await store.snapshot()
    expect(snapshot.accounts).toHaveLength(1)
    expect(snapshot.activeAccountId).toBe(added.accountId)
    expect(snapshot.accounts[0]).toMatchObject({ active: true, state: 'ready', authMethod: 'builder-id', region: 'us-east-1' })
    expect(snapshot.accounts[0]?.label).toBe('AWS Builder ID · us-east-1')
    expect(snapshot.migrated).toBe(false)
  })

  it('adds a second account without stealing the selection', async () => {
    const store = new KiroAccountStore(await directory())
    const first = await store.upsert({ credential: credential('a', 'r'), authMethod: 'builder-id' })
    const second = await store.upsert({ credential: credential('b', 'r2'), authMethod: 'google' })
    const snapshot = await store.snapshot()
    expect(snapshot.accounts).toHaveLength(2)
    expect(snapshot.activeAccountId).toBe(first.accountId)
    await store.activate(second.accountId)
    expect((await store.snapshot()).activeAccountId).toBe(second.accountId)
  })

  it('replaces a credential in place and bumps its revision', async () => {
    const store = new KiroAccountStore(await directory())
    const added = await store.upsert({ credential: credential('old', 'r'), authMethod: 'builder-id' })
    const again = await store.upsert({ credential: credential('new', 'r2'), accountId: added.accountId })
    expect(again.accountId).toBe(added.accountId)
    const snapshot = await store.snapshot()
    expect(snapshot.accounts).toHaveLength(1)
    expect(snapshot.accounts[0]?.credentialRevision).toBe(1)
    const captured = await store.capture()
    await expect(captured?.read()).resolves.toMatchObject({ accessToken: 'new' })
  })

  it('reports an expired refreshable credential as needing refresh', async () => {
    const store = new KiroAccountStore(await directory())
    await store.upsert({
      credential: { ...credential('a', 'r'), expiresAt: new Date(Date.now() - 1_000).toISOString() },
      authMethod: 'builder-id',
    })
    expect((await store.snapshot()).accounts[0]?.state).toBe('refresh-required')
  })

  it('reports a stored credential with neither token as unusable', async () => {
    const path = await directory()
    const store = new KiroAccountStore(path)
    // A record can lose its tokens outside this plugin; the store must show
    // that account as unusable rather than as ready or refreshable.
    await writeFile(store.documentPath, JSON.stringify({
      version: 1,
      revision: 0,
      activeAccountId: 'empty',
      accounts: [{
        id: 'empty',
        label: 'Imported refresh token',
        authMethod: 'imported',
        createdAt: 1,
        updatedAt: 1,
        credentialRevision: 0,
        credential: { region: 'us-east-1' },
      }],
    }), { mode: 0o600 })
    expect((await store.snapshot()).accounts[0]?.state).toBe('unusable')
  })

  it('requires a replacement before removing the active account', async () => {
    const store = new KiroAccountStore(await directory())
    const first = await store.upsert({ credential: credential('a', 'r') })
    const second = await store.upsert({ credential: credential('b', 'r2'), authMethod: 'google' })
    await expect(store.remove(first.accountId))
      .rejects.toMatchObject({ code: 'REPLACEMENT_REQUIRED' })
    await store.remove(first.accountId, { replacementId: second.accountId })
    const snapshot = await store.snapshot()
    expect(snapshot.accounts.map(account => account.id)).toEqual([second.accountId])
    expect(snapshot.activeAccountId).toBe(second.accountId)
  })

  it('removes an inactive account without touching the active one', async () => {
    const store = new KiroAccountStore(await directory())
    const first = await store.upsert({ credential: credential('a', 'r') })
    const second = await store.upsert({ credential: credential('b', 'r2'), authMethod: 'google' })
    await store.remove(second.accountId)
    const snapshot = await store.snapshot()
    expect(snapshot.accounts.map(account => account.id)).toEqual([first.accountId])
    expect(snapshot.activeAccountId).toBe(first.accountId)
  })

  it('stays explicitly signed out after every account is removed', async () => {
    const store = new KiroAccountStore(await directory())
    await store.upsert({ credential: credential('a', 'r') })
    await expect(store.removeAll()).resolves.toHaveLength(1)
    expect(await store.exists()).toBe(true)
    const snapshot = await store.snapshot()
    expect(snapshot.accounts).toEqual([])
    expect(snapshot.activeAccountId).toBeNull()
    await expect(store.capture()).resolves.toBeNull()
  })

  it('presents a legacy single-token install as one imported account', async () => {
    const path = await directory()
    const legacy = JSON.stringify({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'eu-central-1',
      authMethod: 'builder-id',
    }, null, 2)
    await writeFile(join(path, 'kiro-auth-token.json'), legacy, { mode: 0o600 })
    const store = new KiroAccountStore(path)
    const snapshot = await store.snapshot()
    expect(snapshot.migrated).toBe(true)
    expect(snapshot.accounts).toHaveLength(1)
    expect(snapshot.accounts[0]).toMatchObject({ active: true, authMethod: 'builder-id', region: 'eu-central-1' })
    expect(snapshot.accounts[0]?.id.startsWith('legacy-')).toBe(true)
    expect(await store.exists()).toBe(false)
    await store.activate(snapshot.accounts[0]!.id)
    expect(await store.exists()).toBe(true)
    // The legacy file is the CLI's and older versions' contract: migration reads
    // it and never rewrites or deletes it.
    await expect(readFile(join(path, 'kiro-auth-token.json'), 'utf8')).resolves.toBe(legacy)
    const written = JSON.parse(await readFile(store.documentPath, 'utf8')) as { accounts: unknown[] }
    expect(written.accounts).toHaveLength(1)
  })

  it('persists a refreshed credential through its capture', async () => {
    const store = new KiroAccountStore(await directory())
    await store.upsert({ credential: credential('old', 'r') })
    const captured = await store.capture()
    expect(captured).not.toBeNull()
    const written = await captured!.modify(current => ({ ...current, accessToken: 'refreshed' }))
    expect(written).toMatchObject({ accessToken: 'refreshed' })
    const snapshot = await store.snapshot()
    expect(snapshot.accounts[0]?.credentialRevision).toBe(1)
    await expect((await store.capture())?.read()).resolves.toMatchObject({ accessToken: 'refreshed' })
  })

  it('leaves a login that raced the refresh in place', async () => {
    const store = new KiroAccountStore(await directory())
    const added = await store.upsert({ credential: credential('old', 'r') })
    const captured = await store.capture()
    // The user signs in again while the refresh is in flight.
    await store.upsert({ credential: credential('signed-in-again', 'r2'), accountId: added.accountId })
    const written = await captured!.modify(current => ({ ...current, accessToken: 'stale-refresh' }))
    expect(written).toMatchObject({ accessToken: 'signed-in-again' })
    await expect((await store.capture())?.read()).resolves.toMatchObject({ accessToken: 'signed-in-again' })
  })

  it('returns the current credential when a refresh makes no change', async () => {
    const store = new KiroAccountStore(await directory())
    await store.upsert({ credential: credential('a', 'r') })
    const captured = await store.capture()
    await captured!.modify(() => undefined)
    await expect((await store.capture())?.read()).resolves.toMatchObject({ accessToken: 'a' })
    expect((await store.snapshot()).accounts[0]?.credentialRevision).toBe(0)
  })

  it('rejects a document written by a future version', async () => {
    const path = await directory()
    const store = new KiroAccountStore(path)
    await writeFile(store.documentPath, JSON.stringify({ version: 99, revision: 0, activeAccountId: null, accounts: [] }), { mode: 0o600 })
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_STORE' })
  })

  it('rejects a document that repeats an account id', async () => {
    const path = await directory()
    const store = new KiroAccountStore(path)
    const account = {
      id: 'same',
      label: 'One',
      authMethod: 'builder-id',
      createdAt: 1,
      updatedAt: 1,
      credentialRevision: 0,
      credential: credential('a', 'r'),
    }
    await writeFile(store.documentPath, JSON.stringify({
      version: 1, revision: 0, activeAccountId: 'same', accounts: [account, account],
    }), { mode: 0o600 })
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_STORE' })
  })

  it('rejects a document holding more accounts than the limit', async () => {
    const path = await directory()
    const store = new KiroAccountStore(path)
    const accounts = Array.from({ length: MAX_KIRO_ACCOUNTS + 1 }, (_, index) => ({
      id: 'account-' + String(index),
      label: 'Account ' + String(index),
      authMethod: 'builder-id',
      createdAt: 1,
      updatedAt: 1,
      credentialRevision: 0,
      credential: credential('token-' + String(index), 'refresh-' + String(index)),
    }))
    await writeFile(store.documentPath, JSON.stringify({
      version: 1, revision: 0, activeAccountId: 'account-0', accounts,
    }), { mode: 0o600 })
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_STORE' })
  })

  it('refuses an account document another user could read', async () => {
    const path = await directory()
    const store = new KiroAccountStore(path)
    await store.upsert({ credential: credential('a', 'r') })
    await chmod(store.documentPath, 0o644)
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'UNSAFE_ACCOUNT_STORE' })
    const mode = (await stat(store.documentPath)).mode & 0o777
    expect(mode).toBe(0o644)
  })

  it('writes the document owner-only', async () => {
    const path = await directory()
    const store = new KiroAccountStore(path)
    await store.upsert({ credential: credential('a', 'r') })
    expect((await stat(store.documentPath)).mode & 0o777).toBe(0o600)
  })
})
