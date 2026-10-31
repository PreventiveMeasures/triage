// Whether a Stasis bundle holds what it says it does (GET and POST
// /api/bundles/:id/validation), by Stasis's own validation
// (`@exodus/stasis/validate`, as `stasis validate` checks a bundle): every
// file of its own code as GitHub has it at the commit its stamp names, and
// every file of each dependency as its published package has it, fetched with
// upstream and held to the lockfile that installs it there; those two
// covering every file it holds. See doc/validate.md in Stasis for its rules.
//
// What is the app's own is how it reads the repository: with its reader's
// GitHub access, and its own code by git's blob ids, as the commit's tree
// lists them (commitBlobs), never downloading a file of it; the commit held to
// the repository's own history first (historyOf), as GitHub serves a fork's
// through the repository's name too; and the lockfiles, their manifests and
// patches read of it (repositoryLockfiles, lockedBy). Without a reader of all
// of it, a commit, or a lockfile it can read, its dependencies are held to
// their registry alone, and why is told (`own.reason`, `lockfileError`).
import { posix } from 'node:path'
import { FETCHED, type Fetch, type Locked, type Repository, type RepositoryEntry, ValidateError, type BundleValidation as Validation, type ValidationPlan,
  followingMoves, historyOf, lockedBy, validationPlan as planOf, repositoryFiles, repositoryLockfiles, validateBundle } from '@exodus/stasis/validate'
import { createClient } from '@preventive/upstream/github.js'
import { GithubApiError } from './github-app.ts'
import { upstreamGithub } from './github-errors.ts'
import { githubJson } from './github-requests.ts'
import { eachOf } from './pull-dependencies.ts'

export { fetchPackage } from '@exodus/stasis/validate'
export type { ValidationPlan } from '@exodus/stasis/validate'

// The rules a validation was made by, kept with it: one made by others is
// made again.
export const BUNDLE_VALIDATION_READ = 2
// Trees read in all and at once.
const MAX_TREE_READS = 500
const TREES_AT_ONCE = 6
const SHA = /^[\da-f]{40}$/u

// A validation, with why its dependencies were held to no lockfile where they
// were, a reader of all of the repository at a commit of its own asking.
export type BundleValidation = Validation & { lockfileError?: string }

// What a Stasis bundle's files are, as Stasis's validation checks them; null
// for another kind of bundle, or one with no modules.
export function validationPlan(details: { kind: string | null; bundle?: unknown }): ValidationPlan | null {
  const bundle = details.bundle as { modules?: unknown } | undefined
  return details.kind === 'stasis' && bundle?.modules ? planOf(bundle) : null
}

// The entries a commit's tree has at `paths` and above them, by their paths
// from the repository's root, as Stasis's validation takes them (a file by
// git's blob id, a symlink, a submodule), and whether some of the tree was
// left unread (`cut`): its listing whole, else, where GitHub cuts that short,
// each directory alone a level at a time, only those `paths` are in, as many
// as MAX_TREE_READS in all. GitHub having no such commit throws its
// GithubApiError.
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

// The bundle `plan`'s dependencies validated alone, held to their registry,
// its own code unverified for `reason`.
export const validateDependencies = (plan: ValidationPlan, reason: string, options: Options = {}): Promise<BundleValidation> =>
  validateBundle(plan, { reason }, { ...options, locked: null })

// The bundle `plan` validated at `commit` of `fullName`, read with `token`,
// the reader's of all of it, built in `directory`: the commit held to the
// repository's history; its own code to the commit's tree, by blob ids; its
// dependencies to the lockfiles that install it there. A commit of none of
// its refs (a fork's), or one GitHub has none of, leaves own code unverified,
// and the dependencies held to their registry alone.
export async function validateAtCommit(plan: ValidationPlan, { fullName, token, commit, directory }: { fullName: string; token: string; commit: string; directory: string },
  options: Options = {}): Promise<BundleValidation> {
  const repository = followingMoves(createClient({ token, userAgent: 'deepview-triage' }), fullName)
  const ref = await upstreamGithub(() => historyOf(repository, commit))
  if (ref === null) return { ...await validateDependencies(plan, 'commit-not-in-history', options), lockfileError: 'commit-not-in-history' }
  let listing
  // The directory itself is asked too, where the bundle holds no own file, for its lockfile.
  try { listing = await commitBlobs(fullName, token, commit, [...plan.own.map(file => posix.join(directory, file.path)), posix.join(directory, 'package.json')]) } catch (err) {
    if (!(err instanceof GithubApiError) || (err.message !== 'github-not-found' && err.message !== 'github-status-422')) throw err
    return { ...await validateDependencies(plan, 'commit-not-found', options), lockfileError: 'commit-not-found' }
  }
  const { locked, error } = await lockfilesOf(plan, repository, { fullName, commit, directory, entries: listing.entries })
  const validation = await validateBundle(plan, { ...listing, repository: fullName, commit, ref, directory }, { ...options, locked })
  return error ? { ...validation, lockfileError: error } : validation
}

// The lockfiles installing the bundle in `directory` at `commit`, as Stasis
// finds and reads them: the names a directory's files have of the commit's
// listing (`entries`), a file read with upstream; a dependency from a
// directory of the repository held to its files there, read whole. Null, and
// why (ValidateError's code), where none locks some of its packages or one
// can't be read.
async function lockfilesOf(plan: ValidationPlan, repository: Repository, { fullName, commit, directory, entries }: { fullName: string; commit: string; directory: string
  entries: Map<string, RepositoryEntry> }): Promise<{ locked: Locked | null; error?: string }> {
  const ecosystems = new Set(plan.packages.filter(pkg => FETCHED.has(pkg.ecosystem) && pkg.name && pkg.version).map(pkg => pkg.ecosystem))
  if (ecosystems.size === 0) return { locked: lockedBy([]) }
  const read = (path: string) => upstreamGithub(() => repository.getRepoFile({ path, ref: commit }))
  const list = (dir: string) => Promise.resolve([...entries].filter(([path, entry]) => 'sha' in entry && posix.dirname(path) === (dir || '.')).map(([path]) => posix.basename(path)))
  const trees = new Map<string, Promise<Map<string, Uint8Array>>>()
  const tree = (dir: string) => {
    const prefix = dir ? `${dir}/` : ''
    if (!trees.has(dir)) {
      // A directory that isn't there, as upstream tells it: one with no files.
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
    const unlocked = [...ecosystems].some(ecosystem => !locked.locks(ecosystem))
    return unlocked ? { locked: null, error: 'no-lockfile' } : { locked }
  } catch (err) {
    if (err instanceof ValidateError) return { locked: null, error: err.code }
    throw err
  }
}
