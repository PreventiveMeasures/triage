// Keep the unboxed titlebar only while the entire bundle header fits in it.
// Measuring the compact layout first avoids a resize threshold that depends on
// whether the previous frame happened to have the panel's padding and border.
class BundleSlideHeader extends HTMLElement {
  connectedCallback() {
    this._schedule = () => {
      if (!this._frame) this._frame = requestAnimationFrame(() => this._update())
    }
    this._resize = new ResizeObserver(this._schedule)
    this._resize.observe(this)
    this._mutation = new MutationObserver(this._schedule)
    this._mutation.observe(this, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] })
    this._mode = matchMedia('(display-mode: window-controls-overlay)')
    this._mode.addEventListener('change', this._schedule)
    navigator.windowControlsOverlay?.addEventListener('geometrychange', this._schedule)
    this._schedule()
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._frame)
    this._frame = 0
    this._resize.disconnect()
    this._mutation.disconnect()
    this._mode.removeEventListener('change', this._schedule)
    navigator.windowControlsOverlay?.removeEventListener('geometrychange', this._schedule)
  }

  _update() {
    this._frame = 0
    this.classList.remove('boxed')
    const bar = this.querySelector('.bundles-slide-bar')
    if (!bar) return
    this._resize.observe(bar)
    const tabs = this.querySelector('.bundles-slide-tabs')
    if (tabs) this._resize.observe(tabs)
    // The float exists only in collapsed PWA mode; its computed height also
    // handles the native titlebar changing size without a viewport resize.
    const titlebarHeight = parseFloat(getComputedStyle(this, '::before').height) || 0
    if (!titlebarHeight) return
    const headerRect = this.getBoundingClientRect()
    const barRect = bar.getBoundingClientRect()
    this.classList.toggle('boxed', barRect.top > headerRect.top + 1 || barRect.height > titlebarHeight + 1)
  }
}

customElements.define('bundle-slide-header', BundleSlideHeader)
