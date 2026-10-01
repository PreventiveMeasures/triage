import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'
import type { OpenedBlob } from './blob-store.ts'
import { validateCacheKey } from './cache-storage.ts'

export const ENCRYPTED_CACHE_PREFIX = 'cache-encrypted-v1/'
export const LEGACY_PREFIXES = ['reports/', 'bundles/', 'avatars/', 'uploads/', 'cache/']
export interface RawObject extends OpenedBlob { version: string; modifiedAt: number }
export type ObjectMetadata = Omit<RawObject, 'stream'>
export interface ListedObject { key: string; modifiedAt: number }
export interface ObjectPage { objects: ListedObject[]; cursor: string | null }
export interface RawObjectStorage {
  open(key: string, signal?: AbortSignal): Promise<RawObject | null>
  head(key: string, signal?: AbortSignal): Promise<ObjectMetadata | null>
  exists(key: string): Promise<boolean>
  prune?(prefix: string, signal?: AbortSignal): Promise<void>
  // Persist an observed disk replacement before its SQL migration checkpoint.
  sync?(key: string, signal?: AbortSignal): Promise<void>
  // A plaintext size hint selects multipart uploads without buffering streams.
  put(key: string, bytes: Buffer | Readable, signal?: AbortSignal, expected?: string, sizeHint?: number): Promise<boolean>
  // Return false if the original version changed; do not delete its replacement.
  delete(key: string, version?: string, signal?: AbortSignal): Promise<boolean>
  list(prefix: string, cursor: string | null, limit: number, signal?: AbortSignal): Promise<ObjectPage>
}
export interface ObjectStorage {
  open(key: string): Promise<OpenedBlob | null>
  get(key: string): Promise<Buffer | null>
  exists(key: string): Promise<boolean>
  put(key: string, bytes: Buffer): Promise<string | null>
  delete(key: string): Promise<void>
  deletePrefix(prefix: string): Promise<void>
}

export function objectPath(key: string): string {
  validateCacheKey(key)
  if (![...LEGACY_PREFIXES, ENCRYPTED_CACHE_PREFIX].some(prefix => key.startsWith(prefix))) throw new Error('Invalid managed storage namespace')
  return key
}
