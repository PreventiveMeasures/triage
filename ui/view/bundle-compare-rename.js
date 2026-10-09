// A renamed file's label for Compare's Overview and Code views:
// `src/{a.js → a.ts}`, what changed colored — the old part red, the new
// green (see renameParts).
import { html } from 'lit'
import { renameParts } from './bundle-compare-diff.js'

export function renameTemplate(from, to) {
  const { head, from: before, to: after, tail } = renameParts(from, to)
  return html`${head}{<span class="bundle-compare-rename-from">${before}</span> → <span class="bundle-compare-rename-to">${after}</span>}${tail}`
}
