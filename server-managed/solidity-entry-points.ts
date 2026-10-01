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
  const paths = new Set(entries.filter(entry => entry.type === 'file' && sourcePath(entry.path)).map(entry => entry.path as string))
  let limited = false
  for (const root of roots) {
    if (!sourcePath(`${root.path}/Contract.sol`)) continue
    try {
      const data = await read(`/git/trees/${root.sha}?recursive=1`) as { tree?: unknown; truncated?: unknown }
      if (!Array.isArray(data?.tree)) continue
      limited ||= data.truncated === true
      for (const entry of data.tree) {
        if (entry?.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || typeof entry.path !== 'string') continue
        const path = `${root.path}/${entry.path}`
        if (sourcePath(path)) paths.add(path)
      }
    } catch {
      // Optional suggestions must not block browsing. The request handler
      // rechecks GitHub access and local path grants after all reads.
    }
  }
  return { paths: [...paths].toSorted().slice(0, MAX_SUGGESTIONS), limited: limited || paths.size > MAX_SUGGESTIONS }
}
