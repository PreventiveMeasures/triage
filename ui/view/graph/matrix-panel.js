import { html } from 'lit'
import { styleMap } from '../style-map.js'
import { formatBytes } from '../format.js'
import { pkgColor } from './utils.js'
import { countsTowardsCycles } from './cycle-imports.js'
import { graphTerms, packageVersions } from './data.js'

const number = (n) => n.toLocaleString('en-US')

function rowButton(row, count, select) {
  return html`<button class="g2-dist-item matrix-row-link" @click=${() => select(row.id)}>
    <span class="g2-dist-dot" style=${styleMap({ background: pkgColor(row.pkg) })}></span><span class="g2-dist-name" data-tooltip-truncated data-tooltip=${row.label}>${row.label}</span><span class="g2-dist-count">${number(count)}</span>
  </button>`
}

// A row's members as the matrix counts them: a bundle package's files, a
// lockfile package's versions.
export function matrixMembers(graph, row) {
  return graph.packagesOnly ? packageVersions(graph, row.pkg).length : row.files.length
}

export function renderMatrixPanel(model, graph, selection, { select, expand, expanded, neighborhood, focus, clear }) {
  const row = model.byId.get(selection?.from), target = model.byId.get(selection?.to)
  const packagesOnly = graph.packagesOnly, terms = graphTerms(graph)
  const originalPath = file => graph.nodeByFile.get(file)?.origFile ?? file
  if (!row) {
    const hubs = [...model.rows].toSorted((a, b) => b.importers - a.importers).slice(0, 15)
    // A lockfile counts dependencies between packages, not their copies.
    const links = packagesOnly ? [...model.byId.values()].reduce((sum, n) => sum + n.dependencies, 0) : model.importCount
    return html`<div class="matrix-metrics">${packagesOnly ? null : html`<span><b>${number(graph.nodes.length)}</b>files</span>`}<span><b>${number(graph.packages.length)}</b>packages</span><span><b>${number(links)}</b>${terms.links}</span></div>
      <p class="matrix-empty">Select a row to inspect a package.<br>Select a cell to see the ${terms.members} behind a dependency.</p>
      <h4>${terms.mostImported}</h4>${hubs.map((n) => rowButton(n, n.importers, select))}
      ${model.cycleCount ? html`<h4>Cyclic groups <b>${model.cycleCount}</b></h4>${model.rows.filter((n) => n.cyclic).slice(0, 12).map((n) => rowButton(n, n.outgoing, select))}` : null}`
  }
  const cell = target ? model.cells.get(row.id)?.get(target.id) : null
  const cycleLabel = cell?.cycleCount < cell?.count
    ? `${number(cell.cycleCount)} of ${number(cell.count)} ${terms.cellLinks} participate in a cycle` : `${terms.link} participates in a cycle`
  const importGroups = Map.groupBy(cell?.examples ?? [], ([, to]) => to)
  const cycleSize = row.cyclic ? [...model.byId.values()].filter((n) => n.component === row.component).length : 0
  const outgoing = [...(model.cells.get(row.id)?.values() ?? [])].filter((c) => c.to !== row.id).toSorted((a, b) => b.count - a.count)
  const incoming = [...model.cells.values()].map((targets) => targets.get(row.id)).filter((c) => c && c.from !== row.id).toSorted((a, b) => b.count - a.count)
  // A bundle's file opens its source; a lockfile's copy has none to open.
  const copyOrFile = (file, content) => packagesOnly ? html`<span class="matrix-import-copy">${content}</span>`
    : html`<button data-bundle-view-source=${originalPath(file)}>${content}</button>`
  // A lockfile's packages are only ever rows: its copies have no file rows.
  const actions = packagesOnly ? null
    : row.file ? html`<button @click=${() => expand(row.pkg)}>Collapse package</button><button data-bundle-view-source=${originalPath(row.file)}>View source</button>`
    : html`<button @click=${() => expand(row.pkg)}>${expanded.has(row.pkg) ? 'Collapse files' : 'Expand files'}</button>`
  return html`<div class="matrix-panel-head"><button class="matrix-selected-name" @click=${() => select(row.id)}>${row.label}</button><button type="button" class="detail-action" @click=${clear} aria-label="Clear matrix selection">×</button></div>
    ${target ? html`<div class="matrix-direction">${terms.linked} →</div><button class="matrix-selected-name" @click=${() => select(target.id)}>${target.label}</button>` : null}
    ${(target ? cell?.cyclic : row.cyclic) ? html`<span class="matrix-cycle-label">${target ? cycleLabel : `Cyclic group · ${cycleSize} members`}</span>` : null}
    <div class="matrix-metrics"><span><b>${target ? number(cell?.count ?? 0) : number(matrixMembers(graph, row))}</b>${target ? terms.cellLinks : terms.members}</span>${packagesOnly ? null : html`<span><b>${formatBytes(row.size)}</b>source size</span>`}</div>
    <div class="matrix-actions">
      ${actions}
      <button aria-pressed=${String(neighborhood === row.id)} @click=${() => focus(row.id)}>Neighborhood</button>
    </div>
    ${target ? html`<h4>${terms.cellHeading}</h4>${importGroups.size > 0 ? [...importGroups].map(([to, imports]) => html`<div class="matrix-import-group">
      ${packagesOnly ? html`<span class="matrix-import-copy matrix-import-target" data-tooltip-truncated data-tooltip=${to}>${to}</span>`
        : html`<button class="matrix-import-target" data-bundle-view-source=${originalPath(to)} data-tooltip-truncated data-tooltip=${to}>${to}</button>`}
      <ul class="matrix-import-sources" aria-label=${terms.incoming}>${imports.map(([from]) => html`<li>
        ${copyOrFile(from, html`<span aria-hidden="true">←</span><span data-tooltip-truncated data-tooltip=${from}>${from}</span>`)}
        ${countsTowardsCycles(originalPath(from), originalPath(to), graph.ownSourceFiles?.has(to), graph.ownSourceFiles?.has(from)) ? null : html`<span class="matrix-import-excluded">Excluded from cycles</span>`}
      </li>`)}</ul>
    </div>`) : html`<p class="matrix-empty">No direct ${terms.links} in this direction.</p>`}
    ${cell && cell.count > cell.examples.length ? html`<p class="matrix-empty">Showing ${cell.examples.length} of ${number(cell.count)} ${terms.links}.</p>` : null}
    ${target.id !== row.id && model.cells.get(target.id)?.has(row.id) ? html`<h4>Reverse direction</h4><button class="g2-dist-item matrix-reverse-link" @click=${() => select(target.id, row.id)}>← ${number(model.cells.get(target.id).get(row.id).count)} ${terms.cellLinks}</button>` : null}`
      : html`<h4>${terms.outgoing} <b>${outgoing.length}</b></h4>${outgoing.slice(0, 60).map((c) => rowButton(model.byId.get(c.to), c.count, (id) => select(row.id, id)))}
        ${outgoing.length > 60 ? html`<p class="matrix-empty">Showing the 60 strongest of ${outgoing.length} dependencies.</p>` : null}
        <h4>${terms.incoming} <b>${incoming.length}</b></h4>${incoming.slice(0, 60).map((c) => rowButton(model.byId.get(c.from), c.count, (id) => select(id, row.id)))}
        ${incoming.length > 60 ? html`<p class="matrix-empty">Showing the 60 strongest of ${incoming.length} ${terms.importers}.</p>` : null}`}`
}
