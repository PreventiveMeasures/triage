export const MATRIX_LEFT = 196
export const MATRIX_TOP = 118

export function matrixFitCell(rowCount, width, height) {
  return Math.min(24, Math.max(1, width - MATRIX_LEFT - 12) / Math.max(1, rowCount),
    Math.max(1, height - MATRIX_TOP - 12) / Math.max(1, rowCount))
}

export function matrixZoomCell(cell, rowCount, width, height) {
  return Math.max(Math.min(18, matrixFitCell(rowCount, width, height)), Math.min(27, cell))
}

export function matrixHit(x, y, model, view) {
  const col = Math.floor((x - MATRIX_LEFT + view.x) / view.cell)
  const row = Math.floor((y - MATRIX_TOP + view.y) / view.cell)
  if (x < MATRIX_LEFT && y >= MATRIX_TOP && row >= 0 && row < model.rows.length) return { row, col: null }
  if (y < MATRIX_TOP && x >= MATRIX_LEFT && col >= 0 && col < model.rows.length) return { row: col, col: null }
  if (x >= MATRIX_LEFT && y >= MATRIX_TOP && row >= 0 && col >= 0 && row < model.rows.length && col < model.rows.length) return { row, col }
  return null
}

function shortLabel(row) {
  if (!row.file) return row.label
  const prefix = `node_modules/${row.pkg}/`
  return row.file.includes(prefix) ? row.file.slice(row.file.indexOf(prefix) + prefix.length) : row.file
}

export function paintMatrix(ctx, model, view, { width, height, theme, colorOf, hover, selected, dimmed }) {
  const { cell, x: ox, y: oy } = view, { rows } = model
  const x = (i) => MATRIX_LEFT + i * cell - ox
  const y = (i) => MATRIX_TOP + i * cell - oy
  const startRow = Math.max(0, Math.floor(oy / cell))
  const endRow = Math.min(rows.length, Math.ceil((height - MATRIX_TOP + oy) / cell))
  const startCol = Math.max(0, Math.floor(ox / cell))
  const endCol = Math.min(rows.length, Math.ceil((width - MATRIX_LEFT + ox) / cell))
  const active = hover ?? selected
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, width, height)
  ctx.save(); ctx.beginPath(); ctx.rect(MATRIX_LEFT, MATRIX_TOP, width - MATRIX_LEFT, height - MATRIX_TOP); ctx.clip()
  // Outline a cyclic group when ordering keeps its members together. Do not
  // fill its empty cells: group membership does not imply a direct import.
  const runs = []
  for (let i = 0; i < rows.length; i++) {
    const prev = runs.at(-1), r = rows[i]
    if (prev && prev.component === r.component) prev.end = i + 1
    else runs.push({ component: r.component, start: i, end: i + 1, cyclic: r.cyclic })
  }
  for (const run of runs) {
    if (!run.cyclic) continue
    ctx.strokeStyle = theme.cycle + '85'; ctx.lineWidth = 1
    ctx.strokeRect(x(run.start), y(run.start), (run.end - run.start) * cell, (run.end - run.start) * cell)
  }
  if (active) {
    ctx.fillStyle = theme.highlight
    ctx.fillRect(MATRIX_LEFT, y(active.row), width - MATRIX_LEFT, cell)
    ctx.fillRect(x(active.col ?? active.row), MATRIX_TOP, cell, height - MATRIX_TOP)
  }
  ctx.strokeStyle = theme.grid; ctx.lineWidth = 1
  if (cell >= 9) {
    ctx.beginPath()
    for (let i = startRow; i <= endRow; i++) { ctx.moveTo(MATRIX_LEFT, y(i) + .5); ctx.lineTo(width, y(i) + .5) }
    for (let i = startCol; i <= endCol; i++) { ctx.moveTo(x(i) + .5, MATRIX_TOP); ctx.lineTo(x(i) + .5, height) }
    ctx.stroke()
  }
  const max = model.visibleCells.reduce((n, c) => Math.max(n, c.count), 1)
  const inset = cell >= 8 ? 2 : .25
  for (const c of model.visibleCells) {
    if (c.row < startRow || c.row >= endRow || c.col < startCol || c.col >= endCol) continue
    ctx.globalAlpha = dimmed(rows[c.row]) && dimmed(rows[c.col]) ? .12 : .35 + .65 * Math.log1p(c.count) / Math.log1p(max)
    ctx.fillStyle = c.cyclic && cell < 10 ? theme.cycle : colorOf(rows[c.row].pkg)
    ctx.fillRect(x(c.col) + inset, y(c.row) + inset, Math.max(1, cell - 2 * inset), Math.max(1, cell - 2 * inset))
    if (c.cyclic && c.from !== c.to && cell >= 10) {
      ctx.fillStyle = theme.cycle
      ctx.fillRect(x(c.col) + cell - 5, y(c.row) + 2, 3, 3)
    }
  }
  ctx.globalAlpha = 1
  if (selected) {
    ctx.strokeStyle = theme.text; ctx.lineWidth = 2
    if (selected.col === null) ctx.strokeRect(MATRIX_LEFT + 1, y(selected.row) + 1, width - MATRIX_LEFT - 2, cell - 2)
    else ctx.strokeRect(x(selected.col) + 1, y(selected.row) + 1, cell - 2, cell - 2)
  }
  ctx.restore()
  // Fixed axes stay legible while the matrix pans underneath them.
  ctx.fillStyle = theme.surface; ctx.fillRect(0, 0, width, MATRIX_TOP); ctx.fillRect(0, 0, MATRIX_LEFT, height)
  ctx.font = '11px ui-monospace, monospace'; ctx.textBaseline = 'middle'
  const stride = Math.max(1, Math.ceil(14 / cell))
  for (let i = startRow; i < endRow; i++) {
    if (i % stride && i !== active?.row) continue
    // At Fit, the first row can be sub-pixel tall. Its fixed-size label still
    // needs room above the row center, outside the matrix's clipping boundary.
    ctx.save(); ctx.beginPath(); ctx.rect(5, MATRIX_TOP - 7, MATRIX_LEFT - 10, height - MATRIX_TOP + 7); ctx.clip()
    const cy = y(i) + cell / 2
    if (i === active?.row) { ctx.fillStyle = theme.highlight; ctx.fillRect(0, y(i), MATRIX_LEFT, Math.max(cell, 14)) }
    ctx.fillStyle = colorOf(rows[i].pkg); ctx.fillRect(8, cy - 3, 5, 6)
    ctx.fillStyle = i === active?.row || (model.matches.size < model.totalRows && model.matches.has(rows[i].id)) ? theme.text : theme.muted
    ctx.fillText(`${rows[i].file ? '  ' : ''}${shortLabel(rows[i])}`, 20, cy)
    ctx.restore()
  }
  const columnStride = Math.max(1, Math.ceil(17 / cell))
  for (let i = startCol; i < endCol; i++) {
    if (i % columnStride && i !== (active?.col ?? active?.row)) continue
    // Rotating the label extends its first glyph left of the column center.
    ctx.save(); ctx.beginPath(); ctx.rect(MATRIX_LEFT - 7, 22, width - MATRIX_LEFT + 7, MATRIX_TOP - 22); ctx.clip()
    ctx.translate(x(i) + cell / 2, MATRIX_TOP - 10); ctx.rotate(-Math.PI / 4)
    ctx.fillStyle = i === (active?.col ?? active?.row) ? theme.text : theme.muted
    ctx.fillText(shortLabel(rows[i]), 0, 0, 115)
    ctx.restore()
    ctx.fillStyle = colorOf(rows[i].pkg); ctx.fillRect(x(i) + 1, MATRIX_TOP - 4, Math.max(1, cell - 2), 3)
  }
  ctx.fillStyle = theme.muted; ctx.font = '10px ui-monospace, monospace'
  ctx.fillText('IMPORTERS ↓', 14, MATRIX_TOP - 14)
  ctx.fillText('DEPENDENCIES →', MATRIX_LEFT + 8, 12)
  ctx.strokeStyle = theme.border; ctx.beginPath(); ctx.moveTo(MATRIX_LEFT - .5, MATRIX_TOP); ctx.lineTo(MATRIX_LEFT - .5, height)
  ctx.moveTo(MATRIX_LEFT, MATRIX_TOP - .5); ctx.lineTo(width, MATRIX_TOP - .5); ctx.stroke()
  if (rows.length === 0) { ctx.fillStyle = theme.muted; ctx.fillText('No matching dependencies', MATRIX_LEFT + 20, MATRIX_TOP + 30) }
}
