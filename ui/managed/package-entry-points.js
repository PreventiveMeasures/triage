import { html, nothing } from 'lit'

export function packageEntryPointSuggestions(paths, selected, apply) {
  const pending = paths.filter(path => !selected.has(path))
  if (pending.length === 0) return nothing
  return html`<aside class="package-suggestions" aria-label="Suggested entry points">
    <div><p>Entry points declared in <code>package.json</code></p>
      <ul>${pending.map(path => html`<li><code data-tooltip=${path}>${path}</code></li>`)}</ul>
    </div><button type="button" class="btn" @click=${() => apply(pending)}>Use suggestions</button>
  </aside>`
}
