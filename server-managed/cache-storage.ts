import type { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OpenedBlob } from './blob-store.ts'

// Keys are internal relative paths; delete removes a whole directory of variants.
export interface CacheStorage {
  exists(key: string): Promise<boolean>
  put(key: string, bytes: Buffer): Promise<void>
  open(key: string): Promise<OpenedBlob>
  delete(prefix: string): Promise<void>
}

export function validateCacheKey(key: string): string {
  if (!key.split('/').every(part => /^[a-z0-9][a-z0-9.-]*$/iu.test(part))) throw new Error('Invalid cache key')
  return key
}

export function createDiskCacheStorage(dir: string): CacheStorage {
  const path = (key: string) => join(dir, validateCacheKey(key))
  return {
    async exists(key) {
      try { await stat(path(key)); return true }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err }
    },
    async put(key, bytes) {
      const target = path(key), temp = `${target}.${randomUUID()}.tmp`
      await mkdir(dirname(target), { recursive: true })
      try { await writeFile(temp, bytes); await rename(temp, target) }
      finally { await rm(temp, { force: true }) }
    },
    async open(key) {
      const file = await open(path(key), 'r')
      try { return { size: (await file.stat()).size, stream: file.createReadStream() } }
      catch (err) { await file.close(); throw err }
    },
    async delete(prefix) { await rm(path(prefix), { recursive: true, force: true }) },
  }
}
