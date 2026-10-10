import { html, nothing } from 'lit'

// A column of a bundle's Overview (render-bundle.js) or a package's
// (npm-overview.js): its title and count in its head, `extra` after them and
// `tools` at the head's end; its `body`, a list's where `list`.
export function overviewColumn({ title, count, extra = nothing, tools = nothing, body, list = false, className = '' }) {
  return html`<section class=${`bundles-overview-col ${className}`}>
    <header class="bundles-overview-col-head">
      <span class="bundles-overview-col-title">${title} <span class="bundles-overview-col-count">${count}</span>${extra}</span>${tools}
    </header>
    <div class=${`bundles-overview-col-body${list ? ' bundles-overview-col-body--list' : ''}`}>${body}</div>
  </section>`
}
