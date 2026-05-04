import { esc } from '../format.js'
import { treeAnchor } from './utils.js'

// Render the per-file import tree as a flat list of cards. Each card
// shows imports (linked to their target's anchor when the target is in
// the tree), the inverse "imported by", exports, the hashes, and a
// finding-count badge row when the file has any findings.
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
  const linkOrText = (target) => treeData[target]
    ? `<a href="#${esc(treeAnchor(target))}"><span class="name">${esc(target)}</span></a>`
    : `<span class="name">${esc(target)}</span>`
  let html = '<div class="tree-view">'
  for (const file of files) {
    const entry = treeData[file]
    html += `<section class="tree-file" id="${esc(treeAnchor(file))}">`
    html += '<div class="tree-file-header">'
    html += `<span class="name">${esc(file)}</span>`
    const counts = findingCounts.get(file)
    if (counts) {
      const present = Object.entries(counts).filter(([, n]) => n > 0)
      if (present.length > 0) {
        html += '<span class="tree-count-chips">'
        for (const [sev, n] of present) {
          html += `<span class="tree-count-chip ${esc(sev)}">${n} ${esc(sev)}</span>`
        }
        html += '</span>'
      }
    }
    html += '</div>'
    if (entry.fileHash || entry.treeHash) {
      const parts = []
      if (entry.fileHash) parts.push(`file: ${esc(entry.fileHash)}`)
      if (entry.treeHash) parts.push(`tree: ${esc(entry.treeHash)}`)
      html += `<div class="tree-hashes hashes">${parts.join(' | ')}</div>`
    }
    if (entry.imports?.length > 0) {
      html += '<div class="tree-section"><span class="tree-section-label">imports</span><ul>'
      for (const imp of entry.imports) html += `<li>${linkOrText(imp)}</li>`
      html += '</ul></div>'
    }
    const incoming = importedBy.get(file) ?? []
    if (incoming.length > 0) {
      html += '<div class="tree-section"><span class="tree-section-label">imported by</span><ul>'
      for (const f of incoming) html += `<li>${linkOrText(f)}</li>`
      html += '</ul></div>'
    }
    if (entry.exports?.length > 0) {
      html += '<div class="tree-section"><span class="tree-section-label">exports</span><ul>'
      for (const ex of entry.exports) html += `<li><span class="name">${esc(ex)}</span></li>`
      html += '</ul></div>'
    }
    html += '</section>'
  }
  html += '</div>'
  return html
}
