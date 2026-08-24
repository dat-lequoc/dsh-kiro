/** Persistent Kiro model visibility and deterministic catalog ordering. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { KiroCatalogModel } from './adapter.ts'
import { credentialDirectory } from './paths.ts'

const MODEL_SETTINGS_FILE = 'model-settings.json'

export interface KiroModelSettings {
  enabledModelIds: readonly string[]
  knownModelIds: readonly string[]
  updatedAt: number
}

function validIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string =>
    typeof id === 'string' && id.length > 0 && !/\s/u.test(id)))]
}

function normalize(value: unknown): KiroModelSettings {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    enabledModelIds: validIds(record.enabledModelIds),
    knownModelIds: validIds(record.knownModelIds),
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : 0,
  }
}

/** Default storage path; kept beside, but independent from, managed credentials. */
export function modelSettingsPath(): string {
  return join(credentialDirectory(), MODEL_SETTINGS_FILE)
}

/** Sort models by family, newest numeric version, then preferred variant. */
export function compareKiroModels(a: KiroCatalogModel, b: KiroCatalogModel): number {
  const family = (model: KiroCatalogModel): number => {
    const text = `${model.id} ${model.name ?? ''}`.toLowerCase()
    if (text.includes('claude')) return 1
    if (text.includes('gpt')) return 2
    if (text.includes('glm')) return 3
    if (text.includes('deepseek')) return 4
    if (text.includes('minimax')) return 5
    if (text.includes('qwen')) return 6
    if (model.id === 'auto') return 8
    return 7
  }
  const familyDifference = family(a) - family(b)
  if (familyDifference !== 0) return familyDifference

  const version = (model: KiroCatalogModel): number[] => {
    const match = `${model.id} ${model.name ?? ''}`.match(/\b(?:claude|gpt|glm|deepseek|qwen)?[-_ ]*v?(\d+(?:\.\d+)*)/iu)
    return (match?.[1] ?? '0').split('.').map(part => Number(part) || 0)
  }
  const left = version(a)
  const right = version(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference !== 0) return difference
  }

  const variant = (model: KiroCatalogModel): number => {
    const text = `${model.id} ${model.name ?? ''}`.toLowerCase()
    if (text.includes('opus')) return 1
    if (text.includes('sonnet')) return 2
    if (text.includes('haiku')) return 3
    if (text.includes('sol')) return 4
    if (text.includes('terra')) return 5
    if (text.includes('luna')) return 6
    return 10
  }
  const variantDifference = variant(a) - variant(b)
  if (variantDifference !== 0) return variantDifference
  return (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id)
}

/** Serialize model-settings writes so concurrent checkbox changes cannot race. */
export class FileModelSettingsStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly file = modelSettingsPath()) {}

  async read(): Promise<KiroModelSettings> {
    try {
      return normalize(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalize(undefined)
      throw error
    }
  }

  private async write(settings: KiroModelSettings): Promise<KiroModelSettings> {
    const next = { ...normalize(settings), updatedAt: Date.now() }
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
    await rename(temporary, this.file)
    return next
  }

  private modify(update: (current: KiroModelSettings) => KiroModelSettings | undefined): Promise<KiroModelSettings> {
    const next = (async () => {
      await this.chain.catch(() => {})
      const current = await this.read()
      const updated = update(current)
      return updated === undefined ? current : this.write(updated)
    })()
    this.chain = next.catch(() => {})
    return next
  }

  /** Merge a fresh catalog, enabling first-run and newly discovered model ids. */
  mergeCatalog(models: readonly KiroCatalogModel[]): Promise<KiroModelSettings> {
    const catalogIds = [...new Set(models.map(model => model.id))]
    const catalog = new Set(catalogIds)
    return this.modify((current) => {
      const known = new Set(current.knownModelIds)
      const enabled = current.knownModelIds.length === 0
        ? catalogIds
        : [
            ...current.enabledModelIds.filter(id => catalog.has(id)),
            ...catalogIds.filter(id => !known.has(id)),
          ]
      const enabledModelIds = [...new Set(enabled)]
      if (enabledModelIds.length === current.enabledModelIds.length
        && enabledModelIds.every((id, index) => id === current.enabledModelIds[index])
        && catalogIds.length === current.knownModelIds.length
        && catalogIds.every((id, index) => id === current.knownModelIds[index])) return undefined
      return { enabledModelIds, knownModelIds: catalogIds, updatedAt: current.updatedAt }
    })
  }

  /** Persist an exact checkbox selection, constrained to the current catalog. */
  setEnabledModelIds(
    enabledModelIds: readonly string[],
    models: readonly KiroCatalogModel[],
  ): Promise<KiroModelSettings> {
    const catalogIds = [...new Set(models.map(model => model.id))]
    const requested = new Set(validIds(enabledModelIds))
    return this.modify(current => ({
      enabledModelIds: catalogIds.filter(id => requested.has(id)),
      knownModelIds: catalogIds,
      updatedAt: current.updatedAt,
    }))
  }

  /** Resolve enabled models; a missing settings file means all are enabled. */
  async enabledModels(models: readonly KiroCatalogModel[]): Promise<readonly KiroCatalogModel[]> {
    const settings = await this.read()
    const enabled = settings.knownModelIds.length === 0
      ? new Set(models.map(model => model.id))
      : new Set(settings.enabledModelIds)
    return models.filter(model => enabled.has(model.id)).sort(compareKiroModels)
  }
}

/** Project a full catalog into the compact checkbox API shape. */
export async function modelSelection(
  store: FileModelSettingsStore,
  models: readonly KiroCatalogModel[],
): Promise<{ enabledModelIds: readonly string[]; models: readonly (KiroCatalogModel & { enabled: boolean })[] }> {
  const settings = await store.read()
  const enabled = settings.knownModelIds.length === 0
    ? new Set(models.map(model => model.id))
    : new Set(settings.enabledModelIds)
  const projected = models.map(model => ({ ...model, enabled: enabled.has(model.id) }))
  projected.sort((a, b) => Number(b.enabled) - Number(a.enabled) || compareKiroModels(a, b))
  return {
    enabledModelIds: projected.filter(model => model.enabled).map(model => model.id),
    models: projected,
  }
}
