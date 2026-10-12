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
import { hidesMixedWhitespace, layoutDir, renameParts, rootLabel, wordRanges } from '@preventive/compare'
import { state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { bundleFileByteLength, bundleFilesAsMap } from './bundle-sources.js'
import { buildBundleSourceTree, bundleSourceTreePrefix, compactSourceDirectory, filterBundleSourceTree, navigateBundleSourceTree, sourceDirectoryLabel } from './bundle-source-tree.js'
import { sourceFileIcon, sourcePackageIcon } from './source-file-icon.js'
import { highlight, langForPath, splitHighlightedLines } from './prism-highlight.js'
import { LONG_LINE, sourceText } from './source-text.js'
import { controlMarkup } from './control-chars.js'
import { EXPAND_STEP, diffRows, fileLineCounts, hidesWhitespace, lineDiff, markHighlighted, markSegments, whitespaceHidden, whitespaceInsensitive } from './bundle-compare-code-model.js'
import { PRETTY_ICON, prettyCopy, prettyPrintable, prettyTooltip, togglePrettySource } from './pretty-source.js'
import { READABILITY, npmFileReadability, npmReadabilityTag } from './file-readability.js'
import { packageJsonInstallScripts } from './install-scripts.js'
import { NPM_LICENSE_FILE, npmEntryFile, npmLicenseParts } from './npm-entries.js'
import { renameDiff, renameDiffable, retryRenameDiffs } from './rename-diff.js'
import { renameTemplate, rootTemplate } from './bundle-compare-rename.js'
import { fileMetaTags, metaSentences } from './bundle-compare-meta.js'
import { bundleFileGithub, githubFileLink } from './bundle-file-github.js'
import './bundle-code-splitter.js'
import { COLLAPSE_DIRS_ICON, COPY_ICON, NEXT_ICON, PREV_ICON } from './lit-icons.js'

const KINDS = [
  { kind: 'changed', label: 'Modified', letter: 'M' },
  // Moved or re-extensioned (computeBundleDiff's renames); one whose contents changed
  // too shows under Modified as well.
  { kind: 'renamed', label: 'Renamed', letter: '→' },
  { kind: 'added', label: 'Added', letter: 'A' },
  { kind: 'removed', label: 'Removed', letter: 'D' },
  // Same contents, but some of its imports resolve elsewhere.
  { kind: 'repointed', label: 'Repointed', letter: 'R' },
]
export const KIND = Object.fromEntries(KINDS.map(entry => [entry.kind, entry]))

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
// Time a render of the tree spends counting its files' lines (_lineCounts)
// before leaving the rest to the next.
const COUNT_BUDGET_MS = 30

// View preferences shared by every comparison, and by the Diff view
// (bundle-compare-all.js), reset on page reload like the rail's width.
export const prefs = { layout: 'unified', ignoreWhitespace: false, ignoreRenames: false, markRenames: false }
// What hiding whitespace changes hides, as diff -b; and why a file whose
// changes it would hide shows them all (_fileState).
const HIDE_WHITESPACE = 'Hide whitespace changes, in code whose whitespace means nothing (JavaScript, CSS, JSON and the like): a line re-indented, or with blanks added to a run of them or at its end, reads as unchanged; blanks put between other characters or taken from between them still show'
const WHITESPACE_KEPT = {
  mixed: 'Its whitespace changes mix spaces with tabs or other blanks, so all of them show',
  unlisted: 'Whitespace changes are hidden only in code whose whitespace means nothing, as JavaScript, CSS or JSON: all of this file\'s show',
}
// The format a stasis bundle records for one of its files, its own spelling
// of the file's language; undefined for another kind of bundle, or a file it
// records none for.
const stasisFormat = (details, path) => (details?.kind === 'stasis' ? details.bundle?.formats?.get(path) : undefined)
// Renamed names are hidden in JavaScript alone, what a minifier renames: in
// another language a short word (a CSS selector, a tag, prose) is no binding.
export const renamable = path => /\.[cm]?js$/iu.test(path)
const hidesRenames = (path, { ignoreRenames } = prefs) => ignoreRenames && renamable(path)
// How a text reads (file-readability.js), by bundle and path: as the npm
// Overview tags a file, and whether it was minified, its short names then a
// minifier's, not its author's.
const readTexts = new WeakMap()
function readability(details, path, text) {
  let files = readTexts.get(details)
  if (!files) readTexts.set(details, files = new Map())
  if (!files.has(path)) files.set(path, npmFileReadability(path, text))
  return files.get(path)
}
const minified = (details, path, text) => readability(details, path, text).category === 'minified'

// The files a bundle or package version starts from, by path, each with what
// names it: a Stasis bundle's entries, an npm version's main, module, types
// and bins, found as its Overview finds them (npm-entries.js); and its
// license files, named as its Overview's do (an npm version's at its root,
// with the licenses its manifest names them for; a bundle's packages').
const LICENSE_NOTE = 'A license file'
const entryNames = new WeakMap()
function entryPoints(details) {
  let found = entryNames.get(details)
  if (found) return found
  found = new Map()
  const add = (path, label, note) => { if (path) found.set(path, [...found.get(path) ?? [], { label, note }]) }
  if (details?.kind === 'stasis') for (const path of details.bundle?.entries ?? []) add(path, 'entry', 'An entry point of the bundle')
  const manifest = details?.npm?.manifest
  if (manifest) {
    const files = new Set(bundleFilesAsMap(details).keys())
    for (const field of ['main', 'module', 'types']) {
      if (typeof manifest[field] === 'string') add(npmEntryFile(manifest[field], files), field, `package.json "${field}": ${manifest[field]}`)
    }
    for (const [name, file] of Object.entries(manifest.bin ?? {})) if (typeof file === 'string') add(npmEntryFile(file, files), 'bin', `package.json "bin" ${name}: ${file}`)
    const licenses = Map.groupBy(typeof manifest.license === 'string' ? npmLicenseParts(manifest.license, [...files]).filter(part => part.file) : [], part => part.file)
    for (const path of files) {
      if (NPM_LICENSE_FILE.test(path)) add(path, 'license', licenses.has(path) ? `License: ${licenses.get(path).map(part => part.text).join(', ')}` : LICENSE_NOTE)
    }
  } else {
    for (const path of bundleFilesAsMap(details).keys()) if (NPM_LICENSE_FILE.test(path.slice(path.lastIndexOf('/') + 1))) add(path, 'license', LICENSE_NOTE)
  }
  entryNames.set(details, found)
  return found
}

// A package.json's install scripts (install-scripts.js), by bundle and path:
// `node-gyp rebuild` among them where a binding.gyp is beside it.
const PACKAGE_JSON = /(?:^|\/)package\.json$/u
const scriptTexts = new WeakMap()
function packageScripts(details, path, text) {
  let files = scriptTexts.get(details)
  if (!files) scriptTexts.set(details, files = new Map())
  if (!files.has(path)) files.set(path, packageJsonInstallScripts(text, bundleFilesAsMap(details).has(`${path.slice(0, -'package.json'.length)}binding.gyp`)))
  return files.get(path)
}

// Why the server left a file's old names as they were (@preventive/compare's renamedDiff).
const RENAME_REASONS = {
  unparsed: "the file couldn't be parsed",
  dynamic: 'the file reads names by their spelling (eval or with)',
  jsx: 'the file holds JSX',
  'block-function': 'the file declares a function in a block outside strict code',
  unverified: "the old side with the new names couldn't be checked to read as before",
}

// A file's line model by what it was diffed with: the settings, and whether
// its sides were pretty-printed (see _pretty).
export const modelKey = (path, pretty, settings = prefs) => `${path}\0${settings.ignoreWhitespace}\0${hidesRenames(path, settings)}\0${!!settings.markRenames}\0${pretty}`

// `${integrity}\0${path}` → the file's highlighted lines, or null when Prism
// has no grammar for it or it is too large to color.
const highlightCache = new Map()
const highlightPending = new Set()

function countLines(text) {
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

// A diff too large to compute before it is asked for.
// path → { kind, baseBytes, otherBytes, basePath, renamedFrom, modified, meta }
// for every file that differs between the two sides of `files`
// (bundle-compare-diff.js): removed, added, or changed, `basePath` naming the
// file in the base bundle where that differs from its path, `renamedFrom` a
// renamed one's old path, `modified` whether its contents changed too (false
// for a changed one whose record alone changed), and `meta` how what a stasis
// bundle records of it changed.
export function fileEntries(files) {
  const entries = new Map()
  if (!files) return entries
  for (const row of files.onlyBase) entries.set(row.path, { kind: 'removed', basePath: row.basePath, baseBytes: row.bytes, otherBytes: null })
  for (const row of files.onlyOther) entries.set(row.path, { kind: 'added', baseBytes: null, otherBytes: row.bytes })
  for (const row of files.changed) {
    const recorded = { ...row.meta ? { meta: row.meta } : {} }
    entries.set(row.path, row.renamedFrom == null
      ? { kind: 'changed', basePath: row.basePath, baseBytes: row.baseBytes, otherBytes: row.otherBytes, ...row.modified === false ? { modified: false } : {}, ...recorded }
      : { kind: 'renamed', basePath: row.basePath, renamedFrom: row.renamedFrom, modified: row.modified, baseBytes: row.baseBytes, otherBytes: row.otherBytes, ...recorded })
  }
  return entries
}

// A file's two sides, as `entry` names them, from the two bundles' details.
export function fileContents(base, other, path, { kind, basePath = path }) {
  let before = kind === 'added' ? '' : bundleFilesAsMap(base).get(basePath)
  let after = kind === 'removed' ? '' : bundleFilesAsMap(other).get(path)
  // An importer captured on one side only (or neither) is no change of
  // contents; what there is of it shows as unchanged.
  if (kind === 'repointed') before = after = after ?? before
  return { before, after }
}

// Lines added and removed, as a diff's head counts them.
export const diffCounts = (additions, deletions) => html`<span class="bundle-compare-code-counts" aria-label=${`${additions} added, ${deletions} removed lines`}>
  <span class="add">+${additions.toLocaleString()}</span><span class="del">−${deletions.toLocaleString()}</span>
</span>`

export const isLargeDiff = (before, after) => before.length + after.length > LARGE_CHARS || countLines(before) + countLines(after) > LARGE_LINES

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
// Every directory above `paths`, kept for `key`.
function dirsOf(key, paths) {
  if (dirSets.has(key)) return dirSets.get(key)
  const dirs = new Set()
  for (const path of paths) {
    for (let at = path.lastIndexOf('/'); at > 0 && !dirs.has(path.slice(0, at)); at = path.lastIndexOf('/', at - 1)) dirs.add(path.slice(0, at))
  }
  dirSets.set(key, dirs)
  return dirs
}

function bundleDirs(details) {
  const files = bundleFilesAsMap(details)
  return dirsOf(files, files.keys())
}

function containsFile(node, path) {
  for (const full of node.files.values()) if (full === path) return true
  for (const child of node.dirs.values()) if (containsFile(child, path)) return true
  return false
}

export class BundleCompareCode extends LitElement {
  static properties = {
    base: { attribute: false },
    other: { attribute: false },
    files: { attribute: false },
    resolutions: { attribute: false },
    // Alerts on each side's files, by path, and their tags: Socket's, on an
    // npm version's (npm-overview.js npmSocketFileAlerts).
    baseAlerts: { attribute: false },
    otherAlerts: { attribute: false },
    alertTags: { attribute: false },
    // A source's dependency changes, `{ removed, added, changed }`
    // (npm-package.js npmDependencyChanges), and what opens one.
    dependencies: { attribute: false },
    openDependency: { attribute: false },
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
    this.baseAlerts = null
    this.otherAlerts = null
    this.alertTags = null
    this.path = null
    this._query = ''
    this._kinds = new Set(KINDS.map(entry => entry.kind))
    // Directory path → open, for the disclosures the user toggled.
    this._open = new Map()
    this._models = new Map()
    this._modelCap = MODEL_CACHE
    // Path → the tree's line counts for it (_lineCounts), for these entries.
    this._counted = new Map()
    // What diff -b would hide in the texts a file shows (_whitespaceHidden).
    this._spaced = new Map()
    // A model's key (modelKey) → fold run → lines revealed, and the rows
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
        this._spaced.clear()
        this._expansions.clear()
        this._limits.clear()
        this._forced.clear()
      }
    }
    if (['files', 'resolutions', 'base', 'other'].some(name => changed.has(name))) {
      this._entries = this._buildEntries()
      this._counted = new Map()
    }
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

  // fileEntries, and every file that imports something that now resolves
  // elsewhere, `repointed` listing those imports.
  _buildEntries() {
    const entries = fileEntries(this.files)
    if (!this.files) return entries
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

  // Both bundles' modules by directory, the base's moved with the root where
  // the two differ by theirs, as the tree lays out its files.
  _modules() {
    const base = this.base?.kind === 'stasis' ? this.base.bundle?.modules : null
    const other = this.other?.kind === 'stasis' ? this.other.bundle?.modules : null
    const layout = { root: this.files?.root, paths: this.files?.basePaths ?? new Map() }
    return base || other ? new Map([...[...base ?? []].map(([dir, info]) => [layoutDir(layout, dir, Object.keys(info.files ?? {})), info]), ...(other ?? [])]) : null
  }

  // The base bundle's directories as the tree lays them out: the other
  // bundle's way, where the two differ by their root.
  _baseDirs() {
    const paths = this.files?.root ? this.files.basePaths : null
    return paths ? dirsOf(paths, paths.values()) : bundleDirs(this.base)
  }

  _format(path) {
    const entry = this._entries.get(path)
    return entry?.kind === 'removed' ? stasisFormat(this.base, entry.basePath ?? path) : stasisFormat(this.other, path)
  }

  // The tree over the files the kind filter keeps. The display prefix comes
  // from every differing file, so filtering doesn't move the tree's root.
  _tree() {
    const key = [this._entries, [...this._kinds].join()]
    if (this._treeKey?.[0] === key[0] && this._treeKey[1] === key[1]) return this._treeMemo
    const all = [...this._entries.keys()]
    const modules = this._modules()
    const root = rootLabel(this.files?.root, bundleSourceTreePrefix(stripCommonPathPrefix(all).prefix, modules, all))
    const { prefix } = root
    const shown = all.filter(path => this._shown(this._entries.get(path)))
    const strip = path => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    this._treeKey = key
    this._treeMemo = { prefix, root, tree: buildBundleSourceTree(shown.map(strip), shown, modules), shown: shown.length }
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

  // The rail's tree as its path and kind filters leave it, and its files in
  // the order it lists them.
  _railState() {
    const { prefix, root, tree, shown } = this._tree()
    const filtered = this._query ? filterBundleSourceTree(tree, this._query, prefix) : tree
    return { prefix, root, tree, shown, filtered, order: filtered ? orderedFiles(filtered) : [] }
  }

  // The rail: the files that differ as a tree, filtered by path and kind,
  // `current` marked, and the splitter beside it. Picking a file is _select.
  _renderRail({ prefix, root, tree, shown, filtered }, current) {
    this._countUntil = null
    const counts = Object.fromEntries(KINDS.map(({ kind }) => [kind, 0]))
    for (const entry of this._entries.values()) {
      if (entry.kind !== 'repointed') counts[entry.kind]++
      if (entry.modified) counts.changed++
      if (entry.repointed) counts.repointed++
    }
    return html`<aside class="bundle-code-rail">
        <div class="bundle-code-rail-head">
          <span class="bundle-code-rail-label">Changes</span>
          <span class="bundle-code-rail-count">${this._entries.size.toLocaleString()}</span>
          <span class="bundle-code-rail-actions">
            <button type="button" class="bundle-code-rail-action" aria-label="Collapse directories" data-tooltip="Collapse directories"
              ?disabled=${!!this._query || tree.dirs.size === 0} @click=${() => this._collapseAll(tree)}>
              ${COLLAPSE_DIRS_ICON}
            </button>
          </span>
        </div>
        ${root.from ? html`<div class="bundle-code-rail-prefix mono" data-tooltip=${`Root moved: ${root.from} → ${root.to}`}>${rootTemplate(root)}</div>`
          : prefix ? html`<div class="bundle-code-rail-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</div>` : nothing}
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
        aria-label="Resize file tree" data-tooltip="Drag to resize · double-click to reset"></bundle-code-splitter>`
  }

  render() {
    const rail = this._railState()
    const current = this._entries.has(this.path) ? this.path : rail.order[0] ?? null
    if (current && current !== this._current) this._reveal(current, rail.prefix)
    this._current = current
    this._order = rail.order
    return html`<div class="bundle-code-view bundle-compare-code">
      ${this._renderRail(rail, current)}
      <div class="bundle-code-main">
        ${current ? this._renderFile(current, rail.prefix) : html`<div class="bundle-code-placeholder">No files differ in this comparison.</div>`}
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
        const dirKind = this._baseDirs().has(child.sourcePath)
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
        const { kind, repointed, renamedFrom, modified } = this._entries.get(full)
        const imports = repointed ? `${repointed.length} repointed ${repointed.length === 1 ? 'import' : 'imports'}` : ''
        return html`<li class="bundle-code-tree-file">
          <button type="button" class=${classMap({ 'bundle-code-tree-link': true, current: full === current })}
            aria-current=${full === current ? 'true' : nothing} @click=${() => this._select(full)}>
            ${sourceFileIcon(full, this._format(full))}<span class=${`bundle-code-tree-name bundle-compare-code-name ${kind}`} data-tooltip-truncated data-tooltip=${full}>${name}</span>
            ${renamedFrom ? html`<span class="bundle-compare-code-oldname" data-tooltip-truncated data-tooltip=${`Renamed from ${renamedFrom}`}>← ${renameParts(renamedFrom, full, { extension: false }).from}</span>` : nothing}
            ${this._alertTags(full, this._entries.get(full))}${this._treeTag(full, this._entries.get(full))}${this._installTags(full, this._entries.get(full), true)}${fileMetaTags(this._entries.get(full).meta, true)}
            ${this._treeCounts(full, this._entries.get(full))}
            ${repointed && kind !== 'repointed' ? html`<span class="bundle-compare-code-letter repointed" data-tooltip=${imports}>R</span>` : nothing}
            <span class=${classMap({ 'bundle-compare-code-letter': true, [kind]: true, pure: kind === 'renamed' && !modified })}
              data-tooltip=${kind === 'repointed' ? imports : renamedFrom ? `Renamed${modified ? ' and modified' : ''} from ${renamedFrom}` : KIND[kind].label}>${KIND[kind].letter}</span>
          </button>
        </li>`
      })}
    </ul>`
  }

  // A file's lines added and removed in the tree, before its letter, as an
  // npm dependency review's tree lists them: `=` for one renamed as it was,
  // and a count with nothing in it there (an added file's −0) unseen, keeping
  // its room, so the counts line up. None for a file whose contents are the
  // same, only its imports repointed.
  _treeCounts(path, entry) {
    if (entry.kind === 'repointed') return nothing
    const counts = this._lineCounts(path, entry)
    if (!counts) return nothing
    const { additions, deletions } = counts
    const renamed = entry.kind === 'renamed'
    // A file renamed, or recorded otherwise, as it was.
    if ((renamed || entry.modified === false) && additions === 0 && deletions === 0) {
      return html`<span class="bundle-compare-code-line-counts unchanged" aria-label="No line changes">=</span>`
    }
    return html`<span class="bundle-compare-code-line-counts" aria-label=${`${additions} added, ${deletions} removed lines`}>
      <span class=${classMap({ add: true, empty: renamed && additions === 0 })}>+${additions.toLocaleString()}</span>
      <span class=${classMap({ del: true, empty: entry.kind === 'added' || (renamed && deletions === 0) })}>−${deletions.toLocaleString()}</span>
    </span>`
  }

  // A file's lines added and removed between its sides as they are
  // (fileLineCounts), kept for these entries. A long tree is counted a little
  // at a time: a render counts from its first file until its budget is spent
  // and asks for another to count the rest, so the tree paints at once and
  // fills in.
  _lineCounts(path, entry) {
    if (this._counted.has(path)) return this._counted.get(path)
    const now = performance.now()
    this._countUntil ??= now + COUNT_BUDGET_MS
    if (now > this._countUntil) {
      this._countLater ??= setTimeout(() => { this._countLater = null; this.requestUpdate() })
      return null
    }
    const { before, after } = fileContents(this.base, this.other, path, entry)
    const counts = fileLineCounts(before, after)
    this._counted.set(path, counts)
    return counts
  }

  // ── The selected file ────────────────────────────────────────────

  // `options` as lineDiff takes them: the server's blocks, with renamed names
  // hidden, or those it marks (rename-diff.js); found with whitespace changes
  // hidden or not as `ignoreWhitespace` is.
  _model(key, before, after, options = {}, ignoreWhitespace = prefs.ignoreWhitespace) {
    // Re-inserted on every use, so the cache drops the least recent.
    let model = this._models.get(key)
    this._models.delete(key)
    if (!model) {
      model = lineDiff(before, after, { ...options, ignoreWhitespace })
    }
    this._models.set(key, model)
    if (this._models.size > this._modelCap) this._models.delete(this._models.keys().next().value)
    return model
  }

  // A file's two sides, pretty-printed where the toggle has them so, and its
  // line model where it has one to draw: none for a file that is not text,
  // nor for one too large to diff unasked.
  // `prettyAllowed` false where a view would pretty-print more than it can at once.
  _fileState(path, entry, prettyAllowed = true) {
    const contents = fileContents(this.base, this.other, path, entry)
    const textual = typeof contents.before === 'string' && typeof contents.after === 'string'
    const pretty = textual ? this._pretty(path, entry, contents, prettyAllowed) : null
    const { before, after } = pretty?.status === 'ready' ? pretty : contents
    // Renamed names are hidden by the server, in the copies it pretty-printed
    // (rename-diff.js): offered while those come, hidden once they did.
    const generated = textual && renamable(path) && renamable(entry.basePath ?? path) && (pretty?.status === 'ready' || pretty?.status === 'loading')
      && this._generated(path, entry, contents)
    const renames = generated && prefs.ignoreRenames && pretty.status === 'ready'
    // Marked rather than hidden where the viewer asks: the diff of the files
    // as they are, the blocks that differ in renamed names alone drawn apart.
    const marking = renames && prefs.markRenames
    const large = textual && !this._forced.has(path) && isLargeDiff(before, after)
    const { basePath = path } = entry
    const diffed = ignoreWhitespace => {
      const changes = renames && !large
        ? renameDiff(this.base, basePath, contents.before, this.other, path, contents.after, ignoreWhitespace, () => this.requestUpdate(), pretty.hashes) : null
      const ready = changes?.status === 'ready'
      // Where either side reads names (`f.name`, `f.toString()`), a rename may
      // change what the code does, which hiding renamed names could hide: its
      // renamed lines are marked then, as the viewer may ask for anywhere.
      const reading = ready && changes.reason === null && changes.reads.length > 0
      const marked = ready && (marking || reading)
      const hiding = ready && !marked
      const key = modelKey(path, pretty?.status === 'ready', { ...prefs, ignoreWhitespace, ignoreRenames: hiding, markRenames: marked })
      // The old side as the server diffed it, given the new side's names, where they are hidden.
      const shown = hiding ? changes.before : before
      const model = textual && !large && (!changes || ready)
        ? this._model(key, shown, after, hiding ? { changes: { blocks: changes.blocks } } : marked ? { marks: changes.marks } : {}, ignoreWhitespace) : null
      return { key, changes, reading, hiding, shown, model }
    }
    // Whitespace changes are hidden as diff -b hides them, only in a file whose
    // whitespace means nothing, on both sides (whitespaceInsensitive), and not
    // where that would hide blanks of more than one kind changing
    // (hidesMixedWhitespace): others are diffed with them shown.
    const unlisted = !whitespaceInsensitive(path, contents.after, stasisFormat(this.other, path))
      || !whitespaceInsensitive(basePath, contents.before, stasisFormat(this.base, basePath))
    let found = diffed(prefs.ignoreWhitespace && !unlisted)
    const mixed = prefs.ignoreWhitespace && !unlisted && !!found.model && hidesMixedWhitespace(found.shown, after, found.model.blocks)
    if (mixed) found = diffed(false)
    const { key, changes, reading, hiding, shown, model } = found
    // What hiding them does here: hides one (`hideable`), where the diff shown
    // does or diff -b would while they show (_whitespaceHidden); or would, but
    // may not (`mixed`, `unlisted`), said while they are to be hidden. Where it
    // would hide none, or none it may, it is not offered.
    const off = model && (unlisted || !prefs.ignoreWhitespace) ? this._whitespaceHidden(`${path}\0${pretty?.status === 'ready'}\0${hiding}`, shown, after) : null
    const whitespace = model === null ? null
      : mixed ? 'mixed'
      : unlisted ? (prefs.ignoreWhitespace && off.hides ? 'unlisted' : null)
      : prefs.ignoreWhitespace ? (hidesWhitespace(shown, after, model.blocks) ? 'hideable' : null)
      : off.hides && !off.mixed ? 'hideable' : null
    return { before: shown, after, textual, large, pretty, key, generated, renames, marking, reading, hiding, changes, model, whitespace }
  }

  // What diff -b would hide between the texts a file shows (whitespaceHidden),
  // `key` naming them, kept as their models are.
  _whitespaceHidden(key, before, after) {
    const hidden = this._spaced.get(key) ?? whitespaceHidden(before, after)
    this._spaced.delete(key)
    this._spaced.set(key, hidden)
    if (this._spaced.size > this._modelCap) this._spaced.delete(this._spaced.keys().next().value)
    return hidden
  }

  // Whether a file's names are a minifier's on both sides, each minified, and
  // the server can diff it: renamed names are hidden there alone, an
  // author's renamed to a minifier's (or to another author's) a change.
  _generated(path, { kind, basePath = path }, { before, after }) {
    return kind !== 'repointed' && renameDiffable(this.base, this.other) && minified(this.base, basePath, before) && minified(this.other, path, after)
  }

  // Whether each side of a file with text can be pretty-printed.
  _printable(path, { kind, basePath = path }, { before, after } = fileContents(this.base, this.other, path, { kind, basePath })) {
    return kind !== 'repointed' && typeof before === 'string' && typeof after === 'string'
      && [[this.base, basePath, before], [this.other, path, after]].every(([details, file, text]) => text === '' || prettyPrintable(details, details, file, text))
  }

  // Both sides pretty-printed (pretty-source.js), as the Code tab shows a
  // minified file, so minified versions diff line by line: null unless each
  // side with text can be, `limited` where not `allowed`, else the toggle's
  // state and, once both copies came, their texts and hashes.
  _pretty(path, entry, contents, allowed = true) {
    if (!this._printable(path, entry, contents)) return null
    if (!allowed) return { status: 'limited' }
    const { basePath = path } = entry, { before, after } = contents
    const sides = [[this.base, basePath, before], [this.other, path, after]]
    const copies = sides.map(([details, file, text]) => text === '' ? { status: 'ready', text } : prettyCopy(details, details, file, text, () => this.requestUpdate()))
    if (copies.includes(null)) return { status: 'off' }
    const failed = copies.find(copy => copy.status === 'error')
    if (failed) return failed
    if (copies.some(copy => copy.status === 'loading')) return { status: 'loading' }
    return { status: 'ready', before: copies[0].text, after: copies[1].text, hashes: copies.map(copy => copy.hash) }
  }

  // What a file shows in place of a diff: why there is none, or how to have
  // one; null where there is a diff to show.
  _fileMessage(path, { kind, modified, meta }, { before, after, textual, large, model, hiding, changes, whitespace }) {
    const size = value => formatBytes(value ?? 0)
    const recorded = metaSentences(meta)
    const same = `${kind === 'renamed' ? (recorded ? 'Renamed, its contents the same.' : 'Renamed without changes.') : 'The contents are the same.'}${recorded ? ` ${recorded}` : ''}`
    // Its bytes the same (bundle-compare-diff.js): no diff to compute, however large.
    if (textual && modified === false) return html`<div class="bundle-compare-code-message"><p>${same}</p></div>`
    if (!textual) {
      if (kind === 'changed' && modified === false) {
        return html`<div class="bundle-compare-code-message">Binary file, its bytes the same · ${size(bundleFileByteLength(after))}. ${recorded}</div>`
      }
      const bytes = kind === 'added' ? size(bundleFileByteLength(after)) : kind === 'removed' ? size(bundleFileByteLength(before))
        : `${size(bundleFileByteLength(before))} → ${size(bundleFileByteLength(after))}`
      return html`<div class="bundle-compare-code-message">Binary file ${kind} · ${bytes}. A text diff is not available.${recorded ? ` ${recorded}` : ''}</div>`
    }
    if (large) {
      return html`<div class="bundle-compare-code-message">
        <p>This diff is large (${(countLines(before) + countLines(after)).toLocaleString()} lines across both sides) and may take a few seconds to compute.</p>
        <button type="button" class="bundle-compare-code-action" @click=${() => { this._forced.add(path); this.requestUpdate() }}>Show diff</button>
      </div>`
    }
    if (changes?.status === 'loading') return html`<div class="bundle-compare-code-message" aria-busy="true">${prefs.markRenames ? 'Marking renamed lines…' : 'Hiding renamed names…'}</div>`
    if (changes?.status === 'error') {
      return html`<div class="bundle-compare-code-message">
        <p>Couldn't hide renamed names: ${changes.message}</p>
        <button type="button" class="bundle-compare-code-action" @click=${() => this._setRenames(false)}>Show renamed names</button>
      </div>`
    }
    if (model.blocks.length > 0) return null
    const spaced = prefs.ignoreWhitespace && whitespace === 'hideable'
    const hidden = [spaced && 'whitespace', hiding && 'renamed names'].filter(Boolean)
    return html`<div class="bundle-compare-code-message">
      <p>${hidden.length > 0 ? `Only ${hidden.join(' and ')} changed in this file.${recorded ? ` ${recorded}` : ''}` : same}</p>
      ${spaced ? html`<button type="button" class="bundle-compare-code-action" @click=${() => this._setWhitespace(false)}>Show whitespace changes</button>` : nothing}
      ${hiding ? html`<button type="button" class="bundle-compare-code-action" @click=${() => this._setRenames(false)}>Show renamed names</button>` : nothing}
    </div>`
  }

  // A file's kind, icon and path, `prefix` left off, and how it reads.
  _fileName(path, entry, prefix) {
    const strip = file => prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
    return html`<span class=${classMap({ 'bundle-compare-code-pill': true, [entry.kind]: true, pure: entry.kind === 'renamed' && !entry.modified })}>${KIND[entry.kind].label}</span>
      ${sourceFileIcon(path, this._format(path))}
      <span class="bundle-code-main-path mono" data-tooltip-truncated data-tooltip=${entry.renamedFrom ? `${entry.renamedFrom} → ${path}` : path}>${entry.renamedFrom ? renameTemplate(strip(entry.renamedFrom), strip(path)) : strip(path)}</span>
      ${this._entryTags(path, entry)}${this._alertTags(path, entry)}${this._readability(path, entry)}${this._installTags(path, entry)}${fileMetaTags(entry.meta)}${this._githubLink(path, entry)}`
  }

  // The file on GitHub, at the revision of the side it's read from (the one
  // compared with for a removed file), where that side records where its
  // files come from and at what commit (bundle-file-github.js).
  _githubLink(path, { kind, basePath = path }) {
    const github = kind === 'removed' ? bundleFileGithub(this.base, basePath) : bundleFileGithub(this.other, path)
    return github ? githubFileLink(github) : nothing
  }

  // The alerts on a file (`otherAlerts`; `baseAlerts` for one removed), in
  // its head and in the tree.
  _alertTags(path, { kind, basePath = path }) {
    const alerts = kind === 'removed' ? this.baseAlerts?.get(basePath) : this.otherAlerts?.get(path)
    return alerts?.length > 0 && this.alertTags ? this.alertTags(alerts) : nothing
  }

  // A file the open bundle or version starts from (for one removed, the one
  // compared with), labelled with what names it: main, module, types, bin,
  // or a bundle's entry; and a license file, as license.
  _entryTags(path, { kind, basePath = path }) {
    const names = entryPoints(kind === 'removed' ? this.base : this.other).get(kind === 'removed' ? basePath : path) ?? []
    const labels = Map.groupBy(names, ({ label }) => label)
    return [...labels].map(([label, rows]) => html`<span class=${`bundle-compare-code-entry${label === 'license' ? ' is-license' : ''}`}
      data-tooltip=${rows.map(({ note }) => note).join(' · ')}>${label}</span>`)
  }

  // A package.json's install scripts, as warnings, each with its command:
  // those it names now (named, for one removed), one new or changed since
  // saying so, and in its head, one dropped since struck through; the tree
  // (`compact`) tags those it names now alone.
  _installTags(path, entry, compact = false) {
    if (!PACKAGE_JSON.test(path)) return nothing
    const { kind, basePath = path } = entry
    const { before, after } = fileContents(this.base, this.other, path, entry)
    const was = new Map(kind === 'added' || before === undefined ? [] : packageScripts(this.base, basePath, before))
    const now = new Map(kind === 'removed' || after === undefined ? [] : packageScripts(this.other, path, after))
    const tags = [...kind === 'removed' ? was : now].map(([script, command]) => {
      const old = kind === 'removed' ? command : was.get(script)
      const note = old === undefined ? ', new' : old === command ? '' : `, was: ${old}`
      return html`<span class="bundle-compare-code-install" data-tooltip=${`${command}${note}`}>${script}</span>`
    })
    if (!compact && kind !== 'removed') {
      for (const [script, command] of was) {
        if (!now.has(script)) tags.push(html`<span class="bundle-compare-code-install is-dropped" data-tooltip=${`No longer run on install: ${command}`}>${script}</span>`)
      }
    }
    return tags
  }

  // How a file reads (file-readability.js) on the sides it has: `was`, as
  // the bundle compared with has it, and `now`; null for a side without it.
  _reads(path, entry) {
    const { kind, basePath = path } = entry
    const { before, after } = fileContents(this.base, this.other, path, entry)
    return {
      was: kind === 'added' || before === undefined ? null : readability(this.base, basePath, before),
      now: kind === 'removed' || after === undefined ? null : readability(this.other, path, after),
    }
  }

  // A file's head tags how it reads, as the npm Overview tags a file (ASCII,
  // UTF-8, Minified, Controls, ...): as it reads now, after how it read where
  // that differs.
  _readability(path, entry) {
    const { was, now } = this._reads(path, entry)
    if (!was || !now || was.category === now.category) return npmReadabilityTag(now ?? was)
    return html`<span class="bundle-compare-code-readability">${npmReadabilityTag(was)}<span aria-hidden="true">→</span>${npmReadabilityTag(now)}</span>`
  }

  // The tree tags a file as its head does where it can be hard to review by
  // reading it as it reads now (as it read, for one removed): ASCII and UTF-8
  // go untagged there.
  _treeTag(path, entry) {
    const { was, now } = this._reads(path, entry)
    const shown = now ?? was
    return shown && READABILITY.get(shown.category).mark ? npmReadabilityTag(shown) : nothing
  }

  // A file's lines added and removed, and its sizes.
  _fileFigures({ kind, baseBytes, otherBytes }, model) {
    const size = value => formatBytes(value ?? 0)
    return html`${model?.blocks.length > (model?.marked?.size ?? 0) ? diffCounts(model.additions, model.deletions) : nothing}
      ${model?.renamed > 0 ? html`<span class="bundle-compare-code-renamed" aria-label=${`${model.renamed} lines differing in renamed names alone`}
        data-tooltip="Lines differing in renamed names alone, marked">≈${model.renamed}</span>` : nothing}
      <span class="bundle-code-main-stats">${kind === 'added' ? size(otherBytes) : kind === 'removed' ? size(baseBytes) : `${size(baseBytes)} → ${size(otherBytes)}`}</span>`
  }

  // Highlighted lines of one side, or null until (or unless) Prism colors
  // it; the first ask starts the work and re-renders once it lands.
  // `copy` names a text other than the file's own: `pretty`, or the old side
  // given another file's names (`renamed` and that file).
  _highlighted(details, path, text, copy = '') {
    if (!text) return null
    const lang = langForPath(path, stasisFormat(details, path), text)
    if (!lang) return null
    const key = `${details.integrity}\0${path}${copy ? `\0${copy}` : ''}`
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
    const file = this._fileState(path, entry)
    const { after, before, textual, model } = file
    // A file whose only change is a repointed import — moved there by a
    // rename or not — reads as its source, whatever the whitespace setting:
    // its two sides are one text. One whose record changed too says how.
    const asSource = kind === 'repointed' || (kind === 'renamed' && !entry.modified && !!entry.repointed && !entry.meta)
    const diffable = textual && (!asSource || model?.blocks.length > 0)
    const index = this._order.indexOf(path)
    const display = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    const body = kind === 'repointed' && before === undefined
      ? html`<div class="bundle-compare-code-message">Neither bundle carries this importer's source.</div>`
      : asSource && model?.blocks.length === 0 ? this._renderSource(path, after, entry.repointed, file)
      : this._fileMessage(path, entry, file) ?? this._renderDiff(path, entry, file)
    return html`<header class="bundle-code-main-bar bundle-compare-code-bar">
        <span class="bundle-code-file-nav">
          <button type="button" class="focus-code-nav-btn" aria-label="Previous file" data-tooltip="Previous file" ?disabled=${index <= 0} @click=${() => this._select(this._order[index - 1])}>
            ${PREV_ICON}
          </button>
          <button type="button" class="focus-code-nav-btn" aria-label="Next file" data-tooltip="Next file" ?disabled=${index === -1 ? this._order.length === 0 : index >= this._order.length - 1} @click=${() => this._select(this._order[index + 1])}>
            ${NEXT_ICON}
          </button>
        </span>
        ${this._fileName(path, entry, prefix)}
        <button type="button" class="bundle-code-copy-path" data-copy-path=${path} aria-label="Copy file path">
          ${COPY_ICON}
        </button>
        <span class="bundle-code-main-spacer"></span>
        ${this._fileFigures(entry, model)}
        ${this._toggles(diffable, file.pretty, file.generated, file.reading, file.whitespace)}
      </header>
      <div class="bundle-compare-diff" tabindex="0" aria-label=${`Changes in ${display}`}>
        ${this._dependencyChanges(path)}
        ${entry.repointed ? this._renderRepointed(path, entry.repointed, [after, before].find(text => typeof text === 'string' && text !== '') ?? null, textual && !diffable) : nothing}
        ${body}
      </div>`
  }

  // The diff's pretty-print, layout, whitespace and renamed names toggles, as
  // a file has use for them: pretty-printing a minified file (`pretty` from
  // _pretty), a diff its layout, whitespace where hiding it hides a change
  // (`whitespace`) and, in JavaScript minified on both sides (`renames`,
  // _generated), renamed names. Lines always wrap.
  _toggles(diffable, pretty = null, renames = false, reading = false, whitespace = null) {
    return html`${pretty ? html`<button type="button" class=${classMap({ 'bundle-compare-code-toggle': true, 'is-loading': pretty.status === 'loading', 'is-error': pretty.status === 'error' })}
          aria-pressed=${String(!!state.bundleSourcePretty)} aria-busy=${pretty.status === 'loading' ? 'true' : nothing} aria-label="Pretty-print" ?disabled=${pretty.status === 'limited'}
          data-tooltip=${pretty.status === 'limited' ? 'Too many minified files to pretty-print together: open one in Code' : prettyTooltip(pretty)}
          @click=${() => { togglePrettySource(); this.requestUpdate() }}>${PRETTY_ICON}</button>` : nothing}
        ${diffable ? html`<span class="bundles-overview-sort bundle-compare-code-layout" role="group" aria-label="Diff layout">
          ${[['unified', 'Unified'], ['split', 'Split']].map(([value, label]) => html`<button type="button" aria-pressed=${String(prefs.layout === value)} @click=${() => { prefs.layout = value; this.requestUpdate() }}>${label}</button>`)}
        </span>
        ${whitespace ? this._whitespaceToggle(whitespace) : nothing}
        ${renames ? html`<button type="button" class="bundle-compare-code-toggle" aria-pressed=${String(prefs.ignoreRenames)} aria-label="Hide renamed names"
          data-tooltip="Hide renamed names: the old side given the new side's names wherever a minifier renamed a variable alike throughout, an old one no new one stands for named apart (r_old)"
          @click=${() => this._setRenames(!prefs.ignoreRenames)}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h9m-2.5-2.5L11 5 8.5 7.5M14 11H5m2.5-2.5L5 11l2.5 2.5"/></svg>
        </button>` : nothing}
        ${renames && prefs.ignoreRenames ? this._marksToggle(reading) : nothing}` : nothing}`
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
  // Over the package's own package.json, where a source lists what its
  // dependencies changed (`dependencies`): plain, peer and optional ones (dev
  // ones aren't listed), under one head counting them, each a chip with its
  // range beside its name, those the open version adds, those whose range
  // it changes and those it drops, struck through, each opening as the
  // Overview's Dependencies rows do.
  _dependencyChanges(path) {
    if (path !== 'package.json' || !this.dependencies) return nothing
    const { added, changed, removed } = this.dependencies
    const chips = [...added.map(row => ['added', row]), ...changed.map(row => ['changed', row]), ...removed.map(row => ['removed', row])]
    if (chips.length === 0) return nothing
    const counts = [[added, 'new'], [changed, 'updated'], [removed, 'removed']].filter(([rows]) => rows.length > 0).map(([rows, noun]) => `${rows.length} ${noun}`)
    const open = this.openDependency
    return html`<section class="bundle-compare-code-deps" aria-label="Dependency changes">
      <h4>Dependencies <span>${counts.join(' · ')}</span></h4>
      <ul>${chips.map(([kind, row]) => {
        const range = kind === 'changed'
          ? html`<span class="bundle-compare-code-dep-range">${row.from} → <b>${row.to}</b></span>`
          : html`<span class="bundle-compare-code-dep-range">${row.range}</span>`
        const content = html`<span class="bundle-compare-code-dep-name">${row.name}</span>${row.kind ? html`<span class="npm-dependency-kind">${row.kind}</span>` : nothing}${range}`
        const label = `${{ added: 'New', changed: 'Updated', removed: 'Removed' }[kind]}: ${row.name}`
        return html`<li>${open && row.opens
          ? html`<button type="button" class=${`bundle-compare-code-dep is-${kind}`} aria-label=${label} @click=${() => open(row)}>${content}</button>`
          : html`<span class=${`bundle-compare-code-dep is-${kind}`} aria-label=${label}>${content}</span>`}</li>`
      })}</ul>
    </section>`
  }

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
      <code>${source.length <= 240 && typeof markup === 'string' ? unsafeHTML(controlMarkup(markup, true)) : sourceText(`${at > 0 ? '…' : ''}${source.slice(at, at + 240)}${source.length > at + 240 ? '…' : ''}`, true)}</code>
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
  _renderSource(path, text, repointed, { key: modelKeyed, pretty }) {
    const model = this._model(modelKeyed, text, text)
    const lit = { model, b: this._highlighted(this._textSide(path), path, text, pretty?.status === 'ready' ? 'pretty' : '') }
    const marked = new Set([...this._importLines(repointed, model.b).values()].flat())
    const key = `${path}\0source`
    const limit = this._limits.get(key) ?? ROW_LIMIT
    const lines = model.b.length > limit ? model.b.slice(0, limit) : model.b
    return html`<div class="bundle-compare-diff-table single"
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

  // Hiding whitespace changes, as diff -b: off for a file whose changes it may
  // not hide (`whitespace` other than `hideable`, see _fileState), all of
  // which show.
  _whitespaceToggle(whitespace) {
    const kept = WHITESPACE_KEPT[whitespace]
    return html`<button type="button" class="bundle-compare-code-toggle" aria-pressed=${String(prefs.ignoreWhitespace && !kept)} aria-disabled=${kept ? 'true' : nothing}
      aria-label=${kept ?? 'Hide whitespace changes'} data-tooltip=${kept ?? HIDE_WHITESPACE} @click=${() => { if (!kept) this._setWhitespace(!prefs.ignoreWhitespace) }}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9.5v2.5h12V9.5"/></svg>
    </button>`
  }

  // Marking renamed lines rather than hiding them, on for a file that reads
  // names (`reading`, see _fileState) whatever the viewer asks: off there
  // only as it may be turned off for the others.
  _marksToggle(reading) {
    const kept = reading && !prefs.markRenames
    const label = kept ? 'Its renamed lines are marked rather than hidden, as it reads names, which a rename changes'
      : 'Mark renamed lines rather than hide them: the diff of the files as they are, the lines that differ in names renamed alone drawn faint and counted apart, as code that reads its own names can change what it does when they are renamed'
    return html`<button type="button" class="bundle-compare-code-toggle" aria-pressed=${String(prefs.markRenames || reading)} aria-disabled=${kept ? 'true' : nothing}
      aria-label="Mark renamed lines" data-tooltip=${label} @click=${() => { if (!kept) this._setMarks(!prefs.markRenames) }}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3.5 3 3-6 6H3.5v-3zM2 14.5h12"/></svg>
    </button>`
  }

  _setWhitespace(value) {
    prefs.ignoreWhitespace = value
    this.requestUpdate()
  }

  _setRenames(value) {
    prefs.ignoreRenames = value
    if (value) retryRenameDiffs()
    this.requestUpdate()
  }

  _setMarks(value) {
    prefs.markRenames = value
    this.requestUpdate()
  }

  _renderDiff(path, { kind, basePath = path }, { after, before, key, model, pretty, changes, hiding, reading }) {
    const expansion = this._expansions.get(key) ?? new Map()
    const split = prefs.layout === 'split'
    const rows = diffRows(model, expansion, { split })
    const limit = this._limits.get(key) ?? ROW_LIMIT
    const shown = rows.length > limit ? rows.slice(0, limit) : rows
    const lit = {
      model,
      a: kind === 'added' ? null : this._highlighted(this.base, basePath, before,
        hiding ? `renamed\0${this.other.integrity}\0${path}` : pretty?.status === 'ready' ? 'pretty' : ''),
      b: kind === 'removed' ? null : this._highlighted(this.other, path, after, pretty?.status === 'ready' ? 'pretty' : ''),
      expand: (run, change) => {
        const next = new Map(expansion)
        next.set(run, change === 'all' ? { all: true } : { ...next.get(run), [change]: (next.get(run)?.[change] ?? 0) + EXPAND_STEP })
        this._expansions.set(key, next)
        this.requestUpdate()
      },
    }
    const digits = String(Math.max(model.a.length, model.b.length, 1)).length
    return html`${changes?.reason ? html`<p class="bundle-compare-code-note">Renamed names are shown: ${RENAME_REASONS[changes.reason] ?? changes.reason}.</p>` : nothing}
      ${reading && !prefs.markRenames ? html`<p class="bundle-compare-code-note">Renamed lines are marked rather than hidden: the file reads names (${changes.reads.map(read => `.${read}`).join(', ')}), which a rename changes.</p>` : nothing}
      <div class=${classMap({ 'bundle-compare-diff-table': true, split, unified: !split })}
        style=${styleMap({ '--diff-num-width': `${digits + 1}ch` })} role="table" aria-label="Diff">
        ${split ? html`<div class="diff-row diff-split-head" role="row">
          <span class="diff-half">Before<strong data-tooltip-truncated data-tooltip=${this.baseName}>${this.baseName}</strong></span>
          <span class="diff-half">After<strong data-tooltip-truncated data-tooltip=${this.otherName}>${this.otherName}</strong></span>
        </div>` : nothing}
        ${repeat(shown, row => this._rowKey(row), row => split ? this._splitRow(row, lit) : this._unifiedRow(row, lit))}
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

  // A line's code, its changed words marked and control characters boxed
  // (control-chars.js). `lineEnd` says a newline ends the line, so a CR
  // before it is the CRLF's own, shown only where it is what changed.
  _code(text, markup, ranges, lineEnd) {
    const end = lineEnd && !(text.endsWith('\r') && ranges?.at(-1)?.[1] === text.length)
    if (typeof markup === 'string') return unsafeHTML(controlMarkup(markHighlighted(markup, ranges), end))
    if (ranges) {
      const parts = markSegments(text, ranges)
      return parts.map((part, i) => {
        const content = sourceText(part.text, end && i === parts.length - 1)
        return part.marked ? html`<mark class="diff-word">${content}</mark>` : content
      })
    }
    return sourceText(text, end)
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

  _unifiedRow(row, lit) {
    const { model } = lit
    if (row.kind === 'fold') return this._fold(row, lit)
    if (row.kind === 'ctx') {
      return html`<div class="diff-row ctx" role="row"><span class="diff-num">${row.a + 1}</span>${this._cell(lit, 'b', row.b, ' ', null)}</div>`
    }
    const del = row.kind === 'del'
    const words = del ? this._words(model, row.a, row.pair)?.a : this._words(model, row.pair, row.b)?.b
    const renamed = model.marked?.has(row.change)
    return html`<div class=${`diff-row ${row.kind}${renamed ? ' renamed' : ''}`} role="row"
      data-tooltip=${renamed ? 'Renamed names alone' : nothing}>
      ${del
        ? html`<span class="diff-num">${row.a + 1}</span><span class="diff-num"></span><span class="diff-sign">−</span>${this._codeCell(lit, 'a', row.a, words)}`
        : html`<span class="diff-num"></span><span class="diff-num">${row.b + 1}</span><span class="diff-sign">+</span>${this._codeCell(lit, 'b', row.b, words)}`}
    </div>`
  }

  _codeCell(lit, side, line, ranges) {
    const text = lit.model[side][line]
    const noEol = this._noEol(lit.model, side, line)
    return html`<span class=${classMap({ 'diff-code': true, 'diff-long': text.length > LONG_LINE })}>${this._code(text, lit[side]?.[line], ranges, !noEol)}${noEol ? html`<span class="diff-no-eol" data-tooltip="No newline at end of file" aria-label="No newline at end of file">⊘</span>` : nothing}</span>`
  }

  _splitRow(row, lit) {
    const { model } = lit
    if (row.kind === 'fold') return this._fold(row, lit)
    if (row.kind === 'ctx') {
      return html`<div class="diff-row ctx" role="row">
        <span class="diff-half">${this._cell(lit, 'a', row.a, ' ', null)}</span>
        <span class="diff-half">${this._cell(lit, 'b', row.b, ' ', null)}</span>
      </div>`
    }
    const words = row.paired ? this._words(model, row.left, row.right) : null
    const renamed = model.marked?.has(row.change)
    return html`<div class=${`diff-row change${renamed ? ' renamed' : ''}`} role="row"
      data-tooltip=${renamed ? 'Renamed names alone' : nothing}>
      <span class=${classMap({ 'diff-half': true, del: row.left !== null, blank: row.left === null })}>${this._cell(lit, 'a', row.left, '−', words?.a)}</span>
      <span class=${classMap({ 'diff-half': true, add: row.right !== null, blank: row.right === null })}>${this._cell(lit, 'b', row.right, '+', words?.b)}</span>
    </div>`
  }
}

customElements.define('bundle-compare-code', BundleCompareCode)
