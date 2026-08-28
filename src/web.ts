/** DSH Web API for multi-method Kiro login, credential import, and model discovery. */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
import { DEFAULT_REGION, kiroCredentialDirectory } from './auth.ts'
import type { KiroToken } from './auth.ts'
import { discoverKiroProfileArn } from './discovery.ts'
import type { KiroModelDiscovery } from './discovery.ts'
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
} from './login.ts'
import type { DeviceLoginPoll, ManagedCredentials, RefreshTokenOrigin } from './login.ts'
import { getJson, postJson } from './transport.ts'
import type { KiroUsageService } from './usage.ts'

interface WebDependencies {
  managedDirectory: string
  options: () => KiroConnectionOptions
  discovery: KiroModelDiscovery
  modelSettings: FileModelSettingsStore
  usage: KiroUsageService
  resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>
}

interface LoginFlow {
  status: 'pending' | 'complete' | 'error'
  kind: 'device' | 'social-device'
  method: string
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
    ...flow.error === undefined ? {} : { error: flow.error },
  }
}

async function modelPayload(
  models: readonly KiroCatalogModel[],
  source: 'live' | 'configured',
  store: FileModelSettingsStore,
): Promise<unknown> {
  const selection = await modelSelection(store, models)
  return {
    source,
    fetchedAt: Date.now(),
    enabledModelIds: selection.enabledModelIds,
    models: selection.models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      description: model.description,
      contextWindow: model.contextWindow,
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
    const cached = dependencies.discovery.current(connection)
    return {
      authenticated: managed.authenticated || external.authenticated,
      credentialSource: managed.authenticated ? 'dsh' : external.authenticated ? 'kiro' : 'none',
      authMethod: managed.authMethod ?? external.authMethod,
      region: managed.region ?? external.region ?? connection.region,
      expiresAt: managed.expiresAt ?? external.expiresAt,
      profileArn: connection.profileArn ?? managed.profileArn ?? external.profileArn,
      login: publicLogin(login),
      models: await modelPayload(
        cached ?? connection.models,
        cached === undefined ? 'configured' : 'live',
        dependencies.modelSettings,
      ),
      usage: dependencies.usage.current(connection),
    }
  }

  const save = async (credentials: ManagedCredentials, signal: AbortSignal): Promise<void> => {
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
        ctx.logger.warn(`dsh-kiro: profile ARN discovery after login failed: ${safeError(error)}`)
      }
    }
    await saveManagedCredentials(dependencies.managedDirectory, complete)
    dependencies.discovery.clear()
    dependencies.usage.clear()
    emitUpdated()
  }

  const finish = async (credentials: ManagedCredentials, flow: LoginFlow, signal: AbortSignal): Promise<void> => {
    await save(credentials, signal)
    login = {
      status: 'complete',
      kind: flow.kind,
      method: flow.method,
      ...flow.authUrl === undefined ? {} : { authUrl: flow.authUrl },
      ...flow.userCode === undefined ? {} : { userCode: flow.userCode },
      startedAt: flow.startedAt,
      completedAt: Date.now(),
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
    const connection = dependencies.options()
    const region = optionalText(body.region) ?? DEFAULT_REGION
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
    }
    login = flow
    monitorLogin(
      session.intervalSeconds,
      flow,
      controller,
      () => pollDeviceLogin(session, requestJson, controller.signal),
    )
    return publicLogin(login)
  }

  const beginSocialDevice = async (method: 'google' | 'github'): Promise<unknown> => {
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
      const region = optionalText(body.region) ?? DEFAULT_REGION
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
    await save(credentials, signal)
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
              const value = method === 'google' || method === 'github'
                ? await beginSocialDevice(method)
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
              dependencies.usage.clear()
              emitUpdated()
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'models' && request.method === 'GET') {
              const connection = dependencies.options()
              const cached = dependencies.discovery.current(connection)
              sendJson(response, 200, {
                ok: true,
                value: await modelPayload(
                  cached ?? connection.models,
                  cached === undefined ? 'configured' : 'live',
                  dependencies.modelSettings,
                ),
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
              const cached = dependencies.discovery.current(connection)
              const models = cached ?? connection.models
              await dependencies.modelSettings.setEnabledModelIds(body.enabledModelIds, models)
              emitUpdated()
              sendJson(response, 200, {
                ok: true,
                value: await modelPayload(
                  models,
                  cached === undefined ? 'configured' : 'live',
                  dependencies.modelSettings,
                ),
              })
              return
            }
            if (path === 'models/refresh' && request.method === 'POST') {
              const connection = dependencies.options()
              const models = await dependencies.discovery.list(connection, AbortSignal.timeout(15_000), true)
              await dependencies.modelSettings.mergeCatalog(models)
              emitUpdated()
              sendJson(response, 200, {
                ok: true,
                value: await modelPayload(models, 'live', dependencies.modelSettings),
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
