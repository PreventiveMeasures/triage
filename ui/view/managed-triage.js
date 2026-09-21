// Server-side triage for managed team reports. When a team report is open
// (`state.managedReport`), the server's per-finding entries hydrate the local
// triage map, and local edits made while it is open push back debounced
// through the triage change-notifier slot — the managed counterpart of the
// e2e sync fan-out (which claims the same slot, but only when its client
// loads, and never in managed mode). The wire carries color / triage /
// comment / fix / flagged; `ignoredReports` stays client-local and `deleted`
// folds into the bucket.
//
// `state.triage` is ONE map keyed by finding id across every loaded report —
// the app's rule that the same finding (same fingerprint id) in two scans
// shares its triage. The server's rows are per (report, finding), so only what
// changes WHILE a report is open counts as that report's edit: an entry that
// was already local when the report opened (made in another report, or
// hydrated from one) is displayed under the app's rule but never pushed on
// the open report's behalf — nothing crosses reports server-side by merely
// viewing them.
import { bucketOf, saveTriage, setEntry, setTriageChangeNotifier, state } from '#client/index.js'
import { roleAtLeast } from '../../common/managed/roles.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_COLOR, MAX_TRIAGE_ENTRIES, MAX_TRIAGE_TEXT } from '../../common/managed/triage.ts'
import { fetchReportTriage, pushReportTriage } from './client-managed.js'
import { render } from './render.js'

const PUSH_DEBOUNCE_MS = 500
// The request body's fixed part around the entries: `{"entries":{}}`.
const BODY_OVERHEAD_BYTES = 14

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

// Whether the server would accept this entry as sent (its per-entry caps —
// parseTriageEntryPatch's — and the finding-id length).
function fitsWire(id, wire) {
  if (id.length > MAX_FINDING_ID) return false
  if (wire == null) return true
  return (wire.color?.length ?? 0) <= MAX_TRIAGE_COLOR
    && (wire.comment?.length ?? 0) <= MAX_TRIAGE_TEXT
    && (wire.fix?.length ?? 0) <= MAX_TRIAGE_TEXT
}

const utf8Length = (s) => new TextEncoder().encode(s).length

// The open report's baseline: per finding id, the wire state (wireKey) the
// server is taken to hold. Seeded on hydrate — from the local map for every
// loaded id, then from the GET for the ids it returned — and advanced by each
// landed push. An edit is whatever differs from it.
let baseline = new Map()

// The edits captured since they last landed, per report id: the report, the
// baseline they were diffed against, and the wire entries (null = clear) by
// finding id. Captured at edit time, so neither a view switch nor the next
// report's hydrate changes what gets sent — the timer only decides WHEN. A
// batch that fails transiently is put back here for the next flush.
const pending = new Map()
let pushTimer = null
// Flushes run in order: a later batch must not overtake an earlier one on the
// wire (whole-entry replace — the last one to land wins).
let flushChain = Promise.resolve()

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

// A batch the server refused AS SENT (malformed, an id the caller may not
// touch, too large) will not land by sending it again; anything else — the
// network, a 5xx, a lapsed session, rate limiting — may.
function refusedAsSent(status) {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429
}

// Put a batch's unsent tail back for the next flush. A newer capture for the
// same id (an edit made while the batch was in flight) wins over what didn't
// land.
function requeue(p, ids) {
  let q = pending.get(p.report.id)
  if (q == null) {
    q = { report: p.report, baseline: p.baseline, changes: new Map() }
    pending.set(p.report.id, q)
  }
  for (const id of ids) if (!q.changes.has(id)) q.changes.set(id, p.changes.get(id))
}

async function flush(p) {
  const ids = [...p.changes.keys()]
  let i = 0
  while (i < ids.length) {
    // One request: at most MAX_TRIAGE_ENTRIES entries and MAX_TRIAGE_BODY_BYTES
    // of JSON — measured, since the text is free-form (an entry alone always
    // fits: its fields are capped well below the body).
    const start = i
    const batch = {}
    let count = 0
    let bytes = BODY_OVERHEAD_BYTES
    while (i < ids.length && count < MAX_TRIAGE_ENTRIES) {
      const id = ids[i]
      const entryBytes = utf8Length(`${JSON.stringify(id)}:${JSON.stringify(p.changes.get(id))},`)
      if (count > 0 && bytes + entryBytes > MAX_TRIAGE_BODY_BYTES) break
      batch[id] = p.changes.get(id)
      bytes += entryBytes
      count++
      i++
    }
    const status = await pushReportTriage(p.report.id, batch, state.managedSession?.csrfToken)
    const landed = status >= 200 && status < 300
    if (!landed && !refusedAsSent(status)) {
      // Transient: stop here, this batch and the rest go again next time.
      requeue(p, ids.slice(start))
      return
    }
    // Landed — or refused as sent, which re-sending would only repeat: warn,
    // and let the baseline absorb those entries so they aren't sent again
    // until they change (the other batches still go).
    if (!landed) console.warn('managed: the server refused a triage batch', p.report.id, status, Object.keys(batch))
    for (const id of Object.keys(batch)) p.baseline.set(id, wireKey(batch[id]))
  }
}

function flushPending() {
  if (pushTimer != null) { clearTimeout(pushTimer); pushTimer = null }
  const batches = [...pending.values()]
  pending.clear()
  for (const p of batches) {
    flushChain = flushChain.then(() => flush(p)).catch((err) => { console.warn('managed: triage push failed', err) })
  }
}

// The change-notifier hook: fires at the tail of every saveTriage. No-op
// outside an open team report; otherwise capture the edits now and debounce
// the send, so a burst (kanban drag, comment typing) collapses into one POST.
function scheduleTriagePush() {
  const open = state.managedReport
  if (open == null || !canPushTriage()) return
  let q = pending.get(open.id)
  for (const id of loadedFindingIds()) {
    const wire = wireEntryOf(state.triage.get(id))
    const key = wireKey(wire)
    if ((baseline.get(id) ?? '') === key) continue
    if (!fitsWire(id, wire)) {
      // Over the server's caps: it would be refused as sent. Keep it local
      // (say so once) and let the baseline absorb it so it isn't retried until
      // it changes again.
      console.warn('managed: triage entry exceeds the server caps, kept local only', id)
      baseline.set(id, key)
      continue
    }
    if (q == null) {
      q = { report: open, baseline, changes: new Map() }
      pending.set(open.id, q)
    }
    q.changes.set(id, wire)
  }
  if (pending.size === 0) return
  if (pushTimer != null) clearTimeout(pushTimer)
  pushTimer = setTimeout(flushPending, PUSH_DEBOUNCE_MS)
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
// Local entries the server has none for are kept for display (see the header)
// but become part of this report's baseline, never its edits: only what
// changes from here on pushes.
export async function hydrateManagedReportTriage(reportId) {
  if (state.serverMode !== 'managed' || state.managedSession == null) return
  // Whatever is still pending goes first, and lands before the server copy is
  // read — so an edit made moments ago is what "server wins" then confirms,
  // not what it reverts.
  flushPending()
  // The baseline, synchronously: every loaded id starts at its local wire
  // state, so an edit made before the GET returns is diffed against that and
  // nothing already local is mistaken for this report's edit.
  const seeded = new Map()
  for (const id of loadedFindingIds()) {
    const key = wireKey(wireEntryOf(state.triage.get(id)))
    if (key !== '') seeded.set(id, key)
  }
  baseline = seeded
  await flushChain
  const entries = await fetchReportTriage(reportId)
  // Bail when the fetch failed or the user already navigated elsewhere.
  if (entries == null || state.managedReport?.id !== reportId) return
  let changed = false
  for (const [id, raw] of Object.entries(entries)) {
    const wire = wireEntryOf(raw)
    seeded.set(id, wireKey(wire))
    if (wire == null) continue
    const ignoredReports = wire.triage == null ? state.triage.get(id)?.ignoredReports : undefined
    if (setEntry(state.triage, id, { ...wire, ignoredReports })) changed = true
  }
  if (changed) {
    // Persist the adopted entries and repaint the imperatively-rendered
    // surfaces (kanban, toolbar counts) that don't observe state.triage. The
    // save's notifier finds nothing to push: the baseline already says so.
    await saveTriage()
    render()
  }
}
