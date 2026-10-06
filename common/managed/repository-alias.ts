export interface RepositoryAliasInput {
  oldRepo: string
  oldPath: string
  repoId: number
  newPath: string
}

function containsPath(parent: string, path: string) {
  return !parent || path === parent || path.startsWith(`${parent}/`)
}

function aliasLocation(alias: RepositoryAliasInput, directory: string) {
  if (containsPath(alias.oldPath, directory)) {
    const suffix = directory.slice(alias.oldPath.length).replace(/^\//u, '')
    return { directory: [alias.newPath, suffix].filter(Boolean).join('/'), filePrefix: '' }
  }
  if (!containsPath(directory, alias.oldPath)) return null
  const filePrefix = alias.oldPath.slice(directory.length).replace(/^\//u, '')
  // This suffix is already in every file path. The destination must preserve
  // it, so mapping needs only a new directory, never a file-path rewrite.
  if (alias.newPath === filePrefix) return { directory: '', filePrefix }
  if (!alias.newPath.endsWith(`/${filePrefix}`)) return null
  return { directory: alias.newPath.slice(0, -filePrefix.length - 1), filePrefix }
}

// Match directory boundaries, keeping any subdirectory below the alias. A
// shared file prefix can prove a more specific alias applies without changing
// those files. The most specific applicable source wins, once, never chained.
export function matchRepositoryAlias(github: string, directory: string, aliases: readonly RepositoryAliasInput[], filePrefix = '') {
  let match: { repoId: number; directory: string } | null = null, specificity = -1
  for (const alias of aliases) {
    if (alias.oldRepo.toLowerCase() !== github.toLowerCase()) continue
    const location = aliasLocation(alias, directory)
    if (!location || !containsPath(location.filePrefix, filePrefix) || alias.oldPath.length <= specificity) continue
    match = { repoId: alias.repoId, directory: location.directory }
    specificity = alias.oldPath.length
  }
  return match
}

// Run before decoding a bundle's inventory: unrelated repos/directories and
// mappings without the required common suffix cannot benefit from its paths.
export function repositoryAliasNeedsFilePrefix(github: string, directory: string, aliases: readonly RepositoryAliasInput[]) {
  return aliases.some(alias => alias.oldRepo.toLowerCase() === github.toLowerCase()
    && Boolean(aliasLocation(alias, directory)?.filePrefix))
}

// Whole directory segments only; no source bodies, hashing, or path rewriting.
// A single file still proves its parent prefix. Stop as soon as none is shared.
export function commonFileDirectory(paths: Iterable<string>): string {
  let prefix: string[] | undefined
  for (const path of paths) {
    const parts = path.split('/')
    if (parts.some(part => !part || part === '.' || part === '..') || path.includes('\\')) return ''
    parts.pop()
    if (prefix === undefined) prefix = parts
    else {
      let length = 0
      while (length < prefix.length && length < parts.length && prefix[length] === parts[length]) length++
      prefix.length = length
    }
    if (prefix.length === 0) return ''
  }
  return prefix?.join('/') ?? ''
}
