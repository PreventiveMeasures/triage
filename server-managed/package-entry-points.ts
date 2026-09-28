import { Buffer } from 'node:buffer'
import { normalizeTeamPath } from './repo-path.ts'

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

// Use the immutable blob from the authorized listing, never download_url or a
// resolved symlink target. Malformed or oversized manifests are optional.
export async function readPackageEntryPoints(sha: string, directory: string, read: (suffix: string) => Promise<unknown>): Promise<string[]> {
  try {
    const blob = await read(`/git/blobs/${sha}`) as { encoding?: unknown; content?: unknown; size?: unknown }
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string' || typeof blob.size !== 'number'
      || blob.size < 0 || blob.size > MAX_PACKAGE_BYTES || blob.content.length > MAX_PACKAGE_BYTES * 2) return []
    const bytes = Buffer.from(blob.content, 'base64')
    if (bytes.length !== blob.size || bytes.length > MAX_PACKAGE_BYTES) return []
    return packageEntryPoints(JSON.parse(bytes.toString('utf8')), directory)
  } catch {
    // Suggestions must not prevent browsing. The handler still rechecks
    // GitHub and managed access after this optional upstream read.
    return []
  }
}
