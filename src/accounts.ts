/**
 * Multi-account credential storage for Kiro.
 *
 * One versioned document ("accounts.json") holds every credential this plugin
 * owns, and exactly one of them is active. The single-file layout this plugin
 * shipped first is still readable: a directory holding only
 * "kiro-auth-token.json" presents that credential as one imported account until
 * the first mutation, which then writes the document and leaves the legacy file
 * where it was so older tooling and the CLI keep working.
 *
 * Two properties drive the shape:
 *
 * - A refresh must never resurrect or overwrite a login that happened while it
 *   was in flight, so every write is guarded by the account credential
 *   revision and applied under a cross-process lock.
 * - A credential is opaque data here. The store bounds, validates and preserves
 *   it, and never interprets token material; interpreting stays with the
 *   adapter own credential handling.
 *
 * @module dsh-kiro/accounts
 */

import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

/** Document holding every account this plugin owns, inside the credential directory. */
export const KIRO_ACCOUNTS_FILE = 'accounts.json'
/** Single-credential file earlier versions wrote, and the CLI still writes. */
export const KIRO_LEGACY_TOKEN_FILE = 'kiro-auth-token.json'
/** Most accounts one installation may store. */
export const MAX_KIRO_ACCOUNTS = 16
/** Largest accepted account document. */
export const KIRO_ACCOUNT_DOCUMENT_LIMIT = 512 * 1024
/** Longest accepted raw credential record. */
const CREDENTIAL_LIMIT = 64 * 1024
/** How long a mutation waits for another process to release the document lock. */
const LOCK_TIMEOUT_MS = 15_000
/** Age at which an ownerless lock directory is treated as abandoned. */
const LOCK_ORPHAN_MS = 30_000

/** One stored credential and the metadata the settings page shows. */
export interface KiroStoredAccount {
  /** Opaque local identifier; never derived from token material. */
  id: string
  label: string
  /** Recorded authentication method, in the vocabulary the adapter acts on. */
  authMethod: string
  region?: string
  profileArn?: string
  createdAt: number
  updatedAt: number
  /** Increments on every credential write; guards refresh against concurrent logins. */
  credentialRevision: number
  /** The credential record exactly as the adapter resolver expects it. */
  credential: Record<string, unknown>
}

/** The whole account document, as persisted. */
export interface KiroAccountsDocument {
  version: 1
  revision: number
  activeAccountId: string | null
  accounts: KiroStoredAccount[]
}

/** Credential-free account view for the settings page and the status API. */
export interface KiroAccountSummary {
  id: string
  label: string
  authMethod: string
  region?: string
  profileArn?: string
  expiresAt?: number
  active: boolean
  createdAt: number
  updatedAt: number
  credentialRevision: number
  /**
   * ready: the stored access token is still valid. refresh-required: it expired
   * and refresh must run. unusable: the record has neither a usable access token
   * nor a refresh token.
   */
  state: 'ready' | 'refresh-required' | 'unusable'
}

/** Account list plus the revision a mutation must quote to be accepted. */
export interface KiroAccountsSnapshot {
  revision: number
  activeAccountId: string | null
  accounts: KiroAccountSummary[]
  /** True while the document is still synthesized from the legacy token file. */
  migrated: boolean
}

/** Fields one login or import supplies when it stores a credential. */
export interface KiroAccountUpsert {
  /** Raw credential record, in any shape the adapter resolver accepts. */
  credential: Record<string, unknown>
  /** Human label; derived from the method and region when absent. */
  label?: string
  /** Method recorded on the account when the credential does not name one. */
  authMethod?: string
  region?: string
  profileArn?: string
  /** Target an existing account instead of adding one. */
  accountId?: string
  /** Make the written account active. A first account always becomes active. */
  activate?: boolean
  /** Reject the write when the document moved on. */
  expectedRevision?: number
}

/** One account pinned for a request or a refresh, with revision-guarded writes. */
export interface CapturedKiroAccount {
  accountId: string
  credentialRevision: number
  /** Read this account's credential as it stands now. */
  read: () => Promise<Record<string, unknown> | undefined>
  /**
   * Apply a credential change under the document lock. Returns the credential
   * in force afterwards: the change own result, or the one a concurrent login
   * installed while this call was waiting.
   */
  modify: (change: (current: Record<string, unknown>) => Record<string, unknown> | undefined | void)
    => Promise<Record<string, unknown> | undefined>
}

/** Shape of a locally generated account identifier. */
const idPattern = /^[A-Za-z0-9_-]{1,128}$/u

/** Labels for the methods Kiro and this plugin write. */
const METHOD_LABELS: Record<string, string> = {
  'builder-id': 'AWS Builder ID',
  idc: 'AWS IAM Identity Center',
  google: 'Google',
  github: 'GitHub',
  social: 'Kiro social sign-in',
  imported: 'Imported refresh token',
  api_key: 'API key',
  external_idp: 'External IdP',
}

/**
 * Human label for an account that was not given one.
 * @param authMethod - the account recorded method.
 * @param region - the account region, when known.
 * @returns a label naming the method and region.
 */
export function defaultAccountLabel(authMethod: string, region?: string): string {
  const name = METHOD_LABELS[authMethod] ?? authMethod
  return region === undefined || region.length === 0 ? name : name + ' · ' + region
}

/** One validated credential record and the facts derived from it. */
interface ParsedCredential {
  credential: Record<string, unknown>
  authMethod?: string
  region?: string
  profileArn?: string
  expiresAt?: number
  refreshable: boolean
  authenticated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function fail(message: string, code: string): never {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  throw error
}

/** Reject a credential file one other user could read or write. */
function assertPrivateFile(stat: { isFile: () => boolean; uid: number; mode: number }, what: string): void {
  if (!stat.isFile()) fail('Kiro ' + what + ' is not a regular file', 'UNSAFE_ACCOUNT_STORE')
  /* v8 ignore next 2 -- Windows cannot express POSIX ownership or mode */
  if (process.platform === 'win32') return
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('Kiro ' + what + ' is owned by another user', 'UNSAFE_ACCOUNT_STORE')
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('Kiro ' + what + ' is readable beyond its owner; run chmod 600 on it before starting again', 'UNSAFE_ACCOUNT_STORE')
  }
}

/** Reject a credential directory one other user could write. */
function assertPrivateDirectory(stat: { isDirectory: () => boolean; uid: number; mode: number }, what: string): void {
  if (!stat.isDirectory()) fail('Kiro ' + what + ' is not a directory', 'UNSAFE_ACCOUNT_STORE')
  /* v8 ignore next 2 -- Windows cannot express POSIX ownership or mode */
  if (process.platform === 'win32') return
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('Kiro ' + what + ' is owned by another user', 'UNSAFE_ACCOUNT_STORE')
  }
  if ((stat.mode & 0o022) !== 0) fail('Kiro ' + what + ' is writable beyond its owner', 'UNSAFE_ACCOUNT_STORE')
}

/** Read one bounded, owner-only file, or null when it is absent. */
async function readPrivateFile(path: string, what: string, limit: number): Promise<string | null> {
  let handle
  try {
    const before = await lstat(path)
    assertPrivateFile(before, what)
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    assertPrivateFile(opened, what)
    if (before.ino !== opened.ino || before.dev !== opened.dev) {
      fail('Kiro ' + what + ' changed while it was being opened', 'UNSAFE_ACCOUNT_STORE')
    }
    if (opened.size > limit) fail('Kiro ' + what + ' exceeds ' + String(limit) + ' bytes', 'INVALID_ACCOUNT_STORE')
    const buffer = Buffer.alloc(limit + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null)
      if (bytesRead === 0) break
      used += bytesRead
    }
    if (used > limit) fail('Kiro ' + what + ' exceeds ' + String(limit) + ' bytes', 'INVALID_ACCOUNT_STORE')
    return buffer.subarray(0, used).toString('utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close()
  }
}

/** Normalize and bound one raw credential record without interpreting its tokens. */
function parseCredential(value: unknown, what: string): ParsedCredential {
  if (!isRecord(value)) fail('Kiro ' + what + ' must be a JSON object', 'INVALID_ACCOUNT_STORE')
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    fail('Kiro ' + what + ' is not serializable', 'INVALID_ACCOUNT_STORE')
  }
  if (Buffer.byteLength(serialized) > CREDENTIAL_LIMIT) {
    fail('Kiro ' + what + ' exceeds ' + String(CREDENTIAL_LIMIT) + ' bytes', 'INVALID_ACCOUNT_STORE')
  }
  const access = boundedText(value['accessToken'] ?? value['access_token'], 65_536)
  const refresh = boundedText(value['refreshToken'] ?? value['refresh_token'], 65_536)
  const region = boundedText(value['region'], 64)
  const profileArn = boundedText(value['profileArn'] ?? value['profile_arn'], 2048)
  const method = boundedText(value['authMethod'] ?? value['auth_method'], 64)
  const rawExpiry = value['expiresAt'] ?? value['expires_at'] ?? value['expired']
  const parsedExpiry = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : undefined
  return {
    credential: structuredClone(value),
    ...method === undefined ? {} : { authMethod: method },
    ...region === undefined ? {} : { region },
    ...profileArn === undefined ? {} : { profileArn },
    ...expiresAt === undefined ? {} : { expiresAt },
    // An API key carries no refresh token and never expires; every other method
    // is only refreshable when it actually stored one.
    refreshable: refresh !== undefined || method === 'api_key',
    authenticated: access !== undefined || refresh !== undefined,
  }
}

/** Validate one stored account record. */
function parseAccount(value: unknown, index: number): KiroStoredAccount {
  const what = 'account record ' + String(index)
  if (!isRecord(value)) fail('Kiro ' + what + ' must be a JSON object', 'INVALID_ACCOUNT_STORE')
  const id = boundedText(value['id'], 128)
  if (id === undefined || !idPattern.test(id)) fail('Kiro ' + what + ' has an invalid id', 'INVALID_ACCOUNT_STORE')
  const label = boundedText(value['label'], 320)
  if (label === undefined) fail('Kiro ' + what + ' has an invalid label', 'INVALID_ACCOUNT_STORE')
  const createdAt = safeInteger(value['createdAt'])
  const updatedAt = safeInteger(value['updatedAt'])
  const credentialRevision = safeInteger(value['credentialRevision'])
  if (createdAt === undefined || updatedAt === undefined || updatedAt < createdAt || credentialRevision === undefined) {
    fail('Kiro ' + what + ' has invalid timestamps or revision', 'INVALID_ACCOUNT_STORE')
  }
  const parsed = parseCredential(value['credential'], what + ' credential')
  const region = boundedText(value['region'], 64)
  const profileArn = boundedText(value['profileArn'], 2048)
  const authMethod = boundedText(value['authMethod'], 64) ?? parsed.authMethod
  if (authMethod === undefined) fail('Kiro ' + what + ' names no authentication method', 'INVALID_ACCOUNT_STORE')
  return {
    id,
    label,
    authMethod,
    ...region === undefined ? {} : { region },
    ...profileArn === undefined ? {} : { profileArn },
    createdAt,
    updatedAt,
    credentialRevision,
    credential: parsed.credential,
  }
}

/** Validate a whole document, returning it unchanged. */
function parseDocument(value: unknown): KiroAccountsDocument {
  if (!isRecord(value) || value['version'] !== 1) {
    fail('Kiro account document has an unsupported format version', 'INVALID_ACCOUNT_STORE')
  }
  const revision = safeInteger(value['revision'])
  const accounts = value['accounts']
  if (revision === undefined || !Array.isArray(accounts)) {
    fail('Kiro account document is malformed', 'INVALID_ACCOUNT_STORE')
  }
  if (accounts.length > MAX_KIRO_ACCOUNTS) {
    fail('Kiro account document holds more than ' + String(MAX_KIRO_ACCOUNTS) + ' accounts', 'INVALID_ACCOUNT_STORE')
  }
  const parsed = accounts.map(parseAccount)
  const ids = new Set(parsed.map(account => account.id))
  if (ids.size !== parsed.length) fail('Kiro account document repeats an account id', 'INVALID_ACCOUNT_STORE')
  const active = value['activeAccountId']
  if (active !== null && (typeof active !== 'string' || !ids.has(active))) {
    fail('Kiro account document names an active account it does not hold', 'INVALID_ACCOUNT_STORE')
  }
  if (parsed.length === 0 && active !== null) {
    fail('Kiro account document names an active account while holding none', 'INVALID_ACCOUNT_STORE')
  }
  return { version: 1, revision, activeAccountId: active, accounts: parsed }
}

/** Summarize one stored account for the settings page. */
function summarize(account: KiroStoredAccount, activeAccountId: string | null, now: number): KiroAccountSummary {
  const parsed = parseCredential(account.credential, 'account ' + account.id + ' credential')
  // An API key never expires, so it is usable exactly when it is present.
  const state: KiroAccountSummary['state'] = account.authMethod === 'api_key'
    ? parsed.authenticated ? 'ready' : 'unusable'
    : parsed.expiresAt !== undefined && parsed.expiresAt > now
      ? 'ready'
      : parsed.refreshable ? 'refresh-required' : 'unusable'
  return {
    id: account.id,
    label: account.label,
    authMethod: account.authMethod,
    ...account.region === undefined ? {} : { region: account.region },
    ...account.profileArn === undefined ? {} : { profileArn: account.profileArn },
    ...parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt },
    active: account.id === activeAccountId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    credentialRevision: account.credentialRevision,
    state,
  }
}

/** The document representing an installation that holds no account yet. */
function emptyDocument(): KiroAccountsDocument {
  return { version: 1, revision: 0, activeAccountId: null, accounts: [] }
}

/** Stable identifier for the credential a legacy single-file install holds. */
function legacyAccountId(path: string): string {
  return 'legacy-' + createHash('sha256').update(path).digest('hex').slice(0, 24)
}

/** Credential-derived facts recorded beside a stored credential. */
function factsOf(parsed: ParsedCredential): { authMethod?: string; region?: string; profileArn?: string } {
  return {
    ...parsed.authMethod === undefined ? {} : { authMethod: parsed.authMethod },
    ...parsed.region === undefined ? {} : { region: parsed.region },
    ...parsed.profileArn === undefined ? {} : { profileArn: parsed.profileArn },
  }
}

/**
 * Owner-only persistent store for every Kiro credential this plugin owns.
 *
 * Reads are lock-free because writes replace the document atomically; every
 * mutation takes a cross-process lock first, so the Web settings page and the
 * `kiro-login` CLI can both write without losing each other work.
 */
export class KiroAccountStore {
  /** Absolute credential directory this store owns. */
  readonly directory: string

  constructor(directory: string) {
    if (typeof directory !== 'string' || directory.length === 0) {
      fail('Kiro account store requires a directory', 'INVALID_ACCOUNT_STORE')
    }
    this.directory = resolve(directory)
  }

  /** Absolute path of the account document. */
  get documentPath(): string {
    return join(this.directory, KIRO_ACCOUNTS_FILE)
  }

  /** Absolute path of the single-credential file earlier versions wrote. */
  get legacyPath(): string {
    return join(this.directory, KIRO_LEGACY_TOKEN_FILE)
  }

  /** Absolute path of one account device-registration file. */
  registrationPath(clientIdHash: string): string {
    return join(this.directory, clientIdHash + '.json')
  }

  /** Whether the multi-account document exists, written or empty. */
  async exists(): Promise<boolean> {
    return await readPrivateFile(this.documentPath, 'account document', KIRO_ACCOUNT_DOCUMENT_LIMIT) !== null
  }

  /** Create the credential directory and verify no component is shared. */
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    let part = this.directory
    while (true) {
      const stat = await lstat(part)
      if (part === this.directory) assertPrivateDirectory(stat, 'credential directory')
      else if (!stat.isDirectory()) fail('Kiro credential path contains a non-directory component', 'UNSAFE_ACCOUNT_STORE')
      const next = dirname(part)
      if (next === part) break
      part = next
    }
  }

  /**
   * Run one mutation under the document lock, taking over a lock whose owner
   * died on this host and leaving one another host holds alone until it ages out.
   * @param suffix - lock namespace, so account-scoped writes do not serialize with whole-document ones.
   * @param action - the mutation to run while the lock is held.
   * @returns the action result.
   */
  private async withLock<T>(suffix: string, action: () => Promise<T>): Promise<T> {
    await this.ensureDirectory()
    const folder = `${this.documentPath}.${suffix}.lock`
    const token = `${String(process.pid)}-${randomUUID()}`
    const owner = join(folder, token)
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        await mkdir(folder, { mode: 0o700 })
        const created = await lstat(folder)
        assertPrivateDirectory(created, 'account lock')
        const handle = await open(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          await handle.writeFile(hostname())
        } finally {
          await handle.close()
        }
        const current = await lstat(folder)
        if (current.ino !== created.ino || current.dev !== created.dev) {
          await unlink(owner).catch(() => undefined)
          continue
        }
        break
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOENT') throw error
        await this.reapLock(folder).catch(() => undefined)
        if (Date.now() >= deadline) fail('Timed out waiting for the Kiro account lock', 'ACCOUNT_LOCK_TIMEOUT')
        await delay(15 + Math.floor(Math.random() * 20))
      }
    }
    try {
      return await action()
    } finally {
      await unlink(owner).catch(() => undefined)
      await rmdir(folder).catch(() => undefined)
    }
  }

  /**
   * Remove a lock directory whose owner is gone, or which nobody claimed.
   * @param folder - the lock directory to inspect.
   */
  private async reapLock(folder: string): Promise<void> {
    const stat = await lstat(folder)
    assertPrivateDirectory(stat, 'account lock')
    const entries = await readdir(folder)
    if (entries.length === 0) {
      if (Date.now() - stat.mtimeMs > LOCK_ORPHAN_MS) await rmdir(folder)
      return
    }
    if (entries.length !== 1) return
    const entry = entries[0] ?? ''
    if (!/^\d+-[a-f0-9-]+$/u.test(entry)) return
    const host = await readPrivateFile(join(folder, entry), 'account lock', 1024)
    if (host === null || host !== hostname()) return
    const pid = Number(entry.split('-')[0])
    let dead = false
    try {
      process.kill(pid, 0)
    } catch (error: unknown) {
      dead = (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
    if (dead) {
      await unlink(join(folder, entry))
      await rmdir(folder)
    }
  }

  /** Read the document, synthesizing one from the legacy file when needed. */
  private async load(): Promise<{ document: KiroAccountsDocument; legacy: boolean }> {
    const raw = await readPrivateFile(this.documentPath, 'account document', KIRO_ACCOUNT_DOCUMENT_LIMIT)
    if (raw !== null) {
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        fail('Kiro account document is not valid JSON', 'INVALID_ACCOUNT_STORE')
      }
      return { document: parseDocument(value), legacy: false }
    }
    const legacyRaw = await readPrivateFile(this.legacyPath, 'token file', CREDENTIAL_LIMIT)
    if (legacyRaw === null) return { document: emptyDocument(), legacy: false }
    let legacyValue: unknown
    try {
      legacyValue = JSON.parse(legacyRaw)
    } catch {
      return { document: emptyDocument(), legacy: false }
    }
    if (!isRecord(legacyValue)) return { document: emptyDocument(), legacy: false }
    const parsed = parseCredential(legacyValue, 'token file')
    if (!parsed.authenticated) return { document: emptyDocument(), legacy: false }
    const id = legacyAccountId(this.legacyPath)
    const facts = factsOf(parsed)
    const method = facts.authMethod ?? 'builder-id'
    return {
      legacy: true,
      document: {
        version: 1,
        revision: 0,
        activeAccountId: id,
        accounts: [{
          id,
          label: defaultAccountLabel(method, facts.region),
          authMethod: method,
          ...facts.region === undefined ? {} : { region: facts.region },
          ...facts.profileArn === undefined ? {} : { profileArn: facts.profileArn },
          createdAt: 0,
          updatedAt: 0,
          credentialRevision: 0,
          credential: parsed.credential,
        }],
      },
    }
  }

  /**
   * Replace the document atomically, leaving the legacy file untouched.
   * @param document - the complete document to persist.
   */
  private async save(document: KiroAccountsDocument): Promise<void> {
    parseDocument(document)
    const serialized = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(serialized) > KIRO_ACCOUNT_DOCUMENT_LIMIT) {
      fail('Kiro account document exceeds ' + String(KIRO_ACCOUNT_DOCUMENT_LIMIT) + ' bytes', 'INVALID_ACCOUNT_STORE')
    }
    await this.ensureDirectory()
    const temporary = `${this.documentPath}.${String(process.pid)}-${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(serialized)
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, this.documentPath)
      const directory = await open(this.directory, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await handle?.close()
      await unlink(temporary).catch(() => undefined)
    }
  }

  /**
   * Run one mutation and persist its result under a new revision.
   * @param action - the mutation, which edits the document in place.
   * @param options - optional revision guard and lock namespace.
   * @returns the action result.
   */
  private async mutate<T>(
    action: (document: KiroAccountsDocument) => T,
    options: { expectedRevision?: number; suffix?: string } = {},
  ): Promise<T> {
    return this.withLock(options.suffix ?? 'document', async () => {
      const { document } = await this.load()
      if (options.expectedRevision !== undefined && options.expectedRevision !== document.revision) {
        fail('Kiro accounts changed since they were read; reload before retrying', 'REVISION_CONFLICT')
      }
      const result = action(document)
      document.revision += 1
      await this.save(document)
      return result
    })
  }

  /**
   * Locate one stored account or fail.
   * @param document - the document to search.
   * @param accountId - the account to find.
   * @returns the stored account.
   */
  private account(document: KiroAccountsDocument, accountId: string): KiroStoredAccount {
    const found = document.accounts.find(account => account.id === accountId)
    if (found === undefined) fail('Kiro account "' + accountId + '" is not stored', 'ACCOUNT_NOT_FOUND')
    return found
  }

  /**
   * List every stored account, credential-free.
   * @returns the snapshot the settings page renders.
   */
  async snapshot(): Promise<KiroAccountsSnapshot> {
    const { document, legacy } = await this.load()
    const now = Date.now()
    return {
      revision: document.revision,
      activeAccountId: document.activeAccountId,
      accounts: document.accounts.map(account => summarize(account, document.activeAccountId, now)),
      migrated: legacy,
    }
  }

  /**
   * Pin one account for a request or a refresh.
   * @param accountId - the account to pin; the active one when omitted.
   * @returns the pinned account, or null when the store holds none.
   */
  async capture(accountId?: string): Promise<CapturedKiroAccount | null> {
    const document = (await this.load()).document
    const target = accountId ?? document.activeAccountId
    if (target === null) return null
    const account = this.account(document, target)
    let revision = account.credentialRevision
    let pending: Promise<Record<string, unknown> | undefined> | null = null
    return {
      accountId: account.id,
      credentialRevision: revision,
      read: async () => {
        const current = (await this.load()).document
        return current.accounts.find(candidate => candidate.id === account.id)?.credential
      },
      modify: (change) => {
        // One refresh per account at a time: a second caller arriving while a
        // write is in flight wants that write result, not a competing one.
        if (pending !== null) return pending
        pending = this.withLock(`account-${account.id}`, async () => {
          const latest = (await this.load()).document
          const current = latest.accounts.find(candidate => candidate.id === account.id)
          if (current === undefined) fail('Kiro account "' + account.id + '" was removed', 'ACCOUNT_NOT_FOUND')
          if (current.credentialRevision !== revision) {
            // A login replaced these credentials while the refresh was running.
            revision = current.credentialRevision
            return structuredClone(current.credential)
          }
          const next = change(structuredClone(current.credential))
          if (next === undefined) return structuredClone(current.credential)
          const parsed = parseCredential(next, 'account ' + account.id + ' credential')
          const facts = factsOf(parsed)
          const written = await this.mutate(document => {
            const stored = this.account(document, account.id)
            if (stored.credentialRevision !== current.credentialRevision) {
              fail('Kiro account credentials changed while they were being refreshed', 'ACCOUNT_CHANGED')
            }
            stored.credential = parsed.credential
            stored.credentialRevision += 1
            stored.updatedAt = Date.now()
            if (facts.authMethod !== undefined) stored.authMethod = facts.authMethod
            if (facts.region !== undefined) stored.region = facts.region
            if (facts.profileArn !== undefined) stored.profileArn = facts.profileArn
            return structuredClone(stored.credential)
          })
          revision = current.credentialRevision + 1
          return written
        }).finally(() => {
          pending = null
        })
        return pending
      },
    }
  }

  /**
   * Store a credential, updating an existing account or adding one.
   * @param input - the credential and the metadata that names it.
   * @returns the identifier of the account that now holds the credential.
   */
  async upsert(input: KiroAccountUpsert): Promise<{ accountId: string }> {
    const parsed = parseCredential(input.credential, 'credential')
    if (!parsed.authenticated) fail('Kiro credential carries neither an access nor a refresh token', 'INVALID_CREDENTIAL')
    const label = input.label === undefined ? undefined : boundedText(input.label, 320)
    if (input.label !== undefined && label === undefined) fail('Kiro account label is unusable', 'INVALID_ACCOUNT_STORE')
    return this.mutate(document => {
      const existing = input.accountId === undefined ? undefined : this.account(document, input.accountId)
      const now = Date.now()
      const facts = factsOf(parsed)
      const authMethod = input.authMethod ?? facts.authMethod ?? existing?.authMethod
      if (authMethod === undefined) fail('Kiro login did not name an authentication method', 'INVALID_CREDENTIAL')
      const region = input.region ?? facts.region ?? existing?.region
      const profileArn = input.profileArn ?? facts.profileArn ?? existing?.profileArn
      if (existing !== undefined) {
        existing.credential = parsed.credential
        existing.credentialRevision += 1
        existing.updatedAt = now
        existing.authMethod = authMethod
        if (region !== undefined) existing.region = region
        if (profileArn !== undefined) existing.profileArn = profileArn
        if (label !== undefined) existing.label = label
        if (document.activeAccountId === null || input.activate === true) document.activeAccountId = existing.id
        return { accountId: existing.id }
      }
      if (document.accounts.length >= MAX_KIRO_ACCOUNTS) {
        fail('Kiro stores at most ' + String(MAX_KIRO_ACCOUNTS) + ' accounts; remove one first', 'ACCOUNT_LIMIT')
      }
      const account: KiroStoredAccount = {
        id: randomUUID(),
        label: label ?? defaultAccountLabel(authMethod, region),
        authMethod,
        ...region === undefined ? {} : { region },
        ...profileArn === undefined ? {} : { profileArn },
        createdAt: now,
        updatedAt: now,
        credentialRevision: 0,
        credential: parsed.credential,
      }
      document.accounts.push(account)
      if (document.activeAccountId === null || input.activate === true) document.activeAccountId = account.id
      return { accountId: account.id }
    }, {
      ...input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision },
    })
  }

  /**
   * Select the account later requests use.
   * @param accountId - the account to activate.
   * @param expectedRevision - document revision the caller read, when it wants conflict detection.
   * @returns the activated account identifier.
   */
  async activate(accountId: string, expectedRevision?: number): Promise<{ accountId: string }> {
    return this.mutate(document => {
      this.account(document, accountId)
      document.activeAccountId = accountId
      return { accountId }
    }, {
      ...expectedRevision === undefined ? {} : { expectedRevision },
    })
  }

  /**
   * Remove one account, requiring a replacement when it is the active one and
   * others remain.
   * @param accountId - the account to remove.
   * @param options - replacement choice and optional revision guard.
   * @returns the removed account identifier and its credential, so the caller
   *   can also delete that account device registration.
   */
  async remove(
    accountId: string,
    options: { replacementId?: string; expectedRevision?: number } = {},
  ): Promise<{ accountId: string; credential: Record<string, unknown> }> {
    return this.mutate(document => {
      const account = this.account(document, accountId)
      const replacement = options.replacementId
      if (replacement !== undefined) {
        if (replacement === accountId) fail('An account cannot replace itself', 'INVALID_REPLACEMENT')
        this.account(document, replacement)
      }
      if (document.activeAccountId === accountId && document.accounts.length > 1 && replacement === undefined) {
        fail('Removing the active Kiro account needs a replacement account', 'REPLACEMENT_REQUIRED')
      }
      document.accounts = document.accounts.filter(candidate => candidate.id !== accountId)
      if (document.activeAccountId === accountId) document.activeAccountId = replacement ?? null
      return { accountId, credential: account.credential }
    }, {
      ...options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision },
    })
  }

  /**
   * Sign out every account, keeping an empty document so the installation stays
   * explicitly signed out instead of falling back to the legacy file.
   * @returns every removed credential, so the caller can clean up registrations.
   */
  async removeAll(): Promise<readonly { accountId: string; credential: Record<string, unknown> }[]> {
    return this.withLock('document', async () => {
      const { document } = await this.load()
      const removed = document.accounts.map(account => ({ accountId: account.id, credential: account.credential }))
      const next: KiroAccountsDocument = {
        version: 1,
        revision: document.revision + 1,
        activeAccountId: null,
        accounts: [],
      }
      await this.save(next)
      return removed
    })
  }
}

