// The issues and pull requests the code viewer has read, the latest read of
// each: the Issues and Pull requests tabs' lists read them a page at a time
// (repository-issues.js), an item's popup one at a time
// (dialogs/repository-item-dialog.js), and each shows them as the latest
// read of them does, so that a pull request its popup read as merged shows
// merged on its tile too. The latest is the one the server read from GitHub
// last (`readAt`, which it answers with; one it kept is as old as it was
// kept), else the one answered last. Kept, as the lists are, for the session
// that read them, in a store (client/state.ts's library), so that what shows
// them is drawn again as they change.
import { store } from '@rray/frontend/state-management'
import { state } from '#client/index.js'

// By the session, the repository and the number, which an issue and a pull
// request of one repository never share: `{ item, readAt }`, the item with its
// `kind`, 'issues' or 'pulls'; and how many times they changed, which what
// reads them all observes, the store telling those that iterate them of none
// replaced.
const known = store({ items: new Map(), changes: 0 })
let keptFor = null

const sessionOf = () => state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
const keyOf = (session, repoId, number) => `${session}\0${repoId}\0${number}`

// When an answer was read from GitHub, as the server says, else now.
export const readAtOf = answer => Number.isSafeInteger(answer?.readAt) && answer.readAt > 0 ? answer.readAt : Date.now()

// Know `items` of repository `repoId`, as read at `readAt`, each `kind` where
// it names none: each where none read later is known. Another session's
// forgotten.
export function knowItems(repoId, items, readAt, kind = null) {
  const session = sessionOf()
  if (session !== keptFor) {
    known.items.clear()
    keptFor = session
  }
  let changed = false
  for (const item of items) {
    const key = keyOf(session, repoId, item.number)
    const held = known.items.get(key)
    if (held && held.readAt > readAt) continue
    known.items.set(key, { item: { ...item, kind: item.kind ?? kind ?? held?.item.kind ?? null }, readAt })
    changed = true
  }
  if (changed) known.changes++
}

// The latest read of issue or pull request `number` of repository `repoId`,
// `{ item, readAt }`, else null.
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
