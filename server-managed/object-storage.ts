import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'
import type { OpenedBlob } from './blob-store.ts'
import { validateCacheKey } from './cache-storage.ts'

export const ENCRYPTED_CACHE_PREFIX = 'cache-encrypted-v1/'
const STORAGE_PREFIXES = ['reports/', 'bundles/', 'avatars/', 'uploads/', 'cache/', ENCRYPTED_CACHE_PREFIX]
export interface RawObject extends OpenedBlob { version: string; modifiedAt: number }
type ObjectMetadata = Omit<RawObject, 'stream'>
interface ListedObject { key: string; modifiedAt: number }
export interface ObjectPage { objects: ListedObject[]; cursor: string | null }
export interface RawObjectStorage {
  open(key: string, signal?: AbortSignal): Promise<RawObject | null>
  head(key: string, signal?: AbortSignal): Promise<ObjectMetadata | null>
  prune?(prefix: string, signal?: AbortSignal): Promise<void>
  // Persist an observed disk replacement before its SQL migration checkpoint.
  sync?(key: string, signal?: AbortSignal): Promise<void>
  // A plaintext size hint selects multipart uploads without buffering streams.
  // Publish atomically only after consuming the body through clean EOF; a body
  // error must preserve the existing object (migration verifies while streaming).
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

export function isBlobId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

export function objectPath(key: string): string {
  validateCacheKey(key)
  if (!STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) throw new Error('Invalid managed storage namespace')
  return key
}

// Hash verification and migration may consume a stream before it can be used.
// Reopen only the same object version, closing any concurrent replacement.
export async function openObjectVersion(raw: RawObjectStorage, key: string, version: string, signal?: AbortSignal): Promise<RawObject | null> {
  const current = await raw.open(key, signal)
  if (current?.version === version) return current
  current?.stream.destroy()
  return null
}

export async function deleteObjects(raw: RawObjectStorage, prefix: string, signal: AbortSignal, before?: number): Promise<number> {
  const eligible = (modifiedAt: number) => before === undefined || modifiedAt < before
  // Finish listing before deleting: provider cursors may be offset-based.
  const cursors = new Set<string>(), keys = new Set<string>()
  let cursor: string | null = null
  do {
    const page = await raw.list(prefix, cursor, 100, signal)
    for (const object of page.objects) if (eligible(object.modifiedAt)) keys.add(object.key)
    cursor = page.cursor
    if (cursor !== null && cursors.has(cursor)) throw new Error('Invalid blob pagination')
    if (cursor !== null) cursors.add(cursor)
  } while (cursor !== null)
  let removed = 0
  for (const key of keys) {
    const stored = await raw.head(key, signal)
    // Ignore stale listings and preserve concurrent replacements.
    if (stored && eligible(stored.modifiedAt) && await raw.delete(key, stored.version, signal)) removed++
  }
  return removed
}
