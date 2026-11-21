// The issues and pull requests the code viewer has read, the latest read of
// each, by the Issues and Pull requests lists (repository-issues.js) or an
// item's popup (dialogs/repository-item-dialog.js): each shows them as the
// latest read does, so one its popup read as merged shows merged on its tile
// too. The latest is the one the server read from GitHub last (`readAt`),
// else the one answered last. Kept for the session that read them, in a
// store (client/state.ts's library), so what shows them draws again as they
// change.
import { store } from '@rray/frontend/state-management'
import { sessionKept, sessionOf } from './activity-reads.js'

// By the session, repository and number (an issue and a pull request never
// share one): `{ item, readAt, moved }`, the item with its `kind`, and where
// a read before knew it in the other of open and closed, which (`from`) and
// when that read was (`before`), else null; and how many times they changed,
// which what reads them all observes, as the store tells those iterating
// them of none replaced.
const known = store({ items: new Map(), changes: 0 })
const sessionItems = sessionKept(known.items)

const keyOf = (session, repoId, number) => `${session}\0${repoId}\0${number}`

// When an answer was read from GitHub, as the server says, else now.
export const readAtOf = answer => Number.isSafeInteger(answer?.readAt) && answer.readAt > 0 ? answer.readAt : Date.now()

// Know `items` of repository `repoId`, as read at `readAt`, each `kind` where
// it names none: each where none read later is known. Another session's
// forgotten.
export function knowItems(repoId, items, readAt, kind = null) {
  sessionItems()
  const session = sessionOf()
  let changed = false
  for (const item of items) {
    const key = keyOf(session, repoId, item.number)
    const held = known.items.get(key)
    if (held && held.readAt > readAt) continue
    const from = held && (held.item.state === 'open' ? 'open' : 'closed')
    const moved = !from || from === (item.state === 'open' ? 'open' : 'closed') ? held?.moved ?? null : { from, before: held.readAt }
    known.items.set(key, { item: { ...item, kind: item.kind ?? kind ?? held?.item.kind ?? null }, readAt, moved })
    changed = true
  }
  if (changed) known.changes++
}

// The latest read of issue or pull request `number` of repository `repoId`,
// `{ item, readAt, moved }`, else null.
export const knownItem = (repoId, number) => known.items.get(keyOf(sessionOf(), repoId, number)) ?? null

// Those of `kind` known of repository `repoId`, each its latest read.
export function knownItems(repoId, kind) {
  const prefix = keyOf(sessionOf(), repoId, '')
  // Read, so that what iterates them is told of each replaced too.
  void known.changes
  return [...known.items].flatMap(([key, held]) => key.startsWith(prefix) && held.item.kind === kind ? [held] : [])
}

// How many times what is known changed: observed, any change.
export const knownChanges = () => known.changes

// Which of open and closed `item` is in.
export const groupOf = item => item.state === 'open' ? 'open' : 'closed'

// Which of open and closed one known (`held`, knownItem's) was in at `at`, as
// best known: as read, where it was read no later; where it moved since, as it
// was, where a read knew it so no earlier than `at`, or GitHub closed it after
// `at`; else as it is.
export function groupAt(held, at) {
  const now = groupOf(held.item)
  if (held.readAt <= at || !held.moved) return now
  if (held.moved.before >= at) return held.moved.from
  const closedAt = held.item.closedAt ?? held.item.mergedAt ?? null
  return now === 'closed' && closedAt !== null && closedAt > at ? held.moved.from : now
}
