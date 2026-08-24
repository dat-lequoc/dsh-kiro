import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KiroCatalogModel } from '../src/adapter.ts'
import {
  compareKiroModels,
  FileModelSettingsStore,
  modelSelection,
} from '../src/model-settings.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function store(): Promise<{ store: FileModelSettingsStore; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-models-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'model-settings.json')
  return { store: new FileModelSettingsStore(file), file }
}

const catalog = (...ids: string[]): KiroCatalogModel[] => ids.map(id => ({ id, name: id, thinking: true }))

describe('Kiro model settings', () => {
  it('treats the whole catalog as selected before settings are persisted', async () => {
    const fixture = await store()
    const models = catalog('claude-sonnet-4.6', 'claude-opus-5', 'gpt-5.6-luna')
    await expect(fixture.store.enabledModels(models)).resolves.toEqual([
      models[1], models[0], models[2],
    ])
    await expect(modelSelection(fixture.store, models)).resolves.toMatchObject({
      enabledModelIds: ['claude-opus-5', 'claude-sonnet-4.6', 'gpt-5.6-luna'],
      models: [{ enabled: true }, { enabled: true }, { enabled: true }],
    })
  })

  it('retains checkbox choices, enables new discoveries, and removes stale ids', async () => {
    const fixture = await store()
    await fixture.store.mergeCatalog(catalog('claude-opus-4.8', 'gpt-5.6-sol'))
    await fixture.store.setEnabledModelIds(['claude-opus-4.8'], catalog('claude-opus-4.8', 'gpt-5.6-sol'))
    const settings = await fixture.store.mergeCatalog(catalog('claude-opus-5', 'gpt-5.6-sol'))
    expect(settings).toMatchObject({
      enabledModelIds: ['claude-opus-5'],
      knownModelIds: ['claude-opus-5', 'gpt-5.6-sol'],
    })
    expect(JSON.parse(await readFile(fixture.file, 'utf8'))).toMatchObject({
      enabledModelIds: ['claude-opus-5'],
    })
  })

  it('sorts newest models first within stable provider families', () => {
    const models = catalog(
      'auto',
      'gpt-5.6-luna',
      'claude-sonnet-4.6',
      'claude-opus-4.8',
      'claude-sonnet-5',
      'claude-opus-5',
    ).sort(compareKiroModels)
    expect(models.map(model => model.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4.8',
      'claude-sonnet-4.6',
      'gpt-5.6-luna',
      'auto',
    ])
  })
})
