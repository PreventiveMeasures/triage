// Shared across Code-view mounts, but deliberately reset on page reload.
const DEFAULT_WIDTH = 320
let preferredWidth = DEFAULT_WIDTH

class BundleCodeSplitter extends HTMLElement {
  constructor() {
    super()
    this._drag = null
    this.addEventListener('pointerdown', e => this._startDrag(e))
    this.addEventListener('pointermove', e => {
      if (this._drag?.id !== e.pointerId) return
      preferredWidth = this._apply(this._drag.width + e.clientX - this._drag.x)
    })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.addEventListener(type, e => {
        if (this._drag?.id === e.pointerId) this._endDrag()
      })
    }
    this.addEventListener('keydown', e => this._onKeyDown(e))
    this.addEventListener('dblclick', () => {
      preferredWidth = DEFAULT_WIDTH
      this._apply(preferredWidth)
    })
  }

  connectedCallback() {
    this._view = this.closest('.bundle-code-view')
    if (!this._view) return
    this._observer = new ResizeObserver(() => this._apply(preferredWidth))
    this._observer.observe(this._view)
    this._apply(preferredWidth)
  }

  disconnectedCallback() {
    this._observer?.disconnect()
    this._endDrag()
    this._view = null
  }

  _bounds() {
    const width = this._view.getBoundingClientRect().width
    return { min: Math.min(180, width * .4), max: width * .6 }
  }

  _apply(width) {
    if (!this._view) return width
    const { min, max } = this._bounds()
    if (max === 0) return width
    const clamped = Math.max(min, Math.min(max, width))
    // Resize only the layout; rebuilding the source viewer on every move
    // would interrupt selections and needlessly re-render highlighted code.
    this._view.style.setProperty('--bundle-code-rail-width', `${clamped}px`)
    this.setAttribute('aria-valuemin', String(Math.round(min)))
    this.setAttribute('aria-valuemax', String(Math.round(max)))
    this.setAttribute('aria-valuenow', String(Math.round(clamped)))
    this.setAttribute('aria-valuetext', `${Math.round(clamped)} pixels`)
    return clamped
  }

  _startDrag(e) {
    if (e.button !== 0 || !e.isPrimary || this._drag || !this._view) return
    e.preventDefault()
    const width = this._view.querySelector('.bundle-code-rail').getBoundingClientRect().width
    this._drag = { id: e.pointerId, x: e.clientX, width }
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
    const width = this._view.querySelector('.bundle-code-rail').getBoundingClientRect().width
    const { min, max } = this._bounds()
    const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: min, End: max }[e.key]
    if (next === undefined) return
    e.preventDefault()
    e.stopPropagation()
    preferredWidth = this._apply(next)
  }
}

customElements.define('bundle-code-splitter', BundleCodeSplitter)
