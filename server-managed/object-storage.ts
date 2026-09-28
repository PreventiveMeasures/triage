import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'
import type { OpenedBlob } from './blob-store.ts'
import { validateCacheKey } from './cache-storage.ts'

export const ENCRYPTED_PREFIX = 'encrypted-v1/'
export const LEGACY_PREFIXES = ['reports/', 'bundles/', 'avatars/', 'uploads/', 'cache/']
export interface RawObject extends OpenedBlob { version: string; modifiedAt: number }
export interface ListedObject { key: string; modifiedAt: number }
export interface ObjectPage { objects: ListedObject[]; cursor: string | null }
export interface RawObjectStorage {
  open(key: string, signal?: AbortSignal): Promise<RawObject | null>
  exists(key: string): Promise<boolean>
  put(key: string, bytes: Buffer | Readable, signal?: AbortSignal): Promise<void>
  // Return false if the original version changed; do not delete its replacement.
  delete(key: string, version?: string): Promise<boolean>
  list(prefix: string, cursor: string | null, limit: number): Promise<ObjectPage>
}
export interface ObjectStorage {
  open(key: string): Promise<OpenedBlob | null>
  get(key: string): Promise<Buffer | null>
  exists(key: string): Promise<boolean>
  put(key: string, bytes: Buffer): Promise<void>
  delete(key: string): Promise<void>
  deletePrefix(prefix: string): Promise<void>
}

export function objectPath(key: string): string {
  validateCacheKey(key)
  if (![...LEGACY_PREFIXES, ENCRYPTED_PREFIX].some(prefix => key.startsWith(prefix))) throw new Error('Invalid managed storage namespace')
  return key
}
