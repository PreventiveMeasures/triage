// Server-side triage for managed team reports. When a team report is open
// (`state.managedReport`), the server's per-finding entries hydrate the local
// triage map, and local edits push back debounced through the triage
// managed change-notifier — independent of the e2e sync fan-out. The wire carries color / triage / fix / flagged;
// `ignoredReports` and `upstream` stay client-local and `deleted` folds into
// the bucket.
//
// Both sides are keyed by finding id alone. `state.triage` is one map across
// every loaded report — reports mostly repeat one another (a re-scan of the
// same code carries the same finding ids), and a finding's triage is shared
// by every report that carries it — and the server stores one row per finding
// id the same way; a report is only the scope through which a viewer may read
// or write the ids it carries. So opening a report merges the two maps over
// its findings: an id the server knows (a value, or the tombstone of a cleared
// entry) is adopted wholesale, and one it has never seen carries whatever is
// local up.
import { bucketOf, saveTriage, setEntry, setManagedTriageChangeNotifier, state } from '#client/index.js'
import { roleAtLeast } from '../../common/managed/roles.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_COLOR, MAX_TRIAGE_ENTRIES, MAX_TRIAGE_TEXT } from '../../common/managed/triage.ts'
import { fetchReportTriage, pushReportTriage } from './client-managed.js'
import { render } from './render.js'

const PUSH_DEBOUNCE_MS = 500
// The request body's fixed part around the entries: `{"entries":{}}`.
const BODY_OVERHEAD_BYTES = 14

// Wire projection of a triage entry — the four server-persisted fields, empty
// fields omitted. Returns null when nothing server-relevant remains (which
// pushes as a clear). Applied to SERVER values too, so a hydrated entry can't
// smuggle unexpected fields into the local map.
function wireEntryOf(entry) {
  if (!entry) return null
  const out = {}
  if (entry.color) out.color = entry.color
  const bucket = bucketOf(entry)
  if (bucket) out.triage = bucket
  if (typeof entry.fix === 'string' && entry.fix) out.fix = entry.fix
  if (typeof entry.flagged === 'boolean') out.flagged = entry.flagged
  return Object.keys(out).length > 0 ? out : null
}

// Canonical comparison key for a wire entry; '' = no entry, so "unknown to the
// server" and "cleared" compare equal.
function wireKey(e) {
  return e == null ? '' : JSON.stringify([e.color ?? '', e.triage ?? '', e.fix ?? '', e.flagged])
}

// Whether the server would accept this entry as sent (its per-entry caps —
// parseTriageEntryPatch's — and the finding-id length).
function fitsWire(id, wire) {
  if (id.length > MAX_FINDING_ID) return false
  if (wire == null) return true
  return (wire.color?.length ?? 0) <= MAX_TRIAGE_COLOR
    && (wire.fix?.length ?? 0) <= MAX_TRIAGE_TEXT
}

const utf8Length = (s) => new TextEncoder().encode(s).length

// What the server is known to hold, per finding id (wireKey strings): learned
// from every GET and advanced by every landed push, across reports — the ids
// are the same everywhere. An edit is whatever differs from it; an id absent
// here is one the server has never been seen to hold.
const baseline = new Map()

// Reports whose GET has been adopted — pushes for a report wait for its
// hydrate, so nothing goes up before the server's copy has been read.
const hydratedReports = new Set()

// The edits captured since they last landed, per report id: the report they
// were made in (the endpoint they go to) and the wire entries (null = clear)
// by finding id. Captured at edit time, so neither a view switch nor the next
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

function activeManagedReports() {
  if (Array.isArray(state.managedReports) && state.managedReports.length > 0) return state.managedReports
  return state.managedReport == null ? [] : [state.managedReport]
}

function findingIdsForManagedReport(reportId) {
  const ids = new Set()
  let matched = false
  for (const report of state.reports) {
    if (report._managedReportId !== reportId) continue
    matched = true
    for (const group of report.groups ?? []) {
      for (const finding of group) if (typeof finding.id === 'string' && finding.id) ids.add(finding.id)
    }
  }
  // A single-report open predates the source-id stamp; its loaded findings
  // are the complete scope for the active report.
  return matched || state.reports.length === 0 ? ids : new Set(loadedFindingIds())
}

function reportForFinding(id) {
  const active = activeManagedReports()
  for (const report of state.reports) {
    if (report._managedReportId == null) continue
    if ((report.groups ?? []).some((group) => group.some((finding) => finding.id === id))) {
      const match = active.find((candidate) => candidate.id === report._managedReportId)
      if (match) return match
    }
  }
  return active[0] ?? null
}

function canPushTriage() {
  const session = state.managedSession
  return state.serverMode === 'managed' && state.localMode !== true
    && session != null && roleAtLeast(session.role, 'triage')
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
    q = { report: p.report, changes: new Map() }
    pending.set(p.report.id, q)
  }
  for (const id of ids) if (!q.changes.has(id)) q.changes.set(id, p.changes.get(id))
}

async function flush(p) {
  if (!canPushTriage()) return
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
    for (const id of Object.keys(batch)) baseline.set(id, wireKey(batch[id]))
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
// outside an open, hydrated team report; otherwise capture the edits now and
// debounce the send, so a burst (kanban drag, comment typing) collapses into
// one POST.
function scheduleTriagePush() {
  const active = activeManagedReports()
  if (active.length === 0 || !canPushTriage() || hydratedReports.size === 0) return
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
    const report = reportForFinding(id)
    if (report == null || !hydratedReports.has(report.id)) continue
    let q = pending.get(report.id)
    if (q == null) {
      q = { report, changes: new Map() }
      pending.set(report.id, q)
    }
    q.changes.set(id, wire)
  }
  if (pending.size === 0) return
  if (pushTimer != null) clearTimeout(pushTimer)
  pushTimer = setTimeout(flushPending, PUSH_DEBOUNCE_MS)
}

// Register the managed triage change-notifier. Called after the
// session probe; skipped for roles below 'triage' (their reads still hydrate,
// they just have nothing to fan out) and outside managed mode, where the slot
// local notifier belongs to the e2e sync client.
let registered = false
export function initManagedTriagePush() {
  if (registered || !canPushTriage()) return
  registered = true
  setManagedTriageChangeNotifier(scheduleTriagePush)
}

// A managed → local transition invalidates the open server scope. Drop the
// debounce queue and hydration baseline immediately so a timer from the old
// report cannot write after the local surface takes over, and a later managed
// visit starts from fresh server state.
export function resetManagedTriage() {
  state.managedComments?.clear()
  globalThis.document?.dispatchEvent(new Event('managed-comments-reset'))
  if (pushTimer != null) { clearTimeout(pushTimer); pushTimer = null }
  pending.clear()
  hydratedReports.clear()
  baseline.clear()
}

// Merge the server's entries for a just-opened team report's findings into
// `state.triage`. The trusted server wins wholesale per id it knows — a value,
// or null for a cleared entry (its tombstone), which clears the local one —
// except the client-local fields: `ignoredReports`, preserved unless the
// server entry carries a triage bucket (the triage⊻ignore mutex, mirroring
// applyTriageEntries), and `upstream`, preserved outright. Ids the server
// has never seen keep their local entry, which the follow-up push carries
// up: the user's triage of those findings, never uploaded. Pushes for the
// report wait for this to finish. Returns true only when the server state
// was adopted and this is still the active view.
export async function hydrateManagedReportTriage(reportId, { renderView = true } = {}) {
  const reports = state.reports
  const isCurrent = () => state.serverMode === 'managed' && state.localMode !== true
    && state.managedSession != null && state.reports === reports
    && activeManagedReports().some((report) => report.id === reportId)
  if (!isCurrent()) return false
  hydratedReports.delete(reportId)
  // Whatever is still pending goes first, and lands before the server copy is
  // read — so an edit made moments ago is what "server wins" then confirms,
  // not what it reverts.
  flushPending()
  await flushChain
  if (!isCurrent()) return false
  const entries = await fetchReportTriage(reportId)
  // Bail when the fetch failed or the user already navigated elsewhere.
  if (entries == null || !isCurrent()) return false
  let changed = false
  const reportFindingIds = findingIdsForManagedReport(reportId)
  for (const id of reportFindingIds) {
    if (!Object.hasOwn(entries, id)) {
      // Never seen by the server: whatever the baseline remembered is stale.
      baseline.delete(id)
      continue
    }
    const wire = wireEntryOf(entries[id])
    baseline.set(id, wireKey(wire))
    const local = state.triage.get(id)
    const ignoredReports = wire?.triage == null ? local?.ignoredReports : undefined
    // `upstream` rides no wire either, and unlike the ignore it has no mutex
    // to lose it to: what a dependency's maintainers did is a fact about that
    // code, which this report's triage bucket has no opinion about. Carried
    // across the replace whatever the server says, including a tombstone —
    // its clear is of the entry the server keeps, not of a record it has
    // never held.
    if (setEntry(state.triage, id, { ...wire, ignoredReports, upstream: local?.upstream })) changed = true
  }
  hydratedReports.add(reportId)
  if (changed) {
    // Notify the managed push and repaint the imperatively-rendered
    // surfaces (kanban, toolbar counts) that don't observe state.triage; the
    // save's notifier then pushes what the server hasn't seen.
    await saveTriage()
    if (!isCurrent()) return false
    if (renderView) render()
  }
  // Catch edits made while GET was pending even when no server entries
  // changed. Team loading defers paint until every report has hydrated.
  scheduleTriagePush()
  return true
}
