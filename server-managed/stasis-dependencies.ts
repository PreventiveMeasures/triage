// The npm versions a repository's stasis.config.json files have Stasis reach,
// as its dependency review holds to those it names (lockfile-scope.ts
// stasisConfigs): what the build worker tells of the lockfile it builds
// (bundle-build-worker.js buildStasisLockfile), kept by the repository, the
// commit and the file's path, which never change, in this instance and in
// the database, the versions alone. A build takes minutes, so none is waited
// for: one not kept is told as pending and built behind the answer, one at a
// time, the one asked for last meanwhile following a quick one at once; any
// other is built when asked for again, as its page asks. A failed one is
// held in this instance, then built again as asked.
import { BundleBuildError, type LockfileInput, type StasisDependency } from './bundle-build.ts'
import { directoryOf, installsBundle, lockedVersions } from './bundle-dependency-reviews.ts'
import type { CommitLockfiles } from './commit-lockfiles.ts'
import type { LockedPackage } from './locked-packages.ts'
import { isStasisConfig } from './lockfile-scope.ts'
import { type Lru, lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { plainObject } from './npm-manifest.ts'
import { type DirectoryDependencies, type PullDependencies, addedBetween, lockedAs } from './pull-dependencies.ts'

// The rules they are told by, kept with them: one told by others is built again.
export const STASIS_DEPENDENCIES_READ = 1
// How long a failed build is held: GitHub's failure of it, or an unexpected
// one (`transient`), and any other, the commit's or the build's own.
const TRANSIENT_HELD_MS = 60_000
const FAILED_HELD_MS = 60 * 60_000
const TRANSIENT = new Set(['github-rate-limited', 'github-build-failed'])
// How long no build is tried again once one found its slot busy.
const BUSY_MS = 10_000
// How long after the first of them began builds follow one another at once:
// later, the next is built when asked for again, lest they outlast the
// invocation they run behind (serverless).
const FOLLOWED_WITHIN_MS = 60_000
// How often a build under way looks whether the server is stopping.
const STOPPING_EVERY_MS = 1000

export type StasisRead = { status: 'ready'; dependencies: StasisDependency[] } | { status: 'pending' } | { status: 'failed'; error: string; transient: boolean }

export interface StasisDependencyReader {
  // What the stasis.config.json at `config` of `repo` reaches at `commit`, as
  // known now; where nothing is, a build of it started behind the answer
  // with `token`, told the `branch` the commit is of, where its asker knows.
  read(repo: { repoId: number; fullName: string }, token: string, commit: string, config: string, branch?: string): Promise<StasisRead>
}
interface ReaderOptions {
  store: KeptStore<unknown>
  // Builds one, as the deployment's builds are admitted (http.ts stasisReader).
  build(input: LockfileInput, github: string, token: string, signal: AbortSignal): Promise<StasisDependency[]>
  // Work going on behind an answer, handed to its owner (http.ts trackBehind).
  behind(work: Promise<unknown>): void
  stopping(): boolean
}

type Job = { key: string; input: LockfileInput; github: string; token: string }
const optional = (value: unknown) => value === undefined || typeof value === 'string'
const dependenciesOf = (value: unknown) => Array.isArray(value) && value.every(one => plainObject(one) && typeof one['name'] === 'string'
  && typeof one['version'] === 'string' && optional(one['integrity']) && optional(one['patch'])) ? value as StasisDependency[] : null

export function stasisDependencyReader({ store, build, behind, stopping }: ReaderOptions): StasisDependencyReader {
  const known: Lru<{ read: StasisRead; until: number }> = lru(500_000, ({ read }) => read.status === 'ready' ? read.dependencies.length + 1 : 1)
  const hold = (key: string, read: StasisRead, until = Infinity) => { known.set(key, { read, until }); return read }
  // The one being built here, till when none is tried after one found its slot busy, and the one asked for last meanwhile.
  let building: string | null = null, busyTill = 0, next: Job | null = null

  async function built({ key, input, github, token }: Job) {
    const stop = new AbortController()
    const watching = setInterval(() => { if (stopping()) stop.abort() }, STOPPING_EVERY_MS)
    watching.unref()
    try {
      const dependencies = await build(input, github, token, stop.signal)
      await store.write(key, dependencies, Date.now())
      hold(key, { status: 'ready', dependencies })
    } catch (err) {
      if (stop.signal.aborted) return
      const refused = err instanceof BundleBuildError
      const code = refused ? err.code : 'build-failed'
      // Its slot another's, or given up to a build asked for: built when asked for again.
      if (code === 'build-busy' || code === 'build-yielded') { busyTill = Date.now() + BUSY_MS; return }
      if (!refused) console.warn('managed: stasis dependencies build failed:', err)
      const transient = !refused || TRANSIENT.has(code)
      hold(key, { status: 'failed', error: code, transient }, Date.now() + (transient ? TRANSIENT_HELD_MS : FAILED_HELD_MS))
    } finally { clearInterval(watching) }
  }

  // `first` built, then the one asked for last meanwhile, and so on while the first began FOLLOWED_WITHIN_MS ago or less.
  async function run(first: Job) {
    const began = Date.now()
    try {
      for (let job: Job | null = first; job; job = Date.now() - began < FOLLOWED_WITHIN_MS && Date.now() >= busyTill && !stopping() ? next : null) {
        building = job.key
        next = null
        await built(job)
      }
    } finally { building = next = null }
  }

  return {
    async read({ repoId, fullName }, token, commit, config, branch) {
      const key = `${repoId}\0${STASIS_DEPENDENCIES_READ}\0${commit}\0${config}`
      const held = known.get(key)
      if (held && Date.now() < held.until) return held.read
      const kept = dependenciesOf((await store.read(key))?.value)
      if (kept) return hold(key, { status: 'ready', dependencies: kept })
      const job = { key, input: { repoId, commit, config, ...branch !== undefined && { branch } }, github: fullName, token }
      if (building !== null) next = building === key ? next : job
      else if (Date.now() >= busyTill && !stopping()) {
        building = key
        behind(run(job))
      }
      return { status: 'pending' }
    },
  }
}

// The stasis.config.json at `config` as a directory of a review's
// dependencies (pull-dependencies.ts DirectoryDependencies), by its own
// path: the versions its entries reach at `head` that they didn't at `base`,
// a pull request's merge base, and all they reach at `head`; for a default
// branch, of no base, those alone. Each is told as the lockfiles in its
// directory or above lock it there (`locked`; lockedVersions), a patched one
// as the build installed it; one none of them locks told so (`unlocked`),
// which can't be reviewed. Where a build is still to be made, that it is
// (`stasis-pending`); where the head's failed, or GitHub failed the base's,
// why (`stasis-failed`). A base that couldn't be built of its own, as one of
// no such file, reaches nothing, so every version at the head is new, as
// it is for a pull request read without its base (`baseless`,
// pull-dependencies.ts), whose base is never built.
export async function stasisDirectory(config: string, base: string | null, head: string, read: (commit: string) => Promise<StasisRead>,
  locked: (commit: string, held: (path: string) => boolean) => Promise<CommitLockfiles>, baseless = false): Promise<DirectoryDependencies> {
  const paths = [config]
  const [after, before] = await Promise.all([read(head), baseless || base === null || base === head ? null : read(base)])
  if (after.status === 'failed') return { paths, error: 'stasis-failed', detail: after.error }
  if (before?.status === 'failed' && before.transient) return { paths, error: 'stasis-failed', detail: before.error }
  if (after.status === 'pending' || before?.status === 'pending') return { paths, error: 'stasis-pending' }
  const lockedAt = async (commit: string, dependencies: StasisDependency[]): Promise<LockedPackage[]> => {
    const found = lockedVersions(dependencies, await locked(commit, path => installsBundle(path, directoryOf(config))))
    return [...found.locked, ...found.unlocked.map(({ name, version }): LockedPackage => ({ name, version, source: 'registry', unlocked: true }))]
  }
  const [now, was] = await Promise.all([lockedAt(head, after.dependencies), before?.status === 'ready' ? lockedAt(base!, before.dependencies) : []])
  return addedBetween(paths, baseless ? [] : before === null ? now : was, now)
}

// `answer`, a review's dependencies, each version its package manager alone
// asks a review of marked so (`unreached`): one a lockfile locks that the
// stasis.config.json in its directory, held to with it, reaches not, nor
// does any other told; but one another lockfile, with none beside it, locks
// too. Nothing is marked by a file whose reach isn't told (still built,
// failed, or more than are told). `lockfiles`: each lockfile and what it
// locks, where `answer`'s directories don't tell them apart (a default
// branch's).
const isStasis = (dir: DirectoryDependencies) => dir.paths.length > 0 && isStasisConfig(dir.paths[0]!)
export function withReach<T extends PullDependencies>(answer: T, lockfiles?: { path: string; packages: LockedPackage[] }[]): T {
  const beside = new Set<string>(), reached = new Set<string>()
  for (const dir of answer.lockfiles) {
    if (!isStasis(dir) || 'error' in dir || dir.moreLocked > 0) continue
    beside.add(directoryOf(dir.paths[0]!))
    for (const pkg of dir.locked) reached.add(lockedAs(pkg))
  }
  if (beside.size === 0) return answer
  const locking = lockfiles ?? answer.lockfiles.flatMap(dir => isStasis(dir) || 'error' in dir || dir.paths.length === 0 ? [] : [{ path: dir.paths[0]!, packages: dir.locked }])
  // Those a lockfile beside such a file locks, and those any other does.
  const alone = new Set<string>(), asked = new Set<string>()
  for (const { path, packages } of locking) {
    const keys = beside.has(directoryOf(path)) ? alone : asked
    for (const pkg of packages) keys.add(lockedAs(pkg))
  }
  const marked = <P extends LockedPackage>(pkg: P): P => {
    const key = lockedAs(pkg)
    return alone.has(key) && !asked.has(key) && !reached.has(key) ? { ...pkg, unreached: true } : pkg
  }
  return { ...answer, lockfiles: answer.lockfiles.map(dir => isStasis(dir) || 'error' in dir ? dir : { ...dir, added: dir.added.map(marked), locked: dir.locked.map(marked) }) }
}
