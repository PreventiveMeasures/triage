import { html } from '../frontend-global.js'
import { formatBytes } from '../format.js'
import { pkgColor } from './utils.js'

const number = (n) => n.toLocaleString('en-US')

function rowButton(row, count, select) {
  return html`<button class="g2-dist-item matrix-row-link" @click=${() => select(row.id)} data-tooltip=${row.label}>
    <span class="g2-dist-dot" style=${`background:${pkgColor(row.pkg)}`}></span><span class="g2-dist-name">${row.label}</span><span class="g2-dist-count">${number(count)}</span>
  </button>`
}

export function renderMatrixPanel(model, graph, selection, { select, expand, expanded, neighborhood, focus, clear }) {
  const row = model.byId.get(selection?.from), target = model.byId.get(selection?.to)
  if (!row) {
    const hubs = [...model.rows].toSorted((a, b) => b.incoming - a.incoming).slice(0, 15)
    return html`<div class="matrix-metrics"><span><b>${number(graph.nodes.length)}</b>files</span><span><b>${number(graph.packages.length)}</b>packages</span><span><b>${number(model.importCount)}</b>imports</span></div>
      <p class="matrix-empty">Select a row to inspect a package. Select a cell to see the files behind a dependency.</p>
      <h4>Most imported</h4>${hubs.map((n) => rowButton(n, n.incoming, select))}
      ${model.cycleCount ? html`<h4>Cyclic groups <b>${model.cycleCount}</b></h4>${model.rows.filter((n) => n.cyclic).slice(0, 12).map((n) => rowButton(n, n.outgoing, select))}` : null}`
  }
  const cell = target ? model.cells.get(row.id)?.get(target.id) : null
  const importGroups = Map.groupBy(cell?.examples ?? [], ([, to]) => to)
  const cycleSize = row.cyclic ? [...model.byId.values()].filter((n) => n.component === row.component).length : 0
  const outgoing = [...(model.cells.get(row.id)?.values() ?? [])].filter((c) => c.to !== row.id).toSorted((a, b) => b.count - a.count)
  const incoming = [...model.cells.values()].map((targets) => targets.get(row.id)).filter((c) => c && c.from !== row.id).toSorted((a, b) => b.count - a.count)
  return html`<div class="matrix-panel-head"><button class="matrix-selected-name" @click=${() => select(row.id)}>${row.label}</button><button type="button" class="detail-action" @click=${clear} aria-label="Clear matrix selection">×</button></div>
    ${target ? html`<div class="matrix-direction">imports →</div><button class="matrix-selected-name" @click=${() => select(target.id)}>${target.label}</button>` : null}
    ${(target ? cell?.cyclic : row.cyclic) ? html`<span class="matrix-cycle-label">${target ? 'Import participates in a cycle' : `Cyclic group · ${cycleSize} members`}</span>` : null}
    <div class="matrix-metrics"><span><b>${target ? number(cell?.count ?? 0) : number(row.files.length)}</b>${target ? 'file imports' : 'files'}</span><span><b>${formatBytes(row.size)}</b>source size</span></div>
    <div class="matrix-actions">
      ${row.file ? html`<button @click=${() => expand(row.pkg)}>Collapse package</button><button data-bundle-view-source=${graph.nodeByFile.get(row.file)?.origFile ?? row.file}>View source</button>` : html`<button @click=${() => expand(row.pkg)}>${expanded.has(row.pkg) ? 'Collapse files' : 'Expand files'}</button>`}
      <button aria-pressed=${String(neighborhood === row.id)} @click=${() => focus(row.id)}>Neighborhood</button>
    </div>
    ${target ? html`<h4>File imports</h4>${importGroups.size > 0 ? [...importGroups].map(([to, imports]) => html`<div class="matrix-import-group">
      <button class="matrix-import-target" data-bundle-view-source=${graph.nodeByFile.get(to)?.origFile ?? to} data-tooltip=${to}>${to}</button>
      <ul class="matrix-import-sources" aria-label="Imported by">${imports.map(([from]) => html`<li>
        <button data-bundle-view-source=${graph.nodeByFile.get(from)?.origFile ?? from} data-tooltip=${from}><span aria-hidden="true">←</span><span>${from}</span></button>
      </li>`)}</ul>
    </div>`) : html`<p class="matrix-empty">No direct imports in this direction.</p>`}
    ${cell && cell.count > cell.examples.length ? html`<p class="matrix-empty">Showing ${cell.examples.length} of ${number(cell.count)} imports.</p>` : null}
    ${target.id !== row.id && model.cells.get(target.id)?.has(row.id) ? html`<h4>Reverse direction</h4><button class="g2-dist-item matrix-reverse-link" @click=${() => select(target.id, row.id)}>← ${number(model.cells.get(target.id).get(row.id).count)} file imports</button>` : null}`
      : html`<h4>Imports <b>${outgoing.length}</b></h4>${outgoing.slice(0, 60).map((c) => rowButton(model.byId.get(c.to), c.count, (id) => select(row.id, id)))}
        ${outgoing.length > 60 ? html`<p class="matrix-empty">Showing the 60 strongest of ${outgoing.length} dependencies.</p>` : null}
        <h4>Imported by <b>${incoming.length}</b></h4>${incoming.slice(0, 60).map((c) => rowButton(model.byId.get(c.from), c.count, (id) => select(id, row.id)))}
        ${incoming.length > 60 ? html`<p class="matrix-empty">Showing the 60 strongest of ${incoming.length} importers.</p>` : null}`}`
}
