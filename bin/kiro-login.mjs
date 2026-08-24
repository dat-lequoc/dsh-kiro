#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  credentialDirectory,
  deleteDeviceCredentials,
  pollDeviceLogin,
  postJson,
  saveDeviceCredentials,
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
  if (process.argv.includes('--logout')) {
    await deleteDeviceCredentials(directory)
    console.log(`Removed dsh-kiro managed credentials from ${directory}`)
    process.exit(0)
  }

  const region = option('--region') ?? process.env.KIRO_REGION ?? 'us-east-1'
  const proxyUrl = option('--proxy') ?? process.env.KIRO_PROXY_URL
  const requestJson = (url, body, signal) => postJson(url, body, proxyUrl, signal)
  const session = await startDeviceLogin(region, requestJson, controller.signal)
  console.log(`Open ${session.verificationUri}`)
  console.log(`Builder ID code: ${session.userCode}`)
  if (!process.argv.includes('--no-open')) openBrowser(session.verificationUri)

  let intervalSeconds = session.intervalSeconds
  while (true) {
    await delay(intervalSeconds * 1000, controller.signal)
    const result = await pollDeviceLogin(session, requestJson, controller.signal)
    if (result.status === 'pending') {
      intervalSeconds = result.intervalSeconds
      continue
    }
    await saveDeviceCredentials(directory, result.credentials)
    console.log(`Kiro login complete. Credentials saved to ${directory}`)
    break
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`Kiro login failed: ${detail}`)
  process.exitCode = 1
}
