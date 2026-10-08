import { html, nothing } from 'lit'

export function packageEntryPointSuggestions(paths, selected, apply) {
  return entryPointSuggestions(paths, selected, apply, html`Entry points declared in <code>package.json</code>`, 'Suggested entry points')
}

export function solidityEntryPointSuggestions(paths, selected, apply, limited) {
  return entryPointSuggestions(paths, selected, apply, 'Suggested Solidity sources', 'Suggested Solidity sources', limited)
}

function entryPointSuggestions(paths, selected, apply, label, name, limited = false) {
  const pending = paths.filter(path => !selected.has(path))
  if (pending.length === 0 && !limited) return nothing
  return html`<aside class="package-suggestions" aria-label=${name}>
    <div><p>${label}</p>
      ${pending.length > 0 ? html`<ul>${pending.map(path => html`<li><code data-tooltip-truncated data-tooltip=${path}>${path}</code></li>`)}</ul>` : nothing}
      ${limited ? html`<p class="suggestions-note ui-hint">Suggestions are limited. Browse the source directories to select more files.</p>` : nothing}
    </div>${pending.length > 0 ? html`<button type="button" class="btn" @click=${() => apply(pending)}>Use suggestions</button>` : nothing}
  </aside>`
}
