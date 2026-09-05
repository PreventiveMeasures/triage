// The "Download report" button's adapter: reads the viewer — which
// findings are on screen, what the reader wrote on them, where their
// locations link, which report each came from — and hands the plain
// facts to formats/, which writes the document. Nothing about markdown
// lives here.
//
// The set is the on-screen one: the active triage bucket (live, or a
// trash bucket) narrowed by the toolbar filters, over the MERGED groups
// the views render (a workspace's cross-report duplicates as one
// finding with several cases), in the current sort order — so the file
// matches what the reader sees, and what the confirmation dialog
// counted: export-summary.js supplies both the bucket and the filter
// descriptions, so the dialog and the document's header say the same
// thing.

import { listWorkspaces, state } from '#client/index.js'
import { downloadBlob } from './dom.js'
import { exportBucketGroups, exportSelectionSummary } from './export-summary.js'
import { applyFilters, applySorting } from './filters.js'
import { commitUrl, commonPrefix, evidenceUrl, findingUrl, hasRevalidateField, hasSeverityCorrection, isModule } from './format.js'
import { findingRepoFallback, isIgnored, sortTabs, tabKey } from './group.js'
import { findingsToMarkdown } from '../../formats/index.js'

// The on-screen groups in on-screen order, each group's cases in the
// order the card's tab strip shows them (the revalidation row first,
// then the annotated ones, then by severity and confidence — group.js
// sortTabs), so the document's primary case is the card's.
function visibleGroups() {
  return applySorting(applyFilters(exportBucketGroups())).map((g) => sortTabs(g))
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
    return {
      triage: entry?.triage,
      color: entry?.color,
      comment: entry?.comment,
      fix: entry?.fix,
      flagged: entry?.flagged === true,
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
// follows. A mixed load gets none; each finding then names its own on
// its meta line.
function documentRepo(reports, groups) {
  const declared = new Set(reports.map((r) => r.repo).filter(Boolean))
  if (declared.size > 0) return declared.size === 1 ? [...declared][0] : null
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
  const groups = visibleGroups()
  const summary = exportSelectionSummary('download')
  const workspace = currentWorkspace()
  // The lens and the layer are named in the header only where they
  // change what the document says: a set with no severity correction
  // reads the same under either lens, and one with no revalidation
  // stamp is the code view already. Scanned over the full loaded set,
  // like the toolbar controls they describe.
  const loaded = reports.flatMap((r) => r.groups ?? [])
  const hasCorrections = loaded.some((g) => g.some(hasSeverityCorrection))
  const hasRevalidation = loaded.some((g) => g.some(hasRevalidateField))
  return findingsToMarkdown({
    title: documentTitle(reports, workspace),
    workspace: workspace?.name ?? null,
    reports: reports.map((r) => ({ name: r.fileName, source: r.source })),
    repo: documentRepo(reports, groups),
    generatedAt: new Date(),
    view: {
      bucket: summary.bucketLabel,
      severityMode: hasCorrections ? state.severityMode : null,
      revalidation: hasRevalidation ? state.showRevalidation : null,
    },
    filters: summary.filters,
    counts: { included: summary.included, total: summary.total },
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
