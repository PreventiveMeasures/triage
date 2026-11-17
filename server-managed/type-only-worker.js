// Which of a comparison's pairs of files changed in types alone (type-only.ts),
// off the server's event loop, as type-only-proof.js tells each. Told first,
// `{ stamped }`, is whether each is stamped, by pair: what runs is worked out
// after, so that it cannot cost a stamp the worker's deadline, however long
// one file's takes. Then, where asked for (`runsUntil` a time, not null),
// what runs of each pair not stamped, `{ at, runs, otherRuns }` as each is
// found, the smallest files first, so that one that takes long keeps the
// fewest waiting, and none begun once `runsUntil` has come. Last, its answer,
// by pair: `true`, `{ runs, otherRuns }` for one that holds types alone but
// for what runs, or `false`, as for one not asked for or not come to.
import { parentPort, workerData } from 'node:worker_threads'
import { typeOnlyRuns, typeOnlyStamped } from './type-only-proof.js'

const { pairs, runsUntil } = workerData
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
const tell = told => parentPort.postMessage(told)
const answer = pairs.map(([from, to]) => typeOnlyStamped(from, to))
tell({ stamped: answer })
if (runsUntil !== null) {
  const size = ([from, to]) => (from?.text.length ?? 0) + (to?.text.length ?? 0)
  const rest = [...pairs.keys()].filter(at => !answer[at]).toSorted((a, b) => size(pairs[a]) - size(pairs[b]))
  for (const at of rest) {
    if (Date.now() >= runsUntil) break
    const runs = typeOnlyRuns(...pairs[at])
    if (!runs) continue
    answer[at] = runs
    tell({ at, ...runs })
  }
}
tell(answer)
