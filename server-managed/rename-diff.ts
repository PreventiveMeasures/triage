// Compare's diff of a JavaScript file minified on both sides with the names a
// minifier renamed alike left out (GET /api/bundles/:id/rename-diff, GET
// /api/npm/rename-diff): both sides pretty-printed, as the pretty-print toggle
// has them (pretty-print.ts), then diffed by common/rename-diff.js in a worker,
// off the event loop and two at a time per process. The last few diffs are
// kept in memory by both files' hashes, a private npm version's never, each
// read again through the pretty-print cache first, which checks that its
// source holds a file of that hash. Access is the caller's to check.
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { brotliDecompress } from 'node:zlib'
import { FILE_HASH } from '../common/bundle-metadata.js'
import { prettyExtension } from '../common/pretty-print.js'
import type { RenameDiff } from '../common/rename-diff.js'
import type { OpenedBlob } from './blob-store.ts'
import { PrettyError, type PrettyRequest } from './pretty-print.ts'

// What a minifier renames: JavaScript, as the viewer offers it for.
const RENAMABLE = new Set(['js', 'mjs', 'cjs'])
// Diffs worked out at once per process, each in a worker of its own.
const MAX_ACTIVE_DIFFS = 2
// The longest a diff may take, and the most text it is asked of: both sides
// pretty-printed, which the largest files formatted (MAX_PRETTY_BYTES) stay
// under.
const DIFF_TIMEOUT_MS = 60_000
const MAX_DIFF_CHARS = 64 * 1024 * 1024
// Diffs kept, the one read last last.
const KEPT_DIFFS = 32

export interface RenameDiffRequest { base: PrettyRequest; other: PrettyRequest; ignoreWhitespace: boolean }

// The two files a request names, a base's `path` and `hash` and the other
// side's `otherPath` and `otherHash`, or null where either is no JavaScript
// file named by its hash.
export function renameDiffRequest(params: URLSearchParams): RenameDiffRequest | null {
  const side = (path: string, hash: string): PrettyRequest | null => {
    const extension = prettyExtension(path)
    return extension !== null && RENAMABLE.has(extension) && FILE_HASH.test(hash) ? { path, hash, extension } : null
  }
  const base = side(params.get('path') ?? '', params.get('hash') ?? ''), other = side(params.get('otherPath') ?? '', params.get('otherHash') ?? '')
  return base && other ? { base, other, ignoreWhitespace: params.get('ignoreWhitespace') === 'true' } : null
}

const decompress = promisify(brotliDecompress)

// A pretty-printed copy's text, from its Brotli-encoded bytes.
export async function prettyText(copy: OpenedBlob): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of copy.stream) chunks.push(chunk as Buffer)
  return (await decompress(Buffer.concat(chunks))).toString()
}

let activeDiffs = 0
const kept = new Map<string, RenameDiff>()
const pending = new Map<string, Promise<RenameDiff>>()

function inWorker(before: string, after: string, ignoreWhitespace: boolean): Promise<RenameDiff> {
  if (before.length + after.length > MAX_DIFF_CHARS) return Promise.reject(new PrettyError(413, 'diff-too-large'))
  if (activeDiffs >= MAX_ACTIVE_DIFFS) return Promise.reject(new PrettyError(429, 'diff-busy'))
  let worker: Worker
  try {
    worker = new Worker(new URL('./rename-diff-worker.js', import.meta.url), {
      workerData: { before, after, ignoreWhitespace }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 1024 },
    })
  } catch (err) {
    console.warn('managed: a rename diff could not start:', err)
    return Promise.reject(new PrettyError(503, 'unavailable'))
  }
  activeDiffs++
  return new Promise<RenameDiff>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new PrettyError(504, 'diff-timeout')); void worker.terminate() }, DIFF_TIMEOUT_MS)
    worker.once('message', (diff: RenameDiff) => { resolve(diff); void worker.terminate() })
    worker.once('error', err => {
      console.warn('managed: a rename diff failed:', err)
      reject(new PrettyError(422, 'undiffable'))
    })
    // Gone without an answer: run out of memory, or terminated.
    worker.once('exit', () => {
      clearTimeout(timer)
      activeDiffs--
      reject(new PrettyError(422, 'undiffable'))
    })
  })
}

// The diff of the two files a request names, `texts` reading both sides
// pretty-printed (and so checking each is its source's): kept by their hashes
// where `keep`, readers asking for one meanwhile sharing it.
export async function renameDiffOf(request: RenameDiffRequest, texts: () => Promise<[string, string]>, keep = true): Promise<RenameDiff> {
  const [before, after] = await texts()
  const key = `${request.base.hash}\0${request.other.hash}\0${request.ignoreWhitespace}`
  const found = kept.get(key)
  if (found) {
    kept.delete(key)
    kept.set(key, found)
    return found
  }
  let job = pending.get(key)
  if (!job) pending.set(key, job = inWorker(before, after, request.ignoreWhitespace).finally(() => pending.delete(key)))
  const diff = await job
  if (!keep) return diff
  kept.set(key, diff)
  if (kept.size > KEPT_DIFFS) kept.delete(kept.keys().next().value!)
  return diff
}
