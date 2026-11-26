import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Store {
  close: () => void
  exec: (sql: string) => void
  prepare: (sql: string) => { run: (...values: unknown[]) => void }
}

const directories: string[] = []

/**
 * Write a Kiro CLI credential store holding exactly the rows a real sign-in
 * writes, so the reader can be exercised without a Kiro install.
 * @param rows - `auth_kv` key/value pairs, values are stored as JSON text.
 * @returns absolute path of the `data.sqlite3` file created.
 */
export async function createKiroStore(rows: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-local-'))
  directories.push(directory)
  const file = join(directory, 'data.sqlite3')
  const { DatabaseSync } = await import('node:sqlite') as unknown as {
    DatabaseSync: new (path: string) => Store
  }
  const db = new DatabaseSync(file)
  try {
    db.exec('create table auth_kv (key text primary key, value text not null)')
    const insert = db.prepare('insert into auth_kv (key, value) values (?, ?)')
    for (const [key, value] of Object.entries(rows)) insert.run(key, JSON.stringify(value))
  } finally {
    db.close()
  }
  return file
}

/** Remove every store created since the last call. */
export async function removeKiroStores(): Promise<void> {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
}