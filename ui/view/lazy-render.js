// Viewport-proximity gate for the long lists' heavy items.
//
// A `<finding-card>` / `<finding-row>` is a shadow root holding a
// hundred-odd nodes, and the list / grouped / table surfaces hold one
// per dedup group — thousands, for a big report. `content-visibility:
// auto` (findings.css, finding-table.css) already spares the engine
// the style / layout / paint of the ones off screen, but the DOM still
// had to be BUILT for all of them, and that was the cost: a view-mode
// switch, a cleared search or a re-sort cloned every card's template
// before the first frame could paint, seconds of it on a list of two
// thousand.
//
// So the items ask here whether they are anywhere near the viewport,
// and render an empty shell until they are. One IntersectionObserver
// per scroll container, with a margin of one viewport above and below
// it, so a card is built a screen before it scrolls into view rather
// than as it arrives. The root has to be the container that actually
// scrolls — `rootMargin` extends the ROOT's box, and an element outside
// a nested scroller's box is clipped to nothing before the margin is
// ever consulted, so the document viewport gives no lookahead inside
// `#findings-body-slot` or `.findings-table-list`.
//
// The observed element may be the item's wrapper rather than the item
// (the flat list's `.flat-group` carries the `content-visibility` and
// the box the observer needs; see finding-card.js): whoever registers
// says which element to watch, and gets called with `near` on every
// change.

const MARGIN = '100% 0px'

// scroll root (an Element, or `document` for the viewport) → observer
const observers = new WeakMap()
// watched element → { cb, io }, `io` null until the batch below has
// resolved the element's scroll root and started observing it.
const watched = new WeakMap()
// Elements registered since the last batch ran.
let pending = []
let batchQueued = false
// element → whether it is a vertical scroll container. Cached because
// the walk below runs once per item per connect, and a list connects
// thousands of items in one render; the handful of distinct ancestors
// are asked once. Never invalidated: an ancestor's overflow doesn't
// change under a running list, and a stale answer only costs the
// lookahead margin, never the rendering itself.
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

// Start calling `cb(near)` for `target`. The first call comes with the
// observer's initial computation (within a frame), and then on every
// crossing of the margin. Re-registering an element that is already
// watched replaces its callback and re-resolves its scroll root — a
// reconnected item may have landed under a different scroller.
//
// The root is resolved in a batch, one microtask after the render that
// registered the element, not here. Registration happens from
// `connectedCallback`, in the middle of Lit inserting the list, and
// resolving the root means asking for computed style: asked then, each
// answer forces a style recalc over everything inserted so far, and a
// grouped list of a few hundred files spent seconds in exactly that.
// Asked once the render is over, the first question pays for one
// recalc and the rest read a clean tree. The observer computes its
// first intersections in the rendering steps of the frame either way,
// so nothing is delivered later for the wait.
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
