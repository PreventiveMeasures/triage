import type { Buffer } from 'node:buffer'
import type { OpenedBlob } from './blob-store.ts'

export class CacheMissError extends Error {
  constructor() { super('Managed cache unavailable') }
}

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
