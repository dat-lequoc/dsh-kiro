#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import {
  credentialDirectory,
  deleteDeviceCredentials,
  discoverKiroProfileArn,
  getJson,
  importApiKey,
  importExternalIdp,
  importRefreshToken,
  pollDeviceLogin,
  postJson,
  postJsonWithHeaders,
  saveManagedCredentials,
  startDeviceLogin,
} from '../lib/index.js'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', () => {})
  child.unref()
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('login cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const controller = new AbortController()
for (const name of ['SIGINT', 'SIGTERM']) {
  process.once(name, () => controller.abort(`${name} received`))
}

try {
  const directory = credentialDirectory()
  if (process.argv.includes('--help')) {
    console.log(`Usage: kiro-login [options]

Methods:
  --method builder-id             AWS Builder ID device login (default)
  --method idc --start-url URL    IAM Identity Center device login
  --method google|github          Google/GitHub device-code login
  --method refresh-token          Import KIRO_REFRESH_TOKEN or --refresh-token
  --method api-key                Import KIRO_API_KEY or --api-key
  --method external-idp           Import CLIProxyAPI JSON from --credentials-file

Common options:
  --region REGION                 AWS region (default: us-east-1)
  --profile-arn ARN               Optional CodeWhisperer profile ARN
  --proxy URL                     HTTP/HTTPS proxy
  --no-open                       Do not open a browser automatically
  --logout                        Remove dsh-kiro-managed credentials`)
    process.exit(0)
  }
  if (process.argv.includes('--logout')) {
    await deleteDeviceCredentials(directory)
    console.log(`Removed dsh-kiro managed credentials from ${directory}`)
    process.exit(0)
  }

  const region = option('--region') ?? process.env.KIRO_REGION ?? 'us-east-1'
  const proxyUrl = option('--proxy') ?? process.env.KIRO_PROXY_URL
  const method = option('--method') ?? 'builder-id'
  const requestJson = (url, body, signal) => postJson(url, body, proxyUrl, signal)
  let credentials

  if (method === 'builder-id' || method === 'idc' || method === 'google' || method === 'github') {
    const session = await startDeviceLogin(region, requestJson, controller.signal, {
      authMethod: method,
      ...(method === 'idc' ? { startUrl: option('--start-url') ?? process.env.KIRO_START_URL ?? '' } : {}),
    })
    console.log(`Open ${session.verificationUri}`)
    console.log(`Device code: ${session.userCode}`)
    if (!process.argv.includes('--no-open')) openBrowser(session.verificationUri)

    let intervalSeconds = session.intervalSeconds
    while (true) {
      await delay(intervalSeconds * 1000, controller.signal)
      const result = await pollDeviceLogin(session, requestJson, controller.signal)
      if (result.status === 'pending') {
        intervalSeconds = result.intervalSeconds
        continue
      }
      credentials = result.credentials
      break
    }
  } else if (method === 'refresh-token') {
    credentials = await importRefreshToken({
      refreshToken: option('--refresh-token') ?? process.env.KIRO_REFRESH_TOKEN ?? '',
      region,
      ...option('--profile-arn') === undefined ? {} : { profileArn: option('--profile-arn') },
      ...option('--client-id') === undefined ? {} : { clientId: option('--client-id') },
      ...option('--client-secret') === undefined ? {} : { clientSecret: option('--client-secret') },
      ...option('--start-url') === undefined ? {} : { startUrl: option('--start-url') },
    }, requestJson, controller.signal)
  } else if (method === 'api-key') {
    credentials = await importApiKey(
      option('--api-key') ?? process.env.KIRO_API_KEY ?? '',
      region,
      (url, headers, signal) => getJson(url, headers, proxyUrl, signal),
      controller.signal,
    )
  } else if (method === 'external-idp') {
    const path = option('--credentials-file')
    if (path === undefined) throw new Error('--credentials-file is required for external-idp login')
    credentials = importExternalIdp(await readFile(path, 'utf8'))
  } else {
    throw new Error(`unsupported login method: ${method}`)
  }

  const selectedProfileArn = option('--profile-arn')
  if (selectedProfileArn !== undefined) credentials = { ...credentials, profileArn: selectedProfileArn }
  if (credentials.profileArn === undefined && credentials.authMethod !== 'api_key') {
    try {
      const profileArn = await discoverKiroProfileArn(
        { region: credentials.region, ...(proxyUrl === undefined ? {} : { proxyUrl }) },
        {
          accessToken: credentials.accessToken,
          region: credentials.region,
          expiresAt: Date.parse(credentials.expiresAt),
          authMethod: credentials.authMethod,
        },
        controller.signal,
        postJsonWithHeaders,
      )
      if (profileArn !== undefined) credentials = { ...credentials, profileArn }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`Profile ARN discovery did not complete: ${detail}`)
    }
  }
  await saveManagedCredentials(directory, credentials)
  console.log(`Kiro ${method} login complete. Credentials saved to ${directory}`)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`Kiro login failed: ${detail}`)
  process.exitCode = 1
}
