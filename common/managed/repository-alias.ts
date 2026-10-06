export interface RepositoryAliasInput {
  oldRepo: string
  oldPath: string
  repoId: number
  newPath: string
}

// Match directory boundaries, keeping any subdirectory below the alias. The
// most specific source wins; aliases are applied once, never chained.
export function matchRepositoryAlias(github: string, directory: string, aliases: readonly RepositoryAliasInput[]) {
  let match: RepositoryAliasInput | null = null
  for (const alias of aliases) {
    if (alias.oldRepo.toLowerCase() !== github.toLowerCase()) continue
    if (alias.oldPath && directory !== alias.oldPath && !directory.startsWith(`${alias.oldPath}/`)) continue
    if (!match || alias.oldPath.length > match.oldPath.length) match = alias
  }
  if (!match) return null
  const suffix = directory.slice(match.oldPath.length).replace(/^\//u, '')
  return { repoId: match.repoId, directory: [match.newPath, suffix].filter(Boolean).join('/') }
}
