// The "Download report" button's adapter: reads the viewer — which
// findings are on screen, what the reader wrote on them, where their
// locations link, which report each came from — and hands the plain
// facts to the report library's writer (report/src/write-md.js). Nothing
// about markdown lives here.
//
// The set is the on-screen one: the active triage bucket (live, or a
// trash bucket) narrowed by the toolbar filters, over the MERGED groups
// the views render (a workspace's cross-report duplicates as one
// finding with several cases), in the current sort order — so the file
// matches what the reader sees, and what the confirmation dialog
// counted: export-summary.js supplies both the bucket and the filter
// descriptions, so the dialog and the document's header say the same
// thing. When that dialog dropped a filter from the export, the relaxed
// selection is installed as a filter override around this call
// (events.js), and the header describes that selection — the one the
// file was actually written under — rather than the toolbar's.

import { appTriageOf, listWorkspaces, state } from '#client/index.js'
import { downloadBlob } from './dom.js'
import { activeFilterDescriptions, exportBucketGroups, exportBucketLabel } from './export-summary.js'
import { activeFilters, applyFilters, applySorting } from './filters.js'
import { commitUrl, commonPrefix, evidenceUrl, findingUrl, hasRevalidateField, hasSeverityCorrection, isModule } from './format.js'
import { findingRepoFallback, isIgnored, scopedApps, sortTabs, tabFix, tabKey, tabTriage } from './group.js'
import { writeMarkdown } from '../../report/index.js'

// The bucket's groups the selection in force lets through, in on-screen
// order, each group's cases in the order the card's tab strip shows
// them (the revalidation row first, then the annotated ones, then by
// severity and confidence — group.js sortTabs), so the document's
// primary case is the card's.
function visibleGroups(bucket) {
  return applySorting(applyFilters(bucket)).map((g) => sortTabs(g))
}

// The answers only the viewer has. Links resolve the way the card's
// do (format.js findingUrl / evidenceUrl / commitUrl, against the
// per-report repo the finding was stamped with at ingest); annotations
// come off the finding's triage entry, not the finding — findings
// carry no `fix` or `comment` field, ever.
const HOOKS = {
  annotation(f) {
    const entry = state.triage.get(tabKey(f))
    const ignored = isIgnored(f)
    if (!entry && !ignored) return null
    // The bucket and the fix link as the CARD shows them — this app's
    // answer where it gave one, the entry's otherwise (`tabTriage` /
    // `tabFix`) — so the document and the board can't disagree about
    // a finding. `app` names the app when the answer was that app's,
    // which is what stops the written line from reading as a claim
    // about the dependency itself; `upstream` carries the other
    // track, which IS such a claim and says so.
    const bucket = tabTriage(f, entry)
    // Name every app whose own slot carries the bucket the document is
    // about to write — one for the ordinary case, several where a
    // workspace deduplicated one dependency finding across apps and
    // they all answered together. Absent when the bucket came off the
    // entry's unscoped verdict, which names no app because none was
    // recorded.
    const apps = scopedApps(f).filter((app) => appTriageOf(entry, app) === bucket)
    return {
      triage: bucket === 'ignored' ? undefined : bucket,
      app: apps.length > 0 ? apps.join(', ') : undefined,
      color: entry?.color,
      comment: entry?.comment,
      fix: tabFix(f, entry) || undefined,
      flagged: entry?.flagged === true,
      upstream: entry?.upstream,
      ignored,
    }
  },
  location: (f) => findingUrl(f, findingRepoFallback(f)),
  evidence: (row, f, i) => evidenceUrl(row, f, findingRepoFallback(f), i),
  commit: (f) => commitUrl(f.repo?.github, f.commitHash),
  report: (f) => f._reportName ?? null,
}

// The repository the document is about, when there is one answer:
// what every loaded report declares (its own `repo.github`), else the
// one repo every own-source finding agrees on, else the URL typed into
// the header chip — the same precedence the page header's repo chip
// follows. A declaration speaks for the document only when EVERY
// loaded report makes the same one: a report declaring none disagrees
// as much as one naming another slug (one report's declaration says
// nothing about the others' findings), and a mixed load falls through
// to what the findings agree on — which is nothing for genuinely mixed
// repos, each finding then naming its own on its meta line.
function documentRepo(reports, groups) {
  const declared = new Set(reports.map((r) => r.repo ?? null))
  const agreed = declared.size === 1 ? [...declared][0] : null
  if (agreed) return agreed
  const own = new Set()
  for (const g of groups) {
    for (const f of g) if (f.repo?.github && !isModule(f.file)) own.add(f.repo.github)
  }
  if (own.size === 1) return [...own][0]
  if (own.size === 0 && !state.currentWorkspace && state.repoUrl) return state.repoUrl
  return null
}

// `.json` / `.md` / `.codex` say how a report arrived, not what it is
// called.
function stripReportExtension(name) {
  return name.replace(/\.(?:json|md|codex)$/iu, '')
}

function currentWorkspace() {
  if (!state.currentWorkspace) return null
  return listWorkspaces().find((w) => w.id === state.currentWorkspace) ?? null
}

// The document's H1: the workspace's name, a single report's own, or
// what a batch of reports shares — the print button's title heuristic.
function documentTitle(reports, workspace) {
  if (workspace) return workspace.name
  const names = reports.map((r) => r.fileName)
  if (names.length === 1) return stripReportExtension(names[0])
  const prefix = commonPrefix(names).replace(/[-_. ]+$/u, '')
  return prefix || `${names.length} reports`
}

export function reportsToMarkdown() {
  const reports = state.reports
  // The selection in force — the confirm dialog's relaxed copy while an
  // export runs under one, the toolbar's otherwise. The same one the
  // `applyFilters` pass inside visibleGroups reads, so the header
  // describes exactly the pass that picked the findings, and the counts
  // are that pass's.
  const fields = activeFilters()
  const bucket = exportBucketGroups()
  const groups = visibleGroups(bucket)
  const workspace = currentWorkspace()
  // The lens and the layer are named in the header only where they
  // change what the document says: a set with no severity correction
  // reads the same under either lens, and one with no revalidation
  // stamp is the code view already. Scanned over the full loaded set,
  // like the toolbar controls they describe.
  const loaded = reports.flatMap((r) => r.groups ?? [])
  const hasCorrections = loaded.some((g) => g.some(hasSeverityCorrection))
  const hasRevalidation = loaded.some((g) => g.some(hasRevalidateField))
  return writeMarkdown({
    title: documentTitle(reports, workspace),
    workspace: workspace?.name ?? null,
    reports: reports.map((r) => ({ name: r.fileName, source: r.source })),
    repo: documentRepo(reports, groups),
    generatedAt: new Date(),
    view: {
      bucket: exportBucketLabel(),
      severityMode: hasCorrections ? state.severityMode : null,
      revalidation: hasRevalidation ? state.showRevalidation : null,
      // Which app view the groups above were built in: `visibleGroups`
      // takes each group's cases through sortTabs, so the simplified
      // one has already folded the rows the pass re-rated under its
      // own — the document says so rather than leaving a reader to
      // wonder where a case they remember went. Null with the layer
      // off, where the fold is inert and the line reads "code view".
      revalidationDetail: hasRevalidation && state.showRevalidation !== false
        ? state.revalidationDetailed === true
        : null,
    },
    filters: activeFilterDescriptions(fields),
    counts: { included: groups.length, total: bucket.length },
    groups,
  }, HOOKS)
}

// The file's name: the workspace's, a single report's own (its
// extension traded for `.md`), or the common prefix of a batch — the
// print button's heuristic, so a PDF and a markdown of the same view
// sit side by side under one name. Characters no filesystem takes in
// a name (a workspace can be called anything) become hyphens.
export function targetFilename() {
  const workspace = currentWorkspace()
  const names = state.reports.map((r) => r.fileName)
  let base = ''
  if (workspace) base = workspace.name
  else if (names.length === 1) base = stripReportExtension(names[0])
  else if (names.length > 1) base = stripReportExtension(commonPrefix(names))
  base = base.replaceAll(/[\\/:*?"<>|\p{Cc}]/gu, '-').trim()
  return `${base || 'deepview-report'}.md`
}

export function downloadReportsAsMarkdown() {
  if (state.reports.length === 0) return
  const blob = new Blob([reportsToMarkdown()], { type: 'text/markdown;charset=utf-8' })
  downloadBlob(blob, targetFilename())
}
