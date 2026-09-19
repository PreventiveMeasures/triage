// Canvas drawing is separate from the generic shortest-path/weighted layout.
// Coordinates remain in layout space; the caller owns pan, zoom and picking.
function textOnPackage(color) {
  const channels = [1, 3, 5].map((offset) => {
    const c = parseInt(color.slice(offset, offset + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return luminance > 0.18 ? '#000' : '#fff'
}

export function drawDependencyLayers(ctx, layout, { theme, scale, colorOf, labelOf, sizeLabel, dimmed, selected, hovered }) {
  const focus = hovered ?? selected
  const neighbors = new Set([focus])
  for (const edge of layout.edges) {
    if (edge.from === focus) neighbors.add(edge.to)
    if (edge.to === focus) neighbors.add(edge.from)
  }
  const dim = (id) => id === focus || id === selected ? 1 : dimmed(id) ? 0.13 : focus && !neighbors.has(id) ? 0.22 : 1
  ctx.save()
  ctx.lineJoin = 'round'
  // Connections occupy the inter-level gaps. Same-level imports arch into
  // the next gap; back-edges use the right gutter instead of crossing bars.
  for (const edge of layout.edges) {
    const a = layout.rects.get(edge.from), b = layout.rects.get(edge.to)
    const emphasis = edge.from === focus || edge.to === focus
    ctx.globalAlpha = Math.min(dim(edge.from), dim(edge.to)) * (emphasis ? 0.9 : 0.5)
    ctx.strokeStyle = colorOf(edge.from)
    ctx.fillStyle = colorOf(edge.from)
    ctx.lineWidth = (emphasis ? 1.6 : 1) / scale
    const x1 = a.x + a.width * edge.sourcePort, y1 = a.y + a.height
    let x2 = b.x + b.width * edge.targetPort, y2 = b.y
    let tangentX = 0, tangentY = 1
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    if (b.y > a.y) {
      const mid = (y1 + y2) / 2
      ctx.bezierCurveTo(x1, mid, x2, mid, x2, y2)
    } else if (b.y === a.y) {
      y2 = b.y + b.height
      const turn = y1 + layout.gap * 0.65
      ctx.bezierCurveTo(x1, turn, x2, turn, x2, y2)
      tangentY = -1
    } else {
      x2 = b.x + b.width
      y2 = b.y + b.height * edge.targetPort
      const turn = layout.width + 16 + edge.sourcePort * 20
      ctx.bezierCurveTo(x1, y1 + layout.gap / 2, turn, y1 + layout.gap / 2, turn, y1)
      ctx.lineTo(turn, y2 + 8)
      ctx.quadraticCurveTo(turn, y2, x2, y2)
      tangentX = -1; tangentY = 0
    }
    ctx.stroke()
    const tip = 3 / scale
    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - tangentX * tip - tangentY * tip, y2 - tangentY * tip + tangentX * tip)
    ctx.lineTo(x2 - tangentX * tip + tangentY * tip, y2 - tangentY * tip - tangentX * tip)
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'
  ctx.fillStyle = theme.labelDefault
  ctx.font = '11px system-ui, sans-serif'
  const layerRing = theme.edgeIntra(0.16)
  for (const row of layout.levels) {
    const cx = -112, cy = row.y + 26, radius = 18
    ctx.strokeStyle = layerRing
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
    if (row.share !== null && row.share > 0) {
      ctx.strokeStyle = theme.labelDefault
      ctx.beginPath()
      ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + row.share * Math.PI * 2)
      ctx.stroke()
    }
    ctx.textAlign = 'center'
    ctx.font = '9px system-ui, sans-serif'
    const percent = row.share === null ? '—' : row.share > 0 && row.share < 0.001 ? '<0.1%' : `${Number((row.share * 100).toFixed(1))}%`
    ctx.fillText(percent, cx, cy)
    ctx.textAlign = 'right'
    ctx.font = '11px system-ui, sans-serif'
    ctx.fillText(row.level === null ? 'Unreached' : row.level === 0 ? 'App' : `Level ${row.level}`, -12, row.y + 19)
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText(row.proportional ? sizeLabel(row.size) : 'No size data', -12, row.y + 35)
    ctx.font = '11px system-ui, sans-serif'
  }
  ctx.textAlign = 'left'
  for (const rect of layout.rects.values()) {
    const { id, x, y, width, height } = rect
    if (width <= 0) continue
    const color = colorOf(id)
    const textColor = textOnPackage(color)
    ctx.globalAlpha = dim(id)
    // Use the graph's exact theme-aware package fills at full opacity.
    ctx.fillStyle = color
    ctx.fillRect(x, y, width, height)
    // A hairline separates adjacent packages without changing their area.
    ctx.strokeStyle = theme.bg
    ctx.lineWidth = 1 / scale
    ctx.strokeRect(x, y, width, height)
    if (id === selected || id === hovered) {
      ctx.strokeStyle = theme.selectRing
      ctx.lineWidth = 1.5 / scale
      const inset = Math.min(width / 2, 0.75 / scale)
      ctx.strokeRect(x + inset, y + inset, Math.max(0, width - inset * 2), height - inset * 2)
    }
    if (width * scale < 28) continue
    ctx.save()
    ctx.beginPath()
    ctx.rect(x + 7, y + 4, Math.max(0, width - 14), height - 8)
    ctx.clip()
    ctx.fillStyle = textColor
    ctx.font = '500 12px system-ui, sans-serif'
    ctx.fillText(labelOf(id), x + 9, y + 21)
    ctx.fillStyle = textColor
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText(sizeLabel(id), x + 9, y + 38)
    ctx.restore()
  }
  ctx.restore()
}
