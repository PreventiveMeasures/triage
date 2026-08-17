// Server-side triage for managed team reports. When a team report is open
// (`state.managedReport`), the server's per-finding entries hydrate the local
// triage map, and local edits push back debounced through the triage
// change-notifier slot — the managed counterpart of the e2e sync fan-out
// (which claims the same slot, but only when its client loads, and never in
// managed mode). The wire carries color / triage / comment / fix / flagged;
// `ignoredReports` stays client-local and `deleted` folds into the bucket.
import { bucketOf, saveTriage, setEntry, setTriageChangeNotifier, state } from '#client/index.js'
import { roleAtLeast } from '../../common/managed/roles.ts'
import { fetchReportTriage, pushReportTriage } from './client-managed.js'
import { render } from './render.js'

const PUSH_DEBOUNCE_MS = 500
// Matches the server's per-request entry cap; larger diffs push in batches.
const MAX_PUSH_ENTRIES = 200

// Wire projection of a triage entry — the five server-persisted fields, empty
// fields omitted. Returns null when nothing server-relevant remains (which
// pushes as a row clear). Applied to SERVER values too, so a hydrated entry
// can't smuggle unexpected fields into the local map.
function wireEntryOf(entry) {
  if (!entry) return null
  const out = {}
  if (entry.color) out.color = entry.color
  const bucket = bucketOf(entry)
  if (bucket) out.triage = bucket
  if (typeof entry.comment === 'string' && entry.comment) out.comment = entry.comment
  if (typeof entry.fix === 'string' && entry.fix) out.fix = entry.fix
  if (typeof entry.flagged === 'boolean') out.flagged = entry.flagged
  return Object.keys(out).length > 0 ? out : null
}

// Canonical comparison key for a wire entry; '' = no entry, so "absent from
// the snapshot" and "cleared" compare equal.
function wireKey(e) {
  return e == null ? '' : JSON.stringify([e.color ?? '', e.triage ?? '', e.comment ?? '', e.fix ?? '', e.flagged])
}

// Last state acked by the server per finding id (wireKey strings), re-seeded
// from the GET on every hydrate. The push diffs the live map against this, so
// only genuinely-changed entries go over the wire — and a failed push simply
// re-diffs on the next save (best-effort, no queue).
let lastPushed = new Map()
let pushTimer = null

// Server-persistable finding ids of the loaded report(s): real `f.id` values
// only — session-local numeric `_id` fallbacks never leave the client.
function loadedFindingIds() {
  const ids = new Set()
  for (const r of state.reports) {
    for (const g of r.groups) {
      for (const f of g) {
        if (typeof f.id === 'string' && f.id) ids.add(f.id)
      }
    }
  }
  return ids
}

function canPushTriage() {
  const session = state.managedSession
  return state.serverMode === 'managed' && session != null && roleAtLeast(session.role, 'triage')
}

// The entries whose wire state differs from the last-pushed snapshot, as the
// POST body shape (`null` = clear).
function collectChanges() {
  const changes = {}
  for (const id of loadedFindingIds()) {
    const wire = wireEntryOf(state.triage.get(id))
    if ((lastPushed.get(id) ?? '') === wireKey(wire)) continue
    changes[id] = wire
  }
  return changes
}

async function flushTriagePush() {
  pushTimer = null
  const open = state.managedReport
  if (open == null || !canPushTriage()) return
  const changes = collectChanges()
  const ids = Object.keys(changes)
  // Batch under the server's per-request cap. Each landed batch updates the
  // snapshot immediately, so a failed later batch re-diffs on the next save
  // instead of re-sending what already stuck.
  for (let i = 0; i < ids.length; i += MAX_PUSH_ENTRIES) {
    const slice = ids.slice(i, i + MAX_PUSH_ENTRIES)
    const batch = {}
    for (const id of slice) batch[id] = changes[id]
    const ok = await pushReportTriage(open.id, batch, state.managedSession?.csrfToken)
    if (!ok) return
    for (const id of slice) lastPushed.set(id, wireKey(changes[id]))
  }
}

// The change-notifier hook: fires at the tail of every saveTriage. No-op
// outside an open team report; otherwise debounce so a burst of edits (kanban
// drag, comment typing) collapses into one POST.
function scheduleTriagePush() {
  if (state.managedReport == null || !canPushTriage()) return
  if (pushTimer != null) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => { void flushTriagePush() }, PUSH_DEBOUNCE_MS)
}

// Claim the triage change-notifier for the managed push. Called after the
// session probe; skipped for roles below 'triage' (their reads still hydrate,
// they just have nothing to fan out) and outside managed mode, where the slot
// belongs to the e2e sync client.
let registered = false
export function initManagedTriagePush() {
  if (registered || !canPushTriage()) return
  registered = true
  setTriageChangeNotifier(scheduleTriagePush)
}

// Hydrate `state.triage` from the server's entries for a just-opened team
// report. The trusted server wins wholesale per entry — except the client-
// local `ignoredReports`, which is preserved unless the server entry carries a
// triage bucket (the triage⊻ignore mutex, mirroring applyTriageEntries).
// Local entries the server has none for are kept: they're unpushed local
// edits, and seeding the snapshot from the response makes the follow-up save
// push exactly those — never an echo of what the server just sent.
export async function hydrateManagedReportTriage(reportId) {
  if (state.serverMode !== 'managed' || state.managedSession == null) return
  const entries = await fetchReportTriage(reportId)
  // Bail when the fetch failed or the user already navigated elsewhere.
  if (entries == null || state.managedReport?.id !== reportId) return
  lastPushed = new Map()
  let changed = false
  for (const [id, raw] of Object.entries(entries)) {
    const wire = wireEntryOf(raw)
    lastPushed.set(id, wireKey(wire))
    if (wire == null) continue
    const ignoredReports = wire.triage == null ? state.triage.get(id)?.ignoredReports : undefined
    if (setEntry(state.triage, id, { ...wire, ignoredReports })) changed = true
  }
  if (changed) {
    // Persist the adopted entries and repaint the imperatively-rendered
    // surfaces (kanban, toolbar counts) that don't observe state.triage.
    await saveTriage()
    render()
  } else {
    // Nothing adopted, but local-only entries may still need pushing up.
    scheduleTriagePush()
  }
}
