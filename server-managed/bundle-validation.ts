// A Stasis bundle validated (GET and POST /api/bundles/:id/validation) by
// Stasis's own validation (`@exodus/stasis/validate`; its rules are in
// Stasis's doc/validate.md), the repository read the app's way: with its
// reader's GitHub access, own code by git's blob ids of the commit's listing.
import { posix } from 'node:path'
import { FETCHED, type Fetch, type Locked, type Repository, type RepositoryEntry, ValidateError, type BundleValidation as Validation, type ValidationPlan,
  followingMoves, historyOf, lockedBy, repositoryFiles, repositoryLockfiles, validateBundle } from '@exodus/stasis/validate'
import { createClient } from '@preventive/upstream/github.js'
import { GithubApiError } from './github-app.ts'
import { upstreamGithub } from './github-errors.ts'
import { githubJson } from './github-requests.ts'
import { eachOf } from './pull-dependencies.ts'

export { fetchPackage, validationPlan } from '@exodus/stasis/validate'

// The rules a validation was made by, kept with it: one made by others is made again.
export const BUNDLE_VALIDATION_READ = 2
const MAX_TREE_READS = 500
const TREES_AT_ONCE = 6
const SHA = /^[\da-f]{40}$/u

// A validation, with why its dependencies were held to no lockfile, where a
// lockfile of the repository was looked for.
export type BundleValidation = Validation & { lockfileError?: string }

// The entries of a commit's tree at `paths` and above them, as Stasis's
// validation takes them, and whether some were left unread (`cut`): its
// listing whole, else, cut short, a directory at a time into those `paths`
// are in, as many as MAX_TREE_READS. GitHub having no such commit throws.
export async function commitBlobs(fullName: string, token: string, commit: string, paths: string[],
  fetchImpl: typeof fetch = globalThis.fetch): Promise<{ entries: Map<string, RepositoryEntry>; cut: boolean }> {
  const api = `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/git/trees`
  const wanted = new Set(paths.flatMap(path => path.split('/').slice(0, -1).map((_, at, dirs) => dirs.slice(0, at + 1).join('/'))))
  const entries = new Map<string, RepositoryEntry>()
  let cut = false, reads = 0, round = [{ tree: commit, prefix: '', recursive: true }]
  while (round.length > 0) {
    const asked = round.slice(0, Math.max(0, MAX_TREE_READS - reads))
    cut ||= asked.length < round.length
    reads += asked.length
    const listed = await eachOf(asked, TREES_AT_ONCE, async ({ tree, recursive }) =>
      await githubJson(`${api}/${tree}${recursive ? '?recursive=1' : ''}`, token, fetchImpl) as { tree?: unknown; truncated?: unknown })
    const next: typeof round = []
    for (const [at, { tree, prefix, recursive }] of asked.entries()) {
      const answer = listed[at]!
      if (!Array.isArray(answer?.tree)) throw new GithubApiError(502, 'github-malformed')
      const truncated = answer.truncated === true
      if (truncated && recursive) { next.push({ tree, prefix, recursive: false }); continue }
      cut ||= truncated
      for (const item of answer.tree as { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown }[]) {
        if (typeof item?.path !== 'string' || typeof item.sha !== 'string' || !SHA.test(item.sha) || typeof item.mode !== 'string') continue
        const path = `${prefix}${item.path}`
        if (item.type === 'commit') entries.set(path, { submodule: true })
        else if (item.type === 'blob') entries.set(path, item.mode === '120000' ? { symlink: '' } : { sha: item.sha })
        else if (item.type === 'tree' && !recursive && wanted.has(path)) next.push({ tree: item.sha, prefix: `${path}/`, recursive: true })
      }
    }
    round = next
  }
  return { entries, cut }
}

interface Options { fetch?: Fetch; deadline?: number }

// The bundle `plan`'s dependencies alone, held to their registry, own code unverified for `reason`.
export const validateDependencies = (plan: ValidationPlan, reason: string, options: Options = {}): Promise<BundleValidation> =>
  validateBundle(plan, { reason }, { ...options, locked: null })

// The bundle `plan` validated at `commit` of `fullName`, read with `token`,
// built in `directory`: own code held to the commit's listing, the commit to
// the repository's history (none, a fork's say, or none GitHub has, leaving
// own code unverified), the dependencies to the lockfiles installing it.
export async function validateAtCommit(plan: ValidationPlan, { fullName, token, commit, directory }: { fullName: string; token: string; commit: string; directory: string },
  options: Options = {}): Promise<BundleValidation> {
  const repository = followingMoves(createClient({ token, userAgent: 'deepview-triage' }), fullName)
  let listing
  // The directory itself asked too, for its lockfile, where the bundle holds no own file there.
  try { listing = await commitBlobs(fullName, token, commit, [...plan.own.map(file => posix.join(directory, file.path)), posix.join(directory, 'package.json')]) } catch (err) {
    if (!(err instanceof GithubApiError) || (err.message !== 'github-not-found' && err.message !== 'github-status-422')) throw err
    return validateDependencies(plan, 'commit-not-found', options)
  }
  const [ref, { locked, error }] = await Promise.all([upstreamGithub(() => historyOf(repository, commit)),
    lockfilesOf(plan, repository, { fullName, commit, directory, entries: listing.entries })])
  if (ref === null) return validateDependencies(plan, 'commit-not-in-history', options)
  const validation = await validateBundle(plan, { ...listing, repository: fullName, commit, ref, directory }, { ...options, locked })
  return error ? { ...validation, lockfileError: error } : validation
}

// The lockfiles installing the bundle in `directory` at `commit`, as Stasis
// finds and reads them, a directory's files named by the commit's listing
// (`entries`); null, and why (ValidateError's code), where none can be held to.
async function lockfilesOf(plan: ValidationPlan, repository: Repository, { fullName, commit, directory, entries }: { fullName: string; commit: string; directory: string
  entries: Map<string, RepositoryEntry> }): Promise<{ locked: Locked | null; error?: string }> {
  const ecosystems = new Set(plan.packages.filter(pkg => FETCHED.has(pkg.ecosystem) && pkg.name && pkg.version).map(pkg => pkg.ecosystem))
  if (ecosystems.size === 0) return { locked: lockedBy([]) }
  const read = (path: string) => upstreamGithub(() => repository.getRepoFile({ path, ref: commit }))
  const named = Map.groupBy([...entries].filter(([, entry]) => 'sha' in entry).map(([path]) => path), path => posix.dirname(path))
  const list = (dir: string) => Promise.resolve((named.get(dir || '.') ?? []).map(path => posix.basename(path)))
  const trees = new Map<string, Promise<Map<string, Uint8Array>>>()
  // A directory's files, read whole for a dependency installed from it; one that isn't there, as upstream tells it, has none.
  const tree = (dir: string) => {
    const prefix = dir ? `${dir}/` : ''
    if (!trees.has(dir)) {
      trees.set(dir, repositoryFiles(repository, { github: fullName, commit, ...dir && { directory: dir } }).then(
        found => new Map([...found].flatMap(([path, entry]) => path.startsWith(prefix) && 'data' in entry ? [[path.slice(prefix.length), entry.data] as const] : [])),
        (err: unknown) => { if (/has no directory at/u.test((err as Error | undefined)?.message ?? '')) return new Map<string, Uint8Array>(); throw err }))
    }
    return trees.get(dir)!
  }
  try {
    const files = await repositoryLockfiles({ directory, ecosystems, list, read })
    const locked = lockedBy(files.map(one => ({ ...one, from: 'repository' as const, read, tree, root: posix.relative(posix.dirname(one.path), directory),
      // A patch its lockfile names by its hash alone, looked for in the project's patches directory, then the root's.
      patches: [...new Set([posix.join(directory, 'patches'), 'patches'])] })))
    return [...ecosystems].some(ecosystem => !locked.locks(ecosystem)) ? { locked: null, error: 'no-lockfile' } : { locked }
  } catch (err) {
    if (err instanceof ValidateError) return { locked: null, error: err.code }
    throw err
  }
}
