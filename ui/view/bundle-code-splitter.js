// Drag-to-resize handles of the Code view: <bundle-code-splitter> between
// the file tree and the code, by the tree's width, and <bundle-code-terminal-
// splitter> between the code and the terminal pane under it, by the pane's
// height. Each size is shared across Code-view mounts, but deliberately reset
// on page reload.

// What a handle resizes: the pane, the container it is measured in, the
// custom property its size reaches the layout through, and the axis it moves
// along — `grow` saying which way along it the pane gets bigger. `initial` is
// the size before any is chosen, from the container's; `preferred` the one
// chosen since.
const RAIL = {
  view: '.bundle-code-view', pane: '.bundle-code-rail', property: '--bundle-code-rail-width',
  // The pane before the handle: dragging right widens it.
  axis: 'x', grow: 1, keys: { ArrowLeft: -16, ArrowRight: 16 },
  initial: () => 320,
  bounds: size => ({ min: Math.min(180, size * .4), max: size * .6 }),
  preferred: null,
}
const TERMINAL = {
  view: '.bundle-code-main', pane: '.bundle-code-terminal', property: '--bundle-code-terminal-height',
  // The pane after the handle: dragging up heightens it.
  axis: 'y', grow: -1, keys: { ArrowUp: 16, ArrowDown: -16 },
  initial: size => size * .4,
  bounds: size => ({ min: Math.min(96, size * .4), max: size * .85 }),
  preferred: null,
}

class BundleCodeSplitter extends HTMLElement {
  static split = RAIL

  constructor() {
    super()
    this._split = this.constructor.split
    this._drag = null
    this.addEventListener('pointerdown', e => this._startDrag(e))
    this.addEventListener('pointermove', e => {
      if (this._drag?.id !== e.pointerId) return
      this._split.preferred = this._apply(this._drag.size + this._split.grow * (this._client(e) - this._drag.at))
    })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.addEventListener(type, e => {
        if (this._drag?.id === e.pointerId) this._endDrag()
      })
    }
    this.addEventListener('keydown', e => this._onKeyDown(e))
    this.addEventListener('dblclick', () => {
      this._split.preferred = null
      this._apply(this._preferred())
    })
  }

  connectedCallback() {
    this._view = this.closest(this._split.view)
    if (!this._view) return
    this._observer = new ResizeObserver(() => this._apply(this._preferred()))
    this._observer.observe(this._view)
    this._apply(this._preferred())
  }

  disconnectedCallback() {
    this._observer?.disconnect()
    this._endDrag()
    this._view = null
  }

  _client(e) { return this._split.axis === 'x' ? e.clientX : e.clientY }

  _measure(el) {
    const rect = el.getBoundingClientRect()
    return this._split.axis === 'x' ? rect.width : rect.height
  }

  _preferred() {
    return this._split.preferred ?? this._split.initial(this._view ? this._measure(this._view) : 0)
  }

  _bounds() {
    return this._split.bounds(this._measure(this._view))
  }

  _apply(size) {
    if (!this._view) return size
    const { min, max } = this._bounds()
    if (max === 0) return size
    const clamped = Math.max(min, Math.min(max, size))
    // Resize only the layout; rebuilding the source viewer on every move
    // would interrupt selections and needlessly re-render highlighted code.
    this._view.style.setProperty(this._split.property, `${clamped}px`)
    this.setAttribute('aria-valuemin', String(Math.round(min)))
    this.setAttribute('aria-valuemax', String(Math.round(max)))
    this.setAttribute('aria-valuenow', String(Math.round(clamped)))
    this.setAttribute('aria-valuetext', `${Math.round(clamped)} pixels`)
    return clamped
  }

  _paneSize() {
    return this._measure(this._view.querySelector(this._split.pane))
  }

  _startDrag(e) {
    if (e.button !== 0 || !e.isPrimary || this._drag || !this._view) return
    e.preventDefault()
    this._drag = { id: e.pointerId, at: this._client(e), size: this._paneSize() }
    this.setPointerCapture(e.pointerId)
    this.classList.add('dragging')
  }

  _endDrag() {
    if (!this._drag) return
    const { id } = this._drag
    this._drag = null
    this.classList.remove('dragging')
    if (this.hasPointerCapture(id)) this.releasePointerCapture(id)
  }

  _onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !this._view) return
    const { min, max } = this._bounds()
    const step = this._split.keys[e.key]
    const next = step === undefined ? { Home: min, End: max }[e.key] : this._paneSize() + step
    if (next === undefined) return
    e.preventDefault()
    e.stopPropagation()
    this._split.preferred = this._apply(next)
  }
}

customElements.define('bundle-code-splitter', BundleCodeSplitter)
customElements.define('bundle-code-terminal-splitter', class extends BundleCodeSplitter {
  static split = TERMINAL
})
