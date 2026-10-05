import { LitElement, html, nothing } from 'lit'
import { guard } from 'lit/directives/guard.js'
import { until } from 'lit/directives/until.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'

let loadPromise
function loadMarkdown() {
  // A separate build entry, like prism.js: loading the list never loads the parser.
  const path = './markdown.js'
  return loadPromise ??= import(path).catch(error => { loadPromise = null; throw error })
}

class AdvisoryDetails extends LitElement {
  static properties = { markdown: { attribute: false }, url: { attribute: false }, _open: { state: true } }
  constructor() { super(); this._open = false }
  createRenderRoot() { return this }
  render() {
    const { markdown, url } = this
    return html`<details @toggle=${event => { this._open = event.currentTarget.open }}>
      <summary>Details</summary>
      <div class="advisory-markdown">${guard([this._open, markdown, url], () => this._open ? until(
        loadMarkdown().then(module => unsafeHTML(module.renderMarkdown(markdown, url)))
          .catch(() => html`<p>Could not format details. Close and reopen to retry.</p><pre>${markdown}</pre>`),
        html`<span role="status">Loading details…</span>`,
      ) : nothing)}</div>
    </details>`
  }
}
customElements.define('advisory-details', AdvisoryDetails)
