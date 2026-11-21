// Viewport-proximity gate for the long lists' heavy items.
//
// A `<finding-card>` / `<finding-row>` is a shadow root of a hundred-odd
// nodes, one per dedup group; `content-visibility: auto` spares the style
// and layout of those off screen, but building all their DOM was the cost
// (seconds of a view-mode switch on two thousand). So they render an empty
// shell until they are near the viewport: one IntersectionObserver per
// scroll container, a viewport's margin above and below, building a card a
// screen before it scrolls in. The root must be the container that actually
// scrolls: `rootMargin` extends the ROOT's box, and a nested scroller clips
// what is outside it before the margin is consulted.
//
// Whoever registers says which element to watch (the flat list's
// `.flat-group` wrapper carries the box, finding-card.js) and is called
// with `near` on every change.

const MARGIN = '100% 0px'

// scroll root (an Element, or `document` for the viewport) → observer
const observers = new WeakMap()
// watched element → { cb, io }, `io` null until the batch below has
// resolved the element's scroll root and started observing it.
const watched = new WeakMap()
// Elements registered since the last batch ran.
let pending = []
let batchQueued = false
// element → whether it scrolls vertically, asked once per ancestor (a list
// connects thousands of items in one render). Never invalidated: a stale
// answer costs the lookahead margin, never the rendering.
const scrollerCache = new WeakMap()

function isScroller(el) {
  let v = scrollerCache.get(el)
  if (v === undefined) {
    const oy = getComputedStyle(el).overflowY
    v = oy === 'auto' || oy === 'scroll' || oy === 'overlay'
    scrollerCache.set(el, v)
  }
  return v
}

// The nearest ancestor that scrolls vertically, crossing shadow
// boundaries on the way up (a table row lives in `<finding-table>`'s
// shadow root, and the scroller is outside it). `null` for the
// viewport.
export function scrollRootOf(el) {
  let node = el.parentNode
  while (node) {
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      node = node.host ?? null
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node === document.documentElement) return null
    if (isScroller(node)) return node
    node = node.parentNode
  }
  return null
}

function onEntries(entries) {
  for (const entry of entries) {
    watched.get(entry.target)?.cb(entry.isIntersecting)
  }
}

function observerFor(root) {
  const key = root ?? document
  let io = observers.get(key)
  if (!io) {
    io = new IntersectionObserver(onEntries, { root, rootMargin: MARGIN, threshold: 0 })
    observers.set(key, io)
  }
  return io
}

// Start calling `cb(near)` for `target`: first with the observer's initial
// computation (within a frame), then on every crossing of the margin.
// Re-registering replaces the callback and re-resolves the scroll root (a
// reconnected item may sit under another scroller).
//
// The root is resolved a microtask after the registering render, not
// here: registration runs from `connectedCallback` mid-insert, where each
// computed-style question forces a style recalc over everything inserted
// so far (seconds, for a few hundred files). Batched, one recalc pays for
// all; the observer delivers its first answers in the frame either way.
export function watchNearViewport(target, cb) {
  const prev = watched.get(target)
  if (prev?.io) prev.io.unobserve(target)
  watched.set(target, { cb, io: null })
  pending.push(target)
  if (!batchQueued) {
    batchQueued = true
    queueMicrotask(observePending)
  }
}

function observePending() {
  batchQueued = false
  const batch = pending
  pending = []
  for (const target of batch) {
    const rec = watched.get(target)
    // Unwatched again before the batch ran, or registered twice in one
    // render and already observing from its first turn in the batch.
    if (!rec || rec.io) continue
    rec.io = observerFor(scrollRootOf(target))
    rec.io.observe(target)
  }
}

export function unwatchNearViewport(target) {
  const rec = watched.get(target)
  if (!rec) return
  rec.io?.unobserve(target)
  watched.delete(target)
}
