// Workspace pub/sub — five parallel listener registries that the
// mutation functions in `workspaces.js` fire after every state-
// changing call (create, delete, key-rotate, reports-change,
// bundles-change) AND that `propagateWorkspaceChangesFromStorage`
// fires for the equivalent sibling-tab changes the storage event
// surfaces.
//
// Pulled out of `workspaces.js` so:
//   - the mutation file stays under its lint cap without
//     compaction tricks;
//   - the five Set+on+fire trios live next to each other and
//     can be eyeballed for consistency;
//   - tests / future modules that only need the pub/sub surface
//     can import from here without dragging the full workspaces
//     state machine.
//
// Each `fireXxx(arg)` walks its Set and swallows per-callback
// throws so one bad subscriber can't strand the rest — matches
// the prior in-place behaviour.
//
// `triage-sync.ts` is the main subscriber today:
//   - `onWorkspaceDeleted`         — tear down the in-memory +
//     persisted session for the deleted workspace.
//   - `onWorkspacePrivateKeyChanged` — drop + re-open the session
//     so cached signingKey / workspaceTag (derived from the OLD
//     key) get refreshed; otherwise saves keep going to the old
//     chain under a now-orphan tag and silently drift.
//   - `onReportMembershipChanged`  — refresh `session.ids` AND
//     hydrate state.* from baseState for ids that just entered
//     scope (audit H1 — without this the next save would emit
//     deletes for every gap-filled id).
//   - `onWorkspaceCreated`         — no subscriber today; reserved
//     for registries that repaint UI affordances or seed per-
//     workspace caches without polling.
//   - `onBundleMembershipChanged`  — no triage-sync subscriber: bundle
//     bytes carry no triage state (they're read-only OPFS artifacts
//     indexed for findings, not chain participants). Reserved for
//     future UI / objstore subscribers that want to react to bundle
//     membership changes (cross-tab or local) without polling.

function makeListenerRegistry(label) {
  const listeners = new Set()
  function on(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
  function fire(arg) {
    for (const cb of listeners) {
      try { cb(arg) } catch (err) { console.warn(`workspace ${label} listener failed:`, err) }
    }
  }
  return { on, fire }
}

const createReg = makeListenerRegistry('create')
const deleteReg = makeListenerRegistry('delete')
const privateKeyReg = makeListenerRegistry('privateKey')
const reportMembershipReg = makeListenerRegistry('report-membership')
const bundleMembershipReg = makeListenerRegistry('bundle-membership')

export const onWorkspaceCreated = createReg.on
export const onWorkspaceDeleted = deleteReg.on
export const onWorkspacePrivateKeyChanged = privateKeyReg.on
export const onReportMembershipChanged = reportMembershipReg.on
export const onBundleMembershipChanged = bundleMembershipReg.on

export const fireWorkspaceCreated = createReg.fire
export const fireWorkspaceDeleted = deleteReg.fire
export const fireWorkspacePrivateKeyChanged = privateKeyReg.fire
export const fireReportMembershipChanged = reportMembershipReg.fire
export const fireBundleMembershipChanged = bundleMembershipReg.fire
