import { inheritReportMeta, isAppFinding, loadFindings } from '@preventive/report'
import { dependencyDirectory, isDependencyFile } from './dependency-paths.js'
import { bucketOf, isReportIgnoreScoped, patchEntry, setReportIgnored } from './triage-entry.ts'

// The aggregate index does not use ingest's stamped copies.
export function stampIndexedFindings(findings, data) {
  const directory = dependencyDirectory([{ groups: [findings], tree: data.tree }])
  for (const finding of findings) {
    inheritReportMeta(finding, data)
    finding.isApp ??= isAppFinding(finding, finding.source ?? data.source)
    finding._depsDirectory = directory
  }
}

export function usesReportIgnore(finding, directory) {
  return !(finding.isApp ?? isAppFinding(finding, finding._source ?? finding.source))
    && isDependencyFile(finding.file, finding._depsDirectory ?? directory ?? dependencyDirectory([{ groups: [[finding]] }]))
}

// Shared triage is keyed by finding id, but a shared ignore must not hide a
// dependency occurrence of that same id in another report.
export function sharedFindingTriage(finding, entry, directory) {
  const bucket = bucketOf(entry)
  return bucket === 'ignored' && usesReportIgnore(finding, directory) ? undefined : bucket
}

export function setFindingTriage(map, finding, target, directory) {
  const id = finding.id ?? String(finding._id)
  const report = finding._reportName ?? ''
  const perReport = usesReportIgnore(finding, directory)
  if (perReport && (target === 'ignored' || target === 'untriaged')) {
    // A dependency action must not undo the shared ignore of an App/own row.
    if (bucketOf(map.get(id)) !== 'ignored') patchEntry(map, id, { triage: undefined })
    setReportIgnored(map, id, report, target === 'ignored', true)
  } else {
    patchEntry(map, id, { triage: target === 'untriaged' ? undefined : target })
    // A report can hold a dependency copy of this same App/own-code id.
    // Shared ignore/restore must leave that independent report scope alone.
    if (target !== 'ignored' && target !== 'untriaged') setReportIgnored(map, id, report, false)
  }
}

// Only migrate a named report's occurrence once we have its classification.
// Unknown/deleted reports retain their keys; another saved bucket always wins.
export function migrateIgnoredReports(map, reports) {
  if (![...map.values()].some(entry => entry?.ignoredReports?.length)) return false
  let changed = false
  for (const report of reports) {
    const directory = dependencyDirectory([report])
    const findings = (report.groups ?? []).flat()
    const classified = finding => ({ ...finding, _source: finding._source ?? finding.source ?? report.source })
    const dependencyIds = new Set(findings.filter(f => usesReportIgnore(classified(f), directory)).map(f => f.id ?? String(f._id)))
    for (const finding of findings) {
      const id = finding.id ?? String(finding._id)
      const name = finding._reportName ?? report.name ?? report.fileName ?? ''
      const entry = map.get(id)
      if (!entry?.ignoredReports?.includes(name)) continue
      if (isReportIgnoreScoped(entry, name)) continue
      if (usesReportIgnore(classified(finding), directory)) continue
      if (!bucketOf(entry)) changed = patchEntry(map, id, { triage: 'ignored' }) || changed
      // A single report can contain both App and dependency copies of an id.
      if (!dependencyIds.has(id)) changed = setReportIgnored(map, id, name, false) || changed
    }
    // Persist classification after promoting legacy App/own copies. Otherwise
    // a retained dependency ignore would re-ignore a restored shared copy on
    // the next render, save, reload, or import.
    for (const finding of findings) {
      if (!usesReportIgnore(classified(finding), directory)) continue
      const id = finding.id ?? String(finding._id)
      const name = finding._reportName ?? report.name ?? report.fileName ?? ''
      if (map.get(id)?.ignoredReports?.includes(name)) changed = setReportIgnored(map, id, name, true, true) || changed
    }
  }
  return changed
}

// Migrate a detached snapshot for import without hydrating the local map into
// managed state. Read only report names referenced by legacy ignores.
export async function readIgnoredReportContexts(entries, readReport) {
  const names = new Set(Object.values(entries ?? {}).flatMap(entry => Array.isArray(entry?.ignoredReports)
    ? entry.ignoredReports.filter(name => typeof name === 'string' && !isReportIgnoreScoped(entry, name)) : []))
  const reports = []
  for (const name of names) {
    let report
    try {
      const content = await readReport(name)
      if (typeof content !== 'string') continue
      report = await loadFindings(content)
    } catch { continue } // Unavailable reports can be migrated when they return.
    if (!report) continue
    reports.push({ ...report.data, name, groups: [report.findings] })
  }
  return reports
}

export async function migrateStoredIgnores(entries, readReport) {
  if (entries != null && (typeof entries !== 'object' || Array.isArray(entries))) return { entries, changed: false }
  const map = new Map(Object.entries(entries ?? {}))
  const reports = await readIgnoredReportContexts(entries, readReport)
  const changed = migrateIgnoredReports(map, reports)
  return { entries: Object.fromEntries(map), changed }
}
