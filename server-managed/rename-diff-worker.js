// Compare's diff with renamed names hidden (rename-diff.ts), worked out off the
// server's event loop by @preventive/compare's renamedDiff: the old side given
// the new side's names, formatted again where that changes its layout alone,
// diffed, and the blocks checked to take it to the new side. `{ before,
// blocks, reason, reads, marks }`: the old side as diffed, the change blocks,
// why the old side is as it was where its names could not be given safely,
// the properties through which either side reads names (a view marks renamed
// lines rather than hiding them where any are read, as a rename may then
// change what the code does), and the blocks of the diff of the files as they
// are that differ in renamed names alone. Blocks that would not take the old
// side to the new are thrown, and so answer nothing.
import { parentPort, workerData } from 'node:worker_threads'
import { renamedDiff } from '@preventive/compare/names.js'

const { before, after, extension, otherExtension, ignoreWhitespace } = workerData
const diff = await renamedDiff(before, after, { extension, otherExtension, whitespace: ignoreWhitespace ? 'all' : 'none' })
// A check that should never fail did, or a step gave way: told, the file shown with its names.
for (const warning of diff.warnings) console.warn(`managed: rename diff: ${warning}`)
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage({ before: diff.before, blocks: diff.blocks, reason: diff.reason, reads: diff.reads, marks: diff.marks })
