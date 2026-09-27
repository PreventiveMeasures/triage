import { css, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { HoverPreviewElement } from './hover-preview.js'
import { isHttpUrl } from '../../report/index.js'
import { parseGithubIssueUrl, parseGithubPrUrl } from '../../common/github-pr.ts'
import { managedFixes, subscribeFixes } from './managed-pull-requests.js'
import { GITHUB_ICON_SVG } from './icons.js'

const labels = { open: 'Open', draft: 'Draft', closed: 'Closed', merged: 'Merged', completed: 'Completed', not_planned: 'Not planned', duplicate: 'Duplicate', unknown: 'Closed' }
const prIcon = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="3" r="1.75"/><circle cx="4" cy="13" r="1.75"/><circle cx="12" cy="13" r="1.75"/><path d="M4 4.75v6.5M12 11.25V5a2 2 0 0 0-2-2H8m2-2L8 3l2 2"/></svg>`
const issueIcon = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>`
const completedIssueIcon = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="m5 8 2 2 4-4"/></svg>`
const notPlannedIssueIcon = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="m3.5 12.5 9-9"/></svg>`
const issueIcons = { completed: completedIssueIcon, not_planned: notPlannedIssueIcon }

class ManagedFixLink extends HoverPreviewElement {
  static properties = { url: { type: String }, compact: { type: Boolean, reflect: true } }
  static styles = [HoverPreviewElement.styles, css`
    :host { display: inline; word-break: normal; }
    a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; cursor: default; }
    .status { display: inline-flex; align-items: center; gap: .3em; vertical-align: text-bottom; margin-right: .35em; font-weight: 600; white-space: nowrap; }
    svg { flex: none; }
    /* GitHub Primer's foreground colors follow the app's color-scheme. */
    .open { color: light-dark(#1a7f37, #3fb950); }
    .draft, .not_planned, .duplicate, .unknown, .unavailable { color: var(--muted); }
    .closed { color: light-dark(#d1242f, #f85149); }
    .merged, .completed { color: light-dark(#8250df, #a371f7); }
    :host(:not([compact])) { display: block; }
    :host(:not([compact])) .fix-link { display: flex; align-items: center; gap: .55rem; min-width: 0; }
    .link-icon { flex: none; line-height: 1; }
    .link-icon svg { display: block; }
    .link-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 500; line-height: 1.5; }
    .link-icon.unavailable + .link-title { color: var(--accent); }
    .ref { min-width: 0; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .74rem; }
    .link-status { flex: none; padding: .15rem .4rem; border-radius: 999px; background: color-mix(in srgb, currentColor 10%, transparent); font-size: .7rem; font-weight: 500; line-height: 1.3; }
    :host([compact]) { display: inline-flex; }
    :host([compact]) .fix-link { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
    :host([compact]) .status { margin: 0; font-size: 1rem; line-height: 1; }
    .preview-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .preview-ref { display: inline-flex; align-items: center; gap: .4rem; min-width: 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
    .preview-ref span { min-width: 0; }
    .preview-description { margin-top: 8px; white-space: pre-wrap; }
    .preview-title { margin-top: 8px; font-size: 15px; font-weight: 600; line-height: 1.4; }
    .preview .preview-header .status { flex: none; margin: 0; font-size: 12px; line-height: 1.4; }
    @media print {
      /* Print uses normal text flow so neither the title/URL nor repo ref is clipped. */
      :host(:not([compact])) .fix-link { display: block; }
      .link-title, .ref { white-space: normal; overflow: visible; text-overflow: clip; max-width: none; }
      .link-icon { display: inline-block; vertical-align: middle; margin-right: .55rem; }
      .ref, .link-status { margin-left: .55rem; }
      .preview { display: none; }
    }
  `]

  constructor() {
    super()
    this.url = ''
    this.compact = false
    this.unsubscribe = null
  }

  connectedCallback() {
    super.connectedCallback()
    this.unsubscribe = subscribeFixes(() => this.requestUpdate())
    if (this.hasUpdated) this.requestUpdate()
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
    super.disconnectedCallback()
  }

  updated(changed) {
    // Editing the destination or switching to a full row dismisses the preview.
    if (changed.has('url') || changed.has('compact')) this._hidePreview()
    else super.updated(changed)
  }

  render() {
    if (!isHttpUrl(this.url)) return html`${this.url}`
    const pr = parseGithubPrUrl(this.url)
    const issue = !pr && parseGithubIssueUrl(this.url)
    const ref = pr || issue
    const data = managedFixes.read(this.url)
    if (!data && !ref) {
      const label = `Open fix link: ${this.url}`
      return html`<a class=${this.compact ? 'fix-link' : ''} href=${this.url} target="_blank" rel="noopener noreferrer"
        draggable="false" data-tooltip=${this.compact ? label : nothing} aria-label=${label}>
        ${this.compact ? html`<slot></slot>` : this.url}
      </a>`
    }
    const status = data ? issue && data.status === 'closed' ? data.stateReason ?? 'unknown' : data.status : 'unavailable'
    const icon = pr ? prIcon : issue ? issueIcons[status] ?? issueIcon : null
    const name = ref ? `${ref.repo}#${ref.number}` : ''
    const widePreview = (data?.title.length ?? 0) > 40 || (data?.description ?? '').split(/[\r\n]/u).some(line => line.length > 100)
    const description = data ? `${labels[status]} ${pr ? 'pull request' : 'issue'}: ${data.title} (${name})`
      : ref ? `Open ${pr ? 'pull request' : 'issue'}: ${name}` : `Open fix link: ${this.url}`
    return html`<a class="fix-link" href=${this.url} target="_blank" rel="noopener noreferrer" draggable="false" aria-label=${description}
      aria-details=${this.compact && ref ? 'fix-preview' : nothing} data-tooltip=${this.compact && !ref ? description : nothing}
      @mouseenter=${this._schedulePreview} @mouseleave=${this._leavePreview}
      @focus=${this._schedulePreview} @blur=${this._leavePreview} @click=${this._hidePreview}>
      ${this.compact
        ? icon ? html`<span class=${`status ${status}`}>${icon}</span>` : html`<slot></slot>`
        : html`${icon ? html`<span class=${`link-icon ${status}`}>${icon}</span>` : nothing}
          <span class="link-title">${data?.title ?? (name || this.url)}</span>
          ${data ? html`<span class="ref">${name}</span><span class=${`link-status ${status}`}>${labels[status]}</span>` : nothing}`}
    </a>${this.compact && ref ? html`<a class=${widePreview ? 'preview wide' : 'preview'} id="fix-preview" popover="manual" href=${this.url}
      target="_blank" rel="noopener noreferrer" draggable="false" aria-label=${`Open ${pr ? 'pull request' : 'issue'} ${name} on GitHub`}
      @mouseenter=${this._keepPreview} @mouseleave=${this._leavePreview}
      @focusin=${this._keepPreview} @focusout=${this._leavePreview}
      @click=${event => { event.stopPropagation(); this._hidePreview() }}>
      <div class="preview-header">
        <span class="preview-ref">${unsafeHTML(GITHUB_ICON_SVG)}<span>${name}</span></span>
        <span class=${`status ${status}`}>${icon}${data ? labels[status] : pr ? 'Pull request' : 'Issue'}</span>
      </div>
      ${data ? html`<div class="preview-title">${data.title}</div>` : nothing}
      ${data?.description ? html`<div class="preview-description">${data.description}</div>` : nothing}
    </a>` : nothing}`
  }
}

customElements.define('managed-fix-link', ManagedFixLink)
