// The lines a version of a package changes against another, or against none,
// its whole package's (GET /api/npm/delta), as a list of versions wanting
// reviews tells them beside each: added and removed (`additions`,
// `deletions`), as git's --numstat counts them, of their text files, a
// renamed one diffed with what it was; and, where some of the files changed
// are declaration files @preventive/compare's compareTrees proves changed in
// types alone (`typeOnly`, proveTypeOnly: types and comments alone erased,
// the runtime they leave as it was, an added one's empty or a single bare
// `export {}`), those of the rest (`typeless`), what a reviewer may pass by
// leaving those out; and whether a binary file, which they count none of,
// was added, removed or changed (`binary`), one moved as it was not. Worked
// out in a worker, off the event loop, as many at once per process as
// MAX_ACTIVE, both sides' files read together only once their turn has come,
// those waiting past MAX_WAITING refused, each waiting a minute at most and
// counting in a minute at most; one asked again meanwhile sharing the
// first's; and kept by both sides' integrities, in this instance and beyond
// it (`kept`), what a version holds never changing. Access is the caller's
// to check.
import { createHash } from 'node:crypto'
import type { KeptStore } from './npm-kept.ts'
import { type Lru, lru } from './lru.ts'
import { NpmPackageError, type NpmPackageFile, npmFileText } from './npm-packages.ts'
import { workerTurns } from './worker-turns.ts'

export interface NpmDelta { additions: number; deletions: number; typeless: { additions: number; deletions: number } | null; binary: boolean }

const MAX_ACTIVE = 2
const MAX_WAITING = 64
const DELTA_TIMEOUT_MS = 60_000
// The text the two sides may hold together, past which none is counted.
const MAX_TEXT_LENGTH = 64 * 1024 * 1024

const deltas: Lru<NpmDelta> = lru(20_000)
const working = new Map<string, Promise<NpmDelta>>()
const workers = workerTurns({ what: 'package delta', active: MAX_ACTIVE, waiting: MAX_WAITING, error: NpmPackageError,
  busy: 'delta-busy', timeout: 'delta-timeout', failed: 'delta-failed' })

const lines = (told: unknown): told is { additions: number; deletions: number } => typeof told === 'object' && told !== null
  && Number.isSafeInteger((told as { additions?: unknown }).additions) && Number.isSafeInteger((told as { deletions?: unknown }).deletions)
// A delta as kept, none where it isn't one, or was kept before it told of
// binary files.
function deltaOf(told: unknown): NpmDelta | null {
  if (!lines(told)) return null
  const { typeless, binary } = told as { typeless?: unknown; binary?: unknown }
  return (typeless === null || lines(typeless)) && typeof binary === 'boolean' ? { additions: told.additions, deletions: told.deletions, typeless, binary } : null
}

type Counted = { additions: number; deletions: number; typeAdditions: number; typeDeletions: number; typeFiles: number }
const isCounted = (told: unknown): told is Counted => typeof told === 'object' && told !== null
  && ['additions', 'deletions', 'typeAdditions', 'typeDeletions', 'typeFiles'].every(key => Number.isSafeInteger((told as Record<string, unknown>)[key]))

// What the worker counts of `base` against `other`, each its text files' paths and texts.
function counted(base: [string, string][], other: [string, string][], deadline: number): Promise<Counted> {
  return workers.run(new URL('./npm-delta-worker.js', import.meta.url), {
    workerData: { base, other }, execArgv: ['--disable-warning=ExperimentalWarning'], resourceLimits: { maxOldGenerationSizeMb: 1536 },
  }, told => (isCounted(told) ? told : null), deadline)
}

// A side's text files, by path, how long their texts are, and its other,
// binary, files.
function texts(files: NpmPackageFile[] | null) {
  let length = 0
  const binaries: NpmPackageFile[] = []
  const read = (files ?? []).flatMap(file => {
    const text = npmFileText(file.bytes)
    if (text === null) { binaries.push(file); return [] }
    length += text.length
    return [[file.path, text] as [string, string]]
  })
  return { read, length, binaries }
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64')

// Whether `news`, a side's binary files, differ from `olds`, the other's:
// one added, removed or changed, one moved where it is the same as one that
// was elsewhere not, matched by their digests, each file looked at once.
function binaryChanged(olds: NpmPackageFile[], news: NpmPackageFile[]): boolean {
  if (olds.length !== news.length) return true
  const left = new Map(olds.map(({ path, bytes }) => [path, bytes]))
  const moved: Uint8Array[] = []
  for (const { path, bytes } of news) {
    const was = left.get(path)
    if (was && same(was, bytes)) left.delete(path)
    else moved.push(bytes)
  }
  // Those not where they were, by their digests, as many of each as there are.
  const unmoved = new Map<string, number>()
  for (const bytes of left.values()) {
    const key = digest(bytes)
    unmoved.set(key, (unmoved.get(key) ?? 0) + 1)
  }
  return moved.some(bytes => {
    const key = digest(bytes)
    const count = unmoved.get(key) ?? 0
    if (count === 0) return true
    unmoved.set(key, count - 1)
    return false
  })
}

type Side = { integrity: string; files: () => Promise<NpmPackageFile[]> }

// The delta of `other` (its integrity, and how to read its files) against
// `base`, or none, as held, else shared with one asked before it, else
// looked for where it is kept, else worked out and kept: shared from before
// it is looked for, lest those asked together each look, find none, and work
// it out.
export function npmDelta(base: Side | null, other: Side, kept: KeptStore<NpmDelta> | null = null): Promise<NpmDelta> {
  const key = `${base?.integrity ?? '(empty)'}\0${other.integrity}`
  const known = deltas.get(key)
  if (known) return Promise.resolve(known)
  const shared = working.get(key)
  if (shared) return shared
  const work = worked(key, base, other, kept).finally(() => working.delete(key))
  working.set(key, work)
  return work
}

// The deltas of those of `sides` (each the integrities of the version it is
// against, or none, and of the version) held or kept, by their keys
// (npmDelta's), in one read of `kept` for those not held: none worked out.
export async function keptNpmDeltas(sides: [string | null, string][], kept: KeptStore<NpmDelta>): Promise<Map<string, NpmDelta>> {
  const keys = [...new Set(sides.map(([base, other]) => `${base ?? '(empty)'}\0${other}`))]
  const found = new Map(keys.flatMap(key => { const known = deltas.get(key); return known ? [[key, known] as const] : [] }))
  const unheld = keys.filter(key => !found.has(key))
  for (const [key, row] of unheld.length > 0 ? await kept.readMany(unheld) : []) {
    const known = deltaOf(row.value)
    if (!known) continue
    deltas.set(key, known)
    found.set(key, known)
  }
  return found
}

// As kept, else its turn awaited, then both sides' files read, counted and kept.
async function worked(key: string, base: Side | null, other: Side, kept: KeptStore<NpmDelta> | null): Promise<NpmDelta> {
  const known = deltaOf((await kept?.read(key))?.value)
  if (known) { deltas.set(key, known); return known }
  const delta = await workers.inTurn(Date.now() + DELTA_TIMEOUT_MS, async (): Promise<NpmDelta> => {
    // Its turn held till both sides are read, or have failed.
    const [baseRead, otherRead] = await Promise.allSettled([base ? base.files() : Promise.resolve(null), other.files()])
    if (baseRead.status === 'rejected') throw baseRead.reason
    if (otherRead.status === 'rejected') throw otherRead.reason
    const [olds, news] = [texts(baseRead.value), texts(otherRead.value)]
    if (olds.length + news.length > MAX_TEXT_LENGTH) throw new NpmPackageError(413, 'package-too-large')
    const binary = binaryChanged(olds.binaries, news.binaries)
    const told = await counted(olds.read, news.read, Date.now() + DELTA_TIMEOUT_MS)
    return { additions: told.additions, deletions: told.deletions,
      typeless: told.typeFiles > 0 ? { additions: told.additions - told.typeAdditions, deletions: told.deletions - told.typeDeletions } : null, binary }
  })
  deltas.set(key, delta)
  await kept?.write(key, delta, Date.now())
  return delta
}
