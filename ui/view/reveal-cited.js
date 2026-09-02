// Putting a cited block of code where the reader can see it — shared
// by the focus view's code panel (focus-code.js) and the source
// previews on a finding card (finding-card.js), which scroll different
// boxes to the same rule.
//
// A finding citing `20-30` is pointing at the SPAN, so the span is
// what belongs in the middle of the box — not its opening line with
// the rest trailing off below, which is what aligning any single line
// gets you.
//
// Except when the block is as tall as the box or taller. Centring it
// then puts its start above the top edge and opens the reader
// somewhere in the middle of their own citation, so the scroll stops
// one line short of the block instead: the first cited line is what
// they came for, and a line of lead-in above it says the block starts
// here rather than continues here.
//
// `Math.min` is the whole rule — centring wins while it is the gentler
// of the two, and the clamp takes over exactly when it stops being.
// Both ends then clamp to the box's own scroll range, so a block at
// the top or bottom of the file settles against that edge.
//
// Deliberately not `scrollIntoView`: it can only align ONE element,
// which is how this ended up centred on the first line of a span in
// the first place. Writing the offset puts the block where it belongs
// in one go, and `behavior: 'instant'` keeps an arrow-key run-through
// from queueing a smooth animation per step.

export function revealCitedLines(scroller, rows) {
  if (!scroller || !rows || rows.length === 0) return
  const boxTop = scroller.getBoundingClientRect().top
  const first = rows[0].getBoundingClientRect()
  const last = rows.item ? rows.item(rows.length - 1).getBoundingClientRect() : first
  // Offsets within the scrolled content, not the viewport.
  const top = first.top - boxTop + scroller.scrollTop
  const bottom = last.bottom - boxTop + scroller.scrollTop
  const centred = top + (bottom - top) / 2 - scroller.clientHeight / 2
  scroller.scrollTo({ top: Math.max(0, Math.min(centred, top - first.height)), behavior: 'instant' })
}
