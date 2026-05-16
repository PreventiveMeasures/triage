// Workspaces — named scopes a user creates from the sidebar. Each
// workspace gets a UUID-shaped id (derived from the privateKey via
// `deriveWorkspaceIdFromPrivateKey`) and a freshly generated 32-byte
// private key on creation. Persisted as a versioned JSON object
// under `deepview.workspaces` in localStorage; the private key
// rides along base64-encoded so the JSON stays a string.
//
// Persisted shape (round-10 — pre-v1 freeze):
//   { version: 1, workspaces: [...] }
//
// Pre-version blobs were a bare JSON array; `readRaw` accepts both
// shapes so a user upgrading from a pre-version build doesn't lose
// their workspaces on first load. The next `writeRaw` rewrites in
// the versioned form.
//
// Storage is small and synchronous-friendly (a handful of entries, a
// few hundred bytes each), so localStorage is the right tier — same
// pattern as triage / view-mode state. OPFS is reserved for the
// per-report blobs.
import { deriveWorkspaceIdFromPrivateKey } from './workspace-id.js'
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
// (tests, triage-sync, etc.) can keep importing from this module.
// The pub/sub plumbing itself lives in `workspace-listeners.js`.
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
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // Versioned shape: { version, workspaces }. Read forward-compat:
    // a future version we don't recognise still hands us the array
    // (callers operate on `workspaces` only); the next `writeRaw`
    // would downgrade it back to v1, so callers running an older
    // build can lose newer fields. Acceptable for v1; revisit when
    // a v2 actually exists.
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.workspaces)) {
      return parsed.workspaces
    }
    // Pre-version legacy shape: bare array of workspace records.
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

function writeRaw(list) {
  // Don't swallow quota / storage errors. Pre-fix, a failed
  // setItem (QuotaExceeded, security policy) was caught and only
  // logged — `mutateWorkspaces` then continued, the caller called
  // `markObservedFor` on the would-have-persisted entry, and
  // `lastSeen` recorded a workspace that doesn't exist in storage.
  // The next sibling-tab `storage` event would diff lastSeen
  // (has the entry) against readRaw (doesn't have it) and fire a
  // phantom `deleteListener`; a page reload would silently lose
  // the workspace with no error surfaced to the user. Propagating
  // the throw lets `mutateWorkspaces` skip the post-write
  // `markObservedFor` and surfaces the failure to the public
  // mutation function's caller (createWorkspace, etc.) so a UI
  // layer can warn the user. Audit round-13 W-7.
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: WORKSPACES_VERSION,
    workspaces: list,
  }))
}

// Apply `mutator(list)` to the workspaces blob under the same-origin
// Web Lock. The list is freshly read inside the lock so a concurrent
// tab's writes are visible; if the mutator returns `false` the write
// is skipped. Pattern mirrors `mutateAllSessions` in triage-sync.js.
//
// Round-8 follow-up: the read-modify-write pattern in every public
// mutation function (createWorkspace / deleteWorkspace / etc.) used
// to do `readRaw → modify → writeRaw` synchronously, so two tabs
// writing concurrently would each read the pre-write blob, modify
// independently, and the second writer would clobber the first.
// Web Locks serialize the RMW across tabs on the same origin so
// every mutator sees the previous tab's write.
const WORKSPACE_LOCK = STORAGE_KEY
function mutateWorkspaces(mutator) {
  return navigator.locks.request(WORKSPACE_LOCK, async () => {
    const list = readRaw()
    const result = await mutator(list)
    if (result === false) return undefined
    writeRaw(list)
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

// `lastSeen` tracks the per-id state that listeners have already
// observed (= "what callbacks have fired about"). The propagate
// handler diffs the current blob against this and fires for any
// id whose state in the blob differs from what's been observed.
//
// Round-8 M4: the previous design updated lastSeen to the FULL
// blob inside `writeRaw`, so a local mutation that read a sibling's
// concurrent change (via readRaw, post-sibling-write, pre-handler-
// fire) would mark that sibling change as "already observed" —
// the queued storage event then ran with prev == next and the
// sibling's create / privateKey-change / reports-change silently
// dropped its listener fire. Fix: writeRaw no longer touches
// lastSeen; each public mutation calls `markObservedFor(workspace)`
// or `markObservedDeleted(id)` for the ids IT touched. A sibling-
// only change that came in via readRaw stays unmarked, so the
// handler still fires for it on the next run.
let lastSeen = readRaw().map(snapshotForCache)
function markObservedFor(workspace) {
  lastSeen = lastSeen.filter((w) => w.id !== workspace.id)
  lastSeen.push(snapshotForCache(workspace))
}
// Pin only the named field (`reports` or `bundles`) of an existing
// observed snapshot, leaving every other diffed field at its
// previously-observed value. Used by `setReportWorkspace` /
// `setBundleWorkspace`, each of which only mutates ONE list — without
// the field-scoped variant, a sibling tab's concurrent privateKey
// rotation (or the other list's mutation) would be absorbed into
// lastSeen by the full-snapshot `markObservedFor` and the matching
// listener fire silently dropped on the next storage-event handler
// run (`prev == next` for that field). Audit round-12 H5.
function markObservedFieldFor(workspace, field) {
  const value = Array.isArray(workspace[field]) ? [...workspace[field]] : []
  const existing = lastSeen.find((w) => w.id === workspace.id)
  if (existing) {
    existing[field] = value
    return
  }
  // No prior snapshot — push a fresh one. setReport/BundleWorkspace
  // operate on workspaces already in the blob (so lastSeen has them
  // via createWorkspace / upsertWorkspace / propagate), but cover the
  // no-existing case for defense in depth.
  lastSeen.push(snapshotForCache(workspace))
}
function markObservedDeleted(id) {
  lastSeen = lastSeen.filter((w) => w.id !== id)
}

export function listWorkspaces() {
  const list = readRaw()
  // Backfill `reports` / `bundles` for entries persisted before each
  // field existed — keeps the rest of the renderer free of `?? []`
  // checks. `bundles` was added after `reports` so older blobs (and
  // newly-imported share-link / export bundles produced by older
  // builds) need the same defensive default.
  for (const w of list) {
    if (!Array.isArray(w.reports)) w.reports = []
    if (!Array.isArray(w.bundles)) w.bundles = []
  }
  return list
}

// Cap so a runaway paste / scripted input doesn't blow the
// `localStorage` quota with one giant name. 200 chars is comfortably
// past any sensible display label and short enough to keep the JSON
// blob small. Audit round-8 L3.
const MAX_WORKSPACE_NAME_LEN = 200

// `\0` is the separator inside `state.ignoredIds` keys
// (`${reportName}\0${id}`); a workspace name is never used in that
// position, but a control-char-bearing name still pollutes display
// layers and cross-tab logs. Strip control chars (incl. NUL) and
// cap length. Returns the cleaned string or null when nothing
// usable remains.
//
// Exported so the share-link unlock dialog can perform its live name-
// collision check against the SAME normalised form that the persisted
// blob uses. Comparing raw `.trim()` values would let a control-char
// variant (e.g. `Foo`) typed by the recipient slip past the
// dialog's check and persist as the same displayed `Foo` next to an
// existing entry — two workspaces sharing a display name on the same
// device. Audit follow-up (round-2 share-link review).
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
  // Defensive id-collision check INSIDE the same lock as the
  // write. Two random 32-byte keys colliding under SHA-256-
  // truncated-to-128-bits is astronomically improbable, but if
  // `attachSharedWorkspace` already planted the same id (the user
  // replayed their own earlier share link), pushing would land a
  // duplicate-id row that `upsertWorkspace` would later clobber.
  // Returning `false` from the mutator short-circuits the write;
  // the public caller surfaces "nothing happened" as `null`.
  const result = await mutateWorkspaces((list) => {
    if (list.some((w) => w.id === workspace.id)) return false
    list.push(workspace)
    return workspace
  })
  if (!result) return null
  // Mark the new workspace as observed so the next propagate
  // handler doesn't fire createListener for it. createWorkspace
  // is a local-only affordance whose UI caller manages the new
  // workspace directly; the create-listener path is reserved for
  // upsertWorkspace's first-insert + cross-tab propagation. M4
  // round-8: importantly, we do NOT mark workspaces that came
  // through readRaw without local mutation — those may reflect a
  // sibling's queued change that still needs to fire its own
  // listener via the propagate handler.
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

// Rename a workspace in place. Empty / whitespace-only names are
// rejected (returns false) so the sidebar caller can revert the
// inline edit; otherwise the trimmed value replaces the existing
// name and the helper returns true.
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
  // name listener; `snapshotForCache` excludes the field), so the
  // rename has nothing to advance lastSeen for. The pre-fix shape
  // pinned the FULL post-rename snapshot, which absorbed any
  // sibling-introduced privateKey / reports change that arrived via
  // readRaw inside the lock — the queued storage event then
  // computed prev == next and silently dropped the listener fire.
  // Audit round-12 H4.
  return true
}

// Insert or replace a workspace by id. Used by the import path so a
// re-import of the same workspace (same id) updates in place rather
// than producing a duplicate entry. Fires:
//   - `onWorkspaceCreated` on first-insert (new id);
//   - `onWorkspacePrivateKeyChanged` when an existing id's privateKey
//     changes (re-import of a re-keyed bundle, or a future "rotate
//     workspace key" affordance);
//   - `onReportMembershipChanged` when an existing id's `reports`
//     list changes (set-equal compare so reordering is a no-op) —
//     audit H1: a re-import that adds reports via upsertWorkspace
//     used to skip the eager hydration / conflict-dialog path the
//     rest of the membership listeners drive.
//   - `onBundleMembershipChanged` when an existing id's `bundles`
//     list changes (same set-equal compare).
//
// Special option `preserveBundles: true` (only used by the import path
// today) says: ignore `workspace.bundles` and reuse the previously-
// persisted `bundles` array for this id. The read happens INSIDE the
// mutateWorkspaces lock so a sibling tab can't race a detach between
// the caller's listWorkspaces() snapshot and our write — without the
// in-lock read, the import would resurrect a bundle the sibling
// intentionally detached, or smuggle the integrity into multi-owner
// state via the bundles-omitted branch (which skips the detach pass).
// On first-insert with `preserveBundles: true`, falls back to [].
export async function upsertWorkspace(workspace) {
  const result = await mutateWorkspaces((list) => {
    const idx = list.findIndex((w) => w.id === workspace.id)
    const previous = idx >= 0 ? list[idx] : null
    // Sanitize the incoming name — `workspace` may come from an
    // imported bundle whose author put control chars or unbounded
    // length in `workspace.name`. Fall back to the previous name
    // (on update) or 'Workspace' (on first insert) when sanitization
    // empties the string. Audit round-8 L3.
    const cleanedName = sanitizeWorkspaceName(workspace.name)
      ?? previous?.name
      ?? 'Workspace'
    // Resolve the bundles list against the preserve flag, then dedupe
    // — `[...new Set(...)]` is order-preserving so a caller's intended
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
  // Fire decisions compare against `lastSeen` (what the local
  // listeners have actually observed), NOT the in-blob `previous`.
  // Pre-fix, `previous` was read inside the lock — so it could
  // already incorporate a sibling tab's just-committed change that
  // the queued storage event hasn't surfaced locally yet. If our
  // upsert's privateKey happens to match the sibling's (re-import
  // of the same re-keyed bundle), `previous.privateKey ===
  // next.privateKey` → no fire here, then `markObservedFor(next)`
  // pins it as observed → the queued storage event sees prev ==
  // next and silently drops its own fire too. Net: privateKey
  // change never reaches local listeners. Audit round-13 W-6.
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
// (sanitised) name uniqueness check AND the insert in the same
// Web Lock acquisition that owns the read, so a sibling-tab
// `createWorkspace` racing the check can't slip past with the
// same name or the same id between the gate and the write.
// Resolves to one of:
//   { status: 'attached',         workspace }
//   { status: 'already-attached', workspace }  // same id present
//   { status: 'name-collision',   existing  }  // different id, same name
//
// `name` is sanitised the same way `createWorkspace` /
// `upsertWorkspace` do; an empty result rejects via 'name-collision'
// with `existing: null` so the caller can surface a single error
// path. Audit follow-up (round-2 share-link review): the previous
// design did its collision read in view.js BEFORE upserting, so a
// concurrent same-name create from a sibling tab landed a twin
// row that the dialog never warned about.
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
    // First-insert: fire create listeners the same way
    // `upsertWorkspace` does on its first-insert branch — the
    // sync layer subscribes to `onWorkspaceCreated` to bring up a
    // session for the new workspace. Then mark it observed so the
    // propagate handler doesn't re-fire on the storage event our
    // own write triggered.
    fireWorkspaceCreated(outcome.workspace.id)
    markObservedFor(outcome.workspace)
  }
  return outcome
}

// Generic set-equal compare used for both `reports` (filename strings)
// and `bundles` (sha512-integrity strings). Use Set sizes (deduped)
// AND set-membership. Pre-fix the length-then-one-direction-membership
// compare was a false-positive on duplicates: ['F','G'] vs ['F','F']
// passed as equal (same length, all of b's items in a's set) even
// though the deduped sets differ. `reports` / `bundles` are supposed
// to be unique-by-key, but `upsertWorkspace` trusts caller-supplied
// imports — a malformed bundle can plant duplicates that bypass the
// propagate handler's membership-change detection. Audit round-13 W-8.
function filesSetEqual(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const x of setA) if (!setB.has(x)) return false
  return true
}

// Generic membership-mutation core shared by setReportWorkspace and
// setBundleWorkspace. Each entry point passes the field name it owns
// (`reports` or `bundles`) and the matching listener-fire helper;
// the rest of the lifecycle is identical. Audit lineage lives inline:
//   W-4 — short-circuit when target already owns identifier, else a
//         remove-then-push fires the listener for a no-op call.
//   W-5 — validate target BEFORE detaching source; an unknown
//         workspaceId must not orphan the identifier.
//   H5  — advance lastSeen for the touched field only; pinning the
//         full snapshot would mask a sibling tab's concurrent
//         privateKey rotation or other-list mutation.
//   M4  — advance lastSeen only for workspaces THIS call modified.
async function setWorkspaceMembership({ identifier, workspaceId, field, fire }) {
  const result = await mutateWorkspaces((list) => {
    const currentOwnerId = list.find(
      (w) => Array.isArray(w[field]) && w[field].includes(identifier),
    )?.id ?? null
    // No-op short-circuits — return `false` so mutateWorkspaces skips
    // the writeRaw entirely. Pre-fix returned a truthy
    // `{ affected: new Set(), snapshot: new Map() }`, which still
    // landed a no-op writeRaw — firing a `storage` event in every
    // sibling tab that then re-parsed the blob and ran the propagate
    // diff for nothing. Common case (W-4): user drags a row back onto
    // its current workspace.
    if (currentOwnerId === (workspaceId ?? null)) return false
    if (workspaceId != null) {
      const target = list.find((w) => w.id === workspaceId)
      if (!target) return false
    }
    const aff = new Set()
    for (const w of list) {
      if (!Array.isArray(w[field])) w[field] = []
      if (w[field].includes(identifier)) {
        w[field] = w[field].filter((x) => x !== identifier)
        aff.add(w.id)
      }
    }
    if (workspaceId) {
      const target = list.find((w) => w.id === workspaceId)
      if (target && !target[field].includes(identifier)) {
        target[field].push(identifier)
        aff.add(target.id)
      }
    }
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

// Move a report to `workspaceId` (or detach it back to the unfiled
// list when `workspaceId` is null). A report belongs to at most one
// workspace at a time; the prior assignment, if any, is dropped first.
// No-ops cleanly when the target workspace doesn't exist. Fires
// `onReportMembershipChanged` for every workspace whose `reports`
// list actually changed (so an attach + detach pair notifies both
// the old owner and the new one); a no-op call (filename already at
// its destination) fires nothing.
export function setReportWorkspace(filename, workspaceId) {
  return setWorkspaceMembership({
    identifier: filename,
    workspaceId,
    field: 'reports',
    fire: fireReportMembershipChanged,
  })
}

// `bundles` twin of setReportWorkspace — same contract, scoped to
// the workspace's `bundles` list (sha512-integrity strings). Bundle
// bytes live in OPFS and aren't transmitted by the workspace sync
// protocol; this just moves the membership pointer (which IS synced
// cross-tab via the storage-event propagation, same as reports).
export function setBundleWorkspace(integrity, workspaceId) {
  return setWorkspaceMembership({
    identifier: integrity,
    workspaceId,
    field: 'bundles',
    fire: fireBundleMembershipChanged,
  })
}

// Cross-tab propagation: a sibling tab's `deleteWorkspace` /
// `upsertWorkspace` (key rotation, re-import) / `setReportWorkspace`
// fires a `storage` event in this tab. Diff the new blob against
// our cached view and re-fire the matching local listeners so the
// sync layer (which wires those listeners up) cleans up its
// in-memory + persisted session state without waiting for a page
// reload. Audit M-1.
//
// `lastSeen` represents per-id state that listeners have observed.
// Local mutations update it incrementally (only for the ids THIS
// mutation touched) via `markObservedFor` / `markObservedDeleted`;
// the propagate handler diffs the current blob against this and
// fires for any id whose blob state differs from the observed one.
// Round-8 M4: previously `writeRaw` snapshotted the FULL blob on
// every local mutation, so a sibling change that came in via
// `readRaw` (post-sibling-write, pre-handler-fire) was marked
// "observed" and silently dropped its listener fire.
//
// Exposed (not just registered) so node:test environments can
// drive the diff path directly — `window` doesn't exist in tests
// and the storage event never fires there.
export function propagateWorkspaceChangesFromStorage() {
  const next = readRaw().map(snapshotForCache)
  const prev = lastSeen
  const prevById = new Map(prev.map((w) => [w.id, w]))
  const nextById = new Map(next.map((w) => [w.id, w]))
  // Deletions
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
    // session.ids so it shouldn't fire spurious membership listeners.
    // Audit M2 round-3. Same logic mirrors to `bundles`: the field
    // exists alongside `reports` per workspace, propagated cross-tab
    // by the same storage-event diff.
    if (!filesSetEqual(p.reports, w.reports)) fireReportMembershipChanged(id)
    if (!filesSetEqual(p.bundles, w.bundles)) fireBundleMembershipChanged(id)
  }
  // Update lastSeen AFTER firing listeners so a re-entrant handler
  // call (storage event during a listener's work) doesn't see a
  // stale prev. The diff is the source of truth for what listeners
  // know; updating in lockstep with the fires keeps that property.
  lastSeen = next
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    propagateWorkspaceChangesFromStorage()
  })
}
