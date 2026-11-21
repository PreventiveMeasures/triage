// The npm versions a repository's stasis.config.json files have Stasis reach,
// as its dependency review holds to those it names (lockfile-scope.ts
// stasisConfigs): what the build worker tells of the lockfile it builds
// (bundle-build-worker.js buildStasisLockfile), kept by the repository, the
// commit and the file's path, which never change, in this instance and in
// the database, the versions alone. A build takes minutes, so none is waited
// for: one not kept is told as pending (read), and its answer asks for it
// once its review is known (build), with a priority: how many versions the
// lockfiles beside it add that want reviews (wantingBeside). Those asked for
// wait, and are built behind the answers one at a time, the one of highest
// priority first, then the one asked for last; one following another at once
// while the first of them began a minute ago or less, else as one is asked
// for again, as its page asks. A failed one is held in this instance, then
// built again as asked.
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
// later, the next is built when one is asked for again, lest they outlast the
// invocation they run behind (serverless).
const FOLLOWED_WITHIN_MS = 60_000
// How long one waits not asked for again (its page asks every 30 seconds
// while it shows it), and how many wait at most, the one asked for longest
// ago let go past them.
const LAPSED_MS = 2 * 60_000
const MAX_WAITING = 500
// How often a build under way looks whether the server is stopping.
const STOPPING_EVERY_MS = 1000

export type StasisRead = { status: 'ready'; dependencies: StasisDependency[] } | { status: 'pending' } | { status: 'failed'; error: string; transient: boolean }
// A build an answer asks for: of the stasis.config.json at `config` of
// `repo` at `commit`, with `token`, its asker's, told the `branch` the commit
// is of, where its asker knows it, and its priority.
export interface StasisWant { repo: { repoId: number; fullName: string }; token: string; commit: string; config: string; branch?: string; priority: number }

export interface StasisDependencyReader {
  // What the stasis.config.json at `config` of repository `repoId` reaches at
  // `commit`, as known now.
  read(repoId: number, commit: string, config: string): Promise<StasisRead>
  // Those of `wants` not known built behind the answer asking for them.
  build(wants: StasisWant[]): void
}
interface ReaderOptions {
  store: KeptStore<unknown>
  // Builds one, as the deployment's builds are admitted (http.ts stasisReader).
  build(input: LockfileInput, github: string, token: string, signal: AbortSignal): Promise<StasisDependency[]>
  // Work going on behind an answer, handed to its owner (http.ts trackBehind).
  behind(work: Promise<unknown>): void
  stopping(): boolean
}

type Job = { key: string; input: LockfileInput; github: string; token: string; priority: number; asked: number }
const keyOf = (repoId: number, commit: string, config: string) => `${repoId}\0${STASIS_DEPENDENCIES_READ}\0${commit}\0${config}`
const optional = (value: unknown) => value === undefined || typeof value === 'string'
const dependenciesOf = (value: unknown) => Array.isArray(value) && value.every(one => plainObject(one) && typeof one['name'] === 'string'
  && typeof one['version'] === 'string' && optional(one['integrity']) && optional(one['patch'])) ? value as StasisDependency[] : null

export function stasisDependencyReader({ store, build, behind, stopping }: ReaderOptions): StasisDependencyReader {
  const known: Lru<{ read: StasisRead; until: number }> = lru(500_000, ({ read }) => read.status === 'ready' ? read.dependencies.length + 1 : 1)
  const hold = (key: string, read: StasisRead, until = Infinity) => { known.set(key, { read, until }); return read }
  const kept = async (key: string) => {
    const dependencies = dependenciesOf((await store.read(key))?.value)
    return dependencies && hold(key, { status: 'ready', dependencies })
  }
  // Those waiting, the one asked for longest ago first; the one being built here; and till when none is tried after one found its slot busy.
  const waiting = new Map<string, Job>()
  let building: string | null = null, busyTill = 0

  // The one to build next: of the highest priority, then asked for last; those not asked for since LAPSED_MS let go.
  function next(): Job | null {
    let best: Job | null = null
    for (const job of waiting.values()) {
      if (Date.now() - job.asked >= LAPSED_MS) waiting.delete(job.key)
      else if (!best || job.priority >= best.priority) best = job
    }
    if (best) waiting.delete(best.key)
    return best
  }

  async function built(job: Job) {
    // Another instance may have built it since it was asked for.
    if (await kept(job.key)) return
    const stop = new AbortController()
    const watching = setInterval(() => { if (stopping()) stop.abort() }, STOPPING_EVERY_MS)
    watching.unref()
    try {
      const dependencies = await build(job.input, job.github, job.token, stop.signal)
      await store.write(job.key, dependencies, Date.now())
      hold(job.key, { status: 'ready', dependencies })
    } catch (err) {
      if (stop.signal.aborted) return
      const refused = err instanceof BundleBuildError
      const code = refused ? err.code : 'build-failed'
      // Its slot another's, or given up to a build asked for: built when asked for again.
      if (code === 'build-busy' || code === 'build-yielded') { busyTill = Date.now() + BUSY_MS; return }
      if (!refused) console.warn('managed: stasis dependencies build failed:', err)
      const transient = !refused || TRANSIENT.has(code)
      hold(job.key, { status: 'failed', error: code, transient }, Date.now() + (transient ? TRANSIENT_HELD_MS : FAILED_HELD_MS))
    } finally { clearInterval(watching) }
  }

  // Those waiting built, each the next (next), while the first of them began FOLLOWED_WITHIN_MS ago or less.
  async function run() {
    const began = Date.now()
    try {
      for (let job = next(); job; job = Date.now() - began < FOLLOWED_WITHIN_MS && Date.now() >= busyTill && !stopping() ? next() : null) {
        building = job.key
        await built(job)
      }
    } finally { building = null }
  }

  return {
    async read(repoId, commit, config) {
      const key = keyOf(repoId, commit, config)
      const held = known.get(key)
      if (held && Date.now() < held.until) return held.read
      return await kept(key) ?? { status: 'pending' }
    },
    build(wants) {
      for (const { repo, token, commit, config, branch, priority } of wants) {
        const key = keyOf(repo.repoId, commit, config)
        if (key === building) continue
        // Asked for again: last in line, at the higher of its priorities, with its latest asker's token and branch.
        const had = waiting.get(key)
        waiting.delete(key)
        waiting.set(key, { key, input: { repoId: repo.repoId, commit, config, ...branch === undefined ? had?.input.branch === undefined ? {} : { branch: had.input.branch } : { branch } },
          github: repo.fullName, token, priority: Math.max(priority, had?.priority ?? priority), asked: Date.now() })
        if (waiting.size > MAX_WAITING) waiting.delete(waiting.keys().next().value!)
      }
      if (building === null && waiting.size > 0 && Date.now() >= busyTill && !stopping()) behind(run())
    },
  }
}

// How many versions the lockfiles in the directory of the stasis.config.json
// at `config` add that want reviews, as a review counts them by its
// directories' paths (pull-dependency-reviews.ts reviewedDependencies
// `wantedIn`): none where it holds to no lockfile there, or tells no review.
export function wantingBeside(wantedIn: Map<string[], number>, config: string): number {
  let count = 0
  for (const [paths, wanted] of wantedIn) if (!paths.some(isStasisConfig) && paths.some(path => directoryOf(path) === directoryOf(config))) count += wanted
  return count
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
// where it is read without its base (`baseless`), which isn't built then.
// Each told with the builds it reads (`builds`), whether each is made yet,
// for a page to tell how far Stasis is with them.
export async function stasisDirectory(config: string, base: string | null, head: string, read: (commit: string) => Promise<StasisRead>,
  locked: (commit: string, held: (path: string) => boolean) => Promise<CommitLockfiles>, baseless = false): Promise<DirectoryDependencies> {
  const paths = [config]
  const [after, before] = await Promise.all([read(head), baseless || base === null || base === head ? null : read(base)])
  const builds = [{ commit: head, built: after.status !== 'pending' }, ...before ? [{ commit: base!, built: before.status !== 'pending' }] : []]
  if (after.status === 'failed') return { paths, builds, error: 'stasis-failed', detail: after.error }
  if (before?.status === 'failed' && before.transient) return { paths, builds, error: 'stasis-failed', detail: before.error }
  if (after.status === 'pending' || before?.status === 'pending') return { paths, builds, error: 'stasis-pending' }
  const lockedAt = async (commit: string, dependencies: StasisDependency[]): Promise<LockedPackage[]> => {
    const found = lockedVersions(dependencies, await locked(commit, path => installsBundle(path, directoryOf(config))))
    return [...found.locked, ...found.unlocked.map(({ name, version }): LockedPackage => ({ name, version, source: 'registry', unlocked: true }))]
  }
  const [now, was] = await Promise.all([lockedAt(head, after.dependencies), before?.status === 'ready' ? lockedAt(base!, before.dependencies) : []])
  return { ...addedBetween(paths, baseless ? [] : before === null ? now : was, now), builds }
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
