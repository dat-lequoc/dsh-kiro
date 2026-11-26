import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KiroCatalogModel, KiroConnectionOptions } from '../src/adapter.ts'
import { KiroModelCatalog } from '../src/model-catalog.ts'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function catalogFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-catalog-'))
  temporaryDirectories.push(directory)
  return join(directory, 'model-catalog.json')
}

const connection = { models: [] } as unknown as KiroConnectionOptions
const models = (...ids: string[]): KiroCatalogModel[] => ids.map(id => ({ id, name: id }))
const DAY = 24 * 60 * 60 * 1000

/** Settle queued microtasks and fs callbacks a background refresh schedules. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('Kiro model catalog', () => {
  it('discovers once when nothing is stored, then persists for the next process', async () => {
    const file = await catalogFile()
    const fetch = vi.fn(async () => models('claude-opus-5.5', 'auto'))
    const first = new KiroModelCatalog({ file, fetch, now: () => 1_000 })
    await expect(first.get(connection)).resolves.toMatchObject({ fetchedAt: 1_000 })
    expect(fetch).toHaveBeenCalledTimes(1)

    // A restart reads the file instead of discovering again.
    const restartedFetch = vi.fn(async () => models('unused'))
    const restarted = new KiroModelCatalog({ file, fetch: restartedFetch, now: () => 2_000 })
    const snapshot = await restarted.get(connection)
    expect(snapshot.models.map(model => model.id)).toEqual(['claude-opus-5.5', 'auto'])
    expect(restartedFetch).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, fetchedAt: 1_000 })
  })

  it('serves a stale catalog immediately and refreshes it once in the background', async () => {
    const file = await catalogFile()
    await writeFile(file, JSON.stringify({ version: 1, fetchedAt: 0, models: models('old') }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => { await gate; return models('new') })
    const onUpdate = vi.fn()
    const catalog = new KiroModelCatalog({ file, fetch, onUpdate, now: () => DAY + 1 })

    // Three concurrent reads: none waits, and they share one refresh.
    const reads = await Promise.all([catalog.peek(connection), catalog.peek(connection), catalog.get(connection)])
    expect(reads.map(read => read?.models[0]?.id)).toEqual(['old', 'old', 'old'])
    expect(fetch).toHaveBeenCalledTimes(1)

    release()
    await settle()
    expect(catalog.snapshot()?.models[0]?.id).toBe('new')
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not refresh a catalog younger than the TTL', async () => {
    const file = await catalogFile()
    await writeFile(file, JSON.stringify({ version: 1, fetchedAt: 0, models: models('fresh') }))
    const fetch = vi.fn(async () => models('new'))
    const catalog = new KiroModelCatalog({ file, fetch, now: () => DAY - 1 })
    await catalog.peek(connection)
    await settle()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the stored catalog when a background refresh fails, and backs off', async () => {
    const file = await catalogFile()
    await writeFile(file, JSON.stringify({ version: 1, fetchedAt: 0, models: models('kept') }))
    let clock = DAY + 1
    const fetch = vi.fn(async () => { throw new Error('kiro-cli unavailable') })
    const onBackgroundError = vi.fn()
    const catalog = new KiroModelCatalog({
      file, fetch, onBackgroundError, retryDelayMs: 1_000, now: () => clock,
    })

    await catalog.peek(connection)
    await settle()
    expect(onBackgroundError).toHaveBeenCalledTimes(1)
    expect(catalog.snapshot()?.models[0]?.id).toBe('kept')

    await catalog.peek(connection)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1) // inside the back-off window

    clock += 1_000
    await catalog.peek(connection)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(file, 'utf8')).models[0].id).toBe('kept')
  })

  it('treats an empty discovery as a failure rather than erasing the catalog', async () => {
    const file = await catalogFile()
    await writeFile(file, JSON.stringify({ version: 1, fetchedAt: 0, models: models('kept') }))
    const catalog = new KiroModelCatalog({ file, fetch: async () => [], now: () => 5 })
    await expect(catalog.refresh(connection)).rejects.toThrow(/no models/u)
    expect(catalog.snapshot()?.models[0]?.id).toBe('kept')
  })

  it('invalidation keeps showing the catalog but refreshes it on the next read', async () => {
    const file = await catalogFile()
    await writeFile(file, JSON.stringify({ version: 1, fetchedAt: 100, models: models('account-a') }))
    const fetch = vi.fn(async () => models('account-b'))
    const catalog = new KiroModelCatalog({ file, fetch, now: () => 200 })
    await catalog.load()
    catalog.invalidate()
    await expect(catalog.peek(connection)).resolves.toMatchObject({ models: [{ id: 'account-a' }] })
    await settle()
    expect(catalog.snapshot()?.models[0]?.id).toBe('account-b')
  })

  it('ignores an unreadable or foreign file', async () => {
    const file = await catalogFile()
    await writeFile(file, '{"version":99,"fetchedAt":1,"models":[{"id":"x"}]}')
    const catalog = new KiroModelCatalog({ file, fetch: async () => models('discovered'), now: () => 1 })
    await expect(catalog.get(connection)).resolves.toMatchObject({ models: [{ id: 'discovered' }] })
  })

  it('lets one waiter give up without cancelling the shared refresh', async () => {
    const file = await catalogFile()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const catalog = new KiroModelCatalog({ file, fetch: async () => { await gate; return models('late') } })
    const controller = new AbortController()
    const impatient = catalog.get(connection, controller.signal)
    const patient = catalog.get(connection)
    controller.abort(new Error('caller gave up'))
    await expect(impatient).rejects.toThrow('caller gave up')
    release()
    await expect(patient).resolves.toMatchObject({ models: [{ id: 'late' }] })
  })
})
