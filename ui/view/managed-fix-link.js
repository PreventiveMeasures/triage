import { css, html, nothing } from 'lit'
import { StateElement } from '@rray/frontend/state-element'
import { isHttpUrl } from '../../report/index.js'
import { parseGithubIssueUrl, parseGithubPrUrl } from '../../common/github-pr.ts'
import { managedPullRequests, subscribePullRequests } from './managed-pull-requests.js'
import { hideTooltip, installShadowTooltipListener } from './tooltip.js'

const labels = { open: 'Open', draft: 'Draft', closed: 'Closed', merged: 'Merged' }
const prIcon = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="3" r="1.75"/><circle cx="4" cy="13" r="1.75"/><circle cx="12" cy="13" r="1.75"/><path d="M4 4.75v6.5M12 11.25V5a2 2 0 0 0-2-2H8m2-2L8 3l2 2"/></svg>`
const issueIcon = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>`

class ManagedFixLink extends StateElement {
  static properties = { url: { type: String }, compact: { type: Boolean, reflect: true } }
  static styles = css`
    :host { display: inline; word-break: normal; }
    a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; cursor: default; }
    .status { display: inline-flex; align-items: center; gap: .3em; vertical-align: text-bottom; margin-right: .35em; font-weight: 600; white-space: nowrap; }
    svg { flex: none; }
    /* GitHub Primer's foreground colors follow the app's color-scheme. */
    .open { color: light-dark(#1a7f37, #3fb950); }
    .draft { color: var(--muted); }
    .closed { color: light-dark(#d1242f, #f85149); }
    .merged { color: light-dark(#8250df, #a371f7); }
    .unknown { color: var(--muted); }
    :host(:not([compact])) { display: block; }
    :host(:not([compact])) .fix-link { display: flex; align-items: center; gap: .55rem; min-width: 0; }
    .link-icon { flex: none; line-height: 1; }
    .link-icon svg { display: block; }
    .link-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 500; line-height: 1.5; }
    .ref { min-width: 0; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .74rem; }
    .link-status { flex: none; padding: .15rem .4rem; border-radius: 999px; background: color-mix(in srgb, currentColor 10%, transparent); font-size: .7rem; font-weight: 500; line-height: 1.3; }
    :host([compact]) { display: inline-flex; }
    :host([compact]) .fix-link { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
    :host([compact]) .status { margin: 0; font-size: 1rem; line-height: 1; }
    .preview {
      position: fixed; inset: auto; margin: 0; padding: 14px; box-sizing: border-box;
      width: min(24rem, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto;
      border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text);
      box-shadow: 0 8px 28px rgb(0 0 0 / .25); font: 13px/1.45 system-ui, sans-serif;
      text-align: left; white-space: normal; overflow-wrap: anywhere; letter-spacing: normal; cursor: default;
    }
    .preview-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .preview-ref { min-width: 0; color: var(--muted); font-size: 12px; }
    .preview-title { margin-top: 8px; font-size: 15px; font-weight: 600; line-height: 1.4; }
    .preview .preview-header .status { flex: none; margin: 0; font-size: 12px; line-height: 1.4; }
  `

  constructor() {
    super()
    this.url = ''
    this.compact = false
    this.unsubscribe = null
    this.showTimer = null
    this.hideTimer = null
  }

  connectedCallback() {
    super.connectedCallback()
    this.unsubscribe = subscribePullRequests(() => this.requestUpdate())
    installShadowTooltipListener(this.renderRoot)
    if (this.hasUpdated) this.requestUpdate()
  }

  disconnectedCallback() {
    this._hidePreview()
    this.unsubscribe?.()
    this.unsubscribe = null
    super.disconnectedCallback()
  }

  updated(changed) {
    // Editing the destination or switching to a full row dismisses the preview.
    if (changed.has('url') || changed.has('compact')) this._hidePreview()
    else if (this.renderRoot.querySelector('.preview')?.matches(':popover-open')) this._positionPreview()
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
      this.renderRoot.querySelector('.fix-link').focus({ preventScroll: true })
    }
    this._hidePreview()
  }

  _previewScroll = event => {
    if (!event.composedPath().includes(this.renderRoot.querySelector('.preview'))) this._hidePreview()
  }

  _positionPreview() {
    const preview = this.renderRoot.querySelector('.preview')
    const anchor = this.renderRoot.querySelector('a').getBoundingClientRect()
    const { width, height } = preview.getBoundingClientRect()
    const gap = 8, margin = 12
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))
    const top = anchor.bottom + gap + height <= window.innerHeight - margin
      ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - height)
    preview.style.left = `${left}px`
    preview.style.top = `${top}px`
  }

  render() {
    if (!isHttpUrl(this.url)) return html`${this.url}`
    const pr = parseGithubPrUrl(this.url)
    const issue = !pr && parseGithubIssueUrl(this.url)
    const data = managedPullRequests.read(this.url)
    const ref = pr || issue
    const icon = pr ? prIcon : issue ? issueIcon : null
    const name = ref ? `${ref.repo}#${ref.number}` : ''
    const description = data ? `${labels[data.status]} pull request: ${data.title} (${name})`
      : ref ? `Open ${pr ? 'pull request' : 'issue'}: ${name}` : `Open fix link: ${this.url}`
    return html`<a class="fix-link" href=${this.url} target="_blank" rel="noopener noreferrer" draggable="false" aria-label=${description}
      aria-details=${this.compact && ref ? 'fix-preview' : nothing} data-tooltip=${this.compact && !ref ? description : nothing}
      @mouseenter=${this._schedulePreview} @mouseleave=${this._leavePreview}
      @focus=${this._schedulePreview} @blur=${this._leavePreview} @click=${this._hidePreview}>
      ${this.compact
        ? icon ? html`<span class=${`status ${data?.status ?? 'unknown'}`}>${icon}</span>` : html`<slot></slot>`
        : html`${icon ? html`<span class=${`link-icon ${data?.status ?? 'unknown'}`}>${icon}</span>` : nothing}
          <span class="link-title">${data?.title ?? this.url}</span>
          ${data ? html`<span class="ref">${name}</span><span class=${`link-status ${data.status}`}>${labels[data.status]}</span>` : nothing}`}
    </a>${this.compact && ref ? html`<a class="preview" id="fix-preview" popover="manual" href=${this.url}
      target="_blank" rel="noopener noreferrer" draggable="false" aria-label=${`Open ${pr ? 'pull request' : 'issue'} ${name} on GitHub`}
      @mouseenter=${this._keepPreview} @mouseleave=${this._leavePreview}
      @focusin=${this._keepPreview} @focusout=${this._leavePreview}
      @click=${event => { event.stopPropagation(); this._hidePreview() }}>
      <div class="preview-header">
        <span class="preview-ref">${name}</span>
        <span class=${`status ${data?.status ?? 'unknown'}`}>${icon}${data ? labels[data.status] : nothing}</span>
      </div>
      ${data ? html`<div class="preview-title">${data.title}</div>` : nothing}
    </a>` : nothing}`
  }
}

customElements.define('managed-fix-link', ManagedFixLink)
