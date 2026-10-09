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
import { bundleFileByteLength, bundleFilesAsMap } from './bundle-sources.js'
import { sourceFileIcon } from './source-file-icon.js'
import { diffRows, lineDiff } from './bundle-compare-code-model.js'
import { renameTemplate } from './bundle-compare-rename.js'
import { BundleCompareCode, KIND, isLargeDiff, prefs } from './bundle-compare-code.js'

export const COMBINED_DIFF_MAX = 8000

// The files the Diff view lists, by path: each one added, removed, changed
// or renamed, as the Code view's entries have them. A file whose only change
// is an import resolving elsewhere has no text that changed, so none of it
// shows here.
function combinedEntries(files) {
  const entries = []
  for (const row of files?.onlyBase ?? []) entries.push([row.path, { kind: 'removed', baseBytes: row.bytes, otherBytes: null }])
  for (const row of files?.onlyOther ?? []) entries.push([row.path, { kind: 'added', baseBytes: null, otherBytes: row.bytes }])
  for (const row of files?.changed ?? []) {
    entries.push([row.path, row.basePath == null ? { kind: 'changed', baseBytes: row.baseBytes, otherBytes: row.otherBytes }
      : { kind: 'renamed', basePath: row.basePath, modified: row.modified, baseBytes: row.baseBytes, otherBytes: row.otherBytes }])
  }
  return entries.toSorted(([a], [b]) => a.localeCompare(b))
}

function sides(base, other, path, entry) {
  return {
    before: entry.kind === 'added' ? '' : bundleFilesAsMap(base).get(entry.basePath ?? path),
    after: entry.kind === 'removed' ? '' : bundleFilesAsMap(other).get(path),
  }
}

// The rows the Diff view lists for a comparison, a head for each file and
// its diff's rows as they first show, counted up to `max`; and the line
// models found on the way, for the view to draw. Infinity where a file is
// too large to diff without being asked to.
export function combinedDiffRows(base, other, files, max = COMBINED_DIFF_MAX) {
  const models = new Map()
  let rows = 0
  for (const [path, entry] of combinedEntries(files)) {
    rows++
    const { before, after } = sides(base, other, path, entry)
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
  }

  // Nothing to keep in view: the list scrolls as the reader does.
  updated() {}

  _model(path, before, after) {
    if (!prefs.ignoreWhitespace && this.models?.has(path)) return this.models.get(path)
    return super._model(path, before, after)
  }

  render() {
    const entries = combinedEntries(this.files)
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
    const { before, after } = sides(this.base, this.other, path, entry)
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
