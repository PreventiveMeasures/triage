// Which of a comparison's pairs of files changed in types alone (type-only.ts),
// off the server's event loop, as type-only-proof.js tells each: `true`, `{
// runs, otherRuns }` for one that holds types alone but for what runs where
// `runs` is asked for, or `false`, by pair.
import { parentPort, workerData } from 'node:worker_threads'
import { typeOnlyProof } from './type-only-proof.js'

const answer = workerData.pairs.map(([from, to]) => typeOnlyProof(from, to, workerData.runs === true))
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(answer)
