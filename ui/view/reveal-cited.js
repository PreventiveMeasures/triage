// Scroll a cited block of code into view — the focus view's code panel
// (focus-code.js) and a finding card's source previews (finding-card.js).
//
// A finding citing `20-30` points at the SPAN, so the span is centred —
// unless it is as tall as the box or taller, where centring would open the
// reader mid-citation: then the scroll stops one line short of it, a line
// of lead-in saying the block starts here. `Math.min` is the whole rule;
// both ends clamp to the box's scroll range. Not `scrollIntoView`, which
// aligns ONE element; `behavior: 'instant'` keeps an arrow-key run-through
// from queueing a smooth animation per step.
export function revealCitedLines(scroller, rows) {
  if (!scroller || !rows || rows.length === 0) return
  const boxTop = scroller.getBoundingClientRect().top
  const first = rows[0].getBoundingClientRect()
  const last = rows.item(rows.length - 1).getBoundingClientRect()
  // Offsets within the scrolled content, not the viewport.
  const top = first.top - boxTop + scroller.scrollTop
  const bottom = last.bottom - boxTop + scroller.scrollTop
  const centred = top + (bottom - top) / 2 - scroller.clientHeight / 2
  scroller.scrollTo({ top: Math.max(0, Math.min(centred, top - first.height)), behavior: 'instant' })
}
