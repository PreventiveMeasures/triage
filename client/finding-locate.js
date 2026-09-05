// Where does a linked finding actually live? The receiving half of
// `finding-link.js`: turn one half of a `v=` hint pair back into a
// local report name / workspace, and — when it matches nothing, or matches
// something that no longer carries the finding — find the finding by
// scanning what IS stored locally.
//
// Not to be confused with `finding-lookup.js`, which shapes metadata for
// findings ALREADY in `state.reports` (the conflict dialogs). This
// module reaches past the loaded set into OPFS.
//
// Everything here is headless and storage-only; the navigation built on
// top lives in `ui/view/finding-link-nav.js`.
import { computeLinkHint } from './finding-link.js'
import { listFiles, readFile } from './storage.js'
import { listWorkspaces } from './workspaces.js'
import { backfillFindingIds, flattenFindings, parseReport } from '../report/index.js'

// The workspace named by the `v=` workspace half, or null. Hashing
// every local workspace id is a handful of digests over a list that's
// rarely more than a few entries — no storage reads at all.
export async function workspaceForHint(hint) {
  if (!hint) return null
  const workspaces = listWorkspaces()
  const hints = await Promise.all(workspaces.map((w) => computeLinkHint('workspace', w.id)))
  const idx = hints.indexOf(hint)
  return idx === -1 ? null : workspaces[idx]
}

// The report filename named by the `v=` report half, or null. Same
// shape as above and equally cheap: filenames come from the OPFS
// directory listing, so no report is read to answer this.
//
// A 24-bit hint can in principle match two names; the first wins and the
// caller re-checks that the finding is really there, falling back to the
// scan below when it isn't. Being wrong costs a wasted load, never the
// finding.
export async function reportForHint(hint) {
  if (!hint) return null
  const names = await listFiles()
  const hints = await Promise.all(names.map((n) => computeLinkHint('report', n)))
  const idx = hints.indexOf(hint)
  return idx === -1 ? null : names[idx]
}

// Does this stored report carry `id`? Parses with the same helpers the
// triage GC walk uses (`parseReport` → `flattenFindings` →
// `backfillFindingIds`), so a report in any format the app ingests
// answers correctly, including markdown / DeepSec / Piolium reports
// whose ids are derived rather than stamped.
//
// Ordered so the cheap question comes first: reports whose findings
// carry exporter-stamped ids answer on a plain scan, and the crypto
// derivation only runs for the id-less remainder.
async function reportHasFinding(name, id) {
  let content
  try {
    content = await readFile(name)
  } catch {
    // Unlike the GC walk — which keys a destructive decision on its
    // result and so must propagate — a miss here only means "not found
    // in this one". A file deleted by a sibling tab between the listing
    // and the read, or an undecodable blob, shouldn't abort the search
    // across everything else.
    return false
  }
  if (content == null) return false
  const data = parseReport(content)
  // `Array.isArray`, not a truthy check: `parseReport` does no shape
  // validation, so a malformed `findings` (number, plain object) would
  // make `flattenFindings`'s `for…of` throw.
  if (!Array.isArray(data?.findings)) return false
  const findings = flattenFindings(data.findings)
  if (findings.some((f) => f.id === id)) return true
  const idLess = findings.filter((f) => !f.id)
  if (idLess.length === 0) return false
  await backfillFindingIds(idLess)
  return idLess.some((f) => f.id === id)
}

// Find any locally-stored report holding `id`, or null. `skip` names
// reports already known not to have it (typically the ones currently
// loaded, whose in-memory groups were searched first) so they aren't
// re-read.
//
// This reads and parses reports one at a time until it hits, which is
// the expensive path — it exists precisely for the case the cheap ones
// missed: a link whose hint names a report this user doesn't have, but
// whose finding they hold under a different filename (their own export,
// a re-run, a copy attached to their own workspace). Bounded by
// short-circuiting on the first hit, and only ever reached after both
// hints have failed.
export async function findReportWithFinding(id, { skip = [] } = {}) {
  if (!id) return null
  const skipped = new Set(skip)
  const names = (await listFiles()).filter((n) => !skipped.has(n))
  for (const name of names) {
    if (await reportHasFinding(name, id)) return name
  }
  return null
}

// Workspaces that hold `reportName`, in `listWorkspaces` order. Lets the
// caller open a found report in its workspace — the merged view the user
// would normally reach it through — instead of a bare single-file view.
export function workspacesHoldingReport(reportName) {
  if (!reportName) return []
  return listWorkspaces().filter((w) => w.reports.includes(reportName))
}
