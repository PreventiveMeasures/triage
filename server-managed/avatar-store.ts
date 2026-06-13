// Avatar cache for the managed server. The user's GitHub avatar is fetched once
// at login (see github-oauth.ts) and served same-origin from GET
// /api/auth/avatar — the app's CSP is `img-src 'self'`, so the GitHub-hosted
// original can't be loaded by the page directly.
//
// On-disk for now (a dir beside the SQLite store); the AvatarStore interface is
// backend-agnostic so an S3 / Vercel Blob backend slots in later without
// touching callers. Keyed by the user's opaque `id`.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Buffer } from 'node:buffer'

export interface CachedAvatar {
  contentType: string
  bytes: Buffer
}

export interface AvatarStore {
  put(id: string, contentType: string, bytes: Buffer): Promise<void>
  get(id: string): Promise<CachedAvatar | null>
}

// The user id is a v4 uuid (crypto.randomUUID) — lowercase hex + dashes, no
// path separators. Validated anyway so a crafted id can't escape the store dir.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export function createDiskAvatarStore(dir: string): AvatarStore {
  function pathFor(id: string): string {
    if (!ID_RE.test(id)) throw new Error('invalid avatar id')
    return join(dir, id)
  }
  return {
    async put(id, contentType, bytes) {
      const p = pathFor(id)
      await mkdir(dirname(p), { recursive: true })
      // Bytes first, then the content-type sidecar — a crash between the two
      // leaves a typeless blob that `get` treats as missing (re-fetched next
      // login) rather than serving with a wrong/absent type.
      await writeFile(p, bytes)
      await writeFile(`${p}.type`, contentType, 'utf8')
    },
    async get(id) {
      try {
        const p = pathFor(id)
        const [bytes, contentType] = await Promise.all([readFile(p), readFile(`${p}.type`, 'utf8')])
        return { bytes, contentType: contentType.trim() || 'application/octet-stream' }
      } catch {
        return null
      }
    },
  }
}
