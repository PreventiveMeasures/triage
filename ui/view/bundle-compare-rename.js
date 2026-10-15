// A renamed file's label for Compare's Overview and Code views:
// `src/{a.js → a.ts}`, what changed colored — the old part red, the new
// green (see renameParts).
import { html } from 'lit'
import { renameParts } from '@preventive/compare/view.js'

export function renameTemplate(from, to) {
  const { head, from: before, to: after, tail } = renameParts(from, to)
  return html`${head}{<span class="bundle-compare-rename-from">${before}</span> → <span class="bundle-compare-rename-to">${after}</span>}${tail}`
}

// Where the base bundle's files sit and where the other's do, as rootLabel
// reads them: `./ → ./src/`, the old place red, the new green.
export function rootTemplate({ from, to }) {
  return html`<span class="bundle-compare-rename-from">${from}</span> → <span class="bundle-compare-rename-to">${to}</span>`
}
