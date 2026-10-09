// `<bundle-compare-code>` — the Compare slide's Code view. The files that
// differ between the two bundles sit in the Code tab's tree (same builder,
// package rows and styles), each marked added, removed or modified; the
// selected file's changes read as a review diff beside it — unified or
// split, unchanged runs folded to their context and expandable, syntax
// colored, and the words that changed inside a line marked.
//
// `base` / `other` are the two parsed bundles (base is the open one, the
// "before"), `files` the comparison's file lists from computeBundleDiff,
// `resolutions` its repointed imports (computeResolutionDiff) — their
// importers are listed too, with each import's old and new target — and
// `path` the selected file, which the slide owns so the Overview's
// file rows can open one here. A pick dispatches `compare-code-select`.
// Light DOM, like the slide, so the tree takes the Code tab's styles and
// the copy button reaches the document-level [data-copy-path] delegate.
import { LitElement, html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { BUNDLE_SOURCE_WRAP_KEY, state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { bundleFileByteLength, bundleFilesAsMap } from './bundle-sources.js'
import { buildBundleSourceTree, bundleSourceTreePrefix, compactSourceDirectory, filterBundleSourceTree, navigateBundleSourceTree, sourceDirectoryLabel } from './bundle-source-tree.js'
import { sourceFileIcon, sourcePackageIcon } from './source-file-icon.js'
import { highlight, langForPath, splitHighlightedLines } from './prism-highlight.js'
import { LONG_LINE, TEXT_NODE_MAX, textNodes } from './source-text.js'
import { EXPAND_STEP, changeStart, diffRows, lineDiff, markHighlighted, markSegments, wordRanges } from './bundle-compare-code-model.js'
import { renameParts } from './bundle-compare-diff.js'
import { renameTemplate } from './bundle-compare-rename.js'
import './bundle-code-splitter.js'

const KINDS = [
  { kind: 'changed', label: 'Modified', letter: 'M' },
  // Moved or re-extensioned (see detectRenames); one whose contents changed
  // too shows under Modified as well.
  { kind: 'renamed', label: 'Renamed', letter: '→' },
  { kind: 'added', label: 'Added', letter: 'A' },
  { kind: 'removed', label: 'Removed', letter: 'D' },
  // Same contents, but some of its imports resolve elsewhere.
  { kind: 'repointed', label: 'Repointed', letter: 'R' },
]
const KIND = Object.fromEntries(KINDS.map(entry => [entry.kind, entry]))

// Rows a diff renders before asking to show more; each ask adds as many.
const ROW_LIMIT = 2000
// A diff past these is computed only when asked: the search takes seconds
// over a few hundred thousand lines that share nothing.
const LARGE_LINES = 100_000
const LARGE_CHARS = 16 * 1024 * 1024
// Models kept for files viewed recently, so going back to one is instant.
const MODEL_CACHE = 24
// Importing lines a repointed import lists before summing up the rest.
const MAX_IMPORT_LINES = 3
// Directories all start open (a review reads every change) unless the
// tree is too long to scan that way.
const OPEN_ALL_MAX = 300

// View preferences shared by every comparison, reset on page reload like
// the rail's width.
const prefs = { layout: 'unified', ignoreWhitespace: false }

// `${integrity}\0${path}` → the file's highlighted lines, or null when Prism
// has no grammar for it or it is too large to color.
const highlightCache = new Map()
const highlightPending = new Set()

function countLines(text) {
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

function dirOrder([a, an], [b, bn]) {
  return sourceDirectoryLabel(a, an).localeCompare(sourceDirectoryLabel(b, bn)) || an.path.localeCompare(bn.path)
}

// Files in the order the tree shows them, for the default pick and for
// stepping between files.
function orderedFiles(node, depth = 0, out = []) {
  for (const [name, child] of [...node.dirs.entries()].toSorted(dirOrder)) orderedFiles(compactSourceDirectory(name, child, depth).node, depth + 1, out)
  for (const [, full] of [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))) out.push(full)
  return out
}

// Every directory holding a file of the bundle, so a directory of the tree
// can tell whether it is new (none on the base side) or gone.
const dirSets = new WeakMap()
function bundleDirs(details) {
  const files = bundleFilesAsMap(details)
  if (dirSets.has(files)) return dirSets.get(files)
  const dirs = new Set()
  for (const path of files.keys()) {
    for (let at = path.lastIndexOf('/'); at > 0 && !dirs.has(path.slice(0, at)); at = path.lastIndexOf('/', at - 1)) dirs.add(path.slice(0, at))
  }
  dirSets.set(files, dirs)
  return dirs
}

function containsFile(node, path) {
  for (const full of node.files.values()) if (full === path) return true
  for (const child of node.dirs.values()) if (containsFile(child, path)) return true
  return false
}

class BundleCompareCode extends LitElement {
  static properties = {
    base: { attribute: false },
    other: { attribute: false },
    files: { attribute: false },
    resolutions: { attribute: false },
    baseName: {},
    otherName: {},
    path: {},
    _query: { state: true },
    _kinds: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.base = null
    this.other = null
    this.files = null
    this.resolutions = []
    this.path = null
    this._query = ''
    this._kinds = new Set(KINDS.map(entry => entry.kind))
    // Directory path → open, for the disclosures the user toggled.
    this._open = new Map()
    this._models = new Map()
    // `${path}\0${whitespace}` → fold run → lines revealed, and the rows
    // shown before "Show more"; large files the user asked to diff anyway.
    this._expansions = new Map()
    this._limits = new Map()
    this._forced = new Set()
    this._shownPath = null
  }

  willUpdate(changed) {
    if (changed.has('base') || changed.has('other')) {
      const pair = `${this.base?.integrity}|${this.other?.integrity}`
      if (pair !== this._pair) {
        this._pair = pair
        this._models.clear()
        this._expansions.clear()
        this._limits.clear()
        this._forced.clear()
      }
    }
    if (['files', 'resolutions', 'base', 'other'].some(name => changed.has(name))) this._entries = this._buildEntries()
  }

  updated() {
    // A newly shown file starts at its top, with its tree row in view.
    if (this._current !== this._shownPath) {
      this._shownPath = this._current
      const body = this.querySelector('.bundle-compare-diff')
      if (body) body.scrollTop = 0
      this.querySelector('.bundle-compare-code-tree .bundle-code-tree-link.current')?.scrollIntoView({ block: 'nearest' })
    }
  }

  // path → { kind, baseBytes, otherBytes, basePath, modified, repointed }
  // for every file that differs or imports something that now resolves
  // elsewhere; `basePath` names a renamed file on the base side, `modified`
  // says whether its contents changed too, `repointed` lists those imports.
  _buildEntries() {
    const entries = new Map()
    if (!this.files) return entries
    for (const row of this.files.onlyBase) entries.set(row.path, { kind: 'removed', baseBytes: row.bytes, otherBytes: null })
    for (const row of this.files.onlyOther) entries.set(row.path, { kind: 'added', baseBytes: null, otherBytes: row.bytes })
    for (const row of this.files.changed) {
      entries.set(row.path, row.basePath == null ? { kind: 'changed', baseBytes: row.baseBytes, otherBytes: row.otherBytes }
        : { kind: 'renamed', basePath: row.basePath, modified: row.modified, baseBytes: row.baseBytes, otherBytes: row.otherBytes })
    }
    for (const row of this.resolutions ?? []) {
      if (!entries.has(row.parent)) {
        const bytes = bundleFileByteLength(bundleFilesAsMap(this.other).get(row.parent) ?? bundleFilesAsMap(this.base).get(row.parent))
        entries.set(row.parent, { kind: 'repointed', baseBytes: bytes, otherBytes: bytes })
      }
      const entry = entries.get(row.parent)
      entry.repointed = [...(entry.repointed ?? []), row]
    }
    return entries
  }

  // A file shows while any of its kinds of change does: a modified file with
  // repointed imports stays under either filter, a renamed one modified too
  // under Renamed or Modified.
  _shown(entry) {
    return this._kinds.has(entry.kind) || (!!entry.modified && this._kinds.has('changed'))
      || (!!entry.repointed && this._kinds.has('repointed'))
  }

  _modules() {
    const base = this.base?.kind === 'stasis' ? this.base.bundle?.modules : null
    const other = this.other?.kind === 'stasis' ? this.other.bundle?.modules : null
    return base || other ? new Map([...(base ?? []), ...(other ?? [])]) : null
  }

  _format(path) {
    const side = this._entries.get(path)?.kind === 'removed' ? this.base : this.other
    return side?.kind === 'stasis' ? side.bundle?.formats?.get(path) : undefined
  }

  // The tree over the files the kind filter keeps. The display prefix comes
  // from every differing file, so filtering doesn't move the tree's root.
  _tree() {
    const key = [this._entries, [...this._kinds].join()]
    if (this._treeKey?.[0] === key[0] && this._treeKey[1] === key[1]) return this._treeMemo
    const all = [...this._entries.keys()]
    const modules = this._modules()
    const prefix = bundleSourceTreePrefix(stripCommonPathPrefix(all).prefix, modules, all)
    const shown = all.filter(path => this._shown(this._entries.get(path)))
    const strip = path => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    this._treeKey = key
    this._treeMemo = { prefix, tree: buildBundleSourceTree(shown.map(strip), shown, modules), shown: shown.length }
    return this._treeMemo
  }

  _select(path) {
    if (!path || path === this._current) return
    this.dispatchEvent(new CustomEvent('compare-code-select', { detail: { path }, bubbles: true, composed: true }))
  }

  // Open every directory above a file picked elsewhere (the Overview, or
  // stepping to a file in a collapsed directory).
  _reveal(path, prefix) {
    const parts = (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path).split('/')
    for (let i = 1; i < parts.length; i++) this._open.set(parts.slice(0, i).join('/'), true)
  }

  render() {
    const { prefix, tree, shown } = this._tree()
    const filtered = this._query ? filterBundleSourceTree(tree, this._query, prefix) : tree
    const order = filtered ? orderedFiles(filtered) : []
    const current = this._entries.has(this.path) ? this.path : order[0] ?? null
    if (current && current !== this._current) this._reveal(current, prefix)
    this._current = current
    this._order = order
    const counts = Object.fromEntries(KINDS.map(({ kind }) => [kind, 0]))
    for (const entry of this._entries.values()) {
      if (entry.kind !== 'repointed') counts[entry.kind]++
      if (entry.modified) counts.changed++
      if (entry.repointed) counts.repointed++
    }
    return html`<div class="bundle-code-view bundle-compare-code">
      <aside class="bundle-code-rail">
        <div class="bundle-code-rail-head">
          <span class="bundle-code-rail-label">Changes</span>
          <span class="bundle-code-rail-count">${this._entries.size.toLocaleString()}</span>
          <span class="bundle-code-rail-actions">
            <button type="button" class="bundle-code-rail-action" aria-label="Collapse directories" data-tooltip="Collapse directories"
              ?disabled=${!!this._query || tree.dirs.size === 0} @click=${() => this._collapseAll(tree)}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M5 2h8a1 1 0 0 1 1 1v8M3 5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM4.5 9.5h4"/></svg>
            </button>
          </span>
        </div>
        ${prefix ? html`<div class="bundle-code-rail-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</div>` : nothing}
        <div class="bundle-compare-code-filter">
          <label class="bundle-compare-code-search">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>
            <input type="search" placeholder="Filter changed files" aria-label="Filter changed files" .value=${live(this._query)} @input=${e => { this._query = e.target.value }}>
          </label>
          <div class="bundle-compare-code-kinds" role="group" aria-label="Show changes">
            ${KINDS.filter(({ kind }) => counts[kind] > 0).map(({ kind, label }) => html`<button type="button" class=${`bundle-compare-code-kind ${kind}`}
              aria-pressed=${String(this._kinds.has(kind))} data-tooltip=${`${this._kinds.has(kind) ? 'Hide' : 'Show'} ${label.toLowerCase()} files`}
              @click=${() => this._toggleKind(kind)}>${label.toLowerCase()}</button>`)}
          </div>
        </div>
        <div class="bundle-code-rail-body bundle-compare-code-tree">
          ${filtered ? this._renderTree(filtered, current, 0, !!this._query || shown <= OPEN_ALL_MAX) : html`<div class="bundle-code-search-empty">No changed files match.</div>`}
        </div>
      </aside>
      <bundle-code-splitter role="separator" tabindex="0" aria-orientation="vertical"
        aria-label="Resize file tree" data-tooltip="Drag to resize · double-click to reset"></bundle-code-splitter>
      <div class="bundle-code-main">
        ${current ? this._renderFile(current, prefix) : html`<div class="bundle-code-placeholder">No files differ in this comparison.</div>`}
      </div>
    </div>`
  }

  _toggleKind(kind) {
    const kinds = new Set(this._kinds)
    if (kinds.has(kind)) kinds.delete(kind)
    else kinds.add(kind)
    this._kinds = kinds
  }

  _collapseAll(tree) {
    const walk = node => {
      for (const child of node.dirs.values()) { this._open.set(child.path, false); walk(child) }
    }
    walk(tree)
    this.requestUpdate()
  }

  _renderTree(node, current, depth, openAll) {
    const dirs = [...node.dirs.entries()].toSorted(dirOrder)
    const files = [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))
    return html`<ul class=${classMap({ 'bundle-code-tree': true, root: depth === 0 })}
      aria-label=${depth === 0 ? 'Changed files' : nothing}
      @keydown=${depth === 0 ? navigateBundleSourceTree : nothing}>
      ${repeat(dirs, ([, child]) => child.path, ([name, child]) => {
        const compact = compactSourceDirectory(name, child, depth)
        const pkg = child.package
        const vendored = pkg?.ecosystem === 'cargo' || pkg?.ecosystem === 'composer' || pkg?.ecosystem === 'soldeer'
        const open = this._query ? true : this._open.get(child.path) ?? (openAll || depth === 0 || containsFile(child, current))
        // The row's top directory is new or gone as a whole, package or not.
        const dirKind = bundleDirs(this.base).has(child.sourcePath)
          ? bundleDirs(this.other).has(child.sourcePath) ? null : 'removed'
          : 'added'
        return html`<li class="bundle-code-tree-dir">
          <details .open=${live(open)}>
            <summary @click=${e => { this._open.set(child.path, !e.currentTarget.parentElement.open) }}>
              <span class="bundle-code-tree-chevron" aria-hidden="true"></span>
              ${pkg ? sourcePackageIcon(pkg.ecosystem) : nothing}
              <span class=${classMap({ 'bundle-code-tree-dirname': true, 'bundle-code-tree-package': !!pkg, 'bundle-code-tree-package-vendored': vendored, 'bundle-compare-code-name': true, removed: dirKind === 'removed' })}
                data-tooltip-truncated data-tooltip=${compact.node.sourcePath}>
                ${pkg ? html`<span class="bundle-code-tree-package-name">${pkg.name}</span>${pkg.version ? html`<span class="bundle-code-tree-package-version">${vendored ? '- ' : '@'}${pkg.version}</span>` : nothing}` : compact.names.map((part, index) => html`${index > 0 ? html`<span class="bundle-code-tree-separator">/</span>` : nothing}${part}`)}
              </span>
              ${pkg?.variant ? html`<span class="bundle-code-tree-variant">variant ${pkg.variant}</span>` : nothing}
              <span class="bundle-compare-code-dir-count" data-tooltip=${`${child.fileCount} changed ${child.fileCount === 1 ? 'file' : 'files'}`}>${child.fileCount}</span>
              ${dirKind ? html`<span class=${`bundle-compare-code-letter ${dirKind}`} data-tooltip=${`${pkg ? 'Package' : 'Directory'} ${dirKind}`}>${KIND[dirKind].letter}</span>` : nothing}
            </summary>
            ${this._renderTree(compact.node, current, depth + 1, openAll)}
          </details>
        </li>`
      })}
      ${repeat(files, ([, full]) => full, ([name, full]) => {
        const { kind, repointed, basePath, modified } = this._entries.get(full)
        const imports = repointed ? `${repointed.length} repointed ${repointed.length === 1 ? 'import' : 'imports'}` : ''
        return html`<li class="bundle-code-tree-file">
          <button type="button" class=${classMap({ 'bundle-code-tree-link': true, current: full === current })}
            aria-current=${full === current ? 'true' : nothing} @click=${() => this._select(full)}>
            ${sourceFileIcon(full, this._format(full))}<span class=${`bundle-code-tree-name bundle-compare-code-name ${kind}`} data-tooltip-truncated data-tooltip=${full}>${name}</span>
            ${basePath ? html`<span class="bundle-compare-code-oldname" data-tooltip-truncated data-tooltip=${`Renamed from ${basePath}`}>← ${renameParts(basePath, full).from}</span>` : nothing}
            ${repointed && kind !== 'repointed' ? html`<span class="bundle-compare-code-letter repointed" data-tooltip=${imports}>R</span>` : nothing}
            <span class=${classMap({ 'bundle-compare-code-letter': true, [kind]: true, pure: kind === 'renamed' && !modified })}
              data-tooltip=${kind === 'repointed' ? imports : basePath ? `Renamed${modified ? ' and modified' : ''} from ${basePath}` : KIND[kind].label}>${KIND[kind].letter}</span>
          </button>
        </li>`
      })}
    </ul>`
  }

  // ── The selected file ────────────────────────────────────────────

  _contents(path, { kind, basePath = path }) {
    let before = kind === 'added' ? '' : bundleFilesAsMap(this.base).get(basePath)
    let after = kind === 'removed' ? '' : bundleFilesAsMap(this.other).get(path)
    // An importer captured on one side only (or neither) is no change of
    // contents; what there is of it shows as unchanged.
    if (kind === 'repointed') before = after = after ?? before
    return { before, after }
  }

  _model(path, before, after) {
    const key = `${path}\0${prefs.ignoreWhitespace}`
    // Re-inserted on every use, so the cache drops the least recent.
    let model = this._models.get(key)
    this._models.delete(key)
    if (!model) {
      model = lineDiff(before, after, { ignoreWhitespace: prefs.ignoreWhitespace })
    }
    this._models.set(key, model)
    if (this._models.size > MODEL_CACHE) this._models.delete(this._models.keys().next().value)
    return model
  }

  // Highlighted lines of one side, or null until (or unless) Prism colors
  // it; the first ask starts the work and re-renders once it lands.
  _highlighted(details, path, text) {
    if (!text) return null
    const lang = langForPath(path, details?.kind === 'stasis' ? details.bundle?.formats?.get(path) : undefined)
    if (!lang) return null
    const key = `${details.integrity}\0${path}`
    if (highlightCache.has(key)) return highlightCache.get(key)
    if (!highlightPending.has(key)) {
      highlightPending.add(key)
      void (async () => {
        const markup = await highlight(text, lang)
        const lines = typeof markup === 'string' ? splitHighlightedLines(markup) : null
        highlightCache.set(key, lines?.length === text.split('\n').length ? lines : null)
        highlightPending.delete(key)
        if (this.isConnected) this.requestUpdate()
      })()
    }
    return null
  }

  _renderFile(path, prefix) {
    const entry = this._entries.get(path)
    const { kind } = entry
    const { before, after } = this._contents(path, entry)
    const textual = typeof before === 'string' && typeof after === 'string'
    const large = textual && !this._forced.has(path)
      && (before.length + after.length > LARGE_CHARS || countLines(before) + countLines(after) > LARGE_LINES)
    const model = textual && !large ? this._model(path, before, after) : null
    // A file whose only change is a repointed import reads as its source,
    // whatever the whitespace setting: its two sides are one text.
    const diffable = textual && (kind !== 'repointed' || model?.blocks.length > 0)
    const index = this._order.indexOf(path)
    const strip = file => prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
    const display = strip(path)
    const size = value => formatBytes(value ?? 0)
    let body
    if (kind === 'repointed' && before === undefined) {
      body = html`<div class="bundle-compare-code-message">Neither bundle carries this importer's source.</div>`
    } else if (!textual) {
      const bytes = kind === 'added' ? `${size(bundleFileByteLength(after))}` : kind === 'removed' ? `${size(bundleFileByteLength(before))}`
        : `${size(bundleFileByteLength(before))} → ${size(bundleFileByteLength(after))}`
      body = html`<div class="bundle-compare-code-message">Binary file ${kind} · ${bytes}. A text diff is not available.</div>`
    } else if (large) {
      body = html`<div class="bundle-compare-code-message">
        <p>This diff is large (${(countLines(before) + countLines(after)).toLocaleString()} lines across both sides) and may take a few seconds to compute.</p>
        <button type="button" class="bundle-compare-code-action" @click=${() => { this._forced.add(path); this.requestUpdate() }}>Show diff</button>
      </div>`
    } else if (kind === 'repointed' && model.blocks.length === 0) {
      body = this._renderSource(path, after, entry.repointed)
    } else if (model.blocks.length === 0) {
      body = html`<div class="bundle-compare-code-message">
        <p>${prefs.ignoreWhitespace ? 'Only whitespace changed in this file.' : kind === 'renamed' ? 'Renamed without changes.' : 'The contents are the same.'}</p>
        ${prefs.ignoreWhitespace ? html`<button type="button" class="bundle-compare-code-action" @click=${() => this._setWhitespace(false)}>Show whitespace changes</button>` : nothing}
      </div>`
    } else {
      body = this._renderDiff(path, entry, model, before, after)
    }
    return html`<header class="bundle-code-main-bar bundle-compare-code-bar">
        <span class="bundle-code-file-nav">
          <button type="button" class="focus-code-nav-btn" aria-label="Previous file" data-tooltip="Previous file" ?disabled=${index <= 0} @click=${() => this._select(this._order[index - 1])}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg>
          </button>
          <button type="button" class="focus-code-nav-btn" aria-label="Next file" data-tooltip="Next file" ?disabled=${index === -1 ? this._order.length === 0 : index >= this._order.length - 1} @click=${() => this._select(this._order[index + 1])}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>
          </button>
        </span>
        <span class=${classMap({ 'bundle-compare-code-pill': true, [kind]: true, pure: kind === 'renamed' && !entry.modified })}>${KIND[kind].label}</span>
        ${sourceFileIcon(path, this._format(path))}
        <span class="bundle-code-main-path mono" data-tooltip-truncated data-tooltip=${entry.basePath ? `${entry.basePath} → ${path}` : path}>${entry.basePath ? renameTemplate(strip(entry.basePath), display) : display}</span>
        <button type="button" class="bundle-code-copy-path" data-copy-path=${path} aria-label="Copy file path">
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="3" y="2.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><rect x="5.5" y="5" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        </button>
        <span class="bundle-code-main-spacer"></span>
        ${model?.blocks.length > 0 ? html`<span class="bundle-compare-code-counts" aria-label=${`${model.additions} added, ${model.deletions} removed lines`}>
          <span class="add">+${model.additions.toLocaleString()}</span><span class="del">−${model.deletions.toLocaleString()}</span>
        </span>` : nothing}
        <span class="bundle-code-main-stats">${kind === 'added' ? size(entry.otherBytes) : kind === 'removed' ? size(entry.baseBytes) : `${size(entry.baseBytes)} → ${size(entry.otherBytes)}`}</span>
        ${model && model.blocks.length > 0 ? html`<span class="bundle-code-file-nav">
          <button type="button" class="focus-code-nav-btn" aria-label="Previous change" data-tooltip="Previous change" @click=${() => this._stepChange(-1)}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10 5-5 5 5"/></svg>
          </button>
          <button type="button" class="focus-code-nav-btn" aria-label="Next change" data-tooltip="Next change" @click=${() => this._stepChange(1)}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 5 5 5-5"/></svg>
          </button>
        </span>` : nothing}
        ${diffable ? html`<span class="bundles-overview-sort bundle-compare-code-layout" role="group" aria-label="Diff layout">
          ${[['unified', 'Unified'], ['split', 'Split']].map(([value, label]) => html`<button type="button" aria-pressed=${String(prefs.layout === value)} @click=${() => { prefs.layout = value; this.requestUpdate() }}>${label}</button>`)}
        </span>
        <button type="button" class="bundle-compare-code-toggle" aria-pressed=${String(prefs.ignoreWhitespace)} aria-label="Hide whitespace changes" data-tooltip="Hide whitespace changes"
          @click=${() => this._setWhitespace(!prefs.ignoreWhitespace)}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9.5v2.5h12V9.5"/></svg>
        </button>` : nothing}
        ${textual ? html`<button type="button" class="bundle-compare-code-toggle" aria-pressed=${String(!!state.bundleSourceWrap)} aria-label="Wrap lines" data-tooltip="Wrap lines" ?hidden=${diffable && prefs.layout === 'split'}
          @click=${() => this._toggleWrap()}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5h12M2 8h9a2.5 2.5 0 0 1 0 5H8.5M10 11.5 8.5 13l1.5 1.5M2 13h3.5"/></svg>
        </button>` : nothing}
      </header>
      <div class="bundle-compare-diff" tabindex="0" aria-label=${`Changes in ${display}`}>
        ${entry.repointed ? this._renderRepointed(path, entry.repointed, [after, before].find(text => typeof text === 'string' && text !== '') ?? null, textual && !diffable) : nothing}
        ${body}
      </div>`
  }

  // Every line quoting each repointed specifier. Rows for one specifier
  // under different conditions (an `import` and a `require`) can't be told
  // apart by their lines, so each lists them all.
  _importLines(rows, lines) {
    const found = new Map()
    for (const { specifier } of rows) {
      if (found.has(specifier)) continue
      const quoted = ['\'', '"', '`'].map(quote => `${quote}${specifier}${quote}`)
      found.set(specifier, lines.flatMap((line, i) => quoted.some(needle => line.includes(needle)) ? [i] : []))
    }
    return found
  }

  // The bundle an unchanged importer's text comes from: the newer one, or
  // the base when only it carries the file. Highlights are cached by it.
  _textSide(path) {
    return bundleFilesAsMap(this.other).has(path) ? this.other : this.base
  }

  // The file's repointed imports: the specifier and its conditions, the
  // target it resolved to before and after, and the lines importing it —
  // links to them when the source shows below.
  _renderRepointed(path, rows, text, linked) {
    const lines = text ? text.split('\n') : []
    const markup = text ? this._highlighted(this._textSide(path), path, text) : null
    const importLines = this._importLines(rows, lines)
    const target = value => value || '(empty target)'
    return html`<section class="bundle-compare-code-repointed" aria-label="Repointed imports">
      <h4>Repointed ${rows.length === 1 ? 'import' : 'imports'} <b>${rows.length}</b></h4>
      <ul>${rows.map(row => {
        const at = importLines.get(row.specifier)
        const context = `${row.conditions}${row.platform === null ? '' : ` · Platform: ${row.platform}`}`
        return html`<li>
          <div class="bundle-compare-code-repointed-spec">
            <code data-tooltip-truncated data-tooltip=${row.specifier}>${row.specifier}</code>
            <span data-tooltip-truncated data-tooltip=${context}>${context}</span>
          </div>
          <div class="bundle-compare-code-repointed-targets">
            <span class="before"><span>Before</span><code data-tooltip-truncated data-tooltip=${target(row.baseTarget)}>${target(row.baseTarget)}</code></span>
            <span aria-hidden="true">→</span>
            <span class="after"><span>After</span><code data-tooltip-truncated data-tooltip=${target(row.otherTarget)}>${target(row.otherTarget)}</code></span>
          </div>
          ${at.slice(0, MAX_IMPORT_LINES).map(line => this._importLine(line, lines[line], markup?.[line], row.specifier, linked))}
          ${at.length > MAX_IMPORT_LINES ? html`<span class="bundle-compare-code-repointed-more">and ${at.length - MAX_IMPORT_LINES} more ${at.length - MAX_IMPORT_LINES === 1 ? 'line' : 'lines'}</span>` : nothing}
        </li>`
      })}</ul>
    </section>`
  }

  // One importing line as a link to it; a long (minified) line shows the
  // part around the import.
  _importLine(line, source, markup, specifier, linked) {
    const at = source.length > 240 ? Math.max(0, source.indexOf(specifier) - 80) : 0
    return html`<button type="button" class="bundle-compare-code-repointed-line bundle-compare-diff-table" ?disabled=${!linked}
      aria-label=${`Go to line ${line + 1}`} @click=${() => this._goToLine(line + 1)}>
      <span class="diff-num">${line + 1}</span>
      <code>${source.length <= 240 && typeof markup === 'string' ? unsafeHTML(markup) : `${at > 0 ? '…' : ''}${source.slice(at, at + 240)}${source.length > at + 240 ? '…' : ''}`}</code>
    </button>`
  }

  _goToLine(line) {
    const key = `${this._current}\0source`
    // A line past the rows shown brings them in first.
    if (line > (this._limits.get(key) ?? ROW_LIMIT)) {
      this._limits.set(key, Math.ceil(line / ROW_LIMIT) * ROW_LIMIT)
      this.requestUpdate()
    }
    void this.updateComplete.then(() => this.querySelector(`.bundle-compare-diff [data-line="${line}"]`)?.scrollIntoView({ block: 'center' }))
  }

  // An unchanged file, as the Code tab would show it: one column of
  // numbered lines, the ones importing a repointed specifier marked.
  _renderSource(path, text, repointed) {
    const model = this._model(path, text, text)
    const lit = { model, b: this._highlighted(this._textSide(path), path, text) }
    const marked = new Set([...this._importLines(repointed, model.b).values()].flat())
    const key = `${path}\0source`
    const limit = this._limits.get(key) ?? ROW_LIMIT
    const lines = model.b.length > limit ? model.b.slice(0, limit) : model.b
    return html`<div class=${classMap({ 'bundle-compare-diff-table': true, single: true, wrapped: !!state.bundleSourceWrap })}
        style=${styleMap({ '--diff-num-width': `${String(model.b.length).length + 1}ch` })} role="table" aria-label="Source">
        ${repeat(lines, (_, i) => i, (_, i) => html`<div class=${classMap({ 'diff-row': true, ctx: true, 'is-import': marked.has(i) })} role="row" data-line=${i + 1}>
          <span class="diff-num">${i + 1}</span>${this._codeCell(lit, 'b', i, null)}
        </div>`)}
      </div>
      ${model.b.length > lines.length ? html`<div class="bundle-compare-code-more">
        <button type="button" class="bundle-compare-code-action" @click=${() => { this._limits.set(key, limit + ROW_LIMIT); this.requestUpdate() }}>Show ${Math.min(ROW_LIMIT, model.b.length - lines.length).toLocaleString()} more lines</button>
        <span>${(model.b.length - lines.length).toLocaleString()} not shown</span>
      </div>` : nothing}`
  }

  _setWhitespace(value) {
    prefs.ignoreWhitespace = value
    this.requestUpdate()
  }

  _toggleWrap() {
    state.bundleSourceWrap = !state.bundleSourceWrap
    try { localStorage.setItem(BUNDLE_SOURCE_WRAP_KEY, String(state.bundleSourceWrap)) } catch {}
    this.requestUpdate()
  }

  // Scroll to the next change below the top of the diff (or the last one
  // above it); past the file's last change, step on to the next file. At
  // either end of the scroll, where a change can't reach the top, step past
  // the change last stepped to instead, while it is still in view. A change past the rows shown brings
  // them in first.
  _stepChange(direction) {
    const body = this.querySelector('.bundle-compare-diff')
    if (!body) return
    const top = body.getBoundingClientRect().top
    const starts = [...body.querySelectorAll('[data-change-start]')]
    const offset = el => el.getBoundingClientRect().top - top
    const changeOf = el => Number(el.dataset.changeStart)
    // A change stepped to rests its scroll margin below the top.
    const rest = starts.length > 0 ? parseFloat(getComputedStyle(starts[0]).scrollMarginTop) || 0 : 0
    let target = direction > 0 ? starts.find(el => offset(el) > rest + 8) : starts.findLast(el => offset(el) < rest - 8)
    const stuck = direction > 0 ? body.scrollTop + body.clientHeight >= body.scrollHeight - 2 : body.scrollTop <= 1
    // Only while that change is still on screen: a scroll since moves on.
    const last = this._stepped?.path === this._current ? this._stepped.change : null
    const lastStart = last === null ? null : starts.find(el => changeOf(el) === last)
    if (stuck && lastStart && offset(lastStart) >= 0 && offset(lastStart) <= body.clientHeight) {
      target = direction > 0 ? starts.find(el => changeOf(el) > last) : starts.findLast(el => changeOf(el) < last)
    }
    const reach = change => {
      this._stepped = { path: this._current, change }
      this.querySelector(`.bundle-compare-diff [data-change-start="${change}"]`)?.scrollIntoView({ block: 'start' })
    }
    if (target) {
      reach(changeOf(target))
      return
    }
    const shown = this._shownRows
    const hidden = direction > 0 && shown?.path === this._current ? changeStart(shown.rows, shown.limit) : -1
    if (hidden !== -1) {
      this._limits.set(shown.key, hidden + ROW_LIMIT)
      this.requestUpdate()
      void this.updateComplete.then(() => reach(shown.rows[hidden].change))
      return
    }
    const index = this._order.indexOf(this._current)
    this._select(this._order[index + direction])
  }

  _renderDiff(path, { kind, basePath = path }, model, before, after) {
    const key = `${path}\0${prefs.ignoreWhitespace}`
    const expansion = this._expansions.get(key) ?? new Map()
    const split = prefs.layout === 'split'
    const rows = diffRows(model, expansion, { split })
    const limit = this._limits.get(key) ?? ROW_LIMIT
    const shown = rows.length > limit ? rows.slice(0, limit) : rows
    this._shownRows = { path, key, rows, limit }
    const lit = {
      model,
      a: kind === 'added' ? null : this._highlighted(this.base, basePath, before),
      b: kind === 'removed' ? null : this._highlighted(this.other, path, after),
      expand: (run, change) => {
        const next = new Map(expansion)
        next.set(run, change === 'all' ? { all: true } : { ...next.get(run), [change]: (next.get(run)?.[change] ?? 0) + EXPAND_STEP })
        this._expansions.set(key, next)
        this.requestUpdate()
      },
    }
    const digits = String(Math.max(model.a.length, model.b.length, 1)).length
    let started = -1
    const startOf = change => {
      if (change === started) return false
      started = change
      return true
    }
    return html`<div class=${classMap({ 'bundle-compare-diff-table': true, split, unified: !split, wrapped: split || !!state.bundleSourceWrap })}
        style=${styleMap({ '--diff-num-width': `${digits + 1}ch` })} role="table" aria-label="Diff">
        ${split ? html`<div class="diff-row diff-split-head" role="row">
          <span class="diff-half">Before<strong data-tooltip-truncated data-tooltip=${this.baseName}>${this.baseName}</strong></span>
          <span class="diff-half">After<strong data-tooltip-truncated data-tooltip=${this.otherName}>${this.otherName}</strong></span>
        </div>` : nothing}
        ${repeat(shown, row => this._rowKey(row), row => split ? this._splitRow(row, lit, startOf) : this._unifiedRow(row, lit, startOf))}
      </div>
      ${rows.length > shown.length ? html`<div class="bundle-compare-code-more">
        <button type="button" class="bundle-compare-code-action" @click=${() => { this._limits.set(key, limit + ROW_LIMIT); this.requestUpdate() }}>Show ${Math.min(ROW_LIMIT, rows.length - shown.length).toLocaleString()} more rows</button>
        <span>${(rows.length - shown.length).toLocaleString()} not shown</span>
      </div>` : nothing}`
  }

  _rowKey(row) {
    if (row.kind === 'fold') return `f${row.run}:${row.a}`
    if (row.kind === 'change') return `c${row.left ?? ''}:${row.right ?? ''}`
    return `${row.kind}${row.a ?? ''}:${row.b ?? ''}`
  }

  // Words marked in a removed line and the added line it pairs with.
  _words(model, a, b) {
    if (a == null || b == null) return null
    const key = `${a}:${b}`
    if (!model.words.has(key)) model.words.set(key, wordRanges(model.a[a], model.b[b]))
    return model.words.get(key)
  }

  _code(text, markup, ranges) {
    if (typeof markup === 'string') return unsafeHTML(markHighlighted(markup, ranges))
    if (ranges) return markSegments(text, ranges).map(part => part.marked ? html`<mark class="diff-word">${part.text}</mark>` : part.text)
    return text.length > TEXT_NODE_MAX ? textNodes(text) : text
  }

  // One side of a line: number, sign, code. `side` is 'a' or 'b'.
  _cell(lit, side, line, sign, ranges) {
    if (line == null) return html`<span class="diff-num"></span><span class="diff-sign"></span><span class="diff-code diff-empty"></span>`
    return html`<span class="diff-num">${line + 1}</span><span class="diff-sign">${sign}</span>${this._codeCell(lit, side, line, ranges)}`
  }

  _noEol(model, side, line) {
    return line != null && model.noEol[side] && line === model[side].length - 1
  }

  _fold(row, lit) {
    const all = row.count <= EXPAND_STEP
    return html`<div class="diff-row diff-fold" role="row">
      <span class="diff-fold-actions">
        ${!all && row.down ? html`<button type="button" aria-label=${`Show ${EXPAND_STEP} more lines below`} data-tooltip=${`Show ${EXPAND_STEP} more lines`} @click=${() => lit.expand(row.run, 'top')}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v9m-4-4 4 4 4-4"/></svg>
        </button>` : nothing}
        ${!all && row.up ? html`<button type="button" aria-label=${`Show ${EXPAND_STEP} more lines above`} data-tooltip=${`Show ${EXPAND_STEP} more lines`} @click=${() => lit.expand(row.run, 'bottom')}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V4M4 8l4-4 4 4"/></svg>
        </button>` : nothing}
        <button type="button" aria-label=${`Show all ${row.count} unchanged lines`} data-tooltip="Show all" @click=${() => lit.expand(row.run, 'all')}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4-4 4 4M4 10l4 4 4-4"/></svg>
        </button>
      </span>
      <span class="diff-fold-label">${row.count.toLocaleString()} unchanged ${row.count === 1 ? 'line' : 'lines'} · ${row.b + 1}–${row.b + row.count}</span>
    </div>`
  }

  _unifiedRow(row, lit, startOf) {
    const { model } = lit
    if (row.kind === 'fold') return this._fold(row, lit)
    if (row.kind === 'ctx') {
      return html`<div class="diff-row ctx" role="row"><span class="diff-num">${row.a + 1}</span>${this._cell(lit, 'b', row.b, ' ', null)}</div>`
    }
    const del = row.kind === 'del'
    const words = del ? this._words(model, row.a, row.pair)?.a : this._words(model, row.pair, row.b)?.b
    return html`<div class=${`diff-row ${row.kind}`} role="row" data-change-start=${startOf(row.change) ? row.change : nothing}>
      ${del
        ? html`<span class="diff-num">${row.a + 1}</span><span class="diff-num"></span><span class="diff-sign">−</span>${this._codeCell(lit, 'a', row.a, words)}`
        : html`<span class="diff-num"></span><span class="diff-num">${row.b + 1}</span><span class="diff-sign">+</span>${this._codeCell(lit, 'b', row.b, words)}`}
    </div>`
  }

  _codeCell(lit, side, line, ranges) {
    const text = lit.model[side][line]
    return html`<span class=${classMap({ 'diff-code': true, 'diff-long': text.length > LONG_LINE })}>${this._code(text, lit[side]?.[line], ranges)}${this._noEol(lit.model, side, line) ? html`<span class="diff-no-eol" data-tooltip="No newline at end of file" aria-label="No newline at end of file">⊘</span>` : nothing}</span>`
  }

  _splitRow(row, lit, startOf) {
    const { model } = lit
    if (row.kind === 'fold') return this._fold(row, lit)
    if (row.kind === 'ctx') {
      return html`<div class="diff-row ctx" role="row">
        <span class="diff-half">${this._cell(lit, 'a', row.a, ' ', null)}</span>
        <span class="diff-half">${this._cell(lit, 'b', row.b, ' ', null)}</span>
      </div>`
    }
    const words = row.paired ? this._words(model, row.left, row.right) : null
    return html`<div class="diff-row change" role="row" data-change-start=${startOf(row.change) ? row.change : nothing}>
      <span class=${classMap({ 'diff-half': true, del: row.left !== null, blank: row.left === null })}>${this._cell(lit, 'a', row.left, '−', words?.a)}</span>
      <span class=${classMap({ 'diff-half': true, add: row.right !== null, blank: row.right === null })}>${this._cell(lit, 'b', row.right, '+', words?.b)}</span>
    </div>`
  }
}

customElements.define('bundle-compare-code', BundleCompareCode)
