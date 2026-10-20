import { state } from '#client/index.js'
import { store } from '@rray/frontend/state-management'
import { reportEntries } from '@preventive/report'
import { setManagedWorkspace } from '../../client/managed/workspace.js'
import { FINDING_DETAIL_FIELDS } from '../../common/managed/finding-detail.js'
import { forgetFindingText } from './format.js'
import { clearMergedGroups, getRevalidationConflicts } from './group.js'
import { showToast } from './toast.js'

// A team's board is drawn from its reports without their findings' detail
// (`lite`), the whole reports asked for beside them (ingest.js
// switchToManagedTeam). Until they are in, a popup, a view mode other than
// the board and an export wait for them (render.js, events.js); once in,
// each finding is filled in where it is, or, where the board's copy left
// rows out (App mode's, common/managed/finding-detail.js), the whole reports
// are ingested in its place; and the team's finding index
// (client/managed/workspace.js) built again from them.
let current = null

// Whether the loaded reports are those the details are for, or are being
// ingested in their place.
const awaited = () => current !== null && (current.replacing || current.reports === store(state.reports))

// What a view needing the loaded findings' detail shows in its place: null
// once they have it, or need none; 'loading' while it comes; 'failed' where
// it never will.
export function managedDetailsWaiting() {
  if (!awaited() || current.ok) return null
  return current.done ? 'failed' : 'loading'
}

// Whether the whole reports are being ingested in place of the board's copy:
// the view is held as it was meanwhile (render.js).
export function managedDetailsReplacing() {
  return current?.replacing === true
}

// Whether the loaded reports' findings have their detail, once they have it
// or never will: false for a team's whose request failed.
export function managedDetailsReady() {
  return awaited() ? current.ready : Promise.resolve(true)
}

// How the board's copy of the loaded reports left out rows App mode does not
// show (common/managed/finding-detail.js liteWorkspace), until the whole
// reports are in: 'rows', those beneath App rows, which a lens other than
// App's waits for (render.js); 'app', all but those its App view shows, which
// any other view waits for; false where it left out none.
export function managedDetailsFolded() {
  return awaited() && !current.ok && current.folded
}

// Meanwhile, what the rows left out tell the whole team's view offers beside
// its App view (common/managed/team-app.js managedTeamLens), or null.
export function managedDetailsLens() {
  return managedDetailsFolded() ? current.lens ?? null : null
}

// Settles true once `shown`, the view standing, false once `signal` aborts.
function standing(shown, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return }
    signal?.addEventListener('abort', () => resolve(false), { once: true })
    shown.then(resolve, () => resolve(false))
  })
}

// Fills the loaded reports' findings in from `request`'s whole reports, then
// `loaded()`, as long as they are still loaded. Whole reports not holding the
// same findings, as where the board's copy was `folded`, are ingested in
// their place once the view is `shown`, by `replace(workspace)`, true once it
// stands; ones that fail, or cannot be ingested, leave the board as it is,
// telling so. A view left before then waits for nothing.
export function awaitManagedDetails(teamId, request, loaded, { folded = false, lens = null, shown = Promise.resolve(true), signal, replace } = {}) {
  const entry = current = { reports: store(state.reports), folded, lens, done: false, ok: false, replacing: false, ready: null }
  const loadedStill = () => current === entry && store(state.reports) === entry.reports
  entry.ready = (async () => {
    const workspace = await Promise.resolve(request).catch(() => null)
    const fill = loadedStill() && workspace && detailsFill(entry.reports, workspace)
    if (fill) fill()
    else if (loadedStill() && workspace && replace) {
      if (!await standing(shown, signal) || !loadedStill()) { entry.done = true; return false }
      entry.replacing = true
      try { entry.ok = await replace(workspace) } catch { entry.ok = false } finally { entry.replacing = false }
      if (entry.ok) entry.reports = store(state.reports)
    }
    entry.done = true
    if (!loadedStill()) return false
    if (fill || entry.ok) {
      entry.ok = true
      setManagedWorkspace(teamId, workspace)
      // Merged rows are copies of their findings, built again with the
      // detail; copies disagreeing on what the revalidation pass said are told
      // apart by its prose alone (common/finding-duplicates.js).
      clearMergedGroups()
      state.revalidateConflicts = getRevalidationConflicts()
    } else showToast('Could not load finding details. Open the team again to retry.')
    loaded()
    return entry.ok
  })()
}

// Fills each ingested finding (ingest.js ingestReport) from its report's
// entry's member at the same place, non-empty entries alone. None where a
// loaded report or finding has no match, as when a report changed between the
// two reads: findings are filled all together, or not at all.
function detailsFill(reports, workspace) {
  const whole = new Map(workspace.map(report => [report.id, report.data]))
  const pairs = []
  for (const report of reports) {
    const entries = reportEntries(whole.get(report._managedReportId))
    if (!entries) return null
    const groups = entries.map(entry => Array.isArray(entry) ? entry : [entry]).filter(group => group.length > 0)
    if (groups.length !== report.groups.length) return null
    for (const [index, group] of report.groups.entries()) {
      if (groups[index].length !== group.length) return null
      for (const [member, finding] of group.entries()) {
        const detail = groups[index][member]
        if (detail?.id !== finding.id) return null
        pairs.push([finding, detail])
      }
    }
  }
  return () => {
    for (const [finding, detail] of pairs) {
      for (const field of FINDING_DETAIL_FIELDS) if (Object.hasOwn(detail, field)) finding[field] = detail[field]
      forgetFindingText(finding)
    }
  }
}
