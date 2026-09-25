import { css, html, nothing } from 'lit'
import { StateElement } from '@rray/frontend/state-element'
import { isHttpUrl } from '../../report/index.js'
import { parseGithubPrUrl } from '../../common/github-pr.ts'
import { managedPullRequests, subscribePullRequests } from './managed-pull-requests.js'
import { installShadowTooltipListener } from './tooltip.js'

const labels = { open: 'Open', draft: 'Draft', closed: 'Closed', merged: 'Merged' }
const symbols = { open: '○', draft: '◌', closed: '×', merged: '✓' }

class ManagedFixLink extends StateElement {
  static properties = { url: { type: String }, compact: { type: Boolean, reflect: true } }
  static styles = css`
    :host { display: inline; word-break: normal; }
    a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
    a:hover { text-decoration: underline; }
    .status { display: inline-block; margin-right: .35em; font-weight: 600; white-space: nowrap; }
    .open { color: var(--green); }
    .draft { color: var(--muted); }
    .closed { color: var(--high); }
    .merged { color: var(--accent); }
    .ref { color: var(--muted); font-size: .9em; margin-left: .35em; }
    :host([compact]) { display: inline-flex; }
    :host([compact]) a { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
    :host([compact]) .status { margin: 0; font-size: 1rem; line-height: 1; }
  `

  constructor() {
    super()
    this.url = ''
    this.compact = false
    this.unsubscribe = null
  }

  connectedCallback() {
    super.connectedCallback()
    this.unsubscribe = subscribePullRequests(() => this.requestUpdate())
    installShadowTooltipListener(this.renderRoot)
    if (this.hasUpdated) this.requestUpdate()
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
    super.disconnectedCallback()
  }

  render() {
    if (!isHttpUrl(this.url)) return html`${this.url}`
    const data = managedPullRequests.read(this.url)
    const ref = data && parseGithubPrUrl(this.url)
    const name = ref ? `${ref.repo}#${ref.number}` : ''
    const description = data ? `${labels[data.status]}: ${data.title} (${name})` : `Open fix link: ${this.url}`
    return html`<a href=${this.url} target="_blank" rel="noopener noreferrer" draggable="false" aria-label=${description} data-tooltip=${description}>
      ${data ? html`<span class=${`status ${data.status}`}>${symbols[data.status]}${this.compact ? nothing : ` ${labels[data.status]}`}</span>` : nothing}
      ${this.compact ? (data ? nothing : html`<slot></slot>`) : data
        ? html`${data.title}<span class="ref">${name}</span>` : this.url}
    </a>`
  }
}

customElements.define('managed-fix-link', ManagedFixLink)
