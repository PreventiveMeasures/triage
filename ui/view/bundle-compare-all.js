// `<bundle-compare-all>` — Compare's Code for a comparison short enough to
// read whole: every file that differs, its review diff under its name, one
// after another in a single list, as `git diff` prints them, in the order
// the tree of bundle-compare-code.js lists them, beside that tree: picking a
// file scrolls to it, and the file at the list's top is the tree's as it
// scrolls. Each diff draws as a file's alone does there: unified or split,
// unchanged runs folded and expandable, syntax colored, changed words
// marked; an import that resolves elsewhere is listed over its importer's
// diff, a file with no other change listing those alone. Compare shows it
// for a comparison it can list in fewer than COMBINED_DIFF_MAX rows
// (combinedDiffRows), and a file at a time beside the tree otherwise. Its
// files are drawn FILE_BATCH at a time, more as the list nears its end, or
// as one past them is opened.
import { html, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { diffRows, lineDiff } from './bundle-compare-code-model.js'
import { BundleCompareCode, diffCounts, fileContents, fileEntries, isLargeDiff, modelKey } from './bundle-compare-code.js'

export const COMBINED_DIFF_MAX = 25_000
// Minified files pretty-printed together, both sides of each among the
// copies pretty-source.js keeps: more would ask for as many copies at once.
const COMBINED_PRETTY_MAX = 4
// Files drawn at a time, as Review's whole diff draws them.
const FILE_BATCH = 40

// The files the Diff view lists, by path: each one added, removed, changed
// or renamed (fileEntries). A file whose only change is an import resolving
// elsewhere has no text that changed, so none of it shows here.
const combinedEntries = entries => [...entries].toSorted(([a], [b]) => a.localeCompare(b))

// The rows the list shows for a comparison, a head for each file and its
// diff's rows as they first show, two for each repointed import (`resolutions`)
// and a head for an importer with no other change, counted up to `max`; and
// the line models found on the way, for the view to draw. Infinity where a
// file is too large to diff without being asked to. Each file lists two rows
// at least, so one with too many files for `max` is told without a diff.
export function combinedDiffRows(base, other, files, { resolutions = [], max = COMBINED_DIFF_MAX } = {}) {
  const models = new Map()
  const entries = fileEntries(files)
  if (entries.size * 2 >= max) return { rows: Infinity, models }
  const importers = new Set(resolutions.map(row => row.parent).filter(path => !entries.has(path)))
  let rows = resolutions.length * 2 + importers.size
  for (const [path, entry] of combinedEntries(entries)) {
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

class BundleCompareAll extends BundleCompareCode {
  static properties = { ...BundleCompareCode.properties, models: { attribute: false } }

  // Every file's model is drawn on every render, so all are kept for the
  // comparison, starting from those Compare found counting its rows.
  constructor() {
    super()
    this.models = null
    this._modelCap = Infinity
    this._fileLimit = FILE_BATCH
  }

  willUpdate(changed) {
    super.willUpdate(changed)
    if (changed.has('models')) for (const [path, model] of this.models ?? []) this._models.set(modelKey(path, false, { ignoreWhitespace: false, ignoreRenames: false }), model)
    // A new comparison starts from its first files, not from the file the
    // last one was scrolled to.
    if (changed.has('files')) {
      this._fileLimit = FILE_BATCH
      this._current = this._picked = null
    }
    // A file opened from elsewhere (the Overview, a link), or picked before
    // the comparison changed (another scope), is scrolled to, as Code opens it;
    // else a new comparison shows from its top, as it was scrolled however far.
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

  // A file picked in the rail: the list scrolls to it, its head at the top
  // (unless `scroll` is false, a search hit scrolling to its line), and it
  // stays the rail's while it is in view, though the list ends too soon to
  // bring it to the top.
  _select(path, scroll = true) {
    if (!path) return
    this._current = this._picked = path
    this.requestUpdate()
    if (scroll) void this.updateComplete.then(() => this._section(path)?.scrollIntoView({ block: 'start' }))
    this.dispatchEvent(new CustomEvent('compare-code-select', { detail: { path }, bubbles: true, composed: true }))
  }

  _more() {
    this._fileLimit += FILE_BATCH
    this.requestUpdate()
  }

  // The list draws a diff alone, never a file's source: a file whose only
  // change is a repointed import lists its imports there, and one whose bytes
  // are the same says so, so neither is searched.
  _searchable(entry) {
    return entry.modified !== false && entry.kind !== 'repointed'
  }

  _section(path) {
    return [...this.querySelectorAll('.bundle-compare-all-file')].find(section => section.dataset.path === path) ?? null
  }

  // As the list scrolls, the file whose diff is at its top is the rail's,
  // a frame at a time; and within a screen of its end, the next files are
  // drawn.
  _spy() {
    if (this._spying) return
    this._spying = requestAnimationFrame(() => {
      this._spying = 0
      const body = this.querySelector('.bundle-compare-diff')
      if (!body) return
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
      }
    })
  }

  // A file's repointed imports, over its diff where its text changed too:
  // one whose only change they are lists them alone, without its source, and
  // one whose record changed too says how; over the package's package.json,
  // its dependency changes.
  _fileBody(path, entry, file) {
    const repointed = entry.repointed
      ? this._renderRepointed(path, entry.repointed, [file.after, file.before].find(text => typeof text === 'string' && text !== '') ?? null, false) : nothing
    const sourceOnly = entry.kind === 'repointed' || (entry.kind === 'renamed' && !entry.modified && !!entry.repointed && !entry.meta && !(file.model?.blocks.length > 0))
    return html`${this._dependencyChanges(path)}${repointed}${sourceOnly ? nothing : this._fileMessage(path, entry, file) ?? this._renderDiff(path, entry, file)}`
  }

  render() {
    const rail = this._railState()
    const { prefix, order } = rail
    this._order = order
    if (this._goTo && order.includes(this._goTo)) this._current = this._goTo
    if (!order.includes(this._current)) this._current = order[0] ?? null
    if (this._current) this._reveal(this._current, prefix)
    // A file opened past those drawn draws the batches up to it.
    const at = order.indexOf(this._current)
    if (at >= this._fileLimit) this._fileLimit = Math.ceil((at + 1) / FILE_BATCH) * FILE_BATCH
    const entries = order.map(path => [path, this._entries.get(path)])
    const prettyAllowed = entries.filter(([path, entry]) => this._printable(path, entry)).length <= COMBINED_PRETTY_MAX
    const shown = entries.map(([path, entry]) => ({ path, entry, file: this._fileState(path, entry, prettyAllowed) }))
    const additions = shown.reduce((sum, { file }) => sum + (file.model?.additions ?? 0), 0)
    const deletions = shown.reduce((sum, { file }) => sum + (file.model?.deletions ?? 0), 0)
    // The toggle's state for every file, as for one file's two sides (_pretty): a failure first, then one still coming.
    const pretties = shown.map(({ file }) => file.pretty).filter(Boolean)
    const pretty = pretties.find(copy => copy.status === 'error') ?? pretties.find(copy => copy.status === 'loading') ?? pretties[0]
    // The diff's controls, while any file shows a change or hides one they can show.
    const diffable = shown.some(({ file }) => file.model?.blocks.length > 0 || file.whitespace || file.hiding)
    return html`<div class="bundle-code-view bundle-compare-code">
      ${this._renderRail(rail, this._current)}
      <div class="bundle-code-main">
        <header class="bundle-code-main-bar bundle-compare-code-bar">
          <span class="bundle-compare-all-title">${entries.length.toLocaleString()} ${entries.length === 1 ? 'file' : 'files'} changed</span>
          ${additions + deletions > 0 ? diffCounts(additions, deletions) : nothing}
          <span class="bundle-code-main-spacer"></span>
          ${this._toggles(diffable, pretty, shown.some(({ file }) => file.generated), false, shown.some(({ file }) => file.whitespace) ? 'hideable' : null)}
        </header>
        <div class="bundle-compare-diff" tabindex="0" aria-label="Every change" @scroll=${() => this._spy()}>
          ${entries.length === 0 ? html`<div class="bundle-code-placeholder">${this._entries.size === 0 ? 'No files differ in this comparison.' : 'No changed files match.'}</div>`
            : repeat(shown.slice(0, this._fileLimit), ({ path }) => path, ({ path, entry, file }) => html`<section class="bundle-compare-all-file" aria-label=${path} data-path=${path}>
              <header class="bundle-code-main-bar bundle-compare-all-file-head">
                ${this._fileName(path, entry, prefix)}
                <span class="bundle-code-main-spacer"></span>
                ${this._fileFigures(entry, file.model)}
                ${file.whitespace && file.whitespace !== 'hideable' ? this._whitespaceToggle(file.whitespace) : nothing}
              </header>
              ${this._fileBody(path, entry, file)}
            </section>`)}
          ${shown.length > this._fileLimit ? html`<button type="button" class="bundle-compare-code-action bundle-compare-all-more" @click=${() => this._more()}>Show more files (${(shown.length - this._fileLimit).toLocaleString()} remaining)</button>` : nothing}
        </div>
      </div>
    </div>`
  }
}

customElements.define('bundle-compare-all', BundleCompareAll)
