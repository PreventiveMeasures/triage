// Shared avatar cache interface, implemented by storage-stores.ts.
import type { Buffer } from 'node:buffer'

export interface CachedAvatar {
  contentType: string
  bytes: Buffer
}

export interface AvatarStore {
  put(id: string, contentType: string, bytes: Buffer): Promise<void>
  get(id: string): Promise<CachedAvatar | null>
}
