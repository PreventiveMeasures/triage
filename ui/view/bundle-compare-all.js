// `<bundle-compare-all>` — the Compare slide's Diff view: every file that
// differs, its review diff under its name, one after another in a single
// list, as `git diff` prints them. It is the Code view
// (bundle-compare-code.js) without its tree, drawing each diff the same way:
// unified or split, unchanged runs folded and expandable, syntax colored,
// changed words marked. Compare offers it only for a comparison it can list
// in fewer than COMBINED_DIFF_MAX rows (combinedDiffRows).
import { html, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { stripCommonPathPrefix } from './format.js'
import { diffRows, lineDiff } from './bundle-compare-code-model.js'
import { BundleCompareCode, diffCounts, fileContents, fileEntries, isLargeDiff } from './bundle-compare-code.js'

export const COMBINED_DIFF_MAX = 8000

// The files the Diff view lists, by path: each one added, removed, changed
// or renamed (fileEntries). A file whose only change is an import resolving
// elsewhere has no text that changed, so none of it shows here.
const combinedEntries = entries => [...entries].toSorted(([a], [b]) => a.localeCompare(b))

// The rows the Diff view lists for a comparison, a head for each file and
// its diff's rows as they first show, counted up to `max`; and the line
// models found on the way, for the view to draw. Infinity where a file is
// too large to diff without being asked to. Each file lists two rows at
// least, so one with too many files for `max` is told without a diff.
export function combinedDiffRows(base, other, files, max = COMBINED_DIFF_MAX) {
  const models = new Map()
  const entries = fileEntries(files)
  if (entries.size * 2 >= max) return { rows: Infinity, models }
  let rows = 0
  for (const [path, entry] of combinedEntries(entries)) {
    rows++
    const { before, after } = fileContents(base, other, path, entry)
    if (typeof before === 'string' && typeof after === 'string') {
      if (isLargeDiff(before, after)) return { rows: Infinity, models }
      const model = lineDiff(before, after)
      models.set(path, model)
      rows += Math.max(diffRows(model).length, 1)
    } else {
      rows++
    }
    if (rows >= max) break
  }
  return { rows, models }
}

class BundleCompareAll extends BundleCompareCode {
  static properties = { ...BundleCompareCode.properties, models: { attribute: false } }

  // Every file's model is drawn on every render, so all are kept for the
  // comparison, starting from those Compare found counting its rows.
  constructor() {
    super()
    this.models = null
    this._modelCap = Infinity
  }

  willUpdate(changed) {
    super.willUpdate(changed)
    if (changed.has('models')) for (const [path, model] of this.models ?? []) this._models.set(`${path}\0false`, model)
  }

  // Nothing to keep in view: the list scrolls as the reader does.
  updated() {}

  render() {
    const entries = combinedEntries(this._entries)
    const { prefix } = stripCommonPathPrefix(entries.map(([path]) => path))
    const shown = entries.map(([path, entry]) => ({ path, entry, file: this._fileState(path, entry) }))
    const additions = shown.reduce((sum, { file }) => sum + (file.model?.additions ?? 0), 0)
    const deletions = shown.reduce((sum, { file }) => sum + (file.model?.deletions ?? 0), 0)
    return html`<header class="bundle-code-main-bar bundle-compare-code-bar">
        <span class="bundle-compare-all-title">${entries.length.toLocaleString()} ${entries.length === 1 ? 'file' : 'files'} changed</span>
        ${additions + deletions > 0 ? diffCounts(additions, deletions) : nothing}
        ${prefix ? html`<span class="bundle-compare-all-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</span>` : nothing}
        <span class="bundle-code-main-spacer"></span>
        ${this._toggles(shown.some(({ file }) => file.model?.blocks.length > 0), shown.some(({ file }) => file.textual))}
      </header>
      <div class="bundle-compare-diff" tabindex="0" aria-label="Every change">
        ${entries.length === 0 ? html`<div class="bundle-code-placeholder">No files differ in this comparison.</div>`
          : repeat(shown, ({ path }) => path, ({ path, entry, file }) => html`<section class="bundle-compare-all-file" aria-label=${path}>
            <header class="bundle-code-main-bar bundle-compare-all-file-head">
              ${this._fileName(path, entry, prefix)}
              <span class="bundle-code-main-spacer"></span>
              ${this._fileFigures(entry, file.model)}
            </header>
            ${this._fileMessage(path, entry, file) ?? this._renderDiff(path, entry, file.model, file.before, file.after)}
          </section>`)}
      </div>`
  }
}

customElements.define('bundle-compare-all', BundleCompareAll)
