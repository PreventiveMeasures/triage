// Whether `path` names a stasis.config.json a repository's dependency review
// may hold to in a lockfile's place (server-managed/lockfile-scope.ts): a
// file of that name, none of a package installed, under a node_modules.
export function isStasisConfig(path: string): boolean {
  const names = path.split('/')
  return names.at(-1) === 'stasis.config.json' && !names.includes('node_modules')
}
