/** DSH Web API for Kiro login status and live model discovery. */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-host-webserver'
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts'
import { kiroCredentialDirectory } from './auth.ts'
import type { KiroToken } from './auth.ts'
import type { KiroModelDiscovery } from './discovery.ts'
import {
  credentialSummary,
  deleteDeviceCredentials,
  pollDeviceLogin,
  saveDeviceCredentials,
  startDeviceLogin,
} from './login.ts'
import type { DeviceLoginSession } from './login.ts'
import { postJson } from './transport.ts'

interface WebDependencies {
  managedDirectory: string
  options: () => KiroConnectionOptions
  discovery: KiroModelDiscovery
  resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>
}

interface LoginFlow {
  status: 'pending' | 'complete' | 'error'
  session?: DeviceLoginSession
  authUrl?: string
  userCode?: string
  startedAt: number
  completedAt?: number
  error?: string
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
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
    .replace(/(?:access|refresh|client)[_-]?(?:token|secret)\s*[:=]\s*\S+/giu, '[redacted credential]')
}

function publicLogin(flow: LoginFlow | undefined): Record<string, unknown> {
  if (flow === undefined) return { status: 'idle' }
  return {
    status: flow.status,
    startedAt: flow.startedAt,
    ...flow.completedAt === undefined ? {} : { completedAt: flow.completedAt },
    ...flow.authUrl === undefined ? {} : { authUrl: flow.authUrl },
    ...flow.userCode === undefined ? {} : { userCode: flow.userCode },
    ...flow.error === undefined ? {} : { error: flow.error },
  }
}

function modelPayload(models: readonly KiroCatalogModel[], source: 'live' | 'configured'): unknown {
  return {
    source,
    fetchedAt: Date.now(),
    models: models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      description: model.description,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinking: model.thinking ?? true,
      reasoningEfforts: model.thinking === false ? ['off'] : ['off', 'low', 'medium', 'high'],
    })),
  }
}

/**
 * Register the optional DSH Web management API.
 * @param ctx - owning Cordis context.
 * @param dependencies - credential and discovery services shared with the adapter.
 */
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
      ? { authenticated: false }
      : await credentialSummary(kiroCredentialDirectory())
    const connection = dependencies.options()
    const cached = dependencies.discovery.current(connection)
    return {
      authenticated: managed.authenticated || external.authenticated,
      credentialSource: managed.authenticated ? 'dsh' : external.authenticated ? 'kiro' : 'none',
      region: managed.region ?? external.region ?? connection.region,
      expiresAt: managed.expiresAt ?? external.expiresAt,
      login: publicLogin(login),
      models: modelPayload(cached ?? connection.models, cached === undefined ? 'configured' : 'live'),
    }
  }

  const beginLogin = async (): Promise<unknown> => {
    if (login?.status === 'pending') return publicLogin(login)
    loginController?.abort('starting a new Kiro login')
    const controller = new AbortController()
    loginController = controller
    const connection = dependencies.options()
    const region = connection.region ?? 'us-east-1'
    const requestJson = (url: string, body: unknown, signal: AbortSignal) =>
      postJson(url, body, connection.proxyUrl, signal)
    const session = await startDeviceLogin(region, requestJson, controller.signal)
    login = {
      status: 'pending',
      session,
      authUrl: session.verificationUri,
      userCode: session.userCode,
      startedAt: Date.now(),
    }

    void (async () => {
      let intervalSeconds = session.intervalSeconds
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
          const result = await pollDeviceLogin(session, requestJson, controller.signal)
          if (result.status === 'pending') {
            intervalSeconds = result.intervalSeconds
            continue
          }
          await saveDeviceCredentials(dependencies.managedDirectory, result.credentials)
          dependencies.discovery.clear()
          login = {
            status: 'complete',
            authUrl: session.verificationUri,
            userCode: session.userCode,
            startedAt: login?.startedAt ?? Date.now(),
            completedAt: Date.now(),
          }
          emitUpdated()
          return
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        login = {
          status: 'error',
          authUrl: session.verificationUri,
          userCode: session.userCode,
          startedAt: login?.startedAt ?? Date.now(),
          completedAt: Date.now(),
          error: safeError(error),
        }
      }
    })()
    return publicLogin(login)
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
              sendJson(response, 200, { ok: true, value: await beginLogin() })
              return
            }
            if (path === 'logout' && request.method === 'POST') {
              loginController?.abort('Kiro logout')
              login = undefined
              await deleteDeviceCredentials(dependencies.managedDirectory)
              dependencies.discovery.clear()
              emitUpdated()
              sendJson(response, 200, { ok: true, value: await status() })
              return
            }
            if (path === 'models' && request.method === 'GET') {
              const connection = dependencies.options()
              const cached = dependencies.discovery.current(connection)
              sendJson(response, 200, {
                ok: true,
                value: modelPayload(cached ?? connection.models, cached === undefined ? 'configured' : 'live'),
              })
              return
            }
            if (path === 'models/refresh' && request.method === 'POST') {
              const connection = dependencies.options()
              const models = await dependencies.discovery.list(
                connection,
                AbortSignal.timeout(15_000),
                true,
              )
              emitUpdated()
              sendJson(response, 200, { ok: true, value: modelPayload(models, 'live') })
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
