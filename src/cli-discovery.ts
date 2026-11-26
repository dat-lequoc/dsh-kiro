/**
 * Discover Kiro models and profile ARN through external sources that bypass
 * the network-dependent ListAvailableModels API:
 *
 * 1. `kiro-cli chat --list-models --format json` — the CLI does its own auth
 *    and model discovery, so it works even when the API endpoint is not
 *    directly reachable from this process.
 * 2. Kiro IDE/CLI's `profile.json` on disk — the profile ARN the signed-in
 *    client recorded, which is the same fact ListAvailableProfiles discovers.
 *
 * Both are best-effort fallbacks: the API-based discovery remains
 * authoritative when it succeeds, because only it advertises each model's
 * effort levels. {@link mergeCliCatalog} combines the two.
 *
 * @module dsh-kiro/cli-discovery
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { KiroCatalogModel } from './adapter.ts'
import { parseInputModalities, modelSupportsThinking } from './discovery.ts'

/** Timeout for `kiro-cli` subprocess calls. */
const CLI_TIMEOUT_MS = 30_000

/**
 * Files Kiro IDE/CLI writes the active profile ARN to, tried in order.
 * An IdC or Enterprise account has no implicit default profile — the service
 * answers a request that names none with 403 — so this fact is discovered
 * beside the token rather than restated as configuration.
 */
const PROFILE_FILES: readonly (readonly string[])[] = [
  // The remote-server extension host layout.
  ['.kiro-server', 'data', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'],
  // The desktop IDE keeps the same globalStorage layout under its own root.
  ['.kiro', 'data', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'],
]

/** One model entry from `kiro-cli chat --list-models --format json`. */
interface CliModel {
  model_id?: unknown
  model_name?: unknown
  description?: unknown
  context_window_tokens?: unknown
  rate_multiplier?: unknown
}

/**
 * Run `kiro-cli chat --list-models --format json` and parse the output.
 *
 * @returns the CLI's live model catalog, or `undefined` when the CLI is
 *   unavailable or fails (not installed, not logged in, timeout).
 */
export async function discoverModelsFromCli(signal?: AbortSignal): Promise<KiroCatalogModel[] | undefined> {
  try {
    const output = await runKiroCli(['chat', '--list-models', '--format', 'json'], signal)
    if (output === undefined) return undefined
    return parseCliModels(output)
  } catch {
    return undefined
  }
}

/**
 * Combine the API catalog with the CLI catalog.
 *
 * The API entry wins for every model both report: only it carries the live
 * effort schema, output bounds, and input types. Models the CLI alone lists
 * are appended so the catalog never shrinks because one source lagged.
 * @param api - models from ListAvailableModels, in provider order.
 * @param cli - models from `kiro-cli --list-models`, or undefined.
 * @returns the API models followed by CLI-only models.
 */
export function mergeCliCatalog(
  api: readonly KiroCatalogModel[],
  cli: readonly KiroCatalogModel[] | undefined,
): KiroCatalogModel[] {
  const known = new Set(api.map(model => model.id))
  return [...api, ...(cli ?? []).filter(model => !known.has(model.id))]
}

/**
 * Read the profile ARN the signed-in Kiro IDE or CLI recorded on disk.
 *
 * Absence is normal — a personal account reaches the service without one —
 * so a missing or unreadable file yields `undefined`.
 * @param homeDir - root the candidate paths resolve against.
 * @returns the ARN from the first candidate that has one, or `undefined`.
 */
export async function discoverProfileArnFromFile(homeDir?: string): Promise<string | undefined> {
  const root = homeDir ?? homedir()
  for (const parts of PROFILE_FILES) {
    try {
      const raw = JSON.parse(await readFile(join(root, ...parts), 'utf8')) as Record<string, unknown>
      const arn = raw.arn ?? raw.profileArn
      if (typeof arn === 'string' && arn.length > 0 && arn.includes(':codewhisperer:')) return arn
    } catch {
      // Absent, unreadable, or malformed: try the next layout.
      continue
    }
  }
  return undefined
}

/**
 * Execute the kiro-cli binary and capture its stdout.
 * @param args - CLI arguments.
 * @returns the stdout text, or `undefined` when the CLI is not available.
 */
function runKiroCli(args: string[], signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli'
    execFile(command, args, {
      timeout: CLI_TIMEOUT_MS,
      ...signal === undefined ? {} : { signal },
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Parse the JSON output of `kiro-cli chat --list-models --format json`.
 * @param output - raw stdout from the CLI.
 * @returns catalog models, or `undefined` when the output is not usable.
 */
function parseCliModels(output: string): KiroCatalogModel[] | undefined {
  let parsed: { models?: unknown; default_model?: unknown }
  try {
    parsed = JSON.parse(output) as { models?: unknown }
  } catch {
    return undefined
  }
  const rawModels = parsed.models
  if (!Array.isArray(rawModels) || rawModels.length === 0) return undefined

  const seen = new Set<string>()
  const models: KiroCatalogModel[] = []
  for (const raw of rawModels) {
    const entry = raw as CliModel
    const id = typeof entry.model_id === 'string' ? entry.model_id : undefined
    if (id === undefined || id.length === 0 || seen.has(id)) continue
    seen.add(id)

    const name = typeof entry.model_name === 'string' && entry.model_name.length > 0
      ? entry.model_name
      : undefined
    const description = typeof entry.description === 'string' && entry.description.length > 0
      ? entry.description
      : undefined
    const contextWindow = typeof entry.context_window_tokens === 'number'
      && Number.isInteger(entry.context_window_tokens)
      && entry.context_window_tokens > 0
      ? entry.context_window_tokens
      : undefined

    // The CLI does not report thinking or input modalities per model, so
    // infer from the model id using the same heuristic the API discovery uses.
    const thinking = modelSupportsThinking(id)

    // Vision capability: Claude models and auto support images; others text-only.
    const hasVision = /^(?:claude|auto)/iu.test(id)
    const inputModalities: KiroCatalogModel['inputModalities'] = hasVision
      ? ['text', 'image']
      : ['text']

    models.push({
      id,
      ...name === undefined ? {} : { name: cliModelDisplayName(name) },
      ...description === undefined ? {} : { description },
      ...contextWindow === undefined ? {} : { contextWindow },
      thinking,
      inputModalities,
    })
  }
  return models.length === 0 ? undefined : models
}

/**
 * Normalize CLI model names into display-friendly labels.
 * The CLI returns lowercase names like `claude-opus-5.5`; capitalize them.
 */
function cliModelDisplayName(raw: string): string {
  return raw
    .split('-')
    .map(part => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(' ')
    .replace(/(\d)\.(\d)/g, '$1.$2') // keep version numbers as-is
}
