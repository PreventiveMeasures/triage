// The lines a version of a package changes against another, or against none,
// its whole package's (GET /api/npm/delta), as a list of versions wanting
// reviews tells them beside each: added and removed (`additions`,
// `deletions`), as git's --numstat counts them, of their text files, a
// renamed one diffed with what it was; and, where some of the files changed
// are declaration files @preventive/compare's compareTrees proves changed in
// types alone (`typeOnly`, proveTypeOnly: types and comments alone erased,
// the runtime they leave as it was, an added one's empty or a single bare
// `export {}`), those of the rest (`typeless`), what a reviewer may pass by
// leaving those out. Worked out in a worker, off the event loop, as many at
// once per process as MAX_ACTIVE, those waiting their turn past them
// refused, each in at most a minute, its wait included; and kept by both
// sides' integrities, in this instance and beyond it (`kept`), what a version
// holds never changing. Access is the caller's to check.
import { Worker } from 'node:worker_threads'
import type { KeptStore } from './npm-kept.ts'
import { type Lru, lru } from './lru.ts'
import { NpmPackageError, type NpmPackageFile, npmFileText } from './npm-packages.ts'

export interface NpmDelta { additions: number; deletions: number; typeless: { additions: number; deletions: number } | null }

const MAX_ACTIVE = 2
const MAX_WAITING = 64
const DELTA_TIMEOUT_MS = 60_000
// The text the two sides may hold together, past which none is counted.
const MAX_TEXT_LENGTH = 64 * 1024 * 1024

const deltas: Lru<NpmDelta> = lru(20_000)
let active = 0
const waiting: Array<() => void> = []

async function turn(deadline: number): Promise<void> {
  if (active < MAX_ACTIVE) { active++; return }
  if (waiting.length >= MAX_WAITING) throw new NpmPackageError(429, 'delta-busy')
  await new Promise<void>((resolve, reject) => {
    const next = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(next), 1)
      reject(new NpmPackageError(504, 'delta-timeout'))
    }, deadline - Date.now())
    waiting.push(next)
  })
}
function done() {
  const next = waiting.shift()
  if (next) next()
  else active--
}

const lines = (told: unknown): told is { additions: number; deletions: number } => typeof told === 'object' && told !== null
  && Number.isSafeInteger((told as { additions?: unknown }).additions) && Number.isSafeInteger((told as { deletions?: unknown }).deletions)
// A delta as kept, none where it isn't one.
const deltaOf = (told: unknown): NpmDelta | null => lines(told) && ((told as NpmDelta).typeless === null || lines((told as NpmDelta).typeless))
  ? { additions: told.additions, deletions: told.deletions, typeless: (told as NpmDelta).typeless } : null

type Counted = { additions: number; deletions: number; typeAdditions: number; typeDeletions: number; typeFiles: number }
const isCounted = (told: unknown): told is Counted => typeof told === 'object' && told !== null
  && ['additions', 'deletions', 'typeAdditions', 'typeDeletions', 'typeFiles'].every(key => Number.isSafeInteger((told as Record<string, unknown>)[key]))

// What the worker counts of `base` against `other`, each its text files' paths and texts.
function counted(base: [string, string][], other: [string, string][], deadline: number): Promise<Counted> {
  let worker: Worker
  try {
    worker = new Worker(new URL('./npm-delta-worker.js', import.meta.url), {
      workerData: { base, other }, execArgv: ['--disable-warning=ExperimentalWarning'], resourceLimits: { maxOldGenerationSizeMb: 1536 },
    })
  } catch (err) {
    console.warn('managed: a package delta could not start:', err)
    throw new NpmPackageError(503, 'unavailable')
  }
  return new Promise((resolve, reject) => {
    let answer: Counted | null = null, failure = new NpmPackageError(422, 'delta-failed')
    const timer = setTimeout(() => { failure = new NpmPackageError(504, 'delta-timeout'); void worker.terminate() }, deadline - Date.now())
    worker.once('message', (told: unknown) => {
      if (isCounted(told)) answer = told
      void worker.terminate()
    })
    worker.once('error', err => { console.warn('managed: a package delta failed:', err) })
    worker.once('exit', () => {
      clearTimeout(timer)
      if (answer) resolve(answer)
      else reject(failure)
    })
  })
}

// A side's text files, by path, and how long their texts are.
function texts(files: NpmPackageFile[] | null) {
  let length = 0
  const read = (files ?? []).flatMap(({ path, bytes }) => {
    const text = npmFileText(bytes)
    if (text === null) return []
    length += text.length
    return [[path, text] as [string, string]]
  })
  return { read, length }
}

// The delta of `other` (its integrity, and how to read its files) against
// `base`, or none, as kept, else worked out and kept.
export async function npmDelta(base: { integrity: string; files: () => Promise<NpmPackageFile[]> } | null,
  other: { integrity: string; files: () => Promise<NpmPackageFile[]> }, kept: KeptStore<NpmDelta> | null = null): Promise<NpmDelta> {
  const key = `${base?.integrity ?? '(empty)'}\0${other.integrity}`
  const known = deltas.get(key) ?? deltaOf((await kept?.read(key))?.value)
  if (known) { deltas.set(key, known); return known }
  const [olds, news] = [texts(base ? await base.files() : null), texts(await other.files())]
  if (olds.length + news.length > MAX_TEXT_LENGTH) throw new NpmPackageError(413, 'package-too-large')
  const deadline = Date.now() + DELTA_TIMEOUT_MS
  await turn(deadline)
  let told
  try { told = await counted(olds.read, news.read, deadline) } finally { done() }
  const delta = { additions: told.additions, deletions: told.deletions,
    typeless: told.typeFiles > 0 ? { additions: told.additions - told.typeAdditions, deletions: told.deletions - told.typeDeletions } : null }
  deltas.set(key, delta)
  await kept?.write(key, delta, Date.now())
  return delta
}
