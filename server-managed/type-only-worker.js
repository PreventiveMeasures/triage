// Which of a comparison's pairs of files changed in types alone (type-only.ts),
// as @preventive/compare's compareTrees stamps a change `typeOnly`, off the
// server's event loop: each pair a tree of a file a side, a side not there
// none, its paths as they are, which say what a file is. Two paths pair as one
// change wherever compareTrees takes them for a rename at all; where it
// doesn't, the pair is types only where each of its two changes is, as each
// side holds types alone and neither keeps an `export {}`, which is what it
// would stamp of them paired. A declaration file added is types only too where
// stripping leaves it a bare `export {}` alone (proveTypeOnly's `inert`), which
// compareTrees won't stamp, an `export {}` on one side alone: nothing loaded it
// before, so it runs nothing as a module, and as CommonJS throws on loading as
// a file not there did. `[true, false, ...]` by pair.
import { parentPort, workerData } from 'node:worker_threads'
import { compareTrees, proveTypeOnly } from '@preventive/compare'

// A declaration file as compareTrees names one: `.d.ts`, `.d.mts`, `.d.cts`, `.d.css.ts`.
const DECLARATION = /\.d\.(?:[^./]+\.)?[cm]?ts$/u

const tree = file => (file ? [{ name: file.path, data: file.text }] : [])
const answer = workerData.pairs.map(([from, to]) => {
  const changes = compareTrees(tree(from), tree(to), { paths: 'keys', lines: false, renames: Number.MIN_VALUE })
  if (changes.length > 0 && changes.every(change => change.typeOnly === true)) return true
  return from === null && DECLARATION.test(to.path) && proveTypeOnly(to.text).proven
})
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(answer)
