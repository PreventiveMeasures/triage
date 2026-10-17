// The lockfiles a repository's dependency review holds to, as an admin sets
// it (repository-dependency-reviews.ts): every one but those it names
// (`exclude`, naming none for all of them), or those it names alone
// (`include`). Each is named by its path in the repository, or, ending in
// `/`, by a directory, every lockfile under it. A directory of a pull
// request's lockfiles (pull-dependencies.ts) is reviewed where one of its
// lockfiles is held to; one none of whose are, not at all (`excluded`), nor
// failing the review where it couldn't be read.
export interface LockfileScope { mode: 'exclude' | 'include'; paths: string[] }
export const EVERY_LOCKFILE: LockfileScope = { mode: 'exclude', paths: [] }
export const MAX_SCOPED_LOCKFILES = 100
const MAX_PATH = 300

// A path as one is named: relative, of `/`-separated names none of which is
// empty, `.` or `..`, nor holding a backslash or a control character; a
// directory's ending in `/`.
function namedPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH || path.startsWith('/')) return false
  if (/[\\\p{Cc}]/u.test(path)) return false
  const names = path.endsWith('/') ? path.slice(0, -1).split('/') : path.split('/')
  return names.every(name => name !== '' && name !== '.' && name !== '..')
}

// A scope as a request sends it, each path once, in order; null for one
// that isn't one.
export function scopeOf(value: unknown): LockfileScope | null {
  const { mode, paths } = (value ?? {}) as { mode?: unknown; paths?: unknown }
  if ((mode !== 'exclude' && mode !== 'include') || !Array.isArray(paths) || paths.length > MAX_SCOPED_LOCKFILES || !paths.every(namedPath)) return null
  return { mode, paths: [...new Set(paths as string[])].toSorted() }
}

// A scope as stored (JSON, none for every lockfile), every lockfile where
// it can't be read.
export function storedScope(text: string | null): LockfileScope {
  if (!text) return EVERY_LOCKFILE
  try { return scopeOf(JSON.parse(text)) ?? EVERY_LOCKFILE } catch { return EVERY_LOCKFILE }
}
export const scopeText = (scope: LockfileScope) => isEvery(scope) ? null : JSON.stringify({ mode: scope.mode, paths: scope.paths })
export const isEvery = (scope: LockfileScope) => scope.mode === 'exclude' && scope.paths.length === 0

const names = (path: string, named: string) => named.endsWith('/') ? path.startsWith(named) : path === named
// Whether the lockfile at `path` is held to.
export function heldTo(scope: LockfileScope, path: string) {
  const named = scope.paths.some(one => names(path, one))
  return scope.mode === 'include' ? named : !named
}
// Whether a directory of lockfiles at `paths` is reviewed: where one is
// held to, or it names none.
export const reviewedIn = (scope: LockfileScope, paths: string[]) => paths.length === 0 || paths.some(path => heldTo(scope, path))
