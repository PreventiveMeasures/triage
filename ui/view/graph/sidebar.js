import { esc } from '../format.js'
import { tree } from './state.js'
import {
  packageOf, fileHasFindings, totalFindings, indicatorFor, pkgColor,
} from './utils.js'

// Build the right-sidebar HTML (legend + hubs + node detail).
export function renderTreeSidebarFull(file, treeData, ownCounts, transitiveCounts) {
  const allFiles = Object.keys(treeData)
  const files = tree.showAll
    ? allFiles
    : allFiles.filter((f) => fileHasFindings(f, ownCounts, transitiveCounts))

  const importsOf = new Map()
  const importedBy = new Map()
  for (const f of files) {
    const imps = (treeData[f].imports ?? []).filter((i) => new Set(files).has(i))
    importsOf.set(f, imps)
    for (const imp of imps) {
      if (!importedBy.has(imp)) importedBy.set(imp, [])
      importedBy.get(imp).push(f)
    }
  }

  // Package legend
  const pkgCounts = new Map()
  for (const f of files) {
    const p = packageOf(f) ?? '__own__'
    pkgCounts.set(p, (pkgCounts.get(p) ?? 0) + 1)
  }
  const topPkgs = [...pkgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
  const selectedPkg = file ? (packageOf(file) ?? '__own__') : null

  let html = ''

  // Package legend section
  if (topPkgs.length > 0) {
    html += '<div class="tree-legend">'
    html += '<div class="tree-legend-title">Packages</div>'
    html += '<ul class="tree-legend-list">'
    for (const [pkg, count] of topPkgs) {
      const col = pkgColor(pkg)
      const dimmed = selectedPkg && pkg !== selectedPkg ? ' dimmed' : ''
      const label = pkg === '__own__' ? 'own source' : pkg
      html += `<li class="tree-legend-item${dimmed}" data-pkg-select="${esc(pkg)}">`
      html += `<span class="tree-legend-dot" style="background:${esc(col)}"></span>`
      html += `<span class="tree-legend-name">${esc(label)}</span>`
      html += `<span class="tree-legend-count">${count}</span>`
      html += `</li>`
    }
    html += '</ul></div>'
  }

  // Top hubs section — sorted by issues (own findings) by default.
  // The tab state is stored on the sidebar element via data-hubs-tab.
  const hubsTab = tree.graphState._hubsTab ?? 'issues'

  const hubsByIssues = [...files].sort((a, b) => {
    const ca = totalFindings(ownCounts.get(a)), cb = totalFindings(ownCounts.get(b))
    if (cb !== ca) return cb - ca
    const ia = (importsOf.get(a)?.length ?? 0) + (importedBy.get(a)?.length ?? 0)
    const ib = (importsOf.get(b)?.length ?? 0) + (importedBy.get(b)?.length ?? 0)
    return ib - ia
  }).filter((f) => totalFindings(ownCounts.get(f)) > 0).slice(0, 7)

  const hubsByImports = [...files].sort((a, b) => {
    const ca = (importsOf.get(a)?.length ?? 0) + (importedBy.get(a)?.length ?? 0)
    const cb = (importsOf.get(b)?.length ?? 0) + (importedBy.get(b)?.length ?? 0)
    return cb - ca
  }).slice(0, 7)

  const hubsSorted = hubsTab === 'issues' ? hubsByIssues : hubsByImports

  if (hubsByIssues.length > 0 || hubsByImports.length > 0) {
    html += '<div class="tree-hubs">'
    html += '<div class="tree-hubs-header">'
    html += '<div class="tree-hubs-title">Top hubs</div>'
    html += '<div class="tree-hubs-tabs">'
    html += `<button type="button" class="tree-hubs-tab${hubsTab === 'issues' ? ' active' : ''}" data-hubs-tab="issues">Issues</button>`
    html += `<button type="button" class="tree-hubs-tab${hubsTab === 'imports' ? ' active' : ''}" data-hubs-tab="imports">Imports</button>`
    html += '</div>'
    html += '</div>'
    if (hubsSorted.length === 0) {
      html += '<div style="color:rgba(139,148,158,.35);font-size:.75rem;padding:.2rem .3rem;font-style:italic;">None in current view</div>'
    }
    for (const f of hubsSorted) {
      const col = pkgColor(packageOf(f) ?? '__own__')
      const base = f.split('/').pop() ?? f
      const val = hubsTab === 'issues'
        ? totalFindings(ownCounts.get(f))
        : (importsOf.get(f)?.length ?? 0) + (importedBy.get(f)?.length ?? 0)
      const valColor = hubsTab === 'issues' ? (indicatorFor(ownCounts.get(f)) ?? 'rgba(139,148,158,.45)') : 'rgba(139,148,158,.45)'
      html += `<div class="tree-hub-item" data-select-file="${esc(f)}">`
      html += `<span class="tree-hub-dot" style="background:${esc(col)}"></span>`
      html += `<span class="tree-hub-name">${esc(base)}</span>`
      html += `<span class="tree-hub-conn" style="color:${esc(valColor)}">${val}</span>`
      html += `</div>`
    }
    html += '</div>'
  }

  // Node detail
  if (!file || !treeData[file]) {
    html += '<div class="tree-info-empty"><div class="tree-info-empty-icon">↗</div>Click a node to inspect it</div>'
    return html
  }

  const entry = treeData[file]
  const own = ownCounts.get(file) ?? { critical: 0, high: 0, medium: 0, low: 0 }
  const trans = transitiveCounts.get(file) ?? { critical: 0, high: 0, medium: 0, low: 0 }
  const pkg = packageOf(file) ?? '__own__'
  const pkgCol = pkgColor(pkg)

  const renderChips = (counts) => {
    const present = Object.entries(counts).filter(([, n]) => n > 0)
    if (present.length === 0) return '<div class="tree-info-empty-list">none</div>'
    return '<div class="tree-count-chips">' +
      present.map(([sev, n]) => `<span class="tree-count-chip ${esc(sev)}">${n} ${esc(sev)}</span>`).join('') +
      '</div>'
  }

  const importers = []
  for (const [other, e] of Object.entries(treeData)) {
    if ((e.imports ?? []).includes(file)) importers.push(other)
  }
  importers.sort()
  const imports = (entry.imports ?? []).slice().sort()

  const renderList = (items) => {
    if (items.length === 0) return '<div class="tree-info-empty-list">none</div>'
    let h = '<ul class="tree-info-list">'
    for (const i of items) {
      if (treeData[i]) h += `<li><button type="button" data-select-file="${esc(i)}">${esc(i)}</button></li>`
      else h += `<li><span class="external" title="${esc(i)}">${esc(i)}</span></li>`
    }
    h += '</ul>'
    return h
  }

  html += '<div class="tree-info-content">'
  html += '<div class="tree-info-header">'
  html += `<div class="tree-info-pkg-badge"><span class="tree-info-pkg-dot" style="background:${esc(pkgCol)}"></span>${esc(pkg === '__own__' ? 'own source' : pkg)}</div>`
  html += `<div class="tree-info-title">${esc(file)}</div>`
  html += '<div class="tree-info-jumps">'
  const hasOwnFindings = totalFindings(own) > 0
  if (hasOwnFindings) {
    html += `<button type="button" class="tree-info-jump" data-jump-findings="${esc(file)}">Findings →</button>`
  }
  html += `<button type="button" class="tree-info-jump" data-jump-file="${esc(file)}">Files →</button>`
  html += '</div>'
  html += '</div>'
  html += '<div class="tree-info-section"><div class="tree-info-label">Own findings</div>' + renderChips(own) + '</div>'
  html += '<div class="tree-info-section"><div class="tree-info-label">Subtree findings</div>' + renderChips(trans) + '</div>'
  html += `<div class="tree-info-section"><div class="tree-info-label">Imported by (${importers.length})</div>` + renderList(importers) + '</div>'
  html += `<div class="tree-info-section"><div class="tree-info-label">Imports (${imports.length})</div>` + renderList(imports) + '</div>'
  html += '</div>'
  return html
}
