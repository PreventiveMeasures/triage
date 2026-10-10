// `<bundle-compare-all>` — the Compare slide's Diff view: every file that
// differs, its review diff under its name, one after another in a single
// list, as `git diff` prints them. It is the Code view
// (bundle-compare-code.js) without its tree, drawing each diff the same way:
// unified or split, unchanged runs folded and expandable, syntax colored,
// changed words marked. Compare offers it only for a comparison it can list
// in fewer than COMBINED_DIFF_MAX rows (combinedDiffRows).
import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { bundleFileByteLength } from './bundle-sources.js'
import { sourceFileIcon } from './source-file-icon.js'
import { diffRows, lineDiff } from './bundle-compare-code-model.js'
import { renameTemplate } from './bundle-compare-rename.js'
import { BundleCompareCode, KIND, fileContents, fileEntries, isLargeDiff, prefs } from './bundle-compare-code.js'

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

  constructor() {
    super()
    this.models = null
    this._all = new Map()
  }

  willUpdate(changed) {
    super.willUpdate(changed)
    if (['files', 'base', 'other', 'models'].some(name => changed.has(name))) this._all.clear()
  }

  // Nothing to keep in view: the list scrolls as the reader does.
  updated() {}

  // Every file's model is drawn on every render, so they are all kept for the
  // comparison, not the few the Code view keeps for the files it opens:
  // Compare's, found counting its rows, and those without whitespace.
  _model(path, before, after) {
    if (!prefs.ignoreWhitespace && this.models?.has(path)) return this.models.get(path)
    const key = `${path}\0${prefs.ignoreWhitespace}`
    if (!this._all.has(key)) this._all.set(key, lineDiff(before, after, { ignoreWhitespace: prefs.ignoreWhitespace }))
    return this._all.get(key)
  }

  render() {
    const entries = combinedEntries(this._entries)
    const { prefix } = stripCommonPathPrefix(entries.map(([path]) => path))
    const shown = entries.map(([path, entry]) => ({ path, entry, ...this._file(path, entry) }))
    const additions = shown.reduce((sum, file) => sum + (file.model?.additions ?? 0), 0)
    const deletions = shown.reduce((sum, file) => sum + (file.model?.deletions ?? 0), 0)
    return html`<div class="bundle-compare-all">
      <header class="bundle-code-main-bar bundle-compare-code-bar">
        <span class="bundle-compare-all-title">${entries.length.toLocaleString()} ${entries.length === 1 ? 'file' : 'files'} changed</span>
        ${additions + deletions > 0 ? html`<span class="bundle-compare-code-counts" aria-label=${`${additions} added, ${deletions} removed lines`}>
          <span class="add">+${additions.toLocaleString()}</span><span class="del">−${deletions.toLocaleString()}</span>
        </span>` : nothing}
        ${prefix ? html`<span class="bundle-compare-all-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</span>` : nothing}
        <span class="bundle-code-main-spacer"></span>
        ${this._toggles(shown.some(file => file.model?.blocks.length > 0), shown.some(file => file.textual))}
      </header>
      <div class="bundle-compare-diff bundle-compare-all-body" tabindex="0" aria-label="Every change">
        ${entries.length === 0 ? html`<div class="bundle-code-placeholder">No files differ in this comparison.</div>`
          : repeat(shown, file => file.path, file => this._renderEntry(file, prefix))}
      </div>
    </div>`
  }

  // A file's two sides, and its line model where it has one to draw.
  _file(path, entry) {
    const { before, after } = this._contents(path, entry)
    const textual = typeof before === 'string' && typeof after === 'string'
    const large = textual && !this._forced.has(path) && isLargeDiff(before, after)
    return { before, after, textual, large, model: textual && !large ? this._model(path, before, after) : null }
  }

  _renderEntry({ path, entry, before, after, textual, large, model }, prefix) {
    const { kind } = entry
    const strip = file => prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
    const size = value => formatBytes(value ?? 0)
    let body
    if (!textual) {
      const bytes = kind === 'added' ? size(bundleFileByteLength(after)) : kind === 'removed' ? size(bundleFileByteLength(before))
        : `${size(bundleFileByteLength(before))} → ${size(bundleFileByteLength(after))}`
      body = html`<div class="bundle-compare-code-message">Binary file ${kind} · ${bytes}. A text diff is not available.</div>`
    } else if (large) {
      body = html`<div class="bundle-compare-code-message">
        <p>This diff is large and may take a few seconds to compute.</p>
        <button type="button" class="bundle-compare-code-action" @click=${() => { this._forced.add(path); this.requestUpdate() }}>Show diff</button>
      </div>`
    } else if (model.blocks.length === 0) {
      body = html`<div class="bundle-compare-code-message">${prefs.ignoreWhitespace ? 'Only whitespace changed in this file.' : kind === 'renamed' ? 'Renamed without changes.' : 'The contents are the same.'}</div>`
    } else {
      body = this._renderDiff(path, entry, model, before, after)
    }
    return html`<section class="bundle-compare-all-file" aria-label=${strip(path)}>
      <header class="bundle-compare-all-file-head">
        <span class=${classMap({ 'bundle-compare-code-pill': true, [kind]: true, pure: kind === 'renamed' && !entry.modified })}>${KIND[kind].label}</span>
        ${sourceFileIcon(path, this._format(path))}
        <span class="bundle-code-main-path mono" data-tooltip-truncated data-tooltip=${entry.basePath ? `${entry.basePath} → ${path}` : path}>${entry.basePath ? renameTemplate(strip(entry.basePath), strip(path)) : strip(path)}</span>
        <span class="bundle-code-main-spacer"></span>
        ${model?.blocks.length > 0 ? html`<span class="bundle-compare-code-counts"><span class="add">+${model.additions.toLocaleString()}</span><span class="del">−${model.deletions.toLocaleString()}</span></span>` : nothing}
        <span class="bundle-code-main-stats">${kind === 'added' ? size(entry.otherBytes) : kind === 'removed' ? size(entry.baseBytes) : `${size(entry.baseBytes)} → ${size(entry.otherBytes)}`}</span>
      </header>
      ${body}
    </section>`
  }
}

customElements.define('bundle-compare-all', BundleCompareAll)
