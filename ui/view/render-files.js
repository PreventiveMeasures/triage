import { html, nothing } from 'lit'
import { bundlesForFileHash, state } from '#client/index.js'
import { SEVERITIES, formatBytes } from './format.js'
import { totalFindings, treeAnchor } from './file-counts.js'

// A file's Code button: the first bundle holding a file of this hash (the
// cross-report hash index, filled lazily as bundles parse), through the
// finding-card's `data-finding-code-*` attributes and events.js handler.
// None until some bundle has it.
function fileCodeButton(fileHash) {
  if (!fileHash) return nothing
  const match = bundlesForFileHash(fileHash)[0]
  if (!match) return nothing
  return html`<button
    type="button"
    class="tree-code-btn"
    data-finding-code-bundle=${match.integrity}
    data-finding-code-file=${match.file}
    data-tooltip=${`Open ${match.file} in bundle source viewer`}
  >Code</button>`
}

// The Files tab: `table` (default), a compact row per file with its
// finding-count chips, a click opening a details panel (imports, imported
// by, exports, hashes) as the findings table does; or `list`, every file
// a card with those sections inline. The toolbar holds the two modes, a
// case-insensitive path search and its `N of M`.
export function renderTreeView(treeData, findingCounts) {
  const { allFiles, lowerFiles, importedBy } = treeIndex(treeData)

  const search = state.filesSearch.trim().toLowerCase()
  const files = search
    ? allFiles.filter((f, i) => lowerFiles[i].includes(search))
    : allFiles

  // A target in the tree links to its card (list mode's navigation).
  const linkOrText = (target) => treeData[target]
    ? html`<a href=${`#${treeAnchor(target)}`}><span class="name">${target}</span></a>`
    : html`<span class="name">${target}</span>`

  const sevChips = (file) => {
    const counts = findingCounts.get(file)
    if (!counts) return null
    const present = SEVERITIES.filter((s) => (counts[s] ?? 0) > 0)
    if (present.length === 0) return null
    return html`<span class="tree-count-chips">
      ${present.map((s) => html`<span class=${`tree-count-chip ${s}`}>${counts[s]} ${s.replaceAll('_', ' ')}</span>`)}
    </span>`
  }

  const toolbar = html`<div class="tree-toolbar">
    <view-mode-buttons modes="table,list" kind="files"></view-mode-buttons>
    <div class="search-row">
      <toolbar-search kind="files"></toolbar-search>
      <span class="result-count">${files.length} of ${allFiles.length}</span>
    </div>
  </div>`

  if (state.filesViewMode === 'table') {
    // A search hiding the selected file closes its panel. `.with-details`
    // widens the wrapper for the split, as the findings tab's does.
    const selected = state.filesSelectedFile && Object.hasOwn(treeData, state.filesSelectedFile)
      && (!search || state.filesSelectedFile.toLowerCase().includes(search))
      ? state.filesSelectedFile
      : null
    const wrapperClass = selected
      ? 'tree-view tree-view-table with-details'
      : 'tree-view tree-view-table'
    const layoutClass = selected ? 'tree-table-layout open' : 'tree-table-layout'
    return html`<div class=${wrapperClass}>
      ${toolbar}
      <div class=${layoutClass}>
        <div class="tree-table-list">
          ${files.length === 0 ? html`<div class="tree-table-empty">No files match the search.</div>` : nothing}
          ${files.map((file) => {
            const issues = totalFindings(findingCounts.get(file))
            const isSel = file === selected
            const sizeLabel = formatBytes(treeData[file].size)
            return html`<div
              class=${`tree-table-row${isSel ? ' selected' : ''}${issues === 0 ? ' clean' : ''}`}
              data-tree-select=${file}
            >
              <span class="tree-table-name" data-tooltip-truncated data-tooltip=${file}>${file}</span>
              ${sevChips(file) ?? html`<span class="tree-table-clean-marker">—</span>`}
              ${sizeLabel ? html`<span class="tree-table-size">${sizeLabel}</span>` : nothing}
            </div>`
          })}
        </div>
        ${selected ? html`<aside class="tree-table-details" id="tree-table-details">
          <header class="tree-table-details-bar">
            <span class="tree-table-details-label">Details</span>
            <button type="button" class="tree-table-details-close" data-tree-deselect aria-label="Close details">×</button>
          </header>
          <div class="tree-table-details-body">
            ${renderFileDetails(treeData[selected], selected, importedBy.get(selected) ?? [], linkOrText)}
          </div>
        </aside>` : nothing}
      </div>
    </div>`
  }

  // List mode — card layout, filtered by the toolbar's search input.
  return html`<div class="tree-view">
    ${toolbar}
    ${files.length === 0 ? html`<div class="tree-table-empty">No files match the search.</div>` : nothing}
    ${files.map((file) => {
      const entry = treeData[file]
      const incoming = importedBy.get(file) ?? []
      const sizeLabel = formatBytes(entry.size)
      return html`<section class="tree-file" id=${treeAnchor(file)}>
        <div class="tree-file-header">
          <span class="name">${file}</span>
          ${sevChips(file)}
          ${sizeLabel ? html`<span class="tree-file-size">${sizeLabel}</span>` : nothing}
          ${fileCodeButton(entry.fileHash)}
        </div>
        ${fileSections(entry, incoming, linkOrText)}
      </section>`
    })}
  </div>`
}

// The tree's files sorted, case-folded for the search, and the inverse
// adjacency (file → the files that import it), kept for the tree they
// were read from: the tab draws on every keystroke of its search, and
// the merged tree is the same map until the loaded reports change
// (file-counts.js mergeReportsTree).
let lastIndex = { treeData: null, allFiles: [], lowerFiles: [], importedBy: new Map() }
function treeIndex(treeData) {
  if (lastIndex.treeData === treeData) return lastIndex
  const allFiles = Object.keys(treeData).toSorted()
  const importedBy = new Map()
  for (const f of allFiles) {
    for (const imp of (treeData[f].imports ?? [])) {
      const arr = importedBy.get(imp) ?? []
      arr.push(f)
      importedBy.set(imp, arr)
    }
  }
  lastIndex = { treeData, allFiles, lowerFiles: allFiles.map((f) => f.toLowerCase()), importedBy }
  return lastIndex
}

// A file's hashes / imports / imported-by / exports, in the list card and
// the table's details panel alike.
function fileSections(entry, incoming, linkOrText) {
  return html`${(entry.fileHash || entry.treeHash) ? html`<div class="tree-hashes hashes">
      ${entry.fileHash ? html`<div class="tree-hash">file: ${entry.fileHash}</div>` : nothing}
      ${entry.treeHash ? html`<div class="tree-hash">tree: ${entry.treeHash}</div>` : nothing}
    </div>` : nothing}
    ${entry.imports?.length > 0 ? html`<div class="tree-section">
      <span class="tree-section-label">imports</span>
      <ul>${entry.imports.map((imp) => html`<li>${linkOrText(imp)}</li>`)}</ul>
    </div>` : nothing}
    ${incoming.length > 0 ? html`<div class="tree-section">
      <span class="tree-section-label">imported by</span>
      <ul>${incoming.map((f) => html`<li>${linkOrText(f)}</li>`)}</ul>
    </div>` : nothing}
    ${entry.exports?.length > 0 ? html`<div class="tree-section">
      <span class="tree-section-label">exports</span>
      <ul>${entry.exports.map((ex) => html`<li><span class="name">${ex}</span></li>`)}</ul>
    </div>` : nothing}`
}

// The table view's details panel for the selected file.
function renderFileDetails(entry, file, incoming, linkOrText) {
  const sizeLabel = formatBytes(entry.size)
  return html`
    <div class="tree-detail-name">
      <span class="name">${file}</span>
      ${sizeLabel ? html`<span class="tree-detail-size">${sizeLabel}</span>` : nothing}
      ${fileCodeButton(entry.fileHash)}
    </div>
    ${fileSections(entry, incoming, linkOrText)}
  `
}
