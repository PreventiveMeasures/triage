// What a lazily loaded bundle (lazy-entry.js) draws: the template its
// caller hands over once the bundle is here, until then a placeholder
// where it goes, the load started once and the view rendered again when
// it lands; if it fails, the error with a Retry.
import { html } from 'lit'
import { lazyEntry } from './lazy-entry.js'
import { render } from './render.js'

export function lazyTemplate(path) {
  const entry = lazyEntry(path)
  let loading = false
  let error = null
  async function load() {
    loading = true
    try { await entry.load() } catch (err) { error = String(err?.message ?? err) }
    loading = false
    render()
  }
  const shown = template => {
    if (entry.module) return template()
    if (error) {
      return html`<div class="bundles-slide-placeholder is-error">Couldn’t load: ${error} <button type="button" @click=${() => { error = null; render() }}>Retry</button></div>`
    }
    if (!loading) void load()
    return html`<div class="bundles-slide-placeholder">Loading…</div>`
  }
  // Whether the bundle is here.
  shown.loaded = () => entry.module !== null
  return shown
}
