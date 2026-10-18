// Compare's diff of a JavaScript file minified on both sides with the names a
// minifier renamed alike hidden (GET /api/bundles/:id/rename-diff, GET
// /api/npm/rename-diff): both sides pretty-printed, as the pretty-print toggle
// has them (pretty-print.ts), then diffed by @preventive/compare's
// renamedDiffs in a worker, off the event loop and two at a time per process,
// with whitespace changes shown and hidden both. Answered as Brotli-encoded
// JSON, `{ before, blocks, reason, reads, marks, ignoringWhitespace }`
// (rename-diff-worker.js), the two files' hashes, `hash` and `otherHash`, and
// those of the two copies diffed, `prettyHash` and `otherPrettyHash`, which
// the viewer checks are those it asked about and draws: one file's asked for
// by both its sides' paths and hashes, or every pair a comparison's viewer
// diffs so, a line each (renamedPairs). The last few answers are kept in
// memory by both files' hashes, a private npm version's never, each side read
// again through the pretty-print cache first, which checks that its source
// holds a file of that hash. Access is the caller's to check.
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { brotliDecompress } from 'node:zlib'
import { layoutPackageDirs, treeLayout } from '@preventive/compare'
import { computeFileHash } from '@preventive/report'
import { FILE_HASH } from '../common/bundle-metadata.js'
import { computeBundleDiff } from '../common/bundle-compare-diff.js'
import { bundlePkgOf } from '../common/bundle-pkg-of.js'
import { needsPrettyPrint, prettyExtension } from '../common/pretty-print.js'
import { type ChangeBlock, blocksHold, textLines } from '../common/line-diff.js'
import type { OpenedBlob } from './blob-store.ts'
import { encodeBrotli } from './brotli.ts'
import { type ComparedSide, PrettyError, type PrettyRequest, prettyText } from './pretty-print.ts'

// What a minifier renames: JavaScript, as the viewer offers it for.
const RENAMABLE = new Set(['js', 'mjs', 'cjs'])
// Diffs worked out at once per process, each in a worker of its own, and
// those waiting their turn past them (a Diff view asks for all it shows at
// once), any more refused.
const MAX_ACTIVE_DIFFS = 2
const MAX_WAITING_DIFFS = 16
// The longest a diff may take, its wait for a worker included, and the most
// text it is asked of: both sides pretty-printed, which the largest files
// formatted (MAX_PRETTY_BYTES) stay under.
const DIFF_TIMEOUT_MS = 60_000
const MAX_DIFF_CHARS = 64 * 1024 * 1024
// Answers kept, the one read last last: each holds the old side as diffed.
// As many as a comparison's viewer may ask for beside the pairs it has come
// (renamedPairs), so that neither is worked out twice.
const KEPT_DIFFS = 32

// `blocks` and `marks` with whitespace changes shown, `ignoringWhitespace`'s
// hidden as diff -b hides them.
export interface RenameDiff {
  before: string; blocks: ChangeBlock[]; reason: string | null; reads: string[]; marks: ChangeBlock[]
  ignoringWhitespace: { blocks: ChangeBlock[]; marks: ChangeBlock[] }
}

export interface RenameDiffRequest { base: PrettyRequest; other: PrettyRequest }

// The two files a request names, a base's `path` and `hash` and the other
// side's `otherPath` and `otherHash`, or null where either is no JavaScript
// file named by its hash.
export function renameDiffRequest(params: URLSearchParams): RenameDiffRequest | null {
  const side = (path: string, hash: string): PrettyRequest | null => {
    const extension = prettyExtension(path)
    return extension !== null && RENAMABLE.has(extension) && FILE_HASH.test(hash) ? { path, hash, extension } : null
  }
  const base = side(params.get('path') ?? '', params.get('hash') ?? ''), other = side(params.get('otherPath') ?? '', params.get('otherHash') ?? '')
  return base && other ? { base, other } : null
}

let activeDiffs = 0
const waiting: Array<() => void> = []
const kept = new Map<string, Buffer>()
const pending = new Map<string, Promise<Buffer>>()

// A worker's turn, waited for behind those running until `deadline`; given
// up, it goes to the next one waiting.
async function turn(deadline: number): Promise<void> {
  if (activeDiffs < MAX_ACTIVE_DIFFS) { activeDiffs++; return }
  if (waiting.length >= MAX_WAITING_DIFFS) throw new PrettyError(429, 'diff-busy')
  await new Promise<void>((resolve, reject) => {
    const next = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(next), 1)
      reject(new PrettyError(504, 'diff-timeout'))
    }, deadline - Date.now())
    waiting.push(next)
  })
}
function done() {
  const next = waiting.shift()
  if (next) next()
  else activeDiffs--
}
async function inTurn<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  await turn(deadline)
  try { return await work() } finally { done() }
}

// Whether a worker's answer is one as rename-diff-worker.js gives it, its
// blocks taking the old side it answered to the new one asked of, whitespace
// changes shown and hidden: checked again here, apart from the worker, as an
// answer that is not would hide a change.
function answers(diff: unknown, original: string, after: string): diff is RenameDiff {
  const { before, blocks, reason, reads, marks, ignoringWhitespace } = (diff ?? {}) as Partial<RenameDiff>
  return typeof before === 'string' && (reason === null || typeof reason === 'string') && Array.isArray(reads) && reads.every(read => typeof read === 'string')
    && blocksHold(before, after, blocks, false) && marksFit(original, after, marks)
    && blocksHold(before, after, ignoringWhitespace?.blocks, true) && marksFit(original, after, ignoringWhitespace?.marks)
}

// Whether marked blocks (rename-diff-worker.js) are blocks of the diff of the
// two files as they are: in order, apart, within both, each as many lines on
// either side.
function marksFit(before: string, after: string, marks: unknown): boolean {
  if (!Array.isArray(marks)) return false
  const [olds, news] = [textLines(before).length, textLines(after).length]
  let i = 0, j = 0
  for (const mark of marks as Partial<ChangeBlock>[]) {
    const { a0, a1, b0, b1 } = mark ?? {}
    if (![a0, a1, b0, b1].every(Number.isInteger)) return false
    const [x0, x1, y0, y1] = [a0, a1, b0, b1] as [number, number, number, number]
    if (x0 < i || y0 < j || x1 <= x0 || x1 - x0 !== y1 - y0 || x1 > olds || y1 > news) return false
    i = x1
    j = y1
  }
  return true
}

// Settled once the worker is gone, so that its turn is given up only then.
function inWorker(before: string, after: string, { base, other }: RenameDiffRequest, deadline: number): Promise<RenameDiff> {
  if (before.length + after.length > MAX_DIFF_CHARS) throw new PrettyError(413, 'diff-too-large')
  let worker: Worker
  try {
    worker = new Worker(new URL('./rename-diff-worker.js', import.meta.url), {
      workerData: { before, after, extension: base.extension, otherExtension: other.extension }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    })
  } catch (err) {
    console.warn('managed: a rename diff could not start:', err)
    throw new PrettyError(503, 'unavailable')
  }
  return new Promise<RenameDiff>((resolve, reject) => {
    let diff: RenameDiff | null = null, failure = new PrettyError(422, 'undiffable')
    const timer = setTimeout(() => { failure = new PrettyError(504, 'diff-timeout'); void worker.terminate() }, deadline - Date.now())
    worker.once('message', (answer: unknown) => {
      if (answers(answer, before, after)) diff = answer
      else console.warn('managed: a rename diff answered what does not take its old side to the new')
      void worker.terminate()
    })
    worker.once('error', err => { console.warn('managed: a rename diff failed:', err) })
    // Gone: answered, run out of memory, or terminated.
    worker.once('exit', () => {
      clearTimeout(timer)
      if (diff) resolve(diff)
      else reject(failure)
    })
  })
}

// `work` given until `deadline`: past it, answered 504 and left to finish on its own.
function byDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new PrettyError(504, 'diff-timeout')) }, deadline - Date.now()) })
  return Promise.race([work, late]).finally(() => { clearTimeout(timer) })
}

// An answer as sent, naming the files asked about and the pretty-printed
// copies of them it was worked out from.
async function encoded(diff: RenameDiff, { base, other }: RenameDiffRequest, [before, after]: [string, string]): Promise<Buffer> {
  const [prettyHash, otherPrettyHash] = await Promise.all([computeFileHash(before), computeFileHash(after)])
  return encodeBrotli(Buffer.from(JSON.stringify({ ...diff, hash: base.hash, otherHash: other.hash, prettyHash, otherPrettyHash })))
}
const opened = (body: Buffer): OpenedBlob => ({ size: body.byteLength, stream: Readable.from([body]) })

// The answer for the two files a request names, Brotli-encoded, `texts`
// reading both sides pretty-printed (and so checking each is its source's):
// kept by their hashes where `keep`, readers asking for one meanwhile sharing
// it. A minute for it, its wait for a worker included.
export async function renameDiffOf(request: RenameDiffRequest, texts: () => Promise<[string, string]>, keep = true): Promise<OpenedBlob> {
  return opened(await answerOf(request, texts, keep))
}

// Sides `verified` to be the files the request names (renamedPairs) are read
// only where no answer is kept or on its way; others are read first, as
// reading them checks they are.
async function answerOf(request: RenameDiffRequest, texts: () => Promise<[string, string]>, keep: boolean, verified = false): Promise<Buffer> {
  // Sides not kept are formatted again for each diff (pretty-print.ts), so
  // they are read in its turn: the files a Diff view asks for at once wait
  // here rather than being refused by the formats running. Within its minute
  // too, its turn not held past it by a version's files still downloading.
  if (!keep) {
    const deadline = Date.now() + DIFF_TIMEOUT_MS
    let sides: [string, string] = ['', '']
    const diff = await inTurn(deadline, async () => {
      sides = await byDeadline(texts(), deadline)
      return inWorker(sides[0], sides[1], request, deadline)
    })
    return encoded(diff, request, sides)
  }
  // A file's type is part of how it is read: the same text as a script and as a module differ.
  const key = `${request.base.hash}\0${request.base.extension}\0${request.other.hash}\0${request.other.extension}`
  const held = () => {
    const found = kept.get(key)
    if (found) {
      kept.delete(key)
      kept.set(key, found)
    }
    return found ?? pending.get(key)
  }
  let answer = verified ? held() : undefined
  if (!answer) {
    const [before, after] = await texts()
    answer = held()
    if (!answer) {
      const deadline = Date.now() + DIFF_TIMEOUT_MS
      const job = inTurn(deadline, () => inWorker(before, after, request, deadline)).then(diff => encoded(diff, request, [before, after])).finally(() => pending.delete(key))
      pending.set(key, answer = job)
    }
  }
  const body = await answer
  kept.set(key, body)
  if (kept.size > KEPT_DIFFS) kept.delete(kept.keys().next().value!)
  return body
}

const decompress = promisify(brotliDecompress)

// What a minifier renames, by its path's extension.
const renamable = ({ extension }: PrettyRequest) => RENAMABLE.has(extension)

// One of a comparison's pairs of files (renamedPairs), its sides named as a
// request names them, with its answer as renameDiffOf sends it, or why it has
// none, as a PrettyError tells it.
export type RenamedLine = { path: string; hash: string; otherPath: string; otherHash: string } & (Partial<RenameDiff> | { error: string; status: number })

// The files that changed between a comparison's two sides, as its viewer
// pairs them (ui/view/bundle-comparison.js prepareComparison): at one path as
// the other side lays them out, or renamed within a package, as the bundles
// record their packages; every file there, those that can be formatted by
// their texts and the rest by their hashes. A file the viewer pairs otherwise
// (its files are its resources too) it asks about alone.
export function comparedFiles(sides: readonly [ComparedSide, ComparedSide]) {
  const [olds, news] = sides.map(({ files, hashes }) => {
    const texts = new Map(files.map(file => [file.path, file.text]))
    return new Map<string, unknown>([...hashes].map(([path, hash]) => [path, texts.get(path) ?? { format: 'digest', digest: hash }]))
  }) as [Map<string, unknown>, Map<string, unknown>]
  const layout = treeLayout(olds.keys(), news.keys())
  const packageDirs = layoutPackageDirs(sides[0].packageDirs, sides[1].packageDirs, layout)
  return computeBundleDiff(olds, news, path => bundlePkgOf(path, { packageDir: packageDirs?.get(path) }), layout).files
}

// The pairs of JavaScript files minified on both sides that changed between a
// comparison's two sides, paired as its viewer pairs them (comparedFiles),
// each diffed as renameDiffOf diffs it, from both sides' copies, kept or
// made, as they are iterated: in path order, one after another, leaving a
// worker to the files a viewer asks for alone (a pair it reads otherwise, one
// it shows first).
export function renamedPairs([base, other]: readonly [ComparedSide, ComparedSide], keep = true): AsyncGenerator<RenamedLine> {
  const formattable = ({ files }: ComparedSide) => new Map(files.map(file => [file.path, file]))
  const [olds, news] = [formattable(base), formattable(other)]
  const pairs = comparedFiles([base, other]).changed.flatMap(({ path, basePath = path }) => {
    const [from, to] = [olds.get(basePath), news.get(path)]
    return from && to && from.hash !== to.hash && [from, to].every(file => renamable(file) && needsPrettyPrint(file.path, file.text)) ? [[from, to] as const] : []
  }).toSorted(([, a], [, b]) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return (async function* () {
    for (const [from, to] of pairs) {
      const request = { base: { path: from.path, hash: from.hash, extension: from.extension }, other: { path: to.path, hash: to.hash, extension: to.extension } }
      const named = { path: from.path, hash: from.hash, otherPath: to.path, otherHash: to.hash }
      const copy = async (side: ComparedSide, { text, ...file }: typeof from) => prettyText(await side.kept(file) ?? await side.made(file, text))
      let body
      try { body = await answerOf(request, async () => [await copy(base, from), await copy(other, to)], keep, true) }
      catch (err) {
        if (!(err instanceof PrettyError)) throw err
        yield { ...named, error: err.message, status: err.status }
        continue
      }
      yield { ...JSON.parse((await decompress(body)).toString('utf8')) as Partial<RenameDiff>, ...named }
    }
  })()
}
