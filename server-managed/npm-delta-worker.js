// The lines a package's files change from one side to another (npm-delta.ts),
// as @preventive/compare's compareTrees counts them (git's --numstat), off
// the server's event loop: of its text files, renames found as git finds
// them, a side not there empty; and, apart, those of its changes it stamps
// `typeOnly`, declaration files changed in types alone.
import { parentPort, workerData } from 'node:worker_threads'
import { compareTrees } from '@preventive/compare'

const tree = files => files.map(([name, data]) => ({ name, data }))
const changes = compareTrees(tree(workerData.base), tree(workerData.other), { paths: 'keys', lines: true, renames: true })
const answer = { additions: 0, deletions: 0, typeAdditions: 0, typeDeletions: 0, typeFiles: 0 }
for (const change of changes) {
  if (change.binary) continue
  answer.additions += change.insertions ?? 0
  answer.deletions += change.deletions ?? 0
  if (change.typeOnly !== true) continue
  answer.typeAdditions += change.insertions ?? 0
  answer.typeDeletions += change.deletions ?? 0
  answer.typeFiles++
}
// Node worker messages have no browser target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(answer)
