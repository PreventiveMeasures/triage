// Compare's own bundle (ui/compare.js): a bundle's Compare tab
// (`<bundle-compare>`), an npm package's Review tab (`<npm-review>`) and My
// reviews (`<dependency-review-list>`), out of view.js until one of them opens.
import { html } from 'lit'
import { lazyEntry } from './lazy-entry.js'
import { render } from './render.js'

const compare = lazyEntry('./compare.js')
let loading = false
let error = null

async function load() {
  loading = true
  try { await compare.load() } catch (err) { error = String(err?.message ?? err) }
  loading = false
  render()
}

// `template()` once the bundle is here. Until then a placeholder where it
// goes, the load started once and the view rendered again when it lands; if
// it fails, the error with a Retry.
export function withCompare(template) {
  if (compare.module) return template()
  if (error) {
    return html`<div class="bundles-slide-placeholder is-error">Couldn’t load: ${error} <button type="button" @click=${() => { error = null; render() }}>Retry</button></div>`
  }
  if (!loading) void load()
  return html`<div class="bundles-slide-placeholder">Loading…</div>`
}
