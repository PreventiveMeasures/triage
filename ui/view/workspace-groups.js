import { revalidateKindOf } from '../../report/index.js'
import { mergeReportDuplicateFields } from './finding-duplicates.js'
import { splitRevalidationInputs } from './revalidation-input-groups.js'

// Reports retain their original rows. Merge only this derived view, so two
// application findings that refer to the same source issue keep their own
// context, verdicts, and tabs. Code mode removes pass findings BEFORE deciding
// which rows may merge; imports from other analyzers remain App findings.
export function mergeReportGroups(reports, { showRevalidation = true, upstreamOnly = false, hideRuledOut = false, merges = [] } = {}) {
  const rows = []
  for (let reportIndex = 0; reportIndex < reports.length; reportIndex++) {
    const report = reports[reportIndex]
    for (const original of report.groups) {
      // Visibility precedes merging: a hidden answer from another app must
      // neither cause a conflict nor gap-fill the answer the reader will see.
      const kept = upstreamOnly
        ? original.filter((f) => f.isUpstream && revalidateKindOf(f) !== 'revalidation').map(withoutRevalidation)
        : showRevalidation
        ? hideRuledOut
          ? original.filter((f) => !['refuted', 'unreachable'].includes(revalidateKindOf(f)))
          : original
        : original.filter((f) => revalidateKindOf(f) !== 'revalidation').map(withoutRevalidation)
      const group = kept.length === original.length && kept.every((f, i) => f === original[i]) ? original : kept
      if (group.length > 0) rows.push({ group, sourceGroup: original, reportIndex, reportName: report.fileName ?? '', hasApp: group.some((f) => f.isApp) })
    }
  }
  const parent = rows.map((_, i) => i)
  const hasApp = rows.map((r) => r.hasApp)
  const find = (i) => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    while (parent[i] !== root) { const next = parent[i]; parent[i] = root; i = next }
    return root
  }
  const union = (a, b) => {
    a = find(a); b = find(b)
    if (a === b) return
    parent[b] = a
    hasApp[a] ||= hasApp[b]
  }
  const byId = new Map()
  for (let i = 0; i < rows.length; i++) {
    for (const f of rows[i].group) {
      if (!f.id) continue
      if (!byId.has(f.id)) byId.set(f.id, [])
      byId.get(f.id).push({ index: i, app: f.isApp })
    }
  }
  // App identities and within-report overlaps establish their components first.
  // Otherwise a source-only row could bridge two App rows through another report.
  for (const occurrences of byId.values()) {
    const ownReports = new Map()
    const app = occurrences.find((entry) => entry.app)
    for (const { index } of occurrences) {
      if (app) union(app.index, index)
      const reportIndex = rows[index].reportIndex
      if (ownReports.has(reportIndex)) union(ownReports.get(reportIndex), index)
      else ownReports.set(reportIndex, index)
    }
  }
  for (const occurrences of byId.values()) {
    let first = null
    for (const { index } of occurrences) {
      if (hasApp[find(index)]) continue
      if (first === null) first = index
      else union(first, index)
    }
  }
  // Explicit hints are retained for callers supplying already-deduplicated rows.
  // Normal report loading no longer needs them: all original rows are retained.
  for (const merge of merges) {
    let first = null
    for (const id of merge) {
      for (const { index } of byId.get(id) ?? []) {
        if (first === null) first = index
        else union(first, index)
      }
    }
  }
  const components = new Map()
  for (let i = 0; i < rows.length; i++) {
    const root = find(i)
    if (!components.has(root)) components.set(root, [])
    components.get(root).push(rows[i])
  }
  const conflicts = new Map(), groups = []
  for (const component of components.values()) {
    const original = component[0].group
    const ids = original.map((f) => f.id).filter(Boolean)
    if (component.length === 1 && new Set(ids).size === ids.length && merges.length === 0) {
      const app = reports.length > 1 && original.find((f) => f.isApp)
      if (app) {
        const group = [...original]
        group.workspaceKey = app.id ?? String(app._id)
        groups.push(...splitOutput(component, group, showRevalidation, upstreamOnly))
      } else groups.push(...splitOutput(component, original, showRevalidation, upstreamOnly))
      continue
    }
    const rowConflicts = new Map()
    const copies = new Map()
    const findings = []
    for (const { group, reportName } of component) {
      for (const f of group) {
        if (f.id && copies.has(f.id)) {
          mergeReportDuplicateFields(copies.get(f.id), f, reportName, rowConflicts)
        } else {
          // Only the derived copy receives gap fills and per-report variants.
          const copy = { ...f, _reportName: f._reportName ?? reportName }
          if (f.id) copies.set(f.id, copy)
          findings.push(copy)
        }
      }
    }
    // Combined rows carry the author's order; singleton load order does not.
    const canonical = new Set()
    for (const merge of merges) for (const id of merge) if (copies.has(id)) canonical.add(id)
    for (const { group } of component) {
      if (group.length > 1) for (const f of group) if (f.id) canonical.add(f.id)
    }
    const group = [...canonical].map((id) => copies.get(id))
    for (const f of findings) if (!canonical.has(f.id)) group.push(f)
    // Separate App rows can begin with the SAME source id. Give each row its
    // App identity so Lit keys, selection, and popup close targets stay unique.
    if (reports.length > 1) {
      const app = group.find((f) => f.isApp)
      if (app) group.workspaceKey = app.id ?? String(app._id)
    }
    groups.push(...splitOutput(component, group, showRevalidation, upstreamOnly))
    for (const [id, conflict] of rowConflicts) {
      const previous = conflicts.get(id)
      conflicts.set(id, previous
        ? { finding: previous.finding, copies: [...previous.copies, ...conflict.copies] }
        : conflict)
    }
  }
  return { groups, conflicts }
}

function splitOutput(component, group, keepAppLayer, upstreamOnly) {
  if (keepAppLayer) return [group]
  if (upstreamOnly) {
    // Upstream projection removes the App and own-source members before this
    // function runs. Reconstruct the complete source component first so an
    // App's inputs outside the upstream lens still determine its partition.
    const complete = component.flatMap((row) => row.sourceGroup)
    const partitions = splitRevalidationInputs(complete)
    if (partitions.length === 1) return [group]
    const projected = []
    const covered = new Set()
    for (const partition of partitions) {
      const ids = new Set(partition.filter((f) => !f.isApp && f.id).map((f) => f.id))
      const visible = group.filter((f) => ids.has(f.id))
      if (visible.length > 0) {
        projected.push(visible)
        for (const finding of visible) covered.add(finding.id)
      }
    }
    const groupIds = new Set(group.map((f) => f.id).filter(Boolean))
    return covered.size === groupIds.size ? projected : [group]
  }
  const appFindings = component.flatMap((row) => row.sourceGroup.filter((f) => f.isApp))
  return splitRevalidationInputs(group, appFindings)
}

function withoutRevalidation(finding) {
  const fields = Object.keys(finding).filter((key) => key.startsWith('revalidate') || key === '_revalidationCopies')
  if (fields.length === 0) return finding
  const copy = { ...finding }
  for (const field of fields) delete copy[field]
  return copy
}
