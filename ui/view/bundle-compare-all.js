// `<bundle-compare-all>` — Compare's Code for a comparison short enough to
// read whole (fewer than COMBINED_DIFF_MAX rows, combinedDiffRows): every
// file's diff one after another, as `git diff` prints them, beside the tree
// of bundle-compare-code.js, which follows the list as it scrolls; picking a
// file scrolls to it. Files are drawn FILE_BATCH at a time, more as the list
// nears its end or one past them is opened.
import { html, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { diffRows, lineDiff } from './bundle-compare-code-model.js'
import { fileContents, fileEntries } from './bundle-compare-files.js'
import { BundleCompareCode, diffCounts, importerText, isLargeDiff, modelKey, prettyToggle } from './bundle-compare-code.js'

export const COMBINED_DIFF_MAX = 25_000
// Files drawn at a time, as Review's whole diff draws them.
const FILE_BATCH = 40

// The rows the list shows, a head and its first-shown diff rows for each file,
// two for each import resolution that differs and a head for an importer with
// no other change, counted up to `max`; and the line models found on the way.
// Infinity where a file is too large to diff unasked.
export function combinedDiffRows(base, other, files, { resolutions = [], max = COMBINED_DIFF_MAX } = {}) {
  const models = new Map()
  const entries = fileEntries(files)
  if (entries.size * 2 >= max) return { rows: Infinity, models }
  const importers = new Set(resolutions.map(row => row.parent).filter(path => !entries.has(path)))
  let rows = resolutions.length * 2 + importers.size
  for (const [path, entry] of [...entries].toSorted(([a], [b]) => a.localeCompare(b))) {
    rows++
    const { before, after } = fileContents(base, other, path, entry)
    // Its bytes the same (renamed, or recorded otherwise): a line saying so, however large.
    if (entry.modified === false) {
      rows++
    } else if (typeof before === 'string' && typeof after === 'string') {
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

export class BundleCompareAll extends BundleCompareCode {
  static properties = { ...BundleCompareCode.properties, models: { attribute: false } }

  // Every file's model is drawn on every render, so all are kept, starting
  // from those Compare found counting its rows.
  constructor() {
    super()
    this.models = null
    this._modelCap = Infinity
    this._fileLimit = FILE_BATCH
  }

  // Every file's renamed-names diff comes from its comparison's, asked at once (rename-diff.js).
  _renamesAlone = false

  willUpdate(changed) {
    super.willUpdate(changed)
    if (changed.has('models')) {
      for (const [path, model] of this.models ?? []) {
        const entry = this._entries.get(path)
        if (!entry) continue
        const { before, after } = fileContents(this.base, this.other, path, entry)
        this._models.set(modelKey(path, false, { ignoreWhitespace: false, ignoreRenames: false }), { inputs: [before, after, null], value: model })
      }
    }
    // A new comparison starts from its first files.
    if (changed.has('files')) {
      this._fileLimit = FILE_BATCH
      this._current = this._picked = null
    }
    // A file opened from elsewhere, or picked before the comparison changed,
    // is scrolled to; else a new comparison shows from its top.
    if ((changed.has('path') || changed.has('files')) && this.path && this.path !== this._current) this._goTo = this.path
    if (changed.has('files')) this._toTop = true
  }

  // The rail's file at the top of the list, kept in view in the rail.
  updated() {
    const opened = this._goTo && this._section(this._goTo)
    if (opened) {
      this._picked = this._goTo
      opened.scrollIntoView({ block: 'start' })
    } else if (this._toTop) {
      // A new comparison without it shows from its top.
      const body = this.querySelector('.bundle-compare-diff')
      if (body) body.scrollTop = 0
    }
    this._goTo = null
    this._toTop = false
    if (this._current !== this._shownPath) {
      this._shownPath = this._current
      this.querySelector('.bundle-compare-code-tree .bundle-code-tree-link.current')?.scrollIntoView({ block: 'nearest' })
    }
    this._scrollSought()
  }

  // A file picked in the rail: the list scrolls its head to the top (unless
  // `scroll` is false, as a search hit scrolls to its line), the rail's while
  // it is in view though the list ends too soon to bring it to the top.
  _select(path, scroll = true) {
    if (!path || this.extensions?.canSelect?.() === false) return
    this._current = this._picked = path
    this.requestUpdate()
    if (scroll) void this.updateComplete.then(() => this._section(path)?.scrollIntoView({ block: 'start' }))
    this.dispatchEvent(new CustomEvent('compare-code-select', { detail: { path }, bubbles: true, composed: true }))
  }

  _more() {
    this._fileLimit += FILE_BATCH
    this.requestUpdate()
  }

  // The list draws diffs alone, never a file's source, so a repointed or
  // byte-identical file isn't searched.
  _searchable(entry) {
    return entry.modified !== false && entry.kind !== 'repointed'
  }

  // A file's state as the tree counts it: as the list drew it this render.
  _countingState(path, entry) {
    return this._states?.get(path) ?? super._countingState(path, entry)
  }

  _section(path) {
    return [...this.querySelectorAll('.bundle-compare-all-file')].find(section => section.dataset.path === path) ?? null
  }

  // As the list scrolls, the file at its top is the rail's, a frame at a
  // time; within a screen of its end, the next files are drawn.
  _spy() {
    if (this._spying || this.extensions?.canSelect?.() === false) return
    this._spying = requestAnimationFrame(() => {
      this._spying = 0
      const body = this.querySelector('.bundle-compare-diff')
      if (!body || this.extensions?.canSelect?.() === false) return
      if (this._fileLimit < this._order.length && body.scrollTop + 2 * body.clientHeight >= body.scrollHeight) this._more()
      const { top, bottom } = body.getBoundingClientRect()
      const picked = this._picked && this._section(this._picked)?.getBoundingClientRect()
      if (picked && picked.bottom > top && picked.top < bottom) return
      this._picked = null
      let at = null
      for (const section of body.querySelectorAll(':scope > .bundle-compare-all-file')) {
        if (section.getBoundingClientRect().top > top + 4) break
        at = section
      }
      const path = at?.dataset.path ?? this._order[0] ?? null
      if (path !== this._current) {
        this._current = path
        this.requestUpdate()
        this.dispatchEvent(new CustomEvent('compare-code-select', { detail: { path }, bubbles: true, composed: true }))
      }
    })
  }

  // A file's import resolutions that differ over its diff, alone where they
  // are its only change; over package.json, its dependency changes.
  _fileBody(path, entry, file) {
    const repointed = entry.repointed ? this._renderRepointed(path, entry.repointed, importerText(file), false) : nothing
    const sourceOnly = entry.kind === 'repointed' || (entry.kind === 'renamed' && !entry.modified && !!entry.repointed && !entry.meta && !(file.model?.blocks.length > 0))
    return html`${this._dependencyChanges(path)}${repointed}${sourceOnly ? nothing : this._fileMessage(path, entry, file) ?? this._renderDiff(path, entry, file)}`
  }

  _fileContent(path, entry, file, prefix) {
    return html`<header class="bundle-code-main-bar bundle-compare-all-file-head">
      ${this._fileName(path, entry, prefix)}
      <span class="bundle-code-main-spacer"></span>
      ${this._fileFigures(entry, file.model)}
    </header>
    ${this._fileBody(path, entry, file)}`
  }

  render() {
    const rail = this._railState()
    const prefix = this.extensions?.fullPaths ? '' : rail.prefix
    const order = this.extensions?.filterContent === false ? rail.allOrder : rail.order
    this._order = order
    if (this._goTo && order.includes(this._goTo)) this._current = this._goTo
    if (!order.includes(this._current)) this._current = order[0] ?? null
    if (this._current && (this._goTo || this._current !== this._shownPath)) this._reveal(this._current, rail.prefix)
    // A file opened past those drawn draws the batches up to it.
    const at = order.indexOf(this._current)
    if (at >= this._fileLimit) this._fileLimit = Math.ceil((at + 1) / FILE_BATCH) * FILE_BATCH
    const entries = order.map(path => [path, this._entries.get(path)])
    const shown = entries.map(([path, entry]) => ({ path, entry, file: this._fileState(path, entry) }))
    const additions = shown.reduce((sum, { file }) => sum + (file.model?.additions ?? 0), 0)
    const deletions = shown.reduce((sum, { file }) => sum + (file.model?.deletions ?? 0), 0)
    // The pretty-print toggle, where printing changes any file's diff: a
    // failure first, with how many failed, then one still coming; its tooltip
    // lists the files it applies to. The tree counts each file as drawn here.
    this._states = new Map(shown.map(({ path, file }) => [path, file]))
    const printed = shown.filter(({ file }) => prettyToggle(file))
    const pretties = printed.map(({ file }) => prettyToggle(file))
    const failed = pretties.filter(copy => copy.status === 'error')
    const toggle = failed.length > 0 ? { ...failed[0], failed: failed.length, of: pretties.length }
      : pretties.find(copy => copy.status === 'loading') ?? pretties[0] ?? null
    const pretty = toggle && { ...toggle, json: pretties.some(copy => copy.json), affects: printed.map(({ path }) => path) }
    // The diff's controls, while any file shows a change or hides one they can show.
    const diffable = shown.some(({ file }) => file.model?.blocks.length > 0 || file.whitespace || file.hiding || file.types)
    return this._layout(rail, this._current, html`<header class="bundle-code-main-bar bundle-compare-code-bar">
          <span class="bundle-compare-all-title">${entries.length.toLocaleString()} ${entries.length === 1 ? 'file' : 'files'} changed</span>
          ${additions + deletions > 0 ? diffCounts(additions, deletions) : nothing}
          <span class="bundle-code-main-spacer"></span>
          ${this._toggles(diffable, pretty, shown.some(({ file }) => file.renamed), shown.some(({ file }) => file.whitespace === 'hideable'), shown.some(({ file }) => file.types))}
        </header>
        <div class="bundle-compare-diff" tabindex="0" aria-label="Every change" @scroll=${() => this._spy()}>
          ${entries.length === 0 ? html`<div class="bundle-code-placeholder">${this._entries.size === 0 ? 'No files differ in this comparison.' : 'No changed files match.'}</div>`
            : repeat(shown.slice(0, this._fileLimit), ({ path }) => path, ({ path, entry, file }) => html`<section class="bundle-compare-all-file" aria-label=${path} data-path=${path}>
              ${this.extensions?.fileActions ? html`<div class="bundle-compare-file-content">${this._fileContent(path, entry, file, prefix)}</div>
                ${this.extensions.fileActions(path, true)}` : this._fileContent(path, entry, file, prefix)}
            </section>`)}
          ${shown.length > this._fileLimit ? html`<button type="button" class="bundle-compare-code-action bundle-compare-all-more" @click=${() => this._more()}>Show more files (${(shown.length - this._fileLimit).toLocaleString()} remaining)</button>` : nothing}
        </div>`)
  }
}

customElements.define('bundle-compare-all', BundleCompareAll)
