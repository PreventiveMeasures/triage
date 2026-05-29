// Workspaces — named scopes a user creates from the sidebar. Each
// gets a UUID-shaped id (derived from the privateKey via
// `deriveWorkspaceIdFromPrivateKey`) and a fresh 32-byte private key
// on creation. Persisted under `deepview.workspaces` in localStorage
// as `{ version: 1, workspaces: [...] }`; the private key rides
// base64-encoded so the JSON stays a string.
//
// Pre-version blobs were a bare JSON array; `readRaw` accepts both
// shapes so an upgrade doesn't lose workspaces on first load, and the
// next `writeRaw` rewrites in the versioned form.
//
// Storage is small (a handful of entries, a few hundred bytes each),
// so localStorage is the right tier — same pattern as triage / view-
// mode state. OPFS is reserved for the per-report blobs.
import { deriveWorkspaceIdFromPrivateKey } from './workspace-id.js'
import * as secureStorage from './secure-storage.js'
import {
  fireBundleMembershipChanged,
  fireReportMembershipChanged,
  fireWorkspaceCreated,
  fireWorkspaceDeleted,
  fireWorkspacePrivateKeyChanged,
  onBundleMembershipChanged,
  onReportMembershipChanged,
  onWorkspaceCreated,
  onWorkspaceDeleted,
  onWorkspacePrivateKeyChanged,
} from './workspace-listeners.js'

// Re-export the `on*` registration helpers so existing call sites
// (tests, triage-sync, etc.) keep importing from this module; the
// pub/sub plumbing lives in `workspace-listeners.js`.
export {
  onBundleMembershipChanged,
  onReportMembershipChanged,
  onWorkspaceCreated,
  onWorkspaceDeleted,
  onWorkspacePrivateKeyChanged,
}

const STORAGE_KEY = 'deepview.workspaces'
const WORKSPACES_VERSION = 1

function readRaw() {
  try {
    // secure-storage cache (hydrated at boot via `view.js`): JSON
    // payload, decrypted from its envelope when the vault is unlocked.
    const raw = secureStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // Versioned shape { version, workspaces }. Forward-compat: a
    // future version still hands us the array (callers use
    // `workspaces` only), but the next `writeRaw` downgrades it to
    // v1 — so an older build can drop newer fields. Acceptable for
    // v1; revisit when a v2 exists.
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.workspaces)) {
      return parsed.workspaces
    }
    // Pre-version legacy shape: bare array.
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

async function writeRaw(list) {
  // Don't swallow quota / storage errors — audit round-13 W-7.
  // Through secure-storage so the persisted value is envelope-
  // encrypted when the vault is unlocked. setItem is async (seal is
  // async), so this is too; `mutateWorkspaces` awaits it in the lock.
  await secureStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: WORKSPACES_VERSION,
    workspaces: list,
  }))
}

// Apply `mutator(list)` to the workspaces blob under the same-origin
// Web Lock (mirrors `mutateAllSessions` in triage-sync.js). The list
// is freshly read inside the lock so a concurrent tab's writes are
// visible; mutator returning `false` skips the write. The lock
// serializes the read-modify-write across same-origin tabs: without
// it two tabs would each read the pre-write blob, modify
// independently, and the second writer would clobber the first.
const WORKSPACE_LOCK = STORAGE_KEY
function mutateWorkspaces(mutator) {
  return navigator.locks.request(WORKSPACE_LOCK, async () => {
    // Pull the freshest disk state into the secure-storage cache BEFORE
    // reading. The Web Lock serializes the RMW across tabs, but the lock
    // grant is a microtask while a sibling tab's `storage` event is a
    // later task — so `readRaw()` (a cache read) can still be served the
    // pre-sibling-write value. Without this hydrate the mutator operates
    // on stale state and our `setItem` clobbers the sibling's change
    // (cross-tab lost update); worse, once that `setItem` pins
    // `pendingValues`, the late-arriving hydrate skips the key and locks
    // in the stale-derived value. Audit round-13 W (workspaces.js:102).
    // (Relies on `STORAGE_KEY` being written ONLY via `writeRaw` under
    // this lock, so its `pendingValues` pin is clear at acquire and the
    // hydrate below never skips the key — keep that invariant.)
    //
    // `hydrate()` fires secure-storage's after-hydrate listeners — incl.
    // this module's own `propagateWorkspaceChangesFromStorage` — while we
    // hold the lock. That's bounded and not a new behaviour class: any
    // `secureStorage.mutate(...)` call already runs `hydrate()` (firing
    // all after-hydrate listeners) inside its own lock. A workspace-event
    // subscriber is async, so a re-entrant mutation merely QUEUES on this
    // Web Lock (navigator.locks queues, it doesn't deadlock) and runs
    // after release; and every `fire*` is diff-gated against `lastSeen`,
    // so a converged state fires nothing (the chain terminates).
    await secureStorage.hydrate()
    const list = readRaw()
    const result = await mutator(list)
    if (result === false) return undefined
    await writeRaw(list)
    return result
  })
}

// Defensive shallow clone of the fields we diff on. Keeps the
// cache stable even if a caller hands us mutable `reports` /
// `bundles` arrays.
function snapshotForCache(w) {
  return {
    id: w.id,
    privateKey: w.privateKey,
    reports: Array.isArray(w.reports) ? [...w.reports] : [],
    bundles: Array.isArray(w.bundles) ? [...w.bundles] : [],
  }
}

// `lastSeen` tracks the per-id state listeners have observed; the
// propagate handler diffs the current blob against it and fires for
// any id whose blob state differs.
//
// INVARIANT (M4 round-8): `writeRaw` must NOT touch lastSeen; each
// public mutation marks only the ids IT touched via `markObservedFor`
// / `markObservedDeleted`. Pinning the full blob on every write would
// mark a sibling's concurrent change (read via readRaw, post-sibling-
// write, pre-handler-fire) as observed — the queued storage event
// then sees prev == next and silently drops the sibling's listener
// fire. A sibling-only change stays unmarked so the handler fires for
// it next run.
//
// At module init the secure-storage cache is empty (hydration runs
// later in boot), so lastSeen starts empty; boot calls
// `syncObservedAfterHydrate()` once the cache is populated, so the
// FIRST sibling-tab `storage` event doesn't fire phantom create
// listeners for workspaces already in storage at boot.
let lastSeen = readRaw().map(snapshotForCache)

export function syncObservedAfterHydrate() {
  lastSeen = readRaw().map(snapshotForCache)
}

function markObservedFor(workspace) {
  lastSeen = lastSeen.filter((w) => w.id !== workspace.id)
  lastSeen.push(snapshotForCache(workspace))
}
// Pin only the named field (`reports` or `bundles`) of an existing
// observed snapshot, leaving every other diffed field at its
// previously-observed value. Used by `setReportWorkspace` /
// `setBundleWorkspace`, each mutating ONE list — full-snapshot
// `markObservedFor` would absorb a sibling tab's concurrent
// privateKey rotation (or the other list's mutation) into lastSeen
// and silently drop its listener fire next storage-event run
// (`prev == next` for that field). Audit round-12 H5.
function markObservedFieldFor(workspace, field) {
  const value = Array.isArray(workspace[field]) ? [...workspace[field]] : []
  const existing = lastSeen.find((w) => w.id === workspace.id)
  if (existing) {
    existing[field] = value
    return
  }
  // No prior snapshot — push fresh (defense in depth;
  // setReport/BundleWorkspace operate on workspaces already in the
  // blob, so lastSeen normally has them via createWorkspace /
  // upsertWorkspace / propagate).
  lastSeen.push(snapshotForCache(workspace))
}
function markObservedDeleted(id) {
  lastSeen = lastSeen.filter((w) => w.id !== id)
}

export function listWorkspaces() {
  const list = readRaw()
  // Backfill `reports` / `bundles` for entries persisted before each
  // field existed — keeps the renderer free of `?? []` checks.
  // `bundles` postdates `reports`, so older blobs (and older-build
  // exports) need the same defensive default.
  for (const w of list) {
    if (!Array.isArray(w.reports)) w.reports = []
    if (!Array.isArray(w.bundles)) w.bundles = []
  }
  return list
}

// Cap so a runaway paste / scripted input can't blow the localStorage
// quota with one giant name. 200 chars is past any sensible display
// label and keeps the JSON blob small. Audit round-8 L3.
const MAX_WORKSPACE_NAME_LEN = 200

// Strip control chars (incl. NUL) and cap length; returns the cleaned
// string or null when nothing usable remains. A control-char-bearing
// name pollutes display layers and cross-tab logs (and NUL is the
// `state.ignoredIds` key separator `${reportName}\0${id}`).
//
// Exported so the share-link unlock dialog runs its live name-
// collision check against the SAME normalised form the persisted blob
// uses. Comparing raw `.trim()` values would let a control-char
// variant (e.g. `Foo`) typed by the recipient slip past the
// dialog's check and persist as the same displayed `Foo` next to an
// existing entry — two workspaces sharing one display name on the
// same device. Audit follow-up (round-2 share-link review).
export function sanitizeWorkspaceName(raw) {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  // eslint-disable-next-line no-control-regex
  const cleaned = trimmed.replaceAll(/[\u0000-\u001F\u007F]/gu, "").slice(0, MAX_WORKSPACE_NAME_LEN)
  return cleaned || null
}

export async function createWorkspace(name) {
  const cleaned = sanitizeWorkspaceName(name)
  if (!cleaned) return null
  const keyBytes = new Uint8Array(32)
  crypto.getRandomValues(keyBytes)
  const privateKey = keyBytes.toBase64()
  const workspace = {
    // id is derived from the key (not random) so a future share
    // link doesn't have to carry the id on the wire — receiver
    // re-derives the same value from the same privateKey. See
    // `deriveWorkspaceIdFromPrivateKey` above.
    id: await deriveWorkspaceIdFromPrivateKey(privateKey),
    name: cleaned,
    privateKey,
    reports: [],
    bundles: [],
    createdAt: Date.now(),
  }
  // Defensive id-collision check INSIDE the write lock. A random-key
  // collision under SHA-256-truncated-to-128-bits is astronomically
  // improbable, but if `attachSharedWorkspace` already planted the
  // same id (user replayed their own share link), pushing lands a
  // duplicate-id row that `upsertWorkspace` later clobbers. Returning
  // `false` skips the write; the caller surfaces `null`.
  const result = await mutateWorkspaces((list) => {
    if (list.some((w) => w.id === workspace.id)) return false
    list.push(workspace)
    return workspace
  })
  if (!result) return null
  // Mark the new workspace observed so the next propagate handler
  // doesn't fire createListener for it. createWorkspace is a local-
  // only affordance whose UI caller manages the workspace directly;
  // the create-listener path is reserved for upsertWorkspace's first-
  // insert + cross-tab propagation. M4 round-8: do NOT mark
  // workspaces that came through readRaw without local mutation —
  // those may reflect a sibling's queued change still needing to fire
  // its own listener via the propagate handler.
  markObservedFor(workspace)
  return workspace
}

export async function deleteWorkspace(id) {
  const removed = await mutateWorkspaces((list) => {
    const idx = list.findIndex((w) => w.id === id)
    if (idx < 0) return false
    list.splice(idx, 1)
    return true
  })
  if (!removed) return
  fireWorkspaceDeleted(id)
  markObservedDeleted(id)
}

// Empty / whitespace-only names are rejected (returns false) so the
// sidebar caller can revert the inline edit.
export async function renameWorkspace(id, name) {
  const cleaned = sanitizeWorkspaceName(name)
  if (!cleaned) return false
  const renamed = await mutateWorkspaces((list) => {
    const ws = list.find((w) => w.id === id)
    if (!ws || ws.name === cleaned) return false
    ws.name = cleaned
    return ws
  })
  if (!renamed) return false
  // No `markObservedFor` here — `name` isn't part of the diff (no
  // name listener; `snapshotForCache` excludes it), so the rename has
  // nothing to advance lastSeen for. The pre-fix shape pinned the
  // FULL post-rename snapshot, absorbing any sibling-introduced
  // privateKey / reports change that arrived via readRaw inside the
  // lock — the queued storage event then computed prev == next and
  // silently dropped the listener fire. Audit round-12 H4.
  return true
}

// Insert or replace a workspace by id, so a re-import of the same
// workspace (same id) updates in place instead of duplicating. Fires:
//   - `onWorkspaceCreated` on first-insert (new id);
//   - `onWorkspacePrivateKeyChanged` when an existing id's privateKey
//     changes (re-import of a re-keyed bundle, or a future "rotate
//     workspace key" affordance);
//   - `onReportMembershipChanged` when an existing id's `reports`
//     changes (set-equal compare so reordering is a no-op) — audit
//     H1: a re-import that adds reports here used to skip the eager
//     hydration / conflict-dialog path the membership listeners drive.
//   - `onBundleMembershipChanged` when an existing id's `bundles`
//     changes (same set-equal compare).
//
// `preserveBundles: true` (only the import path today): ignore
// `workspace.bundles` and reuse the previously-persisted `bundles`
// for this id. The read happens INSIDE the mutateWorkspaces lock so a
// sibling tab can't race a detach between the caller's
// listWorkspaces() snapshot and our write — otherwise the import
// would resurrect a bundle the sibling intentionally detached, or
// smuggle the integrity into multi-owner state via the bundles-
// omitted branch (which skips the detach pass). First-insert falls
// back to [].
export async function upsertWorkspace(workspace) {
  const result = await mutateWorkspaces((list) => {
    const idx = list.findIndex((w) => w.id === workspace.id)
    const previous = idx >= 0 ? list[idx] : null
    // Sanitize the incoming name — `workspace` may come from an
    // imported bundle whose author put control chars or unbounded
    // length in `workspace.name`. Fall back to the previous name
    // (update) or 'Workspace' (first insert) when sanitization empties
    // it. Audit round-8 L3.
    const cleanedName = sanitizeWorkspaceName(workspace.name)
      ?? previous?.name
      ?? 'Workspace'
    // Resolve bundles against the preserve flag, then dedupe —
    // `[...new Set(...)]` is order-preserving so a caller's intended
    // ordering (e.g. workspace export's report sequence) survives.
    const resolvedBundles = workspace.preserveBundles
      ? (Array.isArray(previous?.bundles) ? previous.bundles : [])
      : (Array.isArray(workspace.bundles) ? workspace.bundles : [])
    const next = {
      id: workspace.id,
      name: cleanedName,
      privateKey: workspace.privateKey,
      reports: Array.isArray(workspace.reports) ? [...new Set(workspace.reports)] : [],
      bundles: [...new Set(resolvedBundles)],
      createdAt: workspace.createdAt ?? Date.now(),
    }
    if (idx >= 0) list[idx] = next
    else list.push(next)
    return { previous, next }
  })
  const { next } = result
  // Fire decisions compare against `lastSeen` (what local listeners
  // have actually observed), NOT the in-blob `previous`. Read inside
  // the lock, `previous` can already incorporate a sibling tab's
  // just-committed change the queued storage event hasn't surfaced
  // locally yet. If our upsert's privateKey matches the sibling's
  // (re-import of the same re-keyed bundle), `previous.privateKey ===
  // next.privateKey` → no fire here, then `markObservedFor(next)`
  // pins it observed → the queued storage event sees prev == next and
  // drops its own fire too. Net: the privateKey change never reaches
  // local listeners. Audit round-13 W-6.
  const observed = lastSeen.find((w) => w.id === next.id) ?? null
  if (observed == null) {
    fireWorkspaceCreated(next.id)
  } else {
    if (observed.privateKey !== next.privateKey) fireWorkspacePrivateKeyChanged(next.id)
    if (!filesSetEqual(observed.reports, next.reports)) fireReportMembershipChanged(next.id)
    if (!filesSetEqual(observed.bundles, next.bundles)) fireBundleMembershipChanged(next.id)
  }
  markObservedFor(next)
  return next
}

// Attach a workspace received via a share link. Runs the id +
// (sanitised) name uniqueness check AND the insert in the same Web
// Lock acquisition that owns the read, so a sibling-tab
// `createWorkspace` racing the check can't slip past with the same
// name or id between the gate and the write. Resolves to one of:
//   { status: 'attached',         workspace }
//   { status: 'already-attached', workspace }  // same id present
//   { status: 'name-collision',   existing  }  // different id, same name
//
// `name` is sanitised as in `createWorkspace` / `upsertWorkspace`; an
// empty result rejects via 'name-collision' with `existing: null` so
// the caller has a single error path. Audit follow-up (round-2 share-
// link review): the previous design read the collision check in
// view.js BEFORE upserting, so a concurrent same-name create from a
// sibling tab landed a twin row the dialog never warned about.
export async function attachSharedWorkspace({ id, name, privateKey, createdAt }) {
  let outcome = null
  await mutateWorkspaces((list) => {
    const sanitisedName = sanitizeWorkspaceName(name)
    if (!sanitisedName) {
      outcome = { status: 'name-collision', existing: null }
      return false
    }
    const existingById = list.find((w) => w.id === id) ?? null
    if (existingById) {
      outcome = { status: 'already-attached', workspace: existingById }
      return false
    }
    const existingByName = list.find(
      (w) => sanitizeWorkspaceName(w.name) === sanitisedName,
    ) ?? null
    if (existingByName) {
      outcome = { status: 'name-collision', existing: existingByName }
      return false
    }
    const workspace = {
      id,
      name: sanitisedName,
      privateKey,
      reports: [],
      bundles: [],
      createdAt: createdAt ?? Date.now(),
    }
    list.push(workspace)
    outcome = { status: 'attached', workspace }
    return undefined
  })
  if (outcome?.status === 'attached') {
    // First-insert: fire create listeners as `upsertWorkspace` does
    // on its first-insert branch — the sync layer subscribes to
    // `onWorkspaceCreated` to bring up a session for the new
    // workspace. Then mark observed so the propagate handler doesn't
    // re-fire on the storage event our own write triggered.
    fireWorkspaceCreated(outcome.workspace.id)
    markObservedFor(outcome.workspace)
  }
  return outcome
}

// Generic set-equal compare for `reports` (filename strings) and
// `bundles` (sha512-integrity strings). Compare deduped Set sizes AND
// membership: the pre-fix length-then-one-direction-membership check
// false-positived on duplicates — ['F','G'] vs ['F','F'] passed
// (same length, all of b in a's set) despite differing deduped sets.
// `reports` / `bundles` should be unique-by-key, but `upsertWorkspace`
// trusts caller imports — a malformed bundle can plant duplicates that
// bypass the propagate handler's membership-change detection. Audit
// round-13 W-8.
function filesSetEqual(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const x of setA) if (!setB.has(x)) return false
  return true
}

// Generic membership-mutation core shared by setReportWorkspace and
// setBundleWorkspace. Each entry point passes the field it owns
// (`reports` or `bundles`) and the matching fire helper; the rest of
// the lifecycle is identical. Audit lineage inline:
//   W-4 — short-circuit when target already owns identifier, else a
//         remove-then-push fires the listener for a no-op call.
//   W-5 — validate target BEFORE detaching source; an unknown
//         workspaceId must not orphan the identifier.
//   H5  — advance lastSeen for the touched field only; pinning the
//         full snapshot would mask a sibling tab's concurrent
//         privateKey rotation or other-list mutation.
//   M4  — advance lastSeen only for workspaces THIS call modified.
// `additive: true` skips the source-detach loop — the identifier
// stays in any other workspace that lists it, and the target row just
// grows. A report can belong to multiple workspaces; "detached" means
// "listed in zero". Used by the objstore auto-attach wrapper
// `addReportToWorkspace`.
//
// `from: workspaceId` scopes the detach loop to that ONE workspace
// instead of iterating the whole blob — used by
// `removeReportFromWorkspace` (drag-out of one workspace under the
// multi-workspace model). Leaves the rest of the membership intact.
async function setWorkspaceMembership({ identifier, workspaceId, field, fire, additive = false, from = undefined }) {
  const result = await mutateWorkspaces((list) => {
    const currentOwnerId = list.find(
      (w) => Array.isArray(w[field]) && w[field].includes(identifier),
    )?.id ?? null
    // No-op short-circuit — return `false` so mutateWorkspaces skips
    // writeRaw entirely. A truthy `{ affected, snapshot }` still lands
    // a no-op writeRaw, firing a `storage` event in every sibling tab
    // that then re-parses the blob and runs the propagate diff for
    // nothing. Common case (W-4): user drags a row back onto its
    // current workspace.
    if (currentOwnerId === (workspaceId ?? null)) return false
    // Resolve the target once. W-5: an unknown `workspaceId` must bail
    // BEFORE the detach loop — else a bad target id strips the
    // identifier from its current owner and attaches it to nothing
    // (orphaned).
    let target = null
    if (workspaceId != null) {
      target = list.find((w) => w.id === workspaceId) ?? null
      if (!target) return false
    }
    const aff = new Set()
    if (!additive) {
      for (const w of list) {
        if (from !== undefined && w.id !== from) continue
        if (!Array.isArray(w[field])) w[field] = []
        if (w[field].includes(identifier)) {
          w[field] = w[field].filter((x) => x !== identifier)
          aff.add(w.id)
        }
      }
    }
    if (target) {
      if (!Array.isArray(target[field])) target[field] = []
      if (!target[field].includes(identifier)) {
        target[field].push(identifier)
        aff.add(target.id)
      }
    }
    // Additive-mode W-4 fix: the early `currentOwnerId === workspaceId`
    // short-circuit catches the single-owner no-op, but `find()`
    // returns first-match and under multi-workspace state the
    // identifier can sit in BOTH the target and another workspace.
    // Then the early check fails (currentOwnerId = the other
    // workspace), the additive branch skips the detach loop, and the
    // target-attach dedup leaves `aff` empty — return false so
    // mutateWorkspaces skips writeRaw and its cross-tab `storage`
    // ripple.
    if (aff.size === 0) return false
    const snap = new Map()
    for (const id of aff) {
      const ws = list.find((w) => w.id === id)
      if (ws) snap.set(id, ws)
    }
    return { affected: aff, snapshot: snap }
  })
  if (!result) return
  const { affected, snapshot } = result
  for (const id of affected) {
    fire(id)
    const ws = snapshot.get(id)
    if (ws) markObservedFieldFor(ws, field)
  }
}

// Membership mutators come in report/bundle pairs differing only by
// the list they touch (`reports` vs `bundles`) and the listener they
// fire. `membershipApi` binds those so the three operation shapes
// (move / additive add / scoped remove) are written once instead of
// duplicated per identifier kind.
function membershipApi(field, fire) {
  return {
    move: (identifier, workspaceId) => setWorkspaceMembership({ identifier, workspaceId, field, fire }),
    add: (identifier, workspaceId) => setWorkspaceMembership({ identifier, workspaceId, field, fire, additive: true }),
    remove: (identifier, workspaceId) => setWorkspaceMembership({ identifier, field, fire, from: workspaceId }),
  }
}
const reportMembership = membershipApi('reports', fireReportMembershipChanged)
const bundleMembership = membershipApi('bundles', fireBundleMembershipChanged)

// Move a report to `workspaceId` (or detach to the unfiled list when
// null), dropping the prior assignment first — drag-into-workspace
// "move the row from one workspace to another". A report can be in
// multiple workspaces (see `addReportToWorkspace`); this is the
// explicit single-owner-move variant. No-ops when the target doesn't
// exist. Fires `onReportMembershipChanged` for every workspace whose
// `reports` actually changed (so an attach+detach pair notifies both
// old and new owner); a no-op call fires nothing.
export const setReportWorkspace = reportMembership.move

// Additive twin of `setReportWorkspace`: grow `workspaceId.reports`
// without detaching from any OTHER workspace that lists `filename`.
// Used by the objstore auto-attach path so a peer-uploaded matching
// fileName converges into our membership row without stealing the
// file from another workspace's independent claim.
export const addReportToWorkspace = reportMembership.add

// Scoped detach: remove `filename` from `workspaceId.reports` only,
// leaving every other workspace's claim alone. Used by the sidebar
// drag-out path — `setReportWorkspace(filename, null)` strips from
// ALL workspaces (single-owner-move shape), making the dragged report
// vanish from sibling workspaces that legitimately also list it.
// No-op when `workspaceId` doesn't list the file or doesn't exist.
export const removeReportFromWorkspace = reportMembership.remove

// `bundles` twin of setReportWorkspace — same contract on the
// `bundles` list (sha512-integrity strings). Bundle bytes live in
// OPFS and aren't transmitted by the sync protocol; this only moves
// the membership pointer (which IS synced cross-tab via the storage-
// event propagation, same as reports).
export const setBundleWorkspace = bundleMembership.move

// `bundles` twin of `addReportToWorkspace` — additive add.
export const addBundleToWorkspace = bundleMembership.add

// `bundles` twin of `removeReportFromWorkspace` — scoped detach.
export const removeBundleFromWorkspace = bundleMembership.remove

// Cross-tab propagation: a sibling tab's `deleteWorkspace` /
// `upsertWorkspace` (key rotation, re-import) / `setReportWorkspace`
// fires a `storage` event here. Diff the new blob against `lastSeen`
// (see the INVARIANT block above) and re-fire the matching local
// listeners so the sync layer cleans up its in-memory + persisted
// session state without a page reload. Audit M-1.
//
// Exposed (not just registered) so node:test environments can drive
// the diff path directly — `window` doesn't exist in tests and the
// storage event never fires there.
export function propagateWorkspaceChangesFromStorage() {
  const next = readRaw().map(snapshotForCache)
  const prev = lastSeen
  const prevById = new Map(prev.map((w) => [w.id, w]))
  const nextById = new Map(next.map((w) => [w.id, w]))
  for (const id of prevById.keys()) {
    if (nextById.has(id)) continue
    fireWorkspaceDeleted(id)
  }
  for (const [id, w] of nextById) {
    const p = prevById.get(id)
    if (!p) {
      // Sibling-tab create — symmetric with the delete branch above.
      // Audit M3 round-3.
      fireWorkspaceCreated(id)
      continue
    }
    if (p.privateKey !== w.privateKey) fireWorkspacePrivateKeyChanged(id)
    // Set-equal compare on `reports` — reordering doesn't change
    // session.ids, so it shouldn't fire spurious membership listeners.
    // Audit M2 round-3. `bundles` mirrors the same logic.
    if (!filesSetEqual(p.reports, w.reports)) fireReportMembershipChanged(id)
    if (!filesSetEqual(p.bundles, w.bundles)) fireBundleMembershipChanged(id)
  }
  // Update lastSeen AFTER firing so a re-entrant handler call
  // (storage event during a listener's work) doesn't see a stale
  // prev. The diff is the source of truth for what listeners know;
  // updating in lockstep with the fires keeps that property.
  lastSeen = next
}

// Subscribe to secure-storage's after-hydrate listener, not the raw
// `storage` event. The raw event fires synchronously in sibling tabs,
// but secure-storage's hydrate (which decrypts the just-written
// envelope) is async — so a sync `storage` handler here would read
// the PRE-hydrate cache and miss any sibling-tab create/delete/rekey.
// The after-hydrate hook fires post-decrypt, so the propagate handler
// sees the fresh cache. Audit round-5 concurrency #2.
secureStorage.onAfterHydrate(() => {
  propagateWorkspaceChangesFromStorage()
})
