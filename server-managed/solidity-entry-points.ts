import { normalizeTeamPath } from './repo-path.ts'

const MAX_SUGGESTIONS = 100
const EXCLUDED_DIRECTORIES = new Set(['test', 'tests', 'script', 'scripts', 'mock', 'mocks', 'node_modules', 'vendor', 'out', 'artifacts', 'cache', 'build', 'dist', 'broadcast'])

function sourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('.sol') || /\.(?:t|s|test|spec)\.sol$/iu.test(value)) return false
  const normalized = normalizeTeamPath(value)
  const directories = value.split('/').slice(0, -1).map(part => part.toLowerCase())
  const sourceRoot = directories.findIndex(part => part === 'src' || part === 'contracts')
  return normalized.ok && normalized.path === value && !directories.some((part, index) =>
    EXCLUDED_DIRECTORIES.has(part) || (part === 'lib' && (sourceRoot < 0 || index < sourceRoot)))
}

type ListingEntry = { name?: unknown; path?: unknown; type?: unknown; sha?: unknown; submodule_git_url?: unknown }

// Maintain the alphabetically first 100 unique candidates even when GitHub's
// input is unordered. Return whether a unique candidate exceeds the capacity.
export function addSoliditySuggestion(paths: string[], path: string): boolean {
  let start = 0
  let end = paths.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if (paths[middle]! < path) start = middle + 1
    else end = middle
  }
  if (paths[start] === path) return false
  const full = paths.length === MAX_SUGGESTIONS
  if (start < MAX_SUGGESTIONS) {
    // Evict before inserting, so retained candidates never exceed the cap.
    if (full) paths.pop()
    paths.splice(start, 0, path)
  }
  return full
}

// Suggestions from filenames, not deployability or import analysis. Read at
// most two source trees, using SHAs from the authorized pinned directory.
export async function readSolidityEntryPoints(directory: string, listing: unknown[], read: (suffix: string) => Promise<unknown>) {
  const prefix = directory ? directory + '/' : ''
  const entries = listing.filter((entry): entry is ListingEntry => !!entry && typeof entry === 'object').filter(entry =>
    typeof entry.name === 'string' && !entry.name.includes('/') && entry.path === prefix + entry.name && !entry.submodule_git_url)
  const hasFramework = entries.some(entry => entry.type === 'file' && typeof entry.name === 'string'
    && (entry.name === 'foundry.toml' || /^hardhat\.config\.(?:[cm]?js|ts)$/u.test(entry.name)))
  const roots = entries.filter(entry => entry.type === 'dir' && (entry.name === 'contracts' || (hasFramework && entry.name === 'src'))
    && typeof entry.sha === 'string' && /^[a-f\d]{40}$/iu.test(entry.sha)).slice(0, 2)
  const paths: string[] = []
  let limited = false
  for (const entry of entries) {
    if (entry.type === 'file' && sourcePath(entry.path) && addSoliditySuggestion(paths, entry.path)) limited = true
  }
  for (const root of roots) {
    if (!sourcePath(`${root.path}/Contract.sol`)) continue
    try {
      const data = await read(`/git/trees/${root.sha}?recursive=1`) as { tree?: unknown; truncated?: unknown }
      if (!Array.isArray(data?.tree)) continue
      limited ||= data.truncated === true
      for (const entry of data.tree) {
        if (entry?.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || typeof entry.path !== 'string') continue
        const path = `${root.path}/${entry.path}`
        if (sourcePath(path) && addSoliditySuggestion(paths, path)) limited = true
      }
    } catch {
      // Optional suggestions must not block browsing. The request handler
      // rechecks GitHub access and local path grants after all reads.
    }
  }
  return { paths, limited }
}
