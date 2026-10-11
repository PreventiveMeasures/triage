// Compare's diff with renamed names hidden (rename-diff.ts), worked out off the
// server's event loop in three steps, each checked apart: the old side given
// the new side's names (rename-map.js), formatted again as the new side was
// (pretty-format.ts), then the two diffed as they are. `{ before, blocks,
// reason }`: the old side as diffed, the change blocks, and why the old side
// is as it was, where its names could not be given safely (as renameMap says).
// Where the blocks found would not take the old side to the new, it answers
// nothing, so that no change is hidden.
import { parentPort, workerData } from 'node:worker_threads'
import { blocksHold, changeBlocks } from '../common/line-diff.js'
import { formatChecked } from './pretty-format.ts'
import { bindsAlike, renameMap } from './rename-map.js'

const { before, after, extension, otherExtension, ignoreWhitespace } = workerData
const mapped = renameMap(before, after, { extension, otherExtension })
// A check that should never fail did: told, the file shown with its names.
if (mapped.invariant) console.warn('managed: a rename map check failed:', mapped.invariant)
let renamed = before
if (!mapped.reason) {
  // A name's new length may move the lines it is on; formatted again, and
  // used only where formatting changed nothing but the layout, which oxc's
  // minifier, reading it as the old side, checks again.
  const formatted = await formatChecked(mapped.text, extension)
  const read = 'code' in formatted && bindsAlike(before, formatted.code, mapped.kind)
  if ('code' in formatted && !read) console.warn('managed: a rename diff\'s old side, formatted, read otherwise')
  renamed = read ? formatted.code : mapped.text
}
const blocks = changeBlocks(renamed, after, ignoreWhitespace)
if (!blocksHold(renamed, after, blocks, ignoreWhitespace)) throw new Error('change blocks that do not take the old side to the new')
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage({ before: renamed, blocks, reason: mapped.reason ?? null })
