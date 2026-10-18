// Compare's diff with renamed names hidden (rename-diff.ts), worked out off the
// server's event loop by @preventive/compare's renamedDiffs: the old side given
// the new side's names, not formatted again (each line where the old side's was),
// diffed with whitespace changes shown and hidden, and the blocks checked to
// take it to the new side. `{ before, blocks, reason, reads, marks,
// ignoringWhitespace }`: the old side as diffed, the change blocks, why the
// old side is as it was where its names could not be given safely, the
// properties through which either side reads names (a view marks renamed
// lines rather than hiding them where any are read, as a rename may then
// change what the code does), and the blocks of the diff of the files as they
// are that differ in renamed names alone; `ignoringWhitespace` the blocks and
// those marked with whitespace changes hidden, as diff -b hides them. Blocks
// that would not take the old side to the new are thrown, and so answer
// nothing.
import { parentPort, workerData } from 'node:worker_threads'
import { renamedDiffs } from '@preventive/compare/names.js'

const { before, after, extension, otherExtension } = workerData
const diff = await renamedDiffs(before, after, { extension, otherExtension, whitespace: ['none', 'change'] })
// A check that should never fail did, or a step gave way: told, the file shown with its names.
for (const warning of diff.warnings) console.warn(`managed: rename diff: ${warning}`)
const [shown, hidden] = diff.diffs
const answer = { before: diff.before, blocks: shown.blocks, reason: diff.reason, reads: diff.reads, marks: shown.marks, ignoringWhitespace: { blocks: hidden.blocks, marks: hidden.marks } }
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(answer)
