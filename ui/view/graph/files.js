import { html, nothing } from 'lit'
import { treeAnchor } from './utils.js'

// Render the per-file import tree as a flat list of cards. Each card
// shows imports (linked to their target's anchor when the target is in
// the tree), the inverse "imported by", exports, the hashes, and a
// finding-count badge row when the file has any findings. Returns a
// Lit `TemplateResult`; the caller in render.js drops a placeholder
// slot into its string-built HTML and `litRender`s this template into
// the slot after `report.innerHTML = …` lands.
export function renderTreeView(treeData, findingCounts) {
  const files = Object.keys(treeData).sort()
  // Inverse adjacency: file → list of files that import it.
  const importedBy = new Map()
  for (const f of files) {
    for (const imp of (treeData[f].imports ?? [])) {
      const arr = importedBy.get(imp) ?? []
      arr.push(f)
      importedBy.set(imp, arr)
    }
  }
  // Targets that exist in the tree get a fragment link to their card;
  // out-of-tree refs render as plain `<span>` so the styling matches
  // but the link doesn't go anywhere broken.
  const linkOrText = (target) => treeData[target]
    ? html`<a href=${`#${treeAnchor(target)}`}><span class="name">${target}</span></a>`
    : html`<span class="name">${target}</span>`

  return html`<div class="tree-view">
    ${files.map((file) => {
      const entry = treeData[file]
      const counts = findingCounts.get(file)
      const present = counts ? Object.entries(counts).filter(([, n]) => n > 0) : []
      const incoming = importedBy.get(file) ?? []
      return html`<section class="tree-file" id=${treeAnchor(file)}>
        <div class="tree-file-header">
          <span class="name">${file}</span>
          ${present.length > 0 ? html`<span class="tree-count-chips">
            ${present.map(([sev, n]) => html`<span class=${`tree-count-chip ${sev}`}>${n} ${sev}</span>`)}
          </span>` : nothing}
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
