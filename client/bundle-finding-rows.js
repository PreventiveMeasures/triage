// Original report rows of the OPFS-wide finding index (bundle-finding-index.js),
// keyed by finding id and by the ids App findings cite. The index walker files
// each row here; a report's rows are dropped together when it is invalidated.
import { findingTitle } from '@preventive/report'
import { isManagedUiMode } from './state.ts'
import { managedRowsCitingIds, managedRowsForIds, managedTitleForId } from './managed/workspace.js'
import { revalidationLinks } from '../common/security-links.js'

// Finding id → `{ reports }`, a Map of report name → { title, rows }.
// Rows retain member ids/titles and source/revalidation metadata, shared by every member's index entry;
// they preserve the report's card boundaries without retaining its full parse.
// Unlike the hash, package and repository buckets this one is
// keyed by the finding's OWN id rather than by something about its
// file, so it answers for every finding an id could name — including
// the ones with no `fileHash` and no package path, which the other
// indexes have nothing to file under. The Links view asks it where the
// findings a links file names actually live, and what they are CALLED,
// which are questions about ids and nothing else.
//
// The title is stored as a string rather than by holding the finding:
// keeping a reference to every finding on disk would pin every
// report's whole parse in memory for the sake of one heading.
//
// It hangs off the REPORT rather than the id, even though one title
// per id would be smaller, because a title has to be one some report
// on this device actually wrote. An explicit `title` is not part of
// what the id is derived from, so two reports carrying the same id can
// word it differently — and pinning the first one seen would leave the
// Links view printing a heading no report still holds once that report
// is deleted or overwritten. Keyed this way the question can't arise:
// a title is dropped by the same `reports.delete` that drops the
// report it came from.
const byId = new Map()
// Input id → report name → the rows whose App findings name that id in
// `revalidateInputs`. The security lens reaches an App row citing a loaded
// finding only through this, when the App report itself is not loaded.
const byInput = new Map()
// Report name → the ids and cited inputs it filed, for the prune.
const keysByName = new Map()

// The OPFS reports carrying the finding with this id, by name. Takes
// an ID, not a finding object, because its caller (the Links view)
// holds nothing but ids — a links file names findings and describes
// none of them. Empty when the id names nothing the user has, which
// is exactly what that view has to be able to say out loud.
export function reportsForFindingId(id) {
  return isManagedUiMode() ? [...new Set(managedRowsForIds([id]).map(row => row.report))] : [...byId.get(id)?.reports.keys() ?? []]
}

// What the finding with this id is called — its own `title`, or the
// first line of its description where the report wrote no title
// (`findingTitle`, the same reading every other surface names a
// finding by). Empty string when no report on this device carries it,
// so a caller can print it unguarded.
//
// The first non-empty one across the reports holding it: they normally
// agree, and where they don't, any of them is a heading some report
// here really wrote, which is the property that matters.
export function findingTitleForId(id) {
  if (isManagedUiMode()) return managedTitleForId(id)
  for (const { title } of byId.get(id)?.reports.values() ?? []) if (title) return title
  return ''
}

// Each original report row containing at least one requested id, once.
// Overlapping rows stay distinct: [A,B] and [A,C] are different cards even
// though both contain A. The returned objects belong to the read-only index.
export function reportRowsForFindingIds(ids) {
  if (isManagedUiMode()) return managedRowsForIds(ids)
  const rows = new Set()
  for (const id of ids) {
    for (const report of byId.get(id)?.reports.values() ?? []) {
      for (const row of report.rows) rows.add(row)
    }
  }
  return [...rows]
}

// Each original report row whose findings name a requested id among their
// `revalidateInputs`, once. Like reportRowsForFindingIds, read-only rows.
export function reportRowsCitingFindingIds(ids) {
  if (isManagedUiMode()) return managedRowsCitingIds(ids)
  const rows = new Set()
  for (const id of ids) {
    for (const reportRows of byInput.get(id)?.values() ?? []) {
      for (const row of reportRows) rows.add(row)
    }
  }
  return [...rows]
}

function keysOf(name) {
  if (!keysByName.has(name)) keysByName.set(name, { ids: new Set(), inputs: new Set() })
  return keysByName.get(name)
}

// Keep the title and original rows for each report carrying a member's id,
// and the row under each id its App findings cite. Returns true when an id
// gains a new report, so attribution changes repaint the views.
export function indexReportRow(name, row) {
  let added = false
  for (const f of row.members) {
    let entry = byId.get(f.id)
    if (!entry) byId.set(f.id, entry = { reports: new Map() })
    const existing = entry.reports.get(name)
    if (existing) { existing.rows.add(row); continue }
    entry.reports.set(name, { title: findingTitle(f), rows: new Set([row]) })
    keysOf(name).ids.add(f.id)
    added = true
  }
  for (const [, ...inputs] of revalidationLinks(row.members)) {
    for (const id of inputs) {
      if (!byInput.has(id)) byInput.set(id, new Map())
      const reports = byInput.get(id)
      if (!reports.has(name)) reports.set(name, new Set())
      reports.get(name).add(row)
      keysOf(name).inputs.add(id)
    }
  }
  return added
}

// Id index — flat, so the prune is too: drop this report from each
// id it contributed, and drop the id itself once no report carries
// it any more (an id nobody holds must read as "not in any of your
// reports", not as an empty set of holders). Its title and original
// row memberships are dropped with the report. True when anything went.
export function dropReportRows(name) {
  const keys = keysByName.get(name)
  keysByName.delete(name)
  if (!keys) return false
  for (const id of keys.ids) {
    const entry = byId.get(id)
    entry?.reports.delete(name)
    if (entry?.reports.size === 0) byId.delete(id)
  }
  for (const id of keys.inputs) {
    const reports = byInput.get(id)
    reports?.delete(name)
    if (reports?.size === 0) byInput.delete(id)
  }
  return true
}
