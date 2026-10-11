// Compare's diff with renamed names hidden (rename-diff.ts), worked out off the
// server's event loop: two pretty-printed texts in, its blocks and the removed
// lines left out as renamed alike out.
import { parentPort, workerData } from 'node:worker_threads'
import { renameDiff } from '../common/rename-diff.js'

const { before, after, ignoreWhitespace } = workerData
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(renameDiff(before, after, { ignoreWhitespace }))
