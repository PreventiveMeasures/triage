// A dependency's row, as Compare lists them: in its Overview's Dependencies
// section (bundle-compare.js) and over package.json's diff in Code
// (bundle-compare-code.js). Its name, its kind where it isn't a plain one,
// and its range, or a changed one's old and new ranges; a button where `open`
// (a source's openDependency) can open it.
import { html, nothing } from 'lit'

export function compareDependencyRow(row, open) {
  const cells = html`<span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${row.name}>${row.name}</span>
    ${row.kind ? html`<span class="npm-dependency-kind">${row.kind}</span>` : nothing}
    ${'from' in row ? html`<span class="bundle-compare-ver" aria-label=${`Changed: ${row.from} to ${row.to}`}>
        <span class="bundle-compare-ver-from">${row.from}</span>
        <span class="bundle-compare-ver-arrow" aria-hidden="true">→</span>
        <span class="bundle-compare-ver-to changed">${row.to}</span>
      </span>`
      : html`<span class="bundle-compare-dep-ver" data-tooltip-truncated data-tooltip=${row.range}>${row.range}</span>`}`
  return open && row.opens
    ? html`<button type="button" class="bundle-compare-row bundle-compare-row-link" @click=${() => open(row)}>${cells}</button>`
    : html`<div class="bundle-compare-row">${cells}</div>`
}
