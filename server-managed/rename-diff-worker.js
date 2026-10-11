// Compare's diff with renamed names hidden (rename-diff.ts), worked out off the
// server's event loop in three steps, each checked apart: the old side given
// the new side's names (rename-map.js), formatted again as the new side was
// (pretty-format.ts), then the two diffed as they are. `{ before, blocks,
// reason }`: the old side as diffed, the change blocks, and why the old side
// is as it was, where its names could not be given safely (as renameMap says).
import { parentPort, workerData } from 'node:worker_threads'
import { changeBlocks } from '../common/line-diff.js'
import { formatChecked } from './pretty-format.ts'
import { renameMap } from './rename-map.js'

const { before, after, extension, ignoreWhitespace } = workerData
const mapped = renameMap(before, after, { extension })
let renamed = before
if (!mapped.reason) {
  // A name's new length may move the lines it is on; formatted again, and
  // used only where formatting changed nothing but the layout.
  const formatted = await formatChecked(mapped.text, extension)
  renamed = 'code' in formatted ? formatted.code : mapped.text
}
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage({ before: renamed, blocks: changeBlocks(renamed, after, ignoreWhitespace), reason: mapped.reason ?? null })
