import { html, nothing } from 'lit'
import { state } from '#client/index.js'
import { SEVERITIES, formatBytes } from './format.js'
import { treeAnchor } from './graph/utils.js'

// Render the Files tab. Two view modes:
//
//   * `table` (default) — one compact row per file with a finding-
//     count chip block on the right; clicking a row opens a details
//     panel with imports / imported by / exports / hashes. Mirrors
//     the findings tab's table-view affordance, with the same
//     two-column layout (3fr list / 2fr details).
//
//   * `list` — every file rendered as a self-contained card with
//     all the import / export / hash sections inlined. The
//     pre-existing layout, kept for users who prefer scrolling
//     through everything in one pass.
//
// A toolbar at the top carries the view-mode switcher (`table` /
// `list` only — `grouped` from the findings tab doesn't apply
// here), a search input that does a case-insensitive substring
// match on file paths, and a `N of M` count.
//
// Returns a Lit `TemplateResult`; render.js drops a `tree-view-slot`
// placeholder into the report html string and `litRender`s the
// template into it after `report.innerHTML = …` lands.
export function renderTreeView(treeData, findingCounts) {
  const allFiles = Object.keys(treeData).toSorted()
  // Inverse adjacency: file → list of files that import it.
  const importedBy = new Map()
  for (const f of allFiles) {
    for (const imp of (treeData[f].imports ?? [])) {
      const arr = importedBy.get(imp) ?? []
      arr.push(f)
      importedBy.set(imp, arr)
    }
  }

  const search = state.filesSearch.trim().toLowerCase()
  const files = search
    ? allFiles.filter((f) => f.toLowerCase().includes(search))
    : allFiles

  // Targets that exist in the tree get a fragment link to their card
  // (only meaningful in list mode — in table mode the row is the
  // primary navigation). Out-of-tree refs render as plain `<span>`.
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

  const totalIssues = (file) => {
    const counts = findingCounts.get(file)
    if (!counts) return 0
    return SEVERITIES.reduce((sum, s) => sum + (counts[s] ?? 0), 0)
  }

  const toolbar = html`<div class="tree-toolbar">
    <view-mode-buttons mode=${state.filesViewMode} modes="table,list" kind="files"></view-mode-buttons>
    <div class="search-row">
      <div class="toolbar-search">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7"/>
          <path d="m20 20-3.5-3.5"/>
        </svg>
        <input
          type="text"
          id="filter-files-search"
          .value=${state.filesSearch}
          placeholder="Search files…">
      </div>
      <span class="result-count">${files.length} of ${allFiles.length}</span>
    </div>
  </div>`

  if (state.filesViewMode === 'table') {
    // Re-validate the selection: a search that hides the previously-
    // selected file should collapse the details panel back, otherwise
    // the user sees a panel pinned to a row they can't see.
    const selected = state.filesSelectedFile && treeData[state.filesSelectedFile]
      && files.includes(state.filesSelectedFile)
      ? state.filesSelectedFile
      : null
    // `.with-details` on the outer wrapper mirrors the findings tab's
    // pattern (see `.findings-content.with-details` in styles/report.css):
    // the wrapper relaxes its max-width to fit the list + details
    // split, while the toolbar inside stays capped at the single-
    // panel width via a separate CSS rule.
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
            const issues = totalIssues(file)
            const isSel = file === selected
            const sizeLabel = formatBytes(treeData[file]?.size)
            return html`<div
              class=${`tree-table-row${isSel ? ' selected' : ''}${issues === 0 ? ' clean' : ''}`}
              data-tree-select=${file}
            >
              <span class="tree-table-name">${file}</span>
              ${sevChips(file) ?? html`<span class="tree-table-clean-marker">—</span>`}
              ${sizeLabel ? html`<span class="tree-table-size">${sizeLabel}</span>` : nothing}
            </div>`
          })}
        </div>
        ${selected ? html`<aside class="tree-table-details" id="tree-table-details">
          <header class="tree-table-details-bar">
            <span class="tree-table-details-label">Details</span>
            <button type="button" class="tree-table-details-close" data-tree-deselect title="Close details" aria-label="Close details">×</button>
          </header>
          <div class="tree-table-details-body">
            ${renderFileDetails(treeData[selected], selected, importedBy.get(selected) ?? [], linkOrText)}
          </div>
        </aside>` : nothing}
      </div>
    </div>`
  }

  // List mode — the original card layout, filtered by the toolbar's
  // search input.
  return html`<div class="tree-view">
    ${toolbar}
    ${files.length === 0 ? html`<div class="tree-table-empty">No files match the search.</div>` : nothing}
    ${files.map((file) => {
      const entry = treeData[file]
      const incoming = importedBy.get(file) ?? []
      const sizeLabel = formatBytes(entry?.size)
      return html`<section class="tree-file" id=${treeAnchor(file)}>
        <div class="tree-file-header">
          <span class="name">${file}</span>
          ${sevChips(file)}
          ${sizeLabel ? html`<span class="tree-file-size">${sizeLabel}</span>` : nothing}
        </div>
        ${(entry.fileHash || entry.treeHash) ? html`<div class="tree-hashes hashes">${[
          entry.fileHash ? `file: ${entry.fileHash}` : null,
          entry.treeHash ? `tree: ${entry.treeHash}` : null,
        ].filter(Boolean).join(' | ')}</div>` : nothing}
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
        </div>` : nothing}
      </section>`
    })}
  </div>`
}

// Right-side details panel for the table view's selected file.
// Mirrors the per-file sections of list mode (hashes, imports,
// imported by, exports) but without the tree-file wrapper since
// the panel itself is the wrapper.
function renderFileDetails(entry, file, incoming, linkOrText) {
  const sizeLabel = formatBytes(entry?.size)
  return html`
    <div class="tree-detail-name">
      <span class="name">${file}</span>
      ${sizeLabel ? html`<span class="tree-detail-size">${sizeLabel}</span>` : nothing}
    </div>
    ${(entry.fileHash || entry.treeHash) ? html`<div class="tree-hashes hashes">${[
      entry.fileHash ? `file: ${entry.fileHash}` : null,
      entry.treeHash ? `tree: ${entry.treeHash}` : null,
    ].filter(Boolean).join(' | ')}</div>` : nothing}
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
    </div>` : nothing}
  `
}
