/** DSH Web API for multi-method Kiro login, credential import, and model discovery. */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-host-webserver'
import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { contextCapacity } from './adapter.ts'
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
import { KiroAccountStore } from './accounts.ts'
import { kiroCredentialDirectory } from './auth.ts'
import type { KiroToken } from './auth.ts'
import { discoverKiroProfileArn } from './discovery.ts'
import type { KiroModelDiscovery } from './discovery.ts'
import type { KiroCatalogSnapshot, KiroModelCatalog } from './model-catalog.ts'
import { modelSelection } from './model-settings.ts'
import type { FileModelSettingsStore } from './model-settings.ts'
import {
  credentialSummary,
  deleteDeviceCredentials,
  importApiKey,
  importExternalIdp,
  importRefreshToken,
  pollDeviceLogin,
  pollSocialDeviceLogin,
  saveManagedCredentials,
  startDeviceLogin,
  startSocialDeviceLogin,
  syncManagedCredentialFile,
} from './login.ts'
import type { DeviceLoginPoll, ManagedCredentials, RefreshTokenOrigin } from './login.ts'
import { readLocalKiroCredentials, refreshLocalKiroCredentials } from './local-credentials.ts'
import { defaultJsonTransport, startPortalLogin } from './portal-login.ts'
import type { PortalOrganization } from './portal-login.ts'
import { getJson, postForm, postJson } from './transport.ts'
import type { KiroUsageService } from './usage.ts'

/** Everything the Kiro Web API needs from the running plugin. */
export interface WebDependencies {
  managedDirectory: string
  options: () => KiroConnectionOptions
  discovery: KiroModelDiscovery
  /** Persistent catalog every model read goes through. */
  catalog: KiroModelCatalog
  modelSettings: FileModelSettingsStore
  usage: KiroUsageService
  resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>
}

interface LoginFlow {
  status: 'pending' | 'complete' | 'error'
  kind: 'device' | 'social-device' | 'portal' | 'local'
  method: string
  /** Account this login replaces; absent when it adds one. */
  accountId?: string
  /** Label the new account receives; absent when the store derives one. */
  label?: string
  authUrl?: string
  userCode?: string
  startedAt: number
  completedAt?: number
  error?: string
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/(?:access|refresh|client|api)[_-]?(?:token|secret|key)\s*[:=]\s*\S+/giu, '[redacted credential]')
    .replace(/aorAAAAAG[A-Za-z0-9._~-]+/gu, '[redacted refresh token]')
}

async function readJson(request: IncomingMessage, maximumBytes = 1_048_576): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
    bytes += chunk.byteLength
    if (bytes > maximumBytes) throw new Error('Kiro request body is too large')
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error: unknown) {
    throw new Error('Kiro request body is not valid JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Kiro request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function requiredText(value: unknown, name: string): string {
  const result = optionalText(value)
  if (result === undefined) throw new Error(`${name} is required`)
  return result
}

/**
 * Narrow the credential origin an import request names.
 * @param value - the request field, if the caller sent one.
 * @returns the origin, or `undefined` to let the importer derive it.
 * @throws when the caller names an origin this importer does not support.
 */
function refreshTokenOrigin(value: unknown): RefreshTokenOrigin | undefined {
  const named = optionalText(value)
  if (named === undefined) return undefined
  if (named === 'builder-id' || named === 'idc' || named === 'imported') return named
  throw new Error(`Unsupported Kiro refresh-token credential source "${named}"`)
}

/**
 * The Host service that persists a plugin's own profile row.
 *
 * Declared structurally rather than imported: the plugin uses one method pair of
 * an optional Host service, and taking a dependency on its package to name them
 * would tie this plugin's install to a package it otherwise never touches.
 */
interface ConfigurationEditor {
  /** Active profile rows with unique patch ids. */
  entries(): { options: { id: string; name?: string } }[]
  /** Persist the next raw config for one of those rows. */
  edit(
    entry: { options: { id: string; name?: string } },
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** The profile row this plugin's configuration lives on. */
const SETTINGS_ENTRY_ID = 'llm-kiro'

/**
 * Resolve the Host configuration editor, when this deployment mounts one.
 * @param ctx - the plugin context.
 * @returns the editor, or undefined.
 */
function configurationEditor(ctx: Context): ConfigurationEditor | undefined {
  const lookup = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof lookup !== 'function') return undefined
  const editor = lookup.call(ctx, 'configEditor') as ConfigurationEditor | undefined
  return typeof editor?.edit === 'function' && typeof editor.entries === 'function' ? editor : undefined
}

/** Account targeting one login or import request may name. */
interface AccountTarget {
  /** Update this stored account instead of adding one. */
  accountId?: string
  /** Label for a newly added account. */
  label?: string
}

/**
 * Read the account a login or import writes to.
 * @param source - the request body, or a login flow already carrying the target.
 * @returns the named account and label, when the caller supplied them.
 */
function accountTarget(source: { accountId?: unknown; label?: unknown }): AccountTarget {
  const accountId = optionalText(source.accountId)
  const label = optionalText(source.label)
  return {
    ...accountId === undefined ? {} : { accountId },
    ...label === undefined ? {} : { label },
  }
}

/**
 * Narrow the optional document revision a client sends with a mutation.
 * @param value - the request field.
 * @returns the revision, or undefined when the client sent none.
 * @throws when the field is present but is not a non-negative safe integer.
 */
function optionalRevision(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Kiro account revision must be a non-negative integer')
  }
  return value
}

/**
 * Delete the device registration one removed account owned.
 *
 * The registration is keyed by the OIDC client, so another stored account may
 * refresh through the very file this would delete; it goes only once no account
 * needs it.
 * @param directory - the credential directory this plugin owns.
 * @param credential - the removed account stored credential.
 */
async function dropRegistration(directory: string, credential: Record<string, unknown>): Promise<void> {
  const hash = credential['clientIdHash']
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) return
  if (await new KiroAccountStore(directory).usesRegistration(hash)) return
  try {
    await unlink(join(directory, hash + '.json'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function publicLogin(flow: LoginFlow | undefined): Record<string, unknown> {
  if (flow === undefined) return { status: 'idle' }
  return {
    status: flow.status,
    kind: flow.kind,
    method: flow.method,
    startedAt: flow.startedAt,
    ...flow.completedAt === undefined ? {} : { completedAt: flow.completedAt },
    ...flow.authUrl === undefined ? {} : { authUrl: flow.authUrl },
    ...flow.userCode === undefined ? {} : { userCode: flow.userCode },
    ...flow.accountId === undefined ? {} : { accountId: flow.accountId },
    ...flow.error === undefined ? {} : { error: flow.error },
  }
}

/**
 * Project the stored catalog for the page; with none stored yet, the
 * configured catalog is shown and labelled as such.
 */
async function modelPayload(
  snapshot: KiroCatalogSnapshot | undefined,
  connection: KiroConnectionOptions,
  store: FileModelSettingsStore,
): Promise<unknown> {
  const models = snapshot?.models ?? connection.models
  const maxContextWindow = connection.maxContextWindow
  const selection = await modelSelection(store, models)
  return {
    source: snapshot === undefined ? 'configured' : 'live',
    fetchedAt: snapshot?.fetchedAt ?? Date.now(),
    enabledModelIds: selection.enabledModelIds,
    models: selection.models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      description: model.description,
      // Report the capacity the adapter will actually declare, so the page
      // shows the budget requests are held to rather than the raw catalog value.
      contextWindow: model.contextWindow === undefined
        ? undefined
        : contextCapacity(model.contextWindow, maxContextWindow === undefined ? {} : { maxContextWindow }),
      maxTokens: model.maxTokens,
      thinking: model.thinking ?? true,
      reasoningEfforts: model.reasoningEfforts
        ?? (model.thinking === false ? ['off'] : ['off', 'low', 'medium', 'high']),
      defaultReasoningEffort: model.defaultReasoningEffort,
      enabled: model.enabled,
    })),
  }
}

/** Register the optional DSH Web management API. */
export function registerWebApi(ctx: Context, dependencies: WebDependencies): void {
  let login: LoginFlow | undefined
  let loginController: AbortController | undefined

  /** The multi-account store this API manages. */
  const accountStore = (): KiroAccountStore => new KiroAccountStore(dependencies.managedDirectory)

  const emitUpdated = (): void => {
    try {
      ctx.emit('llm/adapters-updated')
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-kiro: model update event failed: ${safeError(error)}`)
    }
  }

  const status = async (): Promise<unknown> => {
    const managed = await credentialSummary(dependencies.managedDirectory)
    const external = managed.authenticated
      ? { authenticated: false as const, authMethod: undefined, region: undefined, expiresAt: undefined, profileArn: undefined }
      : await credentialSummary(kiroCredentialDirectory())
    const connection = dependencies.options()
    const catalog = await dependencies.catalog.peek(connection)
    const accounts = await accountStore().snapshot()
    return {
      authenticated: managed.authenticated || external.authenticated,
      credentialSource: managed.authenticated ? 'dsh' : external.authenticated ? 'kiro' : 'none',
      authMethod: managed.authMethod ?? external.authMethod,
      region: managed.region ?? external.region ?? connection.region,
      expiresAt: managed.expiresAt ?? external.expiresAt,
      profileArn: connection.profileArn ?? managed.profileArn ?? external.profileArn,
      accounts,
      activeAccountId: accounts.activeAccountId,
      contextWindowCap: connection.maxContextWindow,
      login: publicLogin(login),
      models: await modelPayload(catalog, connection, dependencies.modelSettings),
      usage: dependencies.usage.current(connection),
    }
  }

  /**
   * Store one login or import, adding an account or replacing a named one.
   * @param credentials - the credential the flow produced.
   * @param signal - request cancellation for profile discovery.
   * @param target - the account to update, and the label for a new one.
   * @returns the identifier of the account that now holds the credential.
   */
  const save = async (
    credentials: ManagedCredentials,
    signal: AbortSignal,
    target: AccountTarget = {},
  ): Promise<{ accountId: string }> => {
    let complete = credentials
    if (credentials.profileArn === undefined && credentials.authMethod !== 'api_key') {
      try {
        const profileArn = await discoverKiroProfileArn(
          dependencies.options(),
          {
            accessToken: credentials.accessToken,
            region: credentials.region,
            expiresAt: Date.parse(credentials.expiresAt),
            authMethod: credentials.authMethod,
          },
          signal,
        )
        if (profileArn !== undefined) complete = { ...credentials, profileArn }
      } catch (error: unknown) {
        ctx.logger.warn('dsh-kiro: profile ARN discovery after login failed: ' + safeError(error))
      }
    }
    const saved = await saveManagedCredentials(dependencies.managedDirectory, complete, target)
    dependencies.discovery.clear()
    dependencies.catalog.invalidate()
    dependencies.usage.clear()
    emitUpdated()
    return saved
  }

  const finish = async (credentials: ManagedCredentials, flow: LoginFlow, signal: AbortSignal): Promise<void> => {
    const saved = await save(credentials, signal, accountTarget(flow))
    login = {
      status: 'complete',
      kind: flow.kind,
      method: flow.method,
      ...flow.authUrl === undefined ? {} : { authUrl: flow.authUrl },
      ...flow.userCode === undefined ? {} : { userCode: flow.userCode },
      startedAt: flow.startedAt,
      completedAt: Date.now(),
      accountId: saved.accountId,
    }
  }

  const monitorLogin = (
    initialIntervalSeconds: number,
    flow: LoginFlow,
    controller: AbortController,
    poll: () => Promise<DeviceLoginPoll>,
  ): void => {
    void (async () => {
      let intervalSeconds = initialIntervalSeconds
      try {
        while (!controller.signal.aborted) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              clearTimeout(timer)
              reject(new Error('Kiro login cancelled'))
            }
            const timer = setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort)
              resolve()
            }, intervalSeconds * 1000)
            controller.signal.addEventListener('abort', onAbort, { once: true })
          })
          const result = await poll()
          if (result.status === 'pending') {
            intervalSeconds = result.intervalSeconds
            continue
          }
          await finish(result.credentials, flow, controller.signal)
          return
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        login = {
          ...flow,
          status: 'error',
          completedAt: Date.now(),
          error: safeError(error),
        }
      }
    })()
  }

  const beginDevice = async (body: Record<string, unknown>): Promise<unknown> => {
    loginController?.abort('starting a new Kiro login')
    const controller = new AbortController()
    loginController = controller
    if (body.method !== 'builder-id' && body.method !== 'idc') {
      throw new Error('Unsupported Kiro device login method')
    }
    const method = body.method
    const target = accountTarget(body)
    const connection = dependencies.options()
    const region = optionalText(body.region) ?? connection.region ?? 'us-east-1'
    const requestJson = (url: string, value: unknown, signal: AbortSignal) =>
      postJson(url, value, connection.proxyUrl, signal)
    const session = await startDeviceLogin(region, requestJson, controller.signal, {
      authMethod: method,
      ...method === 'idc' ? { startUrl: requiredText(body.startUrl, 'IAM Identity Center start URL') } : {},
    })
    const flow: LoginFlow = {
      status: 'pending',
      kind: 'device',
      method,
      authUrl: session.verificationUri,
      userCode: session.userCode,
      startedAt: Date.now(),
      ...target,
    }
    // Publish the pending flow before returning it: the page reads the
    // verification code from this response and from every later /status poll,
    // so a flow left unpublished is a sign-in nobody can finish.
    login = flow
    monitorLogin(
      session.intervalSeconds,
      flow,
      controller,
      () => pollDeviceLogin(session, requestJson, controller.signal),
    )
    return publicLogin(login)
  }

  /**
   * Start a Google or GitHub device login.
   * @param method - the identity provider to sign in with.
   * @param target - the account a re-login updates, and a label for a new one.
   * @returns the pending login the page polls.
   */
  const beginSocialDevice = async (method: 'google' | 'github', target: AccountTarget = {}): Promise<unknown> => {
    loginController?.abort('starting a new Kiro login')
    const controller = new AbortController()
    loginController = controller
    const connection = dependencies.options()
    const requestJson = (url: string, value: unknown, signal: AbortSignal) =>
      postJson(url, value, connection.proxyUrl, signal)
    const session = await startSocialDeviceLogin(method, requestJson, controller.signal)
    const flow: LoginFlow = {
      status: 'pending',
      kind: 'social-device',
      method,
      authUrl: session.verificationUri,
      userCode: session.userCode,
      startedAt: Date.now(),
      ...target,
    }
    login = flow
    monitorLogin(
      session.intervalSeconds,
      flow,
      controller,
      () => pollSocialDeviceLogin(session, requestJson, controller.signal),
    )
    return publicLogin(login)
  }

  /**
   * Sign in the way Kiro IDE does: let the Kiro portal resolve the work email to
   * the organization, then finish at that organization's own IdP. Every other
   * organization answer falls back to the device flow this plugin already runs,
   * with the region and start URL the portal just resolved.
   * @param body login request, optionally carrying a portal override.
   * @returns the pending login the page polls.
   */
  const beginPortal = async (body: Record<string, unknown>): Promise<unknown> => {
    loginController?.abort('starting a new Kiro login')
    const controller = new AbortController()
    loginController = controller
    const target = accountTarget(body)
    const portalUrl = optionalText(body.portalUrl)
    const session = await startPortalLogin(
      portalUrl === undefined ? {} : { portalUrl },
      defaultJsonTransport,
      controller.signal,
    )
    const flow: LoginFlow = {
      status: 'pending',
      kind: 'portal',
      method: 'email',
      authUrl: session.portalUrl,
      startedAt: Date.now(),
      ...target,
    }
    login = flow
    void (async () => {
      try {
        const organization = await session.organization
        if (organization.kind === 'external-idp') {
          const idp = await session.beginExternalIdp(organization, { signal: controller.signal })
          login = {
            ...flow,
            authUrl: idp.authUrl,
            ...idp.userCode === undefined ? {} : { userCode: idp.userCode },
          }
          await finish(await idp.credentials, login, controller.signal)
          return
        }
        const connection = dependencies.options()
        const requestJson = (url: string, value: unknown, signal: AbortSignal) =>
          postJson(url, value, connection.proxyUrl, signal)
        if (organization.kind === 'social') {
          const device = await startSocialDeviceLogin(organization.provider, requestJson, controller.signal)
          login = { ...flow, authUrl: device.verificationUri, userCode: device.userCode }
          monitorLogin(
            device.intervalSeconds,
            login,
            controller,
            () => pollSocialDeviceLogin(device, requestJson, controller.signal),
          )
          return
        }
        const device = await startDeviceLogin(organization.region, requestJson, controller.signal, {
          authMethod: organization.provider === 'builderid' ? 'builder-id' : 'idc',
          startUrl: organization.startUrl,
        })
        login = { ...flow, authUrl: device.verificationUri, userCode: device.userCode }
        monitorLogin(
          device.intervalSeconds,
          login,
          controller,
          () => pollDeviceLogin(device, requestJson, controller.signal),
        )
      } catch (error) {
        if (!controller.signal.aborted) {
          login = { ...flow, status: 'error', completedAt: Date.now(), error: safeError(error) }
        }
      } finally {
        await session.close()
      }
    })()
    return publicLogin(login)
  }

  /**
   * Reuse the credential a local Kiro CLI or Kiro IDE sign-in already stored.
   *
   * An organization whose identity provider only trusts the Kiro IDE callback
   * cannot finish the browser login here: the browser hands the code back to
   * the IDE, which then holds the refreshable credential. Importing that
   * credential keeps the sign-in possible without pasting tokens by hand.
   * @param body login request, optionally naming the store to read.
   * @returns the completed login the page polls.
   */
  const beginLocal = async (body: Record<string, unknown>): Promise<unknown> => {
    loginController?.abort('starting a new Kiro login')
    const controller = new AbortController()
    loginController = controller
    const target = accountTarget(body)
    const dataFile = optionalText(body.dataFile)
    login = {
      status: 'pending',
      kind: 'local',
      method: 'local',
      startedAt: Date.now(),
      ...target,
    }
    try {
      const found = await readLocalKiroCredentials(dataFile === undefined ? {} : { file: dataFile })
      const connection = dependencies.options()
      const credentials = await refreshLocalKiroCredentials(
        found.credentials,
        (url, value, requestSignal) => postJson(url, value, connection.proxyUrl, requestSignal),
        controller.signal,
        (url, form, requestSignal) => postForm(url, form, connection.proxyUrl, requestSignal),
      )
      await finish(credentials, login, controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) {
        login = {
          ...login,
          status: 'error',
          completedAt: Date.now(),
          error: cause instanceof Error ? cause.message : String(cause),
        }
      }
    }
    return publicLogin(login)
  }

  const importCredential = async (body: Record<string, unknown>): Promise<unknown> => {
    loginController?.abort('importing Kiro credentials')
    loginController = undefined
    const connection = dependencies.options()
    const signal = AbortSignal.timeout(30_000)
    const method = requiredText(body.method, 'Kiro import method')
    let credentials: ManagedCredentials
    // What the import proved on the wire, so the page can confirm the credential
    // works instead of only reporting that it was stored.
    let verified: { models?: number; refreshed?: true } | undefined
    if (method === 'refresh-token') {
      const region = optionalText(body.region) ?? connection.region
      const profileArn = optionalText(body.profileArn)
      const clientId = optionalText(body.clientId)
      const clientSecret = optionalText(body.clientSecret)
      const startUrl = optionalText(body.startUrl)
      const origin = refreshTokenOrigin(body.credentialSource ?? body.authMethod)
      const refreshInput = {
        refreshToken: requiredText(body.refreshToken, 'Kiro refresh token'),
        ...region === undefined ? {} : { region },
        ...profileArn === undefined ? {} : { profileArn },
        ...clientId === undefined ? {} : { clientId },
        ...clientSecret === undefined ? {} : { clientSecret },
        ...startUrl === undefined ? {} : { startUrl },
        ...origin === undefined ? {} : { authMethod: origin },
      }
      credentials = await importRefreshToken(
        refreshInput,
        (url, value, requestSignal) => postJson(url, value, connection.proxyUrl, requestSignal),
        signal,
      )
      // The exchange minted a live access token, which is itself the proof.
      verified = { refreshed: true }
    } else if (method === 'api-key') {
      const checked = await importApiKey(
        requiredText(body.apiKey, 'Kiro API key'),
        optionalText(body.region) ?? connection.region,
        (url, headers, requestSignal) => getJson(url, headers, connection.proxyUrl, requestSignal),
        signal,
      )
      credentials = checked.credentials
      verified = { models: checked.models }
    } else if (method === 'external-idp') {
      credentials = importExternalIdp(body.credentials)
    } else {
      throw new Error('Unsupported Kiro import method')
    }
    await save(credentials, signal, accountTarget(body))
    login = undefined
    const current = await status() as Record<string, unknown>
    // External-IdP JSON is only reshaped locally, so it reports no verification:
    // claiming one would be a success the plugin never observed.
    return verified === undefined ? current : { ...current, verified }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/kiro/api',
        handler: async (request, response) => {
          const url = new URL(request.url ?? '/', 'http://dsh.local')
          const path = url.pathname.replace(/^\/kiro\/api\/?/u, '')
          try {
            if ((path === '' || path === 'status') && request.method === 'GET') {
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'login' && request.method === 'POST') {
              const body = await readJson(request)
              const method = optionalText(body.method) ?? 'builder-id'
              const value = method === 'email'
                ? await beginPortal(body)
                : method === 'local'
                  ? await beginLocal(body)
                  : method === 'google' || method === 'github'
                    ? await beginSocialDevice(method, accountTarget(body))
                    : await beginDevice({ ...body, method })
              sendJson(response, 200, { ok: true, value })
              return
            }
            if (path === 'login/cancel' && request.method === 'POST') {
              loginController?.abort('Kiro login cancelled')
              loginController = undefined
              login = undefined
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'credentials/import' && request.method === 'POST') {
              sendJson(response, 200, { ok: true, value: await importCredential(await readJson(request)) })
              return
            }
            if (path === 'logout' && request.method === 'POST') {
              loginController?.abort('Kiro logout')
              login = undefined
              await deleteDeviceCredentials(dependencies.managedDirectory)
              dependencies.discovery.clear()
              dependencies.catalog.invalidate()
              dependencies.usage.clear()
              emitUpdated()
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'context' && request.method === 'POST') {
              const body = await readJson(request)
              const raw = body.maxContextWindow
              if (raw !== null && raw !== undefined
                && (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)) {
                throw new Error('Kiro max context must be a positive whole number of tokens, or null to follow each model')
              }
              const requested: number | null = typeof raw === 'number' ? raw : null
              const editor = configurationEditor(ctx)
              if (editor === undefined) {
                throw new Error('This Harness mounts no configuration editor; set maxContextWindow on the llm-kiro row of cordis.patch.yml')
              }
              const entry = editor.entries().find(candidate => candidate.options.id === SETTINGS_ENTRY_ID)
              if (entry === undefined) {
                throw new Error(`The "${SETTINGS_ENTRY_ID}" row of this profile is not addressable; set maxContextWindow in cordis.patch.yml`)
              }
              await editor.edit(entry, (current) => {
                const next = { ...current }
                if (requested === null) delete next['maxContextWindow']
                else next['maxContextWindow'] = requested
                return next
              })
              dependencies.discovery.clear()
              dependencies.catalog.invalidate()
              dependencies.usage.clear()
              emitUpdated()
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'accounts' && request.method === 'GET') {
              sendJson(response, 200, { ok: true, value: await accountStore().snapshot() })
              return
            }
            if (path === 'accounts/activate' && request.method === 'POST') {
              const body = await readJson(request)
              const accountId = requiredText(body.accountId, 'account id')
              const revision = optionalRevision(body.revision)
              await accountStore().activate(accountId, revision)
              await syncManagedCredentialFile(dependencies.managedDirectory)
              dependencies.discovery.clear()
              dependencies.catalog.invalidate()
              dependencies.usage.clear()
              emitUpdated()
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'accounts/remove' && request.method === 'POST') {
              const body = await readJson(request)
              const accountId = requiredText(body.accountId, 'account id')
              const replacementId = optionalText(body.replacementId)
              const revision = optionalRevision(body.revision)
              const removed = await accountStore().remove(accountId, {
                ...replacementId === undefined ? {} : { replacementId },
                ...revision === undefined ? {} : { expectedRevision: revision },
              })
              await dropRegistration(dependencies.managedDirectory, removed.credential)
              await syncManagedCredentialFile(dependencies.managedDirectory)
              dependencies.discovery.clear()
              dependencies.catalog.invalidate()
              dependencies.usage.clear()
              emitUpdated()
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'models' && request.method === 'GET') {
              const connection = dependencies.options()
              const catalog = await dependencies.catalog.peek(connection)
              sendJson(response, 200, {
                ok: true,
                value: await modelPayload(catalog, connection, dependencies.modelSettings),
              })
              return
            }
            if (path === 'models' && request.method === 'POST') {
              const body = await readJson(request)
              if (!Array.isArray(body.enabledModelIds)
                || !body.enabledModelIds.every(id => typeof id === 'string')) {
                sendJson(response, 400, { ok: false, error: 'enabledModelIds must be an array of strings' })
                return
              }
              const connection = dependencies.options()
              // The selection is constrained to the catalog the page was
              // showing; reading the stored one keeps a checkbox click from
              // shrinking the known ids down to the configured fallback.
              const catalog = await dependencies.catalog.peek(connection)
              await dependencies.modelSettings.setEnabledModelIds(
                body.enabledModelIds,
                catalog?.models ?? connection.models,
              )
              emitUpdated()
              sendJson(response, 200, {
                ok: true,
                value: await modelPayload(catalog, connection, dependencies.modelSettings),
              })
              return
            }
            if (path === 'models/refresh' && request.method === 'POST') {
              const connection = dependencies.options()
              // A failed refresh surfaces as an error and leaves the stored
              // catalog untouched; merging and the update event happen in
              // the catalog's onUpdate hook.
              const catalog = await dependencies.catalog.refresh(connection)
              sendJson(response, 200, {
                ok: true,
                value: await modelPayload(catalog, connection, dependencies.modelSettings),
              })
              return
            }
            if (path === 'usage' && (request.method === 'GET' || request.method === 'POST')) {
              const connection = dependencies.options()
              const usage = await dependencies.usage.get(
                connection,
                AbortSignal.timeout(15_000),
                request.method === 'POST',
              )
              sendJson(response, 200, { ok: true, value: usage })
              return
            }
            if (['GET', 'POST'].includes(request.method ?? '')) {
              sendJson(response, 404, { ok: false, error: 'not-found' })
              return
            }
            sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
          } catch (error: unknown) {
            sendJson(response, 500, { ok: false, error: safeError(error) })
          }
        },
      })
      return () => {
        loginController?.abort('dsh-kiro web API disposed')
        dispose()
      }
    }, 'dsh-kiro: web API')
  })
}
