import { Buffer } from 'node:buffer'
import { buildableEntry } from './bundle-build.ts'
import { normalizeTeamPath } from './repo-path.ts'
import { MAX_STASIS_CONFIG_BYTES, parseStasisConfig } from './stasis-config.ts'

export const MAX_PACKAGE_BYTES = 256 * 1024
const MAX_ENTRY_POINTS = 100

// Declared paths, not a Node resolver: never guess defaults, expand export
// patterns, or execute package code. Keep every suggestion in its package.
export function packageEntryPoints(manifest: unknown, directory: string): string[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const pkg = manifest as { main?: unknown; exports?: unknown; bin?: unknown }
  const paths = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string' || value.startsWith('/') || value.endsWith('/') || /[*?]|^[a-z][a-z\d+.-]*:/iu.test(value)) return
    const normalized = normalizeTeamPath(value)
    if (!normalized.ok || !normalized.path || normalized.path === 'package.json') return
    const path = directory ? `${directory}/${normalized.path}` : normalized.path
    if (path.length <= 500 && paths.size < MAX_ENTRY_POINTS) paths.add(path)
  }
  add(pkg.main)
  const pending = [pkg.exports]
  for (let visited = 0; pending.length > 0 && visited < 4096; visited++) {
    const value = pending.pop()
    if (typeof value === 'string') { if (value.startsWith('./')) add(value); continue }
    if (Array.isArray(value)) pending.push(...value.slice(0, 4096 - visited).toReversed())
    else if (value && typeof value === 'object') {
      const entries = Object.entries(value).filter(([key]) => key !== 'types' && !key.startsWith('types@'))
      pending.push(...entries.slice(0, 4096 - visited).toReversed().map(([, target]) => target))
    }
  }
  if (typeof pkg.bin === 'string') add(pkg.bin)
  else if (pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) Object.values(pkg.bin).forEach(add)
  return [...paths]
}

// The entries a stasis.config.json in `directory` lists, as repository paths:
// the ones a server build takes, which it builds with their options there.
export function configEntryPoints(text: string, directory: string): string[] {
  const paths: string[] = []
  for (const key of parseStasisConfig(text, directory)?.keys() ?? []) {
    const path = directory ? `${directory}/${key}` : key
    if (buildableEntry(path) && paths.length < MAX_ENTRY_POINTS) paths.push(path)
  }
  return paths
}

// Use the immutable blob from the authorized listing, never download_url or a
// resolved symlink target. A malformed or oversized blob is none (null).
async function readBlobText(sha: string, read: (suffix: string) => Promise<unknown>, maxBytes: number): Promise<string | null> {
  const blob = await read(`/git/blobs/${sha}`) as { encoding?: unknown; content?: unknown; size?: unknown }
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string' || typeof blob.size !== 'number'
    || blob.size < 0 || blob.size > maxBytes || blob.content.length > maxBytes * 2) return null
  const bytes = Buffer.from(blob.content, 'base64')
  return bytes.length !== blob.size || bytes.length > maxBytes ? null : bytes.toString('utf8')
}

// Manifests are optional: suggestions must not prevent browsing. The handler
// still rechecks GitHub and managed access after these optional upstream reads.
export async function readPackageEntryPoints(sha: string, directory: string, read: (suffix: string) => Promise<unknown>): Promise<string[]> {
  try {
    const text = await readBlobText(sha, read, MAX_PACKAGE_BYTES)
    return text === null ? [] : packageEntryPoints(JSON.parse(text), directory)
  } catch {
    return []
  }
}

// A stasis.config.json Stasis would refuse lists none here; building its
// entries reports why (config-invalid).
export async function readConfigEntryPoints(sha: string, directory: string, read: (suffix: string) => Promise<unknown>): Promise<string[]> {
  try {
    const text = await readBlobText(sha, read, MAX_STASIS_CONFIG_BYTES)
    return text === null ? [] : configEntryPoints(text, directory)
  } catch {
    return []
  }
}
