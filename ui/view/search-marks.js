// A search hit's line as a row shows it: cut to fit around its first match,
// each match marked. Shared by the Code tab's rail and Search tab
// (render-bundle.js) and Compare's Code rail (bundle-compare-code.js).
import { html, nothing } from 'lit'

// The Code rail's hit rows fit ~40 mono chars at the default rail
// width before the CSS ellipsis, so a match further along would be
// marked but off screen. When the first match sits past
// RAIL_HIT_VISIBLE chars of text (indentation doesn't count — the row
// collapses it), start the row RAIL_HIT_LEAD chars before the match
// behind a `…`. RAIL_HIT_MAX caps the rendered text.
const RAIL_HIT_MAX = 200
const RAIL_HIT_VISIBLE = 28
const RAIL_HIT_LEAD = 12

function clipRailHit(text, ranges) {
  const first = ranges.length > 0 ? ranges[0][0] : 0
  const indent = text.length - text.trimStart().length
  const from = first - indent > RAIL_HIT_VISIBLE ? first - RAIL_HIT_LEAD : 0
  return sliceSearchLine(text, ranges, from, RAIL_HIT_MAX)
}

// A rail hit's text: clipped (clipRailHit) behind a `…` where its head was
// cut, its matches marked.
export function railHitText(text, ranges) {
  const clip = clipRailHit(text, ranges)
  return html`${clip.clipped ? html`<span class="bundle-search-clip">…</span>` : nothing}${renderSearchMarks(clip.text, clip.ranges)}`
}

// Cut `text` to `max` chars starting at `from`, shifting the match
// ranges into the slice (spans cut by an edge are clamped, spans
// outside it dropped). `clipped` reports a cut head.
export function sliceSearchLine(text, ranges, from, max) {
  const slice = text.slice(from, from + max)
  if (from === 0) return { text: slice, ranges, clipped: false }
  const shifted = []
  for (const [s, e] of ranges) {
    const ns = s - from
    const ne = e - from
    if (ne <= 0 || ns >= slice.length) continue
    shifted.push([Math.max(0, ns), Math.min(slice.length, ne)])
  }
  return { text: slice, ranges: shifted, clipped: true }
}

// Wrap each matched span in a <mark>, leaving the rest as plain text
// nodes (Lit auto-escapes both). `ranges` are already clipped into
// `text`; spans are clamped + de-overlapped defensively.
export function renderSearchMarks(text, ranges) {
  if (ranges.length === 0) return text
  const out = []
  let pos = 0
  for (const [s, e] of ranges) {
    const cs = Math.max(pos, Math.min(s, text.length))
    const ce = Math.max(cs, Math.min(e, text.length))
    if (ce <= cs) continue
    if (cs > pos) out.push(text.slice(pos, cs))
    out.push(html`<mark class="bundle-search-mark">${text.slice(cs, ce)}</mark>`)
    pos = ce
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out
}
