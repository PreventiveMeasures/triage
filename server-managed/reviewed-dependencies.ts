// The reviewed dependencies a host keeps beyond the app, as it registers
// them before the server is assembled (server.ts registerReviewedDependencies):
// a single async method telling whether a dependency, as a lockfile locks
// it, is reviewed there. Registered, it replaces the commit a repository is
// reviewed since (pull-dependency-reviews.ts): a version passes by the
// reviews its teams publish, as many as the repository requires, or by the
// method's saying so, and is otherwise unreviewed. A patched version (pnpm's
// patchedDependencies) passes by the method alone, the app reviewing no
// patch yet.
//
// Each version is asked once a request, as many at once as ASK_AT_ONCE, its
// answer kept in this instance KEPT_MS; one the method fails to answer is
// unreviewed, and counted so (`unasked`).
import { type Lru, lru } from './lru.ts'

export type ReviewedLockfile = 'npm' | 'pnpm' | 'yarn1'
// A dependency as a lockfile locks it: npm's always with its integrity (one
// with none is never reviewed, nor asked of), its shasum where the lockfile
// has one (Yarn 1's, after a tarball's `#`), and the hash of its patch where
// it is patched (pnpm's).
export interface ReviewedDependency {
  ecosystem: 'npm'
  lockfile: ReviewedLockfile
  name: string
  version: string
  integrity?: string
  shasum?: string
  patchHash?: string
}
export type ReviewedDependencies = (dependency: ReviewedDependency) => Promise<boolean>

const ASK_AT_ONCE = 16
const KEPT_MS = 60_000

let registered: ReviewedDependencies | null = null
let assembled = false
const answers: Lru<{ at: number; reviewed: boolean }> = lru(100_000)

// Registers the host's reviewed dependencies, once, before the server is
// assembled (init()): a server already assembled keeps what it was given.
export function registerReviewedDependencies(reviewed: ReviewedDependencies): void {
  if (typeof reviewed !== 'function') throw new TypeError('registerReviewedDependencies: expected an async function of a dependency')
  if (assembled) throw new Error('registerReviewedDependencies: call it before init(), as the server takes them as it is assembled')
  if (registered) throw new Error('registerReviewedDependencies: reviewed dependencies are registered already')
  registered = reviewed
}

// The reviewed dependencies registered, as a server takes them once it is
// assembled; none registers after.
export function assembledReviewedDependencies(): ReviewedDependencies | null {
  assembled = true
  return registered
}

// Which of `dependencies`, by their keys, `reviewed` passes, and how many it
// failed to answer.
export async function askReviewed(reviewed: ReviewedDependencies, dependencies: Map<string, ReviewedDependency>): Promise<{ passed: Set<string>; unasked: number }> {
  const passed = new Set<string>()
  let unasked = 0
  const pending = [...dependencies]
  await Promise.all(Array.from({ length: Math.min(ASK_AT_ONCE, pending.length) }, async () => {
    for (let next = pending.pop(); next; next = pending.pop()) {
      const [key, dependency] = next
      const known = answers.get(key)
      let answer = known && Date.now() - known.at < KEPT_MS ? known.reviewed : null
      if (answer === null) {
        try { answer = await reviewed({ ...dependency }) === true } catch (error) {
          unasked++
          console.warn('reviewed dependencies: failed to answer', `${dependency.name}@${dependency.version}`, error instanceof Error ? error.message : error)
          continue
        }
        answers.set(key, { at: Date.now(), reviewed: answer })
      }
      if (answer) passed.add(key)
    }
  }))
  return { passed, unasked }
}
