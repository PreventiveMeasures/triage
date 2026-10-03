import { css } from 'lit'
import { StateElement } from '@rray/frontend/state-element'
import { hideTooltip, installShadowTooltipListener } from './tooltip.js'

// Shared positioning and hover/focus behavior for Kanban action previews.
export class HoverPreviewElement extends StateElement {
  static styles = css`
    .preview {
      position: fixed; inset: auto; margin: 0; padding: 14px; box-sizing: border-box;
      width: min(24rem, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto;
      border: 1px solid var(--border); border-radius: var(--ui-radius, 10px); background: var(--bg); color: var(--text);
      box-shadow: 0 8px 28px rgb(0 0 0 / .25); font: 13px/1.45 system-ui, sans-serif;
      text-align: left; white-space: normal; overflow-wrap: anywhere; letter-spacing: normal; cursor: default;
    }
    .preview.wide { width: min(36rem, calc(100vw - 24px)); }
    @media print { .preview { display: none; } }
  `

  constructor() {
    super()
    this.showTimer = null
    this.hideTimer = null
  }

  connectedCallback() {
    super.connectedCallback()
    installShadowTooltipListener(this.renderRoot)
  }

  disconnectedCallback() {
    this._hidePreview()
    super.disconnectedCallback()
  }

  updated() {
    const preview = this.renderRoot.querySelector('.preview')
    if (!preview) this._hidePreview()
    else if (preview.matches(':popover-open')) this._positionPreview()
  }

  _schedulePreview() {
    clearTimeout(this.hideTimer)
    clearTimeout(this.showTimer)
    if (!this.renderRoot.querySelector('.preview')) return
    this.showTimer = setTimeout(() => {
      if (!this.isConnected) return
      const preview = this.renderRoot.querySelector('.preview')
      if (!preview) return
      hideTooltip()
      preview.showPopover()
      this._positionPreview()
      document.addEventListener('keydown', this._previewKeyDown, true)
      window.addEventListener('scroll', this._previewScroll, true)
      window.addEventListener('resize', this._hidePreview)
    }, 150)
  }

  _keepPreview() {
    clearTimeout(this.hideTimer)
  }

  _leavePreview() {
    clearTimeout(this.showTimer)
    clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      if (!this.renderRoot.querySelector('.preview')?.contains(this.renderRoot.activeElement)) this._hidePreview()
    }, 150)
  }

  _hidePreview = () => {
    clearTimeout(this.showTimer)
    clearTimeout(this.hideTimer)
    const preview = this.renderRoot?.querySelector('.preview')
    if (preview?.matches(':popover-open')) preview.hidePopover()
    document.removeEventListener('keydown', this._previewKeyDown, true)
    window.removeEventListener('scroll', this._previewScroll, true)
    window.removeEventListener('resize', this._hidePreview)
  }

  _previewKeyDown = event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (this.renderRoot.querySelector('.preview')?.contains(this.renderRoot.activeElement)) {
      this.renderRoot.querySelector('[aria-details]').focus({ preventScroll: true })
    }
    this._hidePreview()
  }

  _previewScroll = event => {
    if (!event.composedPath().includes(this.renderRoot.querySelector('.preview'))) this._hidePreview()
  }

  _positionPreview() {
    const preview = this.renderRoot.querySelector('.preview')
    const anchor = this.renderRoot.querySelector('[aria-details]').getBoundingClientRect()
    const { width, height } = preview.getBoundingClientRect()
    const gap = 8, margin = 12
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))
    const top = anchor.bottom + gap + height <= window.innerHeight - margin
      ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - height)
    preview.style.left = `${left}px`
    preview.style.top = `${top}px`
  }

}
