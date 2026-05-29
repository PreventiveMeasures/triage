// Workspace pub/sub — five parallel listener registries that the
// mutation functions in `workspaces.js` fire after every state-
// changing call (create, delete, key-rotate, reports-change,
// bundles-change) AND that `propagateWorkspaceChangesFromStorage`
// fires for the equivalent sibling-tab changes the storage event
// surfaces.
//
// Pulled out of `workspaces.js` so the mutation file stays under its
// lint cap, the five Set+on+fire trios sit together to eyeball for
// consistency, and tests / future modules can import the pub/sub
// surface without the full workspaces state machine.
//
// Each `fireXxx(arg)` walks its Set and swallows per-callback throws
// so one bad subscriber can't strand the rest.
//
// `triage-sync.ts` is the main subscriber today:
//   - `onWorkspaceDeleted`         — tear down the in-memory +
//     persisted session for the deleted workspace.
//   - `onWorkspacePrivateKeyChanged` — drop + re-open the session so
//     cached signingKey / workspaceTag (derived from the OLD key)
//     refresh; else saves keep going to the old chain under a now-
//     orphan tag and silently drift.
//   - `onReportMembershipChanged`  — refresh `session.ids` AND
//     hydrate state.* from baseState for ids that just entered scope
//     (audit H1 — else the next save emits deletes for every gap-
//     filled id).
//   - `onWorkspaceCreated`         — no subscriber today; reserved for
//     registries that repaint UI or seed per-workspace caches without
//     polling.
//   - `onBundleMembershipChanged`  — no triage-sync subscriber: bundle
//     bytes carry no triage state (read-only OPFS artifacts indexed
//     for findings, not chain participants). Reserved for future UI /
//     objstore subscribers reacting to bundle membership changes
//     (cross-tab or local) without polling.

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
