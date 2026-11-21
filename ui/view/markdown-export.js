// The "Download report" button's adapter: the viewer's facts (the findings
// on screen, the reader's annotations, where locations link, each one's
// report) handed to the report library's writer (@preventive/report
// write-md.js); nothing about markdown lives here.
//
// The set is the on-screen one — the triage bucket narrowed by the
// filters, over the MERGED groups, in the current sort — with the bucket
// and filter descriptions from export-summary.js, so the file, its header
// and the confirmation dialog agree. A filter that dialog dropped is
// installed as an override around this call (events.js), and the header
// describes the selection the file was written under.

import { listWorkspaces, state } from '#client/index.js'
import { downloadBlob } from './dom.js'
import { activeFilterDescriptions, exportBucketGroups, exportBucketLabel } from './export-summary.js'
import { activeFilters, applyFilters, applySorting } from './filters.js'
import { commitUrl, commonPrefix, evidenceUrl, findingUrl, hasRevalidateField, hasSeverityCorrection, isModule } from './format.js'
import { activeTabFor, findingRepoTarget, isIgnored, sortTabs, triageEntry, underlyingFindingsShown } from './group.js'
import { writeMarkdown } from '@preventive/report'

// The bucket's groups the selection lets through, in on-screen order, each
// one's cases in its card's tab order (group.js sortTabs), so the
// document's primary case is the card's; or only the card's active one.
function visibleGroups(bucket, oneSamplePerGroup) {
  return applySorting(applyFilters(bucket)).map((g) => oneSamplePerGroup ? [activeTabFor(g)] : sortTabs(g))
}

// The answers only the viewer has: links as the card resolves them
// (format.js, against the repo stamped at ingest), and annotations off
// the triage entry — findings carry no `fix` or `comment` field, ever.
const HOOKS = {
  annotation(f) {
    const entry = triageEntry(f)
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
  location: (f) => findingUrl(f, findingRepoTarget(f)),
  evidence: (row, f, i) => evidenceUrl(row, f, findingRepoTarget(f), i),
  commit: (f) => commitUrl(f.repo?.github, f.commitHash),
  report: (f) => f._reportName ?? null,
}

// The repository the document is about, the header repo chip's
// precedence: what EVERY loaded report declares alike (one declaring none
// disagrees too), else the one repo every own-source finding agrees on,
// else the URL typed into the chip; none for genuinely mixed repos.
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

// `shipped(f, row)` places a finding's evidence in a dependency where its
// bundle records the package (focus-code.js bundleDependencyRepo), as the
// card does; the caller hands it in, so this module loads no view code.
export function reportsToMarkdown({ oneSamplePerGroup = false, shipped = null } = {}) {
  const hooks = shipped ? { ...HOOKS, evidence: (row, f, i) => evidenceUrl(row, f, findingRepoTarget(f), i, (r) => shipped(f, r)) } : HOOKS
  const reports = state.reports
  // The selection in force (the dialog's relaxed copy, else the toolbar's),
  // the one visibleGroups' `applyFilters` reads: the header describes the
  // pass that picked the findings.
  const fields = activeFilters()
  const bucket = exportBucketGroups()
  const groups = visibleGroups(bucket, oneSamplePerGroup)
  const workspace = currentWorkspace()
  // The lens and the layer are named only where they change the document
  // (a correction, a revalidation stamp in the loaded set).
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
      // Which app view built the groups: the simplified one (sortTabs)
      // has folded the re-rated rows under the pass's, and the document
      // says so. Null with the layer off, where the line reads "code view".
      revalidationDetail: hasRevalidation && state.showRevalidation !== false
        ? underlyingFindingsShown()
        : null,
    },
    filters: activeFilterDescriptions(fields),
    counts: { included: groups.length, total: bucket.length },
    groups,
  }, hooks)
}

// The file's name, the print button's heuristic so a PDF and a markdown
// of one view share it: the workspace's, a single report's (`.md` for its
// extension), or a batch's common prefix; characters no filesystem takes
// become hyphens.
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

export function downloadReportsAsMarkdown(options) {
  if (state.reports.length === 0) return
  const blob = new Blob([reportsToMarkdown(options)], { type: 'text/markdown;charset=utf-8' })
  downloadBlob(blob, targetFilename())
}
