// Which of a comparison's pairs of files changed in types alone (type-only.ts),
// off the server's event loop, as type-only-proof.js tells each: `true`, `{
// runs, otherRuns }` for one that holds types alone but for what runs, or
// `false`, by pair. Every pair is stamped first, then what runs is worked out
// of those not stamped while `runsUntil` (a time, or null where it isn't
// asked for) has not come, so the work cannot cost a stamp its deadline: one
// past it is told as not stamped, as where it isn't asked for.
import { parentPort, workerData } from 'node:worker_threads'
import { typeOnlyRuns, typeOnlyStamped } from './type-only-proof.js'

const { pairs, runsUntil } = workerData
const stamped = pairs.map(([from, to]) => typeOnlyStamped(from, to))
const answer = stamped.map((stamp, i) => stamp || (runsUntil !== null && Date.now() < runsUntil && typeOnlyRuns(...pairs[i])))
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(answer)
