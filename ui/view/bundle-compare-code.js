// `<bundle-compare-code>` — Compare's Code view: the files that differ in the
// Code tab's tree, the selected one's changes as a review diff beside it.
// `base` is the "before" bundle, `files` computeBundleDiff's file lists,
// `resolutions` the import resolutions that differ (resolutionRows), whose
// importers are listed too; `path` the selected file, owned by the slide so
// the Overview can open one. A pick dispatches `compare-code-select`. The
// rail's search filters by path or searches the diffs' code
// (bundle-compare-search.js). Light DOM, so the tree takes the Code tab's
// styles and the copy button reaches the document-level [data-copy-path]
// delegate.
import { LitElement, html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { keyed } from 'lit/directives/keyed.js'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { hidesMixedWhitespace, layoutDir, renameParts, rootLabel, wordRanges } from '@preventive/compare/view.js'
import { comparisonEntries, fileContents, resolutionChange } from './bundle-compare-files.js'
import { state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { bundleFileByteLength, bundleFilesAsMap } from '../../common/bundle-sources.js'
import { buildBundleSourceTree, bundleSourceTreePrefix, compactSourceDirectory, compareDirectoryOrder, defaultOpenDirectories, filterBundleSourceTree, navigateBundleSourceTree, orderedComparisonFiles } from './bundle-source-tree.js'
import { fileIconFormat, isNotTextFormat, sourceFileIcon, sourcePackageIcon } from './source-file-icon.js'
import { highlight, langForPath, splitHighlightedLines } from './prism-highlight.js'
import { LONG_LINE, sourceText } from './source-text.js'
import { controlMarkup } from './control-chars.js'
import { EXPAND_STEP, alignedBlock, diffRows, fileLineCounts, hidesWhitespace, lineDiff, markHighlighted, markSegments, markedCounts, textLines, typeFolds, whitespaceHidden, whitespaceInsensitive } from './bundle-compare-code-model.js'
import { changeBlocks } from '../../common/line-diff.js'
import { buildSearchMatcher } from './bundle-search-scan.js'
import { SEARCH_MAX_FILES, searchCompareFiles } from './bundle-compare-search.js'
import { railHitText } from './search-marks.js'
import { PRETTY_ICON, comparedCopy, comparedListingRefusal, comparedPrintable, prettyFolded, prettySettled, prettyTooltip, setPrettySource, togglePrettySource } from './pretty-source.js'
import { jsonPrinted } from '../../common/pretty-json.js'
import { sourcemapPrinted } from '../../common/pretty-sourcemap.js'
import { READABILITY, npmEncodingTag, npmFileFlagTags, npmFileReadabilityOf, npmFileReadabilityRead, npmReadabilityFlags, npmTaggedCategory, npmTextKindTag } from './file-readability.js'
import { npmFileRunsCode, npmRunsCodeTags } from './file-runs-code.js'
import { npmExfiltrationTag, npmFileExfiltration } from './file-hosts.js'
import { packageJsonInstallScripts } from '../../risk/npm/install-scripts.js'
import { NPM_LICENSE_FILE, npmEntryFile, npmLicenseParts } from './npm-entries.js'
import { renameDiff, renameDiffable, retryRenameDiffs } from './rename-diff.js'
import './mode-switch.js'
import { typeProof } from './type-only.js'
import { renameTemplate, rootTemplate, withoutPrefix } from './bundle-compare-rename.js'
import { fileMetaTags, metaSentences } from './bundle-compare-meta.js'
import { bundleFileGithub, githubFileLink } from './bundle-file-github.js'
import './bundle-code-splitter.js'
import { CODE_MODE_ICON, COLLAPSE_DIRS_ICON, COPY_ICON, FILES_MODE_ICON, NEXT_ICON, PREV_ICON } from './lit-icons.js'
import { readKept, trimKept } from './kept-entries.js'
import { prefs } from './bundle-compare-prefs.js'

const KINDS = [
  { kind: 'changed', label: 'Modified', letter: 'M' },
  // Moved or re-extensioned; one whose contents changed too shows under Modified as well.
  { kind: 'renamed', label: 'Renamed', letter: '→' },
  { kind: 'added', label: 'Added', letter: 'A' },
  { kind: 'removed', label: 'Removed', letter: 'D' },
  // Same contents, but some of its imports resolve elsewhere, or on one side alone.
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
// Directories all start open (a review reads every change) unless the tree
// is too long to scan that way (defaultOpenDirectories then).
const OPEN_ALL_MAX = 300
// Time a render spends counting the tree's lines or diffing search hits
// before leaving the rest to the next render.
const COUNT_BUDGET_MS = 30
const SEARCH_MODES = [
  { mode: 'files', label: 'Filter files', placeholder: 'Filter changed files', icon: FILES_MODE_ICON },
  { mode: 'code', label: 'Search code', placeholder: 'Search changed code', icon: CODE_MODE_ICON },
]
// Lines a hit opens its fold by past itself, so it isn't at the fold's edge.
const SEEK_MARGIN = EXPAND_STEP / 2
// Characters of a minified line searched at a time (_soughtLine).
const SEEK_CHUNK = 65_536
// The `seek`s already taken, by any Code drawn.
const seeksTaken = new WeakSet()
// Why a file's hits aren't signed as its diff shows them (_searchResults).
const UNSIGNED = {
  large: 'A large diff, not shown yet: the lines it removed aren\'t searched.',
  printed: 'Shown pretty-printed: its lines as published, unsigned, the lines it removed not searched.',
  numbered: 'Shown pretty-printed: its lines numbered as published.',
}
// A search hit's sign as its row is classed and read.
const SIGNS = { '+': { name: 'add', label: 'Added' }, '−': { name: 'del', label: 'Removed' }, ' ': { name: 'ctx', label: 'Unchanged' } }

// The settings whether a diff of printed copies has rows depends on (_noteRowless).
const rowlessSettings = () => `${prefs.ignoreWhitespace}\0${prefs.ignoreRenames}`
// Hiding whitespace is diff -b, and only in code whose whitespace means nothing
// (whitespaceInsensitive): re-indents and trailing blanks read as unchanged.
const HIDE_RENAMES = 'Hide renamed names', HIDE_TYPES = 'Hide type-only changes', HIDE_WHITESPACE = 'Hide whitespace changes'
// The settings a file's diff is drawn under, which the tree keys its counts
// by (JSON's pretty layout a JSON file's alone); and what those set aside.
const countSettings = path => `${jsonPrinted(path) ? state.bundleSourcePretty : !!state.bundleSourcePretty}\0${prefs.ignoreWhitespace}\0${prefs.ignoreRenames}\0${prefs.ignoreTypes}`
const setAside = ({ pretty, spacesHidden, hiding, typesHidden, typesFolded }) => [pretty?.status === 'ready' && 'Pretty-print', spacesHidden && HIDE_WHITESPACE, hiding && HIDE_RENAMES,
  (typesHidden || typesFolded) && HIDE_TYPES].filter(Boolean)
// A model's lines added and removed, and what the settings set aside of them.
const drawnCounts = (model, drawn) => ({ additions: model.additions, deletions: model.deletions, renamed: model.renamed, aside: setAside(drawn) })
const MIXED_KEPT = 'Whitespace changes are shown: hiding them would hide blanks of more than one kind changing.'
// The format a stasis bundle records for a file (its own spelling of the
// file's language); undefined for another bundle, or a file it records none for.
const stasisFormat = (details, path) => (details?.kind === 'stasis' ? details.bundle?.formats?.get(path) : undefined)
// Renamed names are hidden in JavaScript alone, what a minifier renames: in
// another language a short word (a CSS selector, a tag, prose) is no binding.
const renamable = path => /\.[cm]?js$/iu.test(path)
// Minified text's short names are a minifier's, not its author's.
const minified = (details, path, text) => npmFileReadabilityRead(details, path, text).category === 'minified'
// `make()`'s value, kept in `cache` by `key` while `inputs` are the same
// (compared by identity); with `cap`, the least recently used dropped past it.
function remembered(cache, key, inputs, make, cap = 0) {
  let held = cache.get(key)
  if (cap) cache.delete(key)
  if (!(held && held.inputs.length === inputs.length && held.inputs.every((input, i) => input === inputs[i]))) held = { inputs, value: make() }
  cache.set(key, held)
  if (cap && cache.size > cap) cache.delete(cache.keys().next().value)
  return held.value
}

// The files a bundle or version starts from, by path, each with what names
// it: a Stasis bundle's entries, an npm version's main, module, types and
// bins (npm-entries.js); and its license files, an npm version's with the
// licenses its manifest names them for.
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

// A package.json's install scripts, `node-gyp rebuild` among them where a
// binding.gyp is beside it.
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
// What a file reads names through (renamedDiff's `reads`), which a rename may change.
const readsSaid = reads => `Renamed names are hidden, though the file reads ${reads.map(read => `.${read}`).join(', ')}, which a rename may change.`

// A file's line model by the settings it was diffed with, and whether its
// sides were pretty-printed.
export const modelKey = (path, pretty, settings = prefs) => `${path}\0${settings.ignoreWhitespace}\0${settings.ignoreRenames && renamable(path)}\0${!!settings.markRenames}\0${pretty}`

// By side (its integrity), the sides compared last, KEPT_HIGHLIGHT_SIDES of
// them, each drawn again at once: `${path}` (and the copy it is of) → the
// text colored and its highlighted lines, or null when Prism has no grammar
// for it or it is too large to color. Each side's are many times its files'
// size, so those of comparisons left are let go.
const KEPT_HIGHLIGHT_SIDES = 6
const highlightCache = new Map()
const highlightPending = new Set()
// Each line's drawn code, by its side's lines array and line, so a redraw
// marks no long line again.
const drawnCode = new WeakMap()
// A file's types set aside (typeFolds), by the server's proof of what runs in
// it (typeProof): null where that hides no change.
const foldsKept = new WeakMap()
const foldsOf = (runs, { before, after }) => remembered(foldsKept, runs, [before, after], () => typeFolds(before, after, runs))

// A line's number in its file, where its types are set aside too.
const lineNumber = (model, side, line) => (model.typeFolds?.lineOf[side][line] ?? line) + 1

function countLines(text) {
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

// A file's pretty-print toggle (_fileState): its copies' state, else off, and
// whether it is JSON's; none where printing would change nothing.
export const prettyToggle = file => (file.printing?.applies ? { ...file.pretty ?? { status: 'off' }, json: file.printing.json } : null)

// The files a toggle drawing many applies to: listed, or past AFFECTS_LISTED counted.
const AFFECTS_LISTED = 5
const affectedFiles = paths => (paths ? (paths.length > AFFECTS_LISTED ? `\nAffects files: ${paths.length.toLocaleString()}` : `\nAffects files:\n${paths.join('\n')}`) : '')

const action = (label, run) => html`<button type="button" class="bundle-compare-code-action" @click=${run}>${label}</button>`
// What a file shows in place of a diff, and what it offers: a space between
// the parts after the first, as the built templates had; drawn anew where
// its `kind` changes, so a button pressed doesn't stay focused as another's.
const message = (kind, text, ...more) => keyed(kind, html`<div class="bundle-compare-code-message"><p>${text}</p>${more.map((part, i) => i ? [' ', part] : part)}</div>`)
const size = value => formatBytes(value ?? 0)
// A file's size, or its two sides', by its kind of change.
const sizes = (kind, before, after) => kind === 'added' ? size(after) : kind === 'removed' ? size(before) : `${size(before)} → ${size(after)}`
// The text a file's repointed imports are found in: its new side's, else its old.
export const importerText = ({ after, before }) => [after, before].find(text => typeof text === 'string' && text !== '') ?? null

// Lines added and removed, as a diff's head counts them.
export const diffCounts = (additions, deletions) => html`<span class="bundle-compare-code-counts" aria-label=${`${additions} added, ${deletions} removed lines`}>
  <span class="add">+${additions.toLocaleString()}</span><span class="del">−${deletions.toLocaleString()}</span>
</span>`

// Whether hiding whitespace hides a change in a file drawn with it hidden, kept on the model.
const hidesAnyWhitespace = (model, before, after) => (model.hideable ??= hidesWhitespace(before, after, model.blocks))

// A diff too large to compute before it is asked for.
export const isLargeDiff = (before, after) => before.length + after.length > LARGE_CHARS || countLines(before) + countLines(after) > LARGE_LINES

// A file's import resolutions that differ, as its R and their list name them.
function importsNote(rows) {
  const kinds = Map.groupBy(rows, resolutionChange)
  if (kinds.size === 1 && kinds.has('repointed')) return { title: `Repointed ${rows.length === 1 ? 'import' : 'imports'}`, note: `${rows.length} repointed ${rows.length === 1 ? 'import' : 'imports'}` }
  const counts = ['removed', 'added', 'repointed'].filter(kind => kinds.has(kind)).map(kind => `${kinds.get(kind).length} ${kind}`)
  return { title: 'Import resolutions', note: `Import resolutions: ${counts.join(', ')}` }
}

// Whether a file reads as its source in place of a diff: its only change a
// repointed import, renamed there or not, its record the same.
const readsAsSource = entry => entry.kind === 'repointed' || (entry.kind === 'renamed' && !entry.modified && !!entry.repointed && !entry.meta)

// Whether a Lit value draws anything: not `nothing`, null, false or '', nor
// an array or a template holding only those.
const draws = value => Array.isArray(value) ? value.some(draws)
  : value?.strings ? value.strings.some(text => text.trim() !== '') || value.values.some(draws)
  : value != null && value !== nothing && value !== false && value !== ''

// Every directory above `paths`, kept for `key`: whether a tree directory is new or gone.
const dirSets = new WeakMap()
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
    // The reason scope the files are compared within (bundle-comparison.js).
    scope: { attribute: false },
    resolutions: { attribute: false },
    // A source's file signals (bundle-compare-view.js): alerts on each side's
    // files by path and their tags, the hosts each file names anew and their
    // tag, its dependency changes, what opens one and what tags one.
    baseAlerts: { attribute: false },
    otherAlerts: { attribute: false },
    alertTags: { attribute: false },
    newHosts: { attribute: false },
    newHostTag: { attribute: false },
    dependencies: { attribute: false },
    openDependency: { attribute: false },
    dependencyTags: { attribute: false },
    // Review's decorations of the shared tree and viewer (npm-review-view.js reviewExtensions).
    extensions: { attribute: false },
    baseName: {},
    otherName: {},
    path: {},
    // A line to open at once, `{ path, line, query }` (line from 0), as a search hit is.
    seek: { attribute: false },
    _query: { state: true },
    _kinds: { state: true },
    // 'files' (the query filters the tree) or 'code' (it searches code).
    _mode: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.base = null
    this.other = null
    this.files = null
    this.scope = ''
    this.resolutions = []
    this._query = ''
    this._kinds = new Set(KINDS.map(entry => entry.kind))
    this._mode = 'files'
    // The search's change blocks, by whitespace setting and path, and its last results.
    this._blocks = new Map()
    this._found = null
    // Path → the settings its printed copies' diff last drew no rows under
    // (_noteRowless), and a count of changes to that, keying the results.
    this._rowless = new Map()
    this._rowlessCount = 0
    // The search's blocks → what their split rows are kept on (alignedBlock),
    // so no block is aligned twice.
    this._aligned = new WeakMap()
    // A search hit picked, `{ path, side, line, at, query, key }`, until its
    // file's diff draws (`key` the model last sought in) and settles
    // (`_soughtSettling`); then its row, `{ path, index }`, until scrolled to.
    this._sought = null
    this._soughtRow = null
    // Directory path → open, for the disclosures the user toggled.
    this._open = new Map()
    this._models = new Map()
    this._modelCap = MODEL_CACHE
    // The tree's counts: as published by path (_lineCounts), blocks by model
    // key (_counts), as drawn by path (_shownCounts), and as a file too large
    // to count last drew (_noteDrawn, _largeCounts).
    this._counted = new Map()
    this._countModels = new Map()
    this._drawnCounts = new Map()
    this._drawnTotals = new Map()
    // Kept by the texts they were found for: _whitespaceHidden, _smaller, _large.
    this._spaced = new Map()
    this._shorter = new Map()
    this._larges = new Map()
    // Source maps whose listings' diff didn't read back to the new map, by
    // both sides' paths: drawn as published since (_fileState, _printing).
    this._unrebuilt = new Map()
    // Model key → fold run → lines revealed, and rows shown before "Show
    // more"; large files the user asked to diff anyway.
    this._expansions = new Map()
    this._limits = new Map()
    this._forced = new Set()
    this._shownPath = null
  }

  willUpdate(changed) {
    // What is kept by path is of the texts the path named, which new file
    // lists may pair otherwise (another scope), the bundles the same.
    const pair = `${this.base?.integrity}|${this.other?.integrity}`
    if (pair !== this._pair || changed.has('files')) {
      this._pair = pair
      for (const kept of [this._models, this._spaced, this._shorter, this._unrebuilt, this._larges, this._expansions, this._limits, this._forced]) kept.clear()
    }
    if (['files', 'resolutions', 'base', 'other'].some(name => changed.has(name))) {
      this._entries = comparisonEntries(this.base, this.other, this.files, this.resolutions ?? [])
      for (const kept of [this._counted, this._countModels, this._drawnCounts, this._drawnTotals, this._blocks, this._rowless]) kept.clear()
      this._treeLimit = this.extensions?.treePageSize ?? Infinity
      this._sought = this._soughtRow = null
      this._soughtSettling = false
    }
    // Sought as a rail hit is (_seek), at the query's first match on the line; once.
    if (changed.has('seek') && this.seek && !seeksTaken.has(this.seek)) {
      seeksTaken.add(this.seek)
      const { path, line, query } = this.seek
      const entry = this._entries?.get(path)
      const after = entry ? fileContents(this.base, this.other, path, entry).after : null
      const at = typeof after === 'string' ? textLines(after)[line]?.toLowerCase().indexOf(query.toLowerCase()) ?? -1 : -1
      this._sought = { path, side: 'b', line, at: Math.max(at, 0), query }
      this._soughtRow = null
      this._soughtSettling = false
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
    this._scrollSought()
  }

  // A hit's row, once drawn, scrolled into view and flashed; a hit whose file
  // drew no diff dropped, unless that diff is still settling (_soughtSettling).
  _scrollSought() {
    if (this._sought?.path === this._current && !this._soughtSettling) this._sought = null
    if (!this._soughtRow) return
    const { path, index } = this._soughtRow
    this._soughtRow = null
    const table = [...this.querySelectorAll('.bundle-compare-diff-table')].find(element => element.dataset.path === path)
    const row = table?.children[index]
    if (!row) return
    // A line taller than half the view (a long one, wrapped) shows from its top.
    const view = row.closest('.bundle-compare-diff')
    row.scrollIntoView({ block: view && row.offsetHeight > view.clientHeight / 2 ? 'start' : 'center' })
    row.classList.remove('is-sought')
    void row.offsetWidth
    row.classList.add('is-sought')
    row.addEventListener('animationend', () => row.classList.remove('is-sought'), { once: true })
  }

  // A file shows while any of its kinds of change does.
  _shown(entry) {
    return this._kinds.has(entry.kind) || (!!entry.modified && this._kinds.has('changed'))
      || (!!entry.repointed && this._kinds.has('repointed'))
  }

  // Both bundles' modules by directory, the base's moved with the root where theirs differ.
  _modules() {
    const [base, other] = [this.base, this.other].map(details => (details?.kind === 'stasis' ? details.bundle?.modules : null))
    const layout = { root: this.files?.root, paths: this.files?.basePaths ?? new Map() }
    return base || other ? new Map([...[...base ?? []].map(([dir, info]) => [layoutDir(layout, dir, Object.keys(info.files ?? {})), info]), ...(other ?? [])]) : null
  }

  // The base bundle's directories as the tree lays them out.
  _baseDirs() {
    const paths = this.files?.root ? this.files.basePaths : null
    return paths ? dirsOf(paths, paths.values()) : bundleDirs(this.base)
  }

  // The format a file's icon reads: one either side marks as not text, each
  // side under its own path (as npm-overview.js npmCompareFiles), else the shown side's.
  _format(path) {
    const entry = this._entries.get(path)
    const base = fileIconFormat(this.base, entry?.basePath ?? path), other = fileIconFormat(this.other, path)
    return [base, other].find(isNotTextFormat) ?? (entry?.kind === 'removed' ? base : other)
  }

  // The tree over the files the kind filter keeps. The display prefix comes
  // from every differing file, so filtering doesn't move the tree's root.
  _tree() {
    const key = [this._entries, `${[...this._kinds].join()}:${!!this.extensions?.fullPaths}`]
    if (this._treeKey?.[0] === key[0] && this._treeKey[1] === key[1]) return this._treeMemo
    const all = [...this._entries.keys()]
    const modules = this._modules()
    const root = rootLabel(this.files?.root, this.extensions?.fullPaths ? '' : bundleSourceTreePrefix(stripCommonPathPrefix(all).prefix, modules, all))
    const { prefix } = root
    const shown = all.filter(path => this._shown(this._entries.get(path)))
    const tree = buildBundleSourceTree(shown.map(path => withoutPrefix(path, prefix)), shown, modules)
    this._treeKey = key
    this._treeMemo = { prefix, root, tree, shown: shown.length, allOrder: orderedComparisonFiles(tree) }
    return this._treeMemo
  }

  _select(path) {
    if (!path || path === this._current || this.extensions?.canSelect?.() === false) return
    this.dispatchEvent(new CustomEvent('compare-code-select', { detail: { path }, bubbles: true, composed: true }))
  }

  // Open every directory above a file picked elsewhere.
  _reveal(path, prefix) {
    const parts = withoutPrefix(path, prefix).split('/')
    for (let i = 1; i < parts.length; i++) this._open.set(parts.slice(0, i).join('/'), true)
  }

  // Files mode's query, without the spaces a copy can bring; Code mode searches it as typed.
  _pathQuery() {
    return this._query.trim()
  }

  // The rail's tree as its filters leave it, and its files in its order.
  _railState() {
    const { prefix, root, tree, shown, allOrder } = this._tree()
    const filtered = filterBundleSourceTree(tree, this._mode === 'files' ? this._pathQuery() : '', prefix, this.extensions?.fileFilter)
    return { prefix, root, tree, shown, filtered, order: filtered === tree ? allOrder : filtered ? orderedComparisonFiles(filtered) : [], allOrder }
  }

  // The rail: the files that differ as a tree, `current` marked, and the splitter beside it.
  _renderRail({ prefix, root, tree, shown, filtered, order }, current) {
    this._countUntil = null
    this._treeRemaining = this.extensions?.treePageSize ? this._treeLimit : Infinity
    this._treeTruncated = false
    const openAll = !!this._pathQuery() || shown <= OPEN_ALL_MAX
    const treeContent = this._mode === 'code' ? nothing : filtered ? this._renderTree(filtered, current, 0, openAll, openAll ? null : defaultOpenDirectories(filtered)) : html`<div class="bundle-code-search-empty">No changed files match.</div>`
    // The kinds of change any file has, each a filter.
    const present = new Set([...this._entries.values()].flatMap(entry => [entry.kind !== 'repointed' && entry.kind, entry.modified && 'changed', entry.repointed && 'repointed']))
    const search = SEARCH_MODES.find(({ mode }) => mode === this._mode)
    const named = this._mode === 'files' ? this.extensions : null
    return html`<aside class="bundle-code-rail">
        <div class="bundle-code-rail-head">
          <span class="bundle-code-rail-label">${this.extensions?.railLabel ?? 'Changes'}</span>
          <span class="bundle-code-rail-count">${this._entries.size.toLocaleString()}</span>
          <span class="bundle-code-rail-actions">
            <button type="button" class="bundle-code-rail-action" aria-label=${this.extensions?.collapseLabel ?? 'Collapse directories'} data-tooltip="Collapse directories"
              ?disabled=${this._mode !== 'files' || !!this._pathQuery() && !this.extensions?.collapseClearsSearch || tree.dirs.size === 0} @click=${() => this._collapseAll(tree)}>
              ${COLLAPSE_DIRS_ICON}
            </button>
          </span>
        </div>
        ${root.from ? html`<div class="bundle-code-rail-prefix mono" data-tooltip=${`Root moved: ${root.from} → ${root.to}`}>${rootTemplate(root)}</div>`
          : prefix ? html`<div class="bundle-code-rail-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</div>` : nothing}
        <div class="bundle-compare-code-filter">
          <label class="bundle-compare-code-search">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>
            <input type="search" placeholder=${named?.searchPlaceholder ?? search.placeholder} aria-label=${named?.searchLabel ?? search.placeholder} spellcheck="false" autocomplete="off"
              .value=${live(this._query)} @input=${e => { this._query = e.target.value; this._treeLimit = this.extensions?.treePageSize ?? Infinity }}>
            <span class="bundle-code-search-modes" role="tablist">
              ${SEARCH_MODES.map(({ mode, label, icon }) => html`<button type="button" class=${classMap({ 'bundle-code-search-mode': true, active: mode === this._mode })}
                role="tab" aria-selected=${String(mode === this._mode)} aria-label=${label} data-tooltip=${label} @click=${() => { this._mode = mode }}>${icon}</button>`)}
            </span>
          </label>
          ${this.extensions?.filters ?? html`<div class="bundle-compare-code-kinds" role="group" aria-label="Show changes">
            ${KINDS.filter(({ kind }) => present.has(kind)).map(({ kind, label }) => html`<button type="button" class=${`bundle-compare-code-kind ${kind}`}
              aria-pressed=${String(this._kinds.has(kind))} data-tooltip=${`${this._kinds.has(kind) ? 'Hide' : 'Show'} ${label.toLowerCase()} files`}
              @click=${() => this._toggleKind(kind)}>${label.toLowerCase()}</button>`)}
          </div>`}
        </div>
        <div class="bundle-code-rail-body bundle-compare-code-tree">${this._mode === 'code' ? this._renderSearch(order, current, prefix) : treeContent}
          ${this._mode === 'files' && this._treeTruncated ? action('Show more files', () => { this._treeLimit += this.extensions.treePageSize; this.requestUpdate() }) : nothing}
        </div>
      </aside>
      <bundle-code-splitter role="separator" tabindex="0" aria-orientation="vertical"
        aria-label="Resize file tree" data-tooltip="Drag to resize · double-click to reset"></bundle-code-splitter>`
  }

  // Painted again as what it asked for comes (printed copies, the server's
  // diffs), only while shown: a view gone would ask again. Counted in
  // `_arrived`, so the tree counts its files again (_shownCounts).
  _arrived = 0
  // Whether the file drawn asks for its renamed-names diff alone, ahead of
  // its comparison's (rename-diff.js).
  _renamesAlone = true
  _repaint = () => {
    this._arrived++
    if (this.isConnected) this.requestUpdate()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    clearTimeout(this._countLater)
    clearTimeout(this._searchLater)
    this._countLater = this._searchLater = null
  }

  render() {
    const rail = this._railState()
    const current = this._entries.has(this.path) ? this.path : rail.order[0] ?? null
    if (current && current !== this._current) this._reveal(current, rail.prefix)
    this._current = current
    this._order = this.extensions?.filterContent === false ? rail.allOrder : rail.order
    // The file before the rail, so its search knows how its diff drew (_noteRowless).
    const main = current ? html`${this._renderFile(current, this.extensions?.fullPaths ? '' : rail.prefix)}${this.extensions?.fileActions?.(current, false) ?? nothing}` : html`<div class="bundle-code-placeholder">No files differ in this comparison.</div>`
    return this._layout(rail, current, main)
  }

  _layout(rail, current, main) {
    return html`<div class="bundle-code-view bundle-compare-code">
      ${this._renderRail(rail, current)}
      <div class="bundle-code-main">${main}</div>
    </div>`
  }

  _toggleKind(kind) {
    const kinds = new Set(this._kinds)
    if (!kinds.delete(kind)) kinds.add(kind)
    this._kinds = kinds
  }

  _collapseAll(tree) {
    if (this.extensions?.collapseClearsSearch) this._query = ''
    this._treeLimit = this.extensions?.treePageSize ?? Infinity
    const walk = node => {
      for (const child of node.dirs.values()) { this._open.set(child.path, false); walk(child) }
    }
    walk(tree)
    this.requestUpdate()
  }

  // ── Code search ──────────────────────────────────────────────────

  // Code mode's results: each file's matching lines, numbered and signed as
  // its diff shows them; a pick opens the file there (_seek).
  _renderSearch(order, current, prefix) {
    if (!this._query) return html`<div class="bundle-code-search-hint">Type to search the code of the changed files.</div>`
    const { files, hits, truncated, unsigned } = this._searchResults(order)
    if (files.length === 0) return html`<div class="bundle-code-search-empty">No matches.</div>`
    return html`<div class="bundle-code-search-results bundle-compare-search">
      <div class="bundle-code-search-summary">${hits.toLocaleString()} ${hits === 1 ? 'hit' : 'hits'} in ${files.length.toLocaleString()} ${files.length === 1 ? 'file' : 'files'}${truncated ? `, the first ${SEARCH_MAX_FILES}` : ''}</div>
      ${repeat(files, file => file.path, ({ path, hits: lines }) => html`<div class=${classMap({ 'bundle-code-search-file': true, current: path === current })}>
        <button type="button" class=${`bundle-code-search-file-name bundle-compare-code-name ${this._entries.get(path).kind}`}
          data-tooltip-truncated data-tooltip=${path} @click=${() => this._select(path)}>${withoutPrefix(path, prefix)}</button>
        ${unsigned.has(path) ? html`<p class="bundle-compare-search-note">${UNSIGNED[unsigned.get(path)]}</p>` : nothing}
        <ul class="bundle-code-search-hits">
          ${lines.map(hit => html`<li class="bundle-code-search-hit">
            <button type="button" class="bundle-code-search-hit-link" aria-label=${`${SIGNS[hit.sign]?.label ?? 'Line'} ${hit.line + 1}${hit.side === 'a' ? ' of the old text' : ''}: ${hit.text.trim().slice(0, 80)}`}
              @click=${() => this._seek(path, hit)}>
              <span class="bundle-code-search-hit-ln">${hit.line + 1}</span>
              <span class=${`bundle-compare-search-sign ${SIGNS[hit.sign]?.name ?? ''}`} aria-hidden="true">${hit.sign ?? ''}</span>
              <span class="bundle-code-search-hit-text mono">${railHitText(hit.text, hit.ranges)}</span>
            </button>
          </li>`)}
        </ul>
      </div>`)}
    </div>`
  }

  // The search's results over the rail's files (`order`) whose text this view
  // shows, kept while what they depend on is. A changed file is diffed as
  // this view diffs it; one shown pretty-printed, or too large to diff
  // unasked, lists its new text's lines unsigned, so the rail claims no sign
  // its diff doesn't show (none where that diff has no rows, _noteRowless),
  // the reason by path in `unsigned` (UNSIGNED). Diffs are found within a
  // render's budget, the rest unsigned till a later render.
  _searchResults(order) {
    const drawn = rowlessSettings()
    const key = `${this._query}\0${this._forced.size}\0${drawn}\0${prefs.layout}\0${state.bundleSourcePretty}\0${prettySettled()}\0${this._rowlessCount}\0${order.join('\0')}`
    if (this._found?.key === key && this._found.entries === this._entries) return this._found.result
    // Counted from the first diff, not the scan, so each render finds one.
    let until = null
    let complete = true
    const unsigned = new Map()
    const blocksOf = (path, before, after) => {
      if (unsigned.get(path) === 'printed') return null
      const kept = `${prefs.ignoreWhitespace}\0${path}`
      if (this._blocks.has(kept)) return this._blocks.get(kept)
      if (!this._forced.has(path) && isLargeDiff(before, after)) {
        unsigned.set(path, 'large')
        return null
      }
      const now = performance.now()
      until ??= now + COUNT_BUDGET_MS
      if (now > until) {
        complete = false
        return null
      }
      // As _fileState diffs it: whitespace changes hidden where the setting and
      // the file's language hide them, but for blanks of more than one kind.
      const hide = prefs.ignoreWhitespace && !this._unlisted(path, this._entries.get(path), { before, after })
      let blocks = changeBlocks(before, after, hide)
      if (hide && hidesMixedWhitespace(before, after, blocks)) blocks = changeBlocks(before, after)
      this._blocks.set(kept, blocks)
      return blocks
    }
    const files = order.flatMap(path => {
      const entry = this._entries.get(path)
      if (!this._searchable(entry)) return []
      const contents = fileContents(this.base, this.other, path, entry)
      const { before, after } = contents
      if (this._prettyShown(path, entry, contents)) {
        // Blanks alone are what the printer respaces: a match of them
        // as published has no place in the copy to be found at.
        if (!/\S/u.test(this._query)) return []
        const changed = before !== '' && after !== '' && before !== after
        // Its diff here drawn without rows, as these settings draw it: no change to seek.
        if (changed && this._rowless.get(path) === drawn) return []
        unsigned.set(path, changed ? 'printed' : 'numbered')
      }
      return [{ path, ...contents }]
    })
    const align = (a, b, blocks, block) => {
      let held = this._aligned.get(blocks)
      if (!held) this._aligned.set(blocks, held = { a, b, blocks })
      return alignedBlock(held, blocks.indexOf(block))
    }
    const result = { ...searchCompareFiles(files, buildSearchMatcher(this._query, false, false), blocksOf, { split: prefs.layout === 'split', align }), unsigned }
    if (complete) this._found = { key, entries: this._entries, result }
    else this._later('_searchLater')
    return result
  }

  // A render asked for soon, once, to go on with what a budget left.
  _later(timer) {
    this[timer] ??= setTimeout(() => { this[timer] = null; this.requestUpdate() })
  }

  // Whether this render's counting budget, from its first count, is spent: the rest left to a later render.
  _spent() {
    const now = performance.now()
    this._countUntil ??= now + COUNT_BUDGET_MS
    if (now <= this._countUntil) return false
    this._later('_countLater')
    return true
  }

  // Whether a file's text shows here, to be searched: its diff, or its source.
  _searchable(entry) {
    return entry.modified !== false || readsAsSource(entry)
  }

  // Whether a file's diff here is of its pretty-printed copies: not where a
  // copy failed, the file then drawn as published.
  _prettyShown(path, entry, contents) {
    if (!state.bundleSourcePretty) return false
    const printing = this._printing(path, entry, contents)
    return !!printing?.applies && printing.copies.status !== 'error'
  }

  // A printed copies' diff drawn, noted with its settings where it has no
  // rows, for the search to leave the file out while they hold.
  _noteRowless(path, rowless) {
    const drawn = rowless ? rowlessSettings() : undefined
    if (this._rowless.get(path) === drawn) return
    if (drawn === undefined) this._rowless.delete(path)
    else this._rowless.set(path, drawn)
    this._rowlessCount++
  }

  // A search hit picked: its file opened at its line (_seekRows), its diff
  // asked for where too large to show unasked (_fileState).
  _seek(path, hit) {
    this._sought = { path, side: hit.side, line: hit.line, at: hit.ranges[0]?.[0] ?? 0, query: this._query }
    if (path === this._current) this.requestUpdate()
    else this._select(path, false)
  }

  // The line a hit names in the text a file's diff shows, `{ side, line }`:
  // in a pretty-printed copy, the line holding the same match, counted with
  // whitespace taken out of query and texts, as the printer respaces (else
  // the line its first character falls on); null past the copy's end.
  _soughtLine(path, entry, pretty, model) {
    const { side, line, at, query } = this._sought
    if (pretty?.status !== 'ready') return { side, line }
    const solid = text => text.replaceAll(/\s+/gu, '')
    const raw = textLines(fileContents(this.base, this.other, path, entry)[side === 'a' ? 'before' : 'after'] ?? '')
    const offset = raw.slice(0, line).reduce((sum, text) => sum + solid(text).length, 0) + solid(raw[line]?.slice(0, at) ?? '').length
    const needle = solid(query).toLowerCase()
    // The first match, whitespace out and case folded, that `found(index,
    // start)` takes: read a piece at a time (a line, or SEEK_CHUNK of a
    // minified one), keeping only what a match may still start in, so
    // nothing is read or folded past it.
    const first = (lines, found) => {
      if (!needle) return null
      let from = 0, index = 0, past = 0, text = ''
      for (const read of lines) {
        for (let piece = 0; piece < read.length; piece += SEEK_CHUNK) {
          text += solid(read.slice(piece, piece + SEEK_CHUNK)).toLowerCase()
          for (let i = text.indexOf(needle, from); i !== -1; i = text.indexOf(needle, from), index++) {
            if (found(index, past + i)) return { index, start: past + i }
            from = i + needle.length
          }
          const kept = Math.max(from, text.length - needle.length + 1)
          text = text.slice(kept)
          past += kept
          from = Math.max(0, from - kept)
        }
      }
      return null
    }
    const hit = first(raw, (_, start) => start >= offset)
    let target = (hit && first(model[side], index => index === hit.index)?.start) ?? offset
    for (let i = 0; i < model[side].length; i++) {
      target -= solid(model[side][i]).length
      if (target < 0) return { side, line: i }
    }
    return null
  }

  // A sought line's row among a diff's rows, a fold it is in opened past it
  // and the rows shown taken to it: `{ rows, index }`, -1 where it isn't
  // among them. With its types set aside, a line of types alone is sought
  // at the row standing for them.
  _seekRows(key, model, { side, line: sought }, split) {
    const folds = model.typeFolds
    const line = folds ? folds.lineOf[side].indexOf(sought) : sought
    const shows = row => row.kind === 'types' ? line === -1 && !!row[side] && sought >= row[side].from && sought < row[side].to
      : side === 'b' ? ((row.kind === 'ctx' || row.kind === 'add') && row.b === line) || (row.kind === 'change' && row.right === line)
      : ((row.kind === 'ctx' || row.kind === 'del') && row.a === line) || (row.kind === 'change' && row.left === line)
    let expansion = this._expansions.get(key) ?? new Map()
    let rows = diffRows(model, expansion, { split })
    let index = rows.findIndex(shows)
    if (index === -1) {
      const fold = rows.find(row => row.kind === 'fold' && line >= row[side] && line < row[side] + row.count)
      if (fold) {
        // Opened from its top where it has one to open (a run after a change),
        // else from its bottom (the run before the first), else whole.
        const open = expansion.get(fold.run) ?? {}
        const depth = line - fold[side]
        expansion = new Map(expansion).set(fold.run, fold.down ? { ...open, top: (open.top ?? 0) + depth + 1 + SEEK_MARGIN }
          : fold.up ? { ...open, bottom: (open.bottom ?? 0) + fold.count - depth + SEEK_MARGIN } : { all: true })
        this._expansions.set(key, expansion)
        rows = diffRows(model, expansion, { split })
        index = rows.findIndex(shows)
      }
    }
    this._reach(key, index)
    return { rows, index }
  }

  // The rows `key`'s diff shows taken past `index`; whether that took more.
  _reach(key, index) {
    if (index < (this._limits.get(key) ?? ROW_LIMIT)) return false
    this._limits.set(key, Math.ceil((index + 1) / ROW_LIMIT) * ROW_LIMIT)
    return true
  }

  _takeTreeRow(required = false) {
    if (this._treeRemaining-- > 0) return true
    this._treeTruncated = true
    return required
  }

  _renderTree(node, current, depth, openAll, opened) {
    const dirs = [...node.dirs.entries()].toSorted(compareDirectoryOrder)
    const files = [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))
    const directories = dirs.flatMap(([name, child]) => {
      const compact = compactSourceDirectory(name, child, depth)
      const pkg = child.package
      const vendored = pkg?.ecosystem === 'cargo' || pkg?.ecosystem === 'composer' || pkg?.ecosystem === 'soldeer'
      const open = this._pathQuery() ? true : this._open.get(child.path) ?? (openAll || Boolean(opened?.has(child.path)) || containsFile(child, current))
      // The row's top directory is new or gone as a whole, package or not.
      const dirKind = this._baseDirs().has(child.sourcePath)
        ? bundleDirs(this.other).has(child.sourcePath) ? null : 'removed'
        : 'added'
      if (!this._takeTreeRow(containsFile(child, current))) return []
      const content = html`<li class="bundle-code-tree-dir">
        <details .open=${live(open)} @toggle=${event => {
          const expanded = event.currentTarget.open
          if (this._open.get(child.path) === expanded) return
          this._open.set(child.path, expanded)
          if (this.extensions?.treePageSize) this.requestUpdate()
        }}>
          <summary aria-label=${this.extensions?.directoryLabel?.(compact.node) ?? nothing}>
            <span class="bundle-code-tree-chevron" aria-hidden="true"></span>
            ${pkg || child.dependencyRoot ? sourcePackageIcon(pkg?.ecosystem ?? child.dependencyRoot) : nothing}
            <span class=${classMap({ 'bundle-code-tree-dirname': true, 'bundle-code-tree-package': !!pkg, 'bundle-code-tree-package-vendored': vendored, 'bundle-compare-code-name': true, removed: dirKind === 'removed' })}
              data-tooltip-truncated data-tooltip=${compact.node.sourcePath}>
              ${pkg ? html`<span class="bundle-code-tree-package-name">${pkg.name}</span>${pkg.version ? html`<span class="bundle-code-tree-package-version">${vendored ? '- ' : '@'}${pkg.version}</span>` : nothing}` : compact.names.map((part, index) => html`${index > 0 ? html`<span class="bundle-code-tree-separator">/</span>` : nothing}${part}`)}
            </span>
            ${pkg?.variant ? html`<span class="bundle-code-tree-variant">variant ${pkg.variant}</span>` : nothing}
            <span class="bundle-compare-code-dir-count" data-tooltip=${`${child.fileCount} changed ${child.fileCount === 1 ? 'file' : 'files'}`}>${this.extensions?.directorySummary?.(compact.node) ?? child.fileCount}</span>
            ${dirKind ? html`<span class=${`bundle-compare-code-letter ${dirKind}`} data-tooltip=${`${pkg ? 'Package' : 'Directory'} ${dirKind}`}>${KIND[dirKind].letter}</span>` : nothing}
          </summary>
          ${open || !this.extensions?.treePageSize ? this._renderTree(compact.node, current, depth + 1, openAll, opened) : nothing}
        </details>
      </li>`
      return [{ key: child.path, content }]
    })
    const leaves = files.flatMap(([name, full]) => {
      if (!this._takeTreeRow(full === current)) return []
      const entry = this._entries.get(full), { kind, repointed, renamedFrom, modified } = entry
      const imports = repointed ? importsNote(repointed).note : ''
      const content = html`<li class="bundle-code-tree-file">
        <button type="button" class=${classMap({ 'bundle-code-tree-link': true, current: full === current })}
          aria-label=${this.extensions?.fileLabel?.(full) ?? nothing} aria-current=${full === current ? 'true' : nothing} @click=${() => this._select(full)}>
          ${this.extensions?.filePrefix?.(full) ?? nothing}${sourceFileIcon(full, this._format(full))}<span class=${`bundle-code-tree-name bundle-compare-code-name ${kind}`} data-tooltip-truncated data-tooltip=${full}>${name}</span>
          ${this.extensions?.fileSuffix?.(full) ?? nothing}
          ${renamedFrom ? html`<span class="bundle-compare-code-oldname" data-tooltip-truncated data-tooltip=${`Renamed from ${renamedFrom}`}>← ${renameParts(renamedFrom, full, { extension: false }).from}</span>` : nothing}
          ${this._fileTags(full, entry, true)}
          ${this._treeCounts(full, entry)}
          ${repointed && kind !== 'repointed' ? html`<span class="bundle-compare-code-letter repointed" data-tooltip=${imports}>R</span>` : nothing}
          <span class=${classMap({ 'bundle-compare-code-letter': true, [kind]: true, pure: kind === 'renamed' && !modified })}
            data-tooltip=${kind === 'repointed' ? imports : renamedFrom ? `Renamed${modified ? ' and modified' : ''} from ${renamedFrom}` : KIND[kind].label}>${KIND[kind].letter}</span>
        </button>
      </li>`
      return [{ key: full, content }]
    })
    return html`<ul class=${classMap({ 'bundle-code-tree': true, root: depth === 0 })}
      aria-label=${depth === 0 ? this.extensions?.treeLabel ?? 'Changed files' : nothing}
      @keydown=${depth === 0 ? navigateBundleSourceTree : nothing}>
      ${repeat(directories, row => row.key, row => row.content)}${repeat(leaves, row => row.key, row => row.content)}
    </ul>`
  }

  // A file's lines added and removed as its diff draws them, else as
  // published: `=` for one unchanged in its lines, `≈` for one whose changes
  // the settings set aside; the published counts told where they differ.
  _treeCounts(path, entry) {
    if (entry.kind === 'repointed') return nothing
    let published = this._lineCounts(path, entry), shown
    if (published === null && this._counted.has(path)) ({ published, shown } = this._largeCounts(path, entry))
    else shown = published && this._shownCounts(path, entry)
    if (!(published || shown) || shown === undefined) return nothing
    const { additions, deletions } = shown ?? published
    // Its counts as published unknown, its sides differ: two the same are counted at once (fileLineCounts).
    const changed = !published || published.additions > 0 || published.deletions > 0, renamed = entry.kind === 'renamed'
    const marked = shown?.renamed > 0 ? `\n≈${shown.renamed.toLocaleString()} lines differing in renamed names alone, marked` : ''
    const asPublished = published ? `\nAs published: +${published.additions.toLocaleString()} −${published.deletions.toLocaleString()}` : ''
    const aside = shown ? `${shown.aside.join(', ')}${marked}${asPublished}` : null
    if (additions === 0 && deletions === 0) {
      if ((renamed || entry.modified === false) && !changed) return html`<span class="bundle-compare-code-line-counts unchanged" aria-label="No line changes">=</span>`
      if (shown && changed) {
        return html`<span class="bundle-compare-code-line-counts unchanged" aria-label=${`No line changes with ${shown.aside.join(', ')}`}
          data-tooltip=${`No line changes with ${aside}`}>≈</span>`
      }
    }
    const differs = shown && (!published || additions !== published.additions || deletions !== published.deletions)
    return html`<span class="bundle-compare-code-line-counts" aria-label=${`${additions} added, ${deletions} removed lines`} data-tooltip=${differs ? `With ${aside}` : nothing}>
      <span class=${classMap({ add: true, empty: renamed && additions === 0 })}>+${additions.toLocaleString()}</span>
      <span class=${classMap({ del: true, empty: entry.kind === 'added' || (renamed && deletions === 0) })}>−${deletions.toLocaleString()}</span>
    </span>`
  }

  // A file's state as the tree counts it (_shownCounts): its blocks alone.
  _countingState(path, entry) {
    return this._fileState(path, entry, true)
  }

  // A file's lines added and removed as its diff draws them where a setting
  // sets some of it aside (`aside`), lines differing in renamed names alone
  // counted apart (`renamed`); null where none does, or till its copies come,
  // or where too large to diff unasked. Undefined where the render's budget
  // is spent (_spent).
  _shownCounts(path, entry) {
    if (!(state.bundleSourcePretty || prefs.ignoreWhitespace || prefs.ignoreRenames || prefs.ignoreTypes)) return null
    const settings = `${countSettings(path)}\0${this._arrived}\0${this._forced.size}`
    const kept = this._drawnCounts.get(path)
    if (kept?.settings === settings) return kept.counts
    if (this._spent()) return undefined
    const counted = this._countingState(path, entry)
    const counts = counted.model && setAside(counted).length > 0 ? drawnCounts(counted.model, counted) : null
    this._drawnCounts.set(path, { settings, counts })
    return counts
  }

  // A file's lines added and removed as published (fileLineCounts), counted
  // within each render's budget, so a long tree paints at once and fills in.
  _lineCounts(path, entry) {
    if (this._counted.has(path)) return this._counted.get(path)
    if (this._spent()) return null
    const { before, after } = fileContents(this.base, this.other, path, entry)
    const counts = fileLineCounts(before, after)
    this._counted.set(path, counts)
    return counts
  }

  // A file's lines as its diff drew them, with the settings, for a file too
  // large for the tree to count (_largeCounts).
  _noteDrawn(path, drawn) {
    if (drawn.model) this._drawnTotals.set(path, { settings: countSettings(path), counts: drawnCounts(drawn.model, drawn) })
    return drawn
  }

  // A file too large for the tree to count, counted as its diff last drew it
  // under these settings; none changed where its type-only changes are
  // hidden, drawn or not; else none.
  _largeCounts(path, entry) {
    const drawn = this._drawnTotals.get(path)
    if (drawn?.settings === countSettings(path)) return drawn.counts.aside.length === 0 ? { published: drawn.counts, shown: null } : { published: null, shown: drawn.counts }
    const contents = prefs.ignoreTypes ? fileContents(this.base, this.other, path, entry) : null
    const types = typeof contents?.before === 'string' && typeof contents.after === 'string' && typeProof(this.base, this.other, path, entry, contents, this._repaint, this.scope) === true
    return { published: null, shown: types ? { additions: 0, deletions: 0, renamed: 0, aside: [HIDE_TYPES] } : null }
  }

  // ── The selected file ────────────────────────────────────────────

  // A file's line model, `options` as lineDiff takes them (the server's
  // blocks or marks, rename-diff.js), kept by `key` with the texts and those
  // blocks or marks, so never drawn for other lines than its own.
  _model(key, before, after, options = {}, ignoreWhitespace = prefs.ignoreWhitespace) {
    return remembered(this._models, key, [before, after, options.changes?.blocks ?? options.marks ?? null],
      () => lineDiff(before, after, { ...options, ignoreWhitespace }), this._modelCap)
  }

  // A file's change blocks as _model would find them, for the tree's counts:
  // kept apart, so counting the tree evicts none of the models drawn.
  _counts(key, before, after, options, ignoreWhitespace) {
    return remembered(this._countModels, key, [before, after, options.changes?.blocks ?? options.marks ?? null], () => {
      const blocks = options.changes?.blocks ?? changeBlocks(before, after, ignoreWhitespace)
      return { blocks, ...markedCounts(blocks, options.marks) }
    })
  }

  // A file's two sides, pretty-printed where the toggle has them so, and its
  // line model where it has one to draw: none for a file not text, nor one too
  // large to diff unasked. `counting` (the tree's counts) finds its blocks
  // alone (_counts) and leaves alone what a drawn file sets: a hit sought, the
  // search's blocks, the whitespace toggle. One the server proved changed in
  // types alone (typeProof) draws nothing while those are hidden
  // (`typesHidden`); one changed in types but for what runs draws those lines
  // alone (`typesFolded`).
  _fileState(path, entry, counting = false) {
    const contents = fileContents(this.base, this.other, path, entry)
    const textual = typeof contents.before === 'string' && typeof contents.after === 'string'
    const proof = textual ? typeProof(this.base, this.other, path, entry, contents, this._repaint, this.scope) : undefined
    const types = proof === true
    if (types && prefs.ignoreTypes) {
      const model = { a: [], b: [], blocks: [], additions: 0, deletions: 0, renamed: 0, marked: new Set(), noEol: { a: false, b: false }, words: new Map() }
      if (counting) return { pretty: null, hiding: false, model, spacesHidden: false, typesHidden: true }
      return this._noteDrawn(path, { ...contents, textual, large: false, printing: null, pretty: null, key: null, generated: false, renamed: false, warned: [], hiding: false, changes: null,
        model, whitespace: null, spacesHidden: false, types, typesHidden: true })
    }
    const folds = proof && proof !== true ? foldsOf(proof, contents) : null
    const folded = !!folds && prefs.ignoreTypes
    // Its printed copies drawn where the toggle is on and printing changes its diff.
    const printing = textual && !folded && (!counting || state.bundleSourcePretty) ? this._printing(path, entry, contents) : null
    const pretty = state.bundleSourcePretty && printing?.applies ? printing.copies : null
    const { before, after } = folded ? folds : pretty?.status === 'ready' ? pretty : contents
    // Renamed names are found by the server in its printed copies, once those
    // came (rename-diff.js): the lines differing in them alone marked, or hidden.
    const generated = textual && renamable(path) && renamable(entry.basePath ?? path) && ['ready', 'loading', 'error'].includes(pretty?.status)
      && this._generated(path, entry, contents)
    const renames = generated && pretty.status === 'ready'
    // A hit sought here asks for a diff too large to show unasked, as "Show diff" does.
    if (!counting && textual && this._sought?.path === path && !this._forced.has(path) && this._large(path, before, after)) this._forced.add(path)
    const large = textual && !this._forced.has(path) && this._large(path, before, after)
    const { basePath = path } = entry
    const diffed = ignoreWhitespace => {
      const ask = () => renameDiff(this.base, basePath, contents.before, this.other, path, contents.after, ignoreWhitespace, this._repaint, pretty.hashes,
        !counting && this._renamesAlone, this.scope)
      const changes = renames && !large ? ask() : null
      const ready = changes?.status === 'ready'
      const hiding = ready && prefs.ignoreRenames
      const marked = ready && !hiding
      // Where either side reads names (`f.name`), a rename may change what the
      // code does, which hiding them would hide: said (`warned`).
      const warned = hiding && changes.reason === null ? changes.reads : []
      // Hide renamed names is offered where it hides any, and while it is on
      // in any file it is for, to be turned off.
      const renamed = ready && changes.reason === null ? changes.marks.length > 0 || (prefs.ignoreRenames && changes.before !== before) : prefs.ignoreRenames && generated
      const key = `${modelKey(path, pretty?.status === 'ready', { ...prefs, ignoreWhitespace, ignoreRenames: hiding, markRenames: marked })}${folded ? '\0types' : ''}`
      // The old side as the server diffed it, given the new side's names, where they are hidden.
      const shown = hiding ? changes.before : before
      const options = hiding ? { changes: { blocks: changes.blocks } } : marked ? { marks: changes.marks } : {}
      const model = textual && !large && (!changes || ready || !prefs.ignoreRenames)
        ? (counting ? this._counts(key, shown, after, options, ignoreWhitespace) : this._model(key, shown, after, options, ignoreWhitespace)) : null
      if (folded && model) model.typeFolds = folds
      return { key, changes, warned, renamed, hiding, shown, model, ignoreWhitespace }
    }
    // Whitespace changes hidden as diff -b, only where it means nothing on both
    // sides, and not where blanks of more than one kind change (hidesMixedWhitespace).
    const unlisted = this._unlisted(path, entry, contents)
    let found = diffed(prefs.ignoreWhitespace && !unlisted)
    const mixed = prefs.ignoreWhitespace && !unlisted && !!found.model && (found.model.mixed ??= hidesMixedWhitespace(found.shown, after, found.model.blocks))
    if (mixed) found = diffed(false)
    const { key, changes, warned, renamed, hiding, shown, model } = found
    // A source map's listings are drawn only where their diff reads back to
    // the new map (comparedListingRefusal, kept on the model): else as published.
    if (printing?.map && pretty?.status === 'ready' && model) {
      if (!Object.hasOwn(model, 'listingRefusal')) {
        model.listingRefusal = comparedListingRefusal(this.base, this.other, basePath, path, contents, { a: model.a ?? textLines(shown), b: model.b ?? textLines(after), blocks: model.blocks })
      }
      if (model.listingRefusal !== null) {
        this._unrebuilt.set(`${basePath}\0${path}`, { status: 'error', message: `Its listings' diff wouldn't show every change: ${model.listingRefusal}`, retry: false })
        return this._fileState(path, entry, counting)
      }
    }
    if (counting) return { pretty, hiding, model, spacesHidden: found.ignoreWhitespace, typesFolded: folded }
    if (pretty?.status === 'ready' && model) this._noteRowless(path, model.blocks.length === 0)
    // The texts as published diffed as the search diffs them: their blocks kept for it.
    else if (model && !folded) {
      this._blocks.set(`${prefs.ignoreWhitespace}\0${path}`, model.blocks)
      this._aligned.set(model.blocks, model)
    }
    // Whether hiding whitespace hides a change here (`hideable`), or would but
    // may not as blanks of more than one kind change (`mixed`); else not offered.
    const off = model && !unlisted && !prefs.ignoreWhitespace ? this._whitespaceHidden(`${path}\0${pretty?.status === 'ready'}\0${hiding}`, shown, after) : null
    const whitespace = model === null || unlisted ? null
      : mixed ? 'mixed'
      : prefs.ignoreWhitespace ? (hidesAnyWhitespace(model, shown, after) ? 'hideable' : null)
      : off.hides && !off.mixed ? 'hideable' : null
    // A hit sought here waits while its printed copies, or the renamed names
    // to hide, are coming or failed (_scrollSought).
    if (this._sought?.path === path) this._soughtSettling = pretty?.status === 'loading' || (prefs.ignoreRenames && (changes?.status === 'loading' || changes?.status === 'error'))
    return this._noteDrawn(path, { ...folded ? contents : { before: shown, after }, textual, large, printing, pretty, key, generated, renamed, warned, hiding, changes, model,
      whitespace, spacesHidden: found.ignoreWhitespace, types: types || !!folds, typesFolded: folded })
  }

  // Whether a file's whitespace may mean something on either side, its changes shown whatever the setting.
  _unlisted(path, { basePath = path }, { before, after }) {
    return !whitespaceInsensitive(path, after, stasisFormat(this.other, path))
      || !whitespaceInsensitive(basePath, before, stasisFormat(this.base, basePath))
  }

  // What diff -b would hide between the texts a file shows, kept as models are.
  _whitespaceHidden(key, before, after) {
    return remembered(this._spaced, key, [before, after], () => whitespaceHidden(before, after), this._modelCap)
  }

  // Whether both sides are minified and the server can diff them: renamed
  // names are hidden there alone, as an author's renamed is a change.
  _generated(path, { kind, basePath = path }, { before, after }) {
    return kind !== 'repointed' && renameDiffable(this.base, this.other) && minified(this.base, basePath, before) && minified(this.other, path, after)
  }

  // A file's two sides pretty-printed (pretty-source.js comparedCopy), and
  // whether the toggle applies (`applies`): to JSON and source maps (whose
  // copies are their listings) always; else where either side is minified,
  // or where the copies' diff is smaller than the files' (`smaller`, as
  // formatting changed). `copies`: the first failure, else one coming, else
  // one not made while off, else both texts and hashes. Null for a file
  // whose sides can't both be printed.
  _printing(path, entry, contents) {
    const { kind, basePath = path, modified } = entry, { before, after } = contents
    if (kind === 'repointed' || modified === false || typeof before !== 'string' || typeof after !== 'string' || before === after) return null
    const sides = [['base', this.base, basePath, before], ['other', this.other, path, after]]
    if (!sides.every(([side, , file, text]) => text === '' || comparedPrintable(this.base, this.other, side, file, text))) return null
    const json = sides.every(([, , file, text]) => text === '' || jsonPrinted(file))
    const map = sides.every(([, , file, text]) => text === '' || sourcemapPrinted(file))
    const unreadable = !json && !map && sides.some(([, details, file, text]) => text !== '' && minified(details, file, text))
    const both = sides.map(([side, , file, text]) => (text === '' ? { status: 'ready', text } : comparedCopy(this.base, this.other, side, file, text, this._repaint)))
    const copies = this._unrebuilt.get(`${basePath}\0${path}`)
      ?? both.find(copy => copy.status === 'error') ?? both.find(copy => copy.status === 'loading') ?? both.find(copy => copy.status === 'off')
      ?? { status: 'ready', before: both[0].text, after: both[1].text, hashes: both.map(copy => copy.hash) }
    const smaller = !json && !map && !unreadable && before !== '' && after !== '' && copies.status === 'ready' && this._smaller(path, contents, copies)
    return { copies, json, map, minified: unreadable, smaller, applies: json || map || unreadable || smaller }
  }

  // Whether the texts a file shows are too large to diff unasked, kept: every
  // render asks it of every file, and counting a large file's lines takes a while.
  _large(path, before, after) {
    return remembered(this._larges, path, [before, after], () => isLargeDiff(before, after))
  }

  // Whether a file's printed copies' diff has fewer changed lines than its
  // texts', false where either is too large to diff unasked.
  _smaller(path, { before, after }, printed) {
    const changed = (a, b) => changeBlocks(a, b).reduce((sum, { a0, a1, b0, b1 }) => sum + a1 - a0 + b1 - b0, 0)
    return remembered(this._shorter, path, [before, after, printed.before, printed.after],
      () => !isLargeDiff(before, after) && !isLargeDiff(printed.before, printed.after) && changed(printed.before, printed.after) < changed(before, after))
  }

  // What a file shows in place of a diff: why there is none, or how to have
  // one; null where there is a diff to show.
  _fileMessage(path, { kind, modified, meta }, { before, after, textual, large, model, pretty, hiding, warned = [], changes, whitespace, typesHidden = false, typesFolded = false }) {
    const recorded = metaSentences(meta)
    const withRecorded = text => `${text}${recorded ? ` ${recorded}` : ''}`
    const same = withRecorded(kind === 'renamed' ? (recorded ? 'Renamed, its contents the same.' : 'Renamed without changes.') : 'The contents are the same.')
    // Its bytes the same (bundle-compare-diff.js): no diff to compute, however large.
    if (textual && modified === false) return message('same', same)
    if (!textual) {
      if (kind === 'changed' && modified === false) {
        return html`<div class="bundle-compare-code-message">Binary file, its bytes the same · ${size(bundleFileByteLength(after))}. ${recorded}</div>`
      }
      return html`<div class="bundle-compare-code-message">Binary file ${kind} · ${sizes(kind, bundleFileByteLength(before), bundleFileByteLength(after))}. A text diff is not available.${
        recorded ? ` ${recorded}` : ''}</div>`
    }
    if (large) {
      return message('large', html`This diff is large (${(countLines(before) + countLines(after)).toLocaleString()} lines across both sides) and may take a few seconds to compute.`,
        action('Show diff', () => { this._forced.add(path); this.requestUpdate() }))
    }
    const showRenames = action('Show renamed names', () => this._setRenames(false)), showTypes = action('Show type-only changes', () => this._setTypes(false))
    // Proven by the server to change types alone, what runs left as it was (type-only.js).
    if (typesHidden) return message('types', html`Only types changed in this file.${recorded ? ` ${recorded}` : ''}`, showTypes)
    if (changes?.status === 'loading' && prefs.ignoreRenames) return html`<div class="bundle-compare-code-message" aria-busy="true">Hiding renamed names…</div>`
    if (changes?.status === 'error' && prefs.ignoreRenames) return message('renames', html`Couldn't hide renamed names: ${changes.message}`, showRenames)
    if (model.blocks.length > 0) return null
    // Its printed copies the same, its texts not: its layout changed alone, the
    // copies each checked by the server to read as its text does.
    const reformatted = pretty?.status === 'ready' && pretty.before === pretty.after
    const spaced = !reformatted && prefs.ignoreWhitespace && whitespace === 'hideable'
    const renamed = !reformatted && hiding
    const hidden = [typesFolded && 'types', spaced && 'whitespace', renamed && 'renamed names'].filter(Boolean)
    const told = reformatted ? 'No actual code changes in this file.' : hidden.length > 0 ? `Only ${hidden.join(' and ')} changed in this file.` : null
    return message('told', told ? withRecorded(told) : same,
      warned.length > 0 ? html`<p>${readsSaid(warned)}</p>` : nothing,
      reformatted ? action('Show as published', () => { setPrettySource(false); this._viewChanged() }) : nothing,
      typesFolded ? showTypes : nothing,
      spaced ? action('Show whitespace changes', () => this._setWhitespace(false)) : nothing,
      renamed ? showRenames : nothing)
  }

  // A file's kind, icon and path, `prefix` left off, then as in Code `copy`
  // and its GitHub link, and how it reads.
  _fileName(path, entry, prefix, copy = nothing) {
    const strip = file => withoutPrefix(file, prefix)
    return html`<span class=${classMap({ 'bundle-compare-code-pill': true, [entry.kind]: true, pure: entry.kind === 'renamed' && !entry.modified })}>${KIND[entry.kind].label}</span>
      ${sourceFileIcon(path, this._format(path))}
      <span class="bundle-code-main-path mono" data-tooltip-truncated data-tooltip=${entry.renamedFrom ? `${entry.renamedFrom} → ${path}` : path}>${entry.renamedFrom ? renameTemplate(strip(entry.renamedFrom), strip(path)) : strip(path)}</span>
      ${copy}${this._githubLink(path, entry)}${this._fileTags(path, entry)}`
  }

  // The side a file is read from: the open one, or for one removed the one
  // compared with, `at` its path there.
  _side(path, { kind, basePath = path }) {
    return kind === 'removed' ? { details: this.base, at: basePath, alerts: this.baseAlerts } : { details: this.other, at: path, alerts: this.otherAlerts }
  }

  // All comparison file chips, shared by Compare and Review in headers and
  // trees; the tree's shorter, tagging a file Large only where it has no other tag.
  _fileTags(path, entry, compact = false) {
    if (!compact) return html`${this._entryTags(path, entry)}${this._alertTags(path, entry)}${this._runsTags(path, entry)}${this._newHostTags(path, entry)}${this._flagTags(path, entry)}${this._readability(path, entry)}${this._installTags(path, entry)}${fileMetaTags(entry.meta)}`
    const tags = [this._alertTags(path, entry), this._runsTags(path, entry), this._newHostTags(path, entry), this._flagTags(path, entry, false), this._treeTag(path, entry), this._installTags(path, entry, true), fileMetaTags(entry.meta, true)]
    return draws(tags) ? tags : this._flagTags(path, entry)
  }

  // The file on GitHub, at its side's revision, where that side records it (bundle-file-github.js).
  _githubLink(path, entry) {
    const { details, at } = this._side(path, entry), github = bundleFileGithub(details, at)
    return github ? githubFileLink(github) : nothing
  }

  _alertTags(path, entry) {
    const { alerts, at } = this._side(path, entry), found = alerts?.get(at)
    return found?.length > 0 && this.alertTags ? this.alertTags(found) : nothing
  }

  // The hosts a file names that the one compared with named in none of its files; none for one removed.
  _newHostTags(path, { kind }) {
    const hosts = kind === 'removed' ? null : this.newHosts?.get(path)
    return hosts && this.newHostTag ? this.newHostTag(hosts) : nothing
  }

  // What a file's code can run beyond itself (file-runs-code.js) and an
  // exfiltration host it names (file-hosts.js), as it is now (was, for one
  // removed), what the one compared with didn't hold said so.
  _runsTags(path, entry) {
    return [[npmFileRunsCode, npmRunsCodeTags], [npmFileExfiltration, npmExfiltrationTag]].map(([read, tags]) => {
      const { was, now } = this._reads(path, entry, read)
      return entry.kind === 'removed' ? tags(was) : tags(now, was)
    })
  }

  // A file its side starts from, labelled with what names it (entryPoints).
  _entryTags(path, entry) {
    const { details, at } = this._side(path, entry)
    const labels = Map.groupBy(entryPoints(details).get(at) ?? [], ({ label }) => label)
    return [...labels].map(([label, rows]) => html`<span class=${`bundle-compare-code-entry${label === 'license' ? ' is-license' : ''}`}
      data-tooltip=${rows.map(({ note }) => note).join(' · ')}>${label}</span>`)
  }

  // A package.json's install scripts, each with its command: those it names
  // now (named, for one removed), new or changed ones said so, and in its
  // head, dropped ones struck through.
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

  // How a file reads (file-readability.js), or what `of` reads of it, as it
  // `was` and is `now`: null for a side without it, undefined where unknown.
  _reads(path, entry, of = npmFileReadabilityOf) {
    const { kind, basePath = path } = entry
    const { before, after } = fileContents(this.base, this.other, path, entry)
    return {
      was: kind === 'added' ? null : before === undefined ? undefined : of(this.base, basePath, before),
      now: kind === 'removed' || after === undefined ? null : of(this.other, path, after),
    }
  }

  // How a file reads, as the npm Overview tags it (ASCII, Minified, ...): as
  // it reads now, after how it read where that differs, its other labels
  // (npmReadabilityFlags) beside.
  _readability(path, entry) {
    const { was, now } = this._reads(path, entry)
    const reads = read => html`${npmEncodingTag(read)}${npmTextKindTag(read)}`
    const tag = !was || !now || (npmTaggedCategory(was) === npmTaggedCategory(now) && was.kind === now.kind) ? reads(now ?? was)
      : html`<span class="bundle-compare-code-readability">${reads(was)}<span aria-hidden="true">→</span>${reads(now)}</span>`
    return html`${npmReadabilityFlags(now ?? was)}${tag}`
  }

  // What a file is beyond how it reads, as the npm Files list tags it; `large` false leaves Large out.
  _flagTags(path, entry, large = true) {
    const { details, at } = this._side(path, entry)
    return npmFileFlagTags(details, at, entry.kind === 'removed' ? entry.baseBytes : entry.otherBytes, large)
  }

  // The tree's briefer readability tags: those it warns of, and its tag where
  // it marks one (not a source map's, which its name says).
  _treeTag(path, entry) {
    const { was, now } = this._reads(path, entry)
    const shown = now ?? was
    if (!shown) return nothing
    const tagged = shown.category !== 'map' && READABILITY.get(npmTaggedCategory(shown)).mark
    return html`${npmReadabilityFlags(shown, ['warn'])}${tagged ? npmEncodingTag(shown, true) : nothing}`
  }

  // A file's lines added and removed, and its sizes.
  _fileFigures({ kind, baseBytes, otherBytes }, model) {
    return html`${model?.blocks.length > (model?.marked?.size ?? 0) ? diffCounts(model.additions, model.deletions) : nothing}
      ${model?.renamed > 0 ? html`<span class="bundle-compare-code-renamed" aria-label=${`${model.renamed} lines differing in renamed names alone`}
        data-tooltip="Lines differing in renamed names alone, marked">≈${model.renamed}</span>` : nothing}
      <span class="bundle-code-main-stats">${sizes(kind, baseBytes, otherBytes)}</span>`
  }

  // Highlighted lines of one side, or null until Prism colors it, which
  // repaints. `copy` names a text other than the file's own (`pretty`, or the
  // old side given another file's names); kept only for the text it colored.
  _highlighted(details, path, text, copy = '') {
    if (!text) return null
    const lang = langForPath(path, stasisFormat(details, path), text)
    if (!lang) return null
    const file = `${path}${copy ? `\0${copy}` : ''}`, key = `${details.integrity}\0${file}`
    const kept = readKept(highlightCache, details.integrity)?.get(file)
    if (kept?.text === text) return kept.lines
    if (!highlightPending.has(key)) {
      highlightPending.add(key)
      void (async () => {
        const markup = await highlight(text, lang)
        const lines = typeof markup === 'string' ? splitHighlightedLines(markup) : null
        const side = readKept(highlightCache, details.integrity) ?? highlightCache.set(details.integrity, new Map()).get(details.integrity)
        side.set(file, { text, lines: lines?.length === text.split('\n').length ? lines : null })
        trimKept(highlightCache, KEPT_HIGHLIGHT_SIDES)
        highlightPending.delete(key)
        if (this.isConnected) this.requestUpdate()
      })()
    }
    return null
  }

  _renderFile(path, prefix) {
    const entry = this._entries.get(path)
    const file = this._fileState(path, entry)
    const { after, before, textual, model } = file
    // A file whose only change is a repointed import reads as its source,
    // whatever the whitespace setting: its two sides are one text.
    const asSource = readsAsSource(entry)
    const diffable = textual && (!asSource || model?.blocks.length > 0)
    const index = this._order.indexOf(path)
    const body = entry.kind === 'repointed' && before === undefined
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
        ${this._fileName(path, entry, prefix, html`<button type="button" class="bundle-code-copy-path" data-copy-path=${path} aria-label="Copy file path">
          ${COPY_ICON}
        </button>`)}
        <span class="bundle-code-main-spacer"></span>
        ${this._fileFigures(entry, model)}
        ${this._toggles(diffable, prettyToggle(file), file.renamed, file.whitespace === 'hideable', file.types)}
      </header>
      <div class="bundle-compare-diff" tabindex="0" aria-label=${`Changes in ${withoutPrefix(path, prefix)}`}>
        ${this._dependencyChanges(path)}
        ${entry.repointed ? this._renderRepointed(path, entry.repointed, importerText(file), textual && !diffable) : nothing}
        ${body}
      </div>`
  }

  // The diff's controls, as the file shown, or any listed, has use for them:
  // what it hides (_hides), pretty-printing, and the layout.
  _toggles(diffable, pretty = null, renamed = false, whitespace = false, types = false) {
    return html`${diffable ? this._hides(renamed, whitespace, types) : nothing}
        ${pretty ? html`<button type="button" class=${classMap({ 'bundle-compare-code-toggle': true, 'is-loading': pretty.status === 'loading', 'is-error': pretty.status === 'error',
          'is-folded': prettyFolded(pretty.json) })}
          aria-pressed=${String(!!state.bundleSourcePretty)} aria-busy=${pretty.status === 'loading' ? 'true' : nothing} aria-label="Pretty-print"
          data-tooltip=${`${prettyTooltip(pretty, pretty.json)}${affectedFiles(pretty.affects)}`}
          @click=${() => { togglePrettySource(pretty.json); this._viewChanged() }}>${PRETTY_ICON}</button>` : nothing}
        ${diffable ? html`<span class="bundles-overview-sort bundle-compare-code-layout" role="group" aria-label="Diff layout">
          ${[['unified', 'Unified'], ['split', 'Split']].map(([value, label]) => html`<button type="button" aria-pressed=${String(prefs.layout === value)} @click=${() => { prefs.layout = value; this.requestUpdate() }}>${label}</button>`)}
        </span>` : nothing}`
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

  // The bundle an unchanged importer's text comes from (highlights cached by it).
  _textSide(path) {
    return bundleFilesAsMap(this.other).has(path) ? this.other : this.base
  }

  // Over the package's package.json, a source's dependency changes: a chip
  // each, with its range, added, changed or removed (struck through), opening
  // as the Overview's Dependencies rows do, tagged as the source tags it; the
  // head counting them and their flags.
  _dependencyChanges(path) {
    if (path !== 'package.json' || !this.dependencies) return nothing
    const kinds = { added: ['new', 'New'], changed: ['updated', 'Updated'], removed: ['removed', 'Removed'] }
    const chips = Object.keys(kinds).flatMap(kind => this.dependencies[kind].map(row => [kind, row]))
    if (chips.length === 0) return nothing
    const counts = Object.entries(kinds).filter(([kind]) => this.dependencies[kind].length > 0).map(([kind, [noun]]) => `${this.dependencies[kind].length} ${noun}`)
    const flagged = Map.groupBy(chips.flatMap(([, row]) => row.flags ?? []), ({ label }) => label)
    const open = this.openDependency
    return html`<section class="bundle-compare-code-deps" aria-label="Dependency changes">
      <h4>Dependencies <span>${counts.join(' · ')}</span>${[...flagged].map(([label, flags]) => html`<span class="bundle-compare-code-deps-flagged">${flags.length} ${label}</span>`)}</h4>
      <ul>${chips.map(([kind, row]) => {
        const range = html`<span class="bundle-compare-code-dep-range">${kind === 'changed' ? html`${row.from} → <b>${row.to}</b>` : row.range}</span>`
        const content = html`<span class="bundle-compare-code-dep-name">${row.name}</span>${row.kind ? html`<span class="npm-dependency-kind">${row.kind}</span>` : nothing}${range}${this.dependencyTags?.(row, kind) ?? nothing}`
        const label = `${kinds[kind][1]}: ${row.name}`
        return html`<li>${open && row.opens
          ? html`<button type="button" class=${`bundle-compare-code-dep is-${kind}`} aria-label=${label} @click=${() => open(row)}>${content}</button>`
          : html`<span class=${`bundle-compare-code-dep is-${kind}`} aria-label=${label}>${content}</span>`}</li>`
      })}</ul>
    </section>`
  }

  // The file's import resolutions that differ: each specifier and its
  // conditions, its target before and after, and the lines importing it,
  // links to them when the source shows below.
  _renderRepointed(path, rows, text, linked) {
    const lines = text ? text.split('\n') : []
    const markup = text ? this._highlighted(this._textSide(path), path, text) : null
    const importLines = this._importLines(rows, lines)
    // A side without one, (none): the import resolved on the other alone.
    const target = value => value === null ? html`<code class="is-none">(none)</code>` : html`<code data-tooltip-truncated data-tooltip=${value || '(empty target)'}>${value || '(empty target)'}</code>`
    const { title } = importsNote(rows)
    return html`<section class="bundle-compare-code-repointed" aria-label=${title}>
      <h4>${title} <b>${rows.length}</b></h4>
      <ul>${rows.map(row => {
        const at = importLines.get(row.specifier)
        const context = `${row.conditions}${row.platform === null ? '' : ` · Platform: ${row.platform}`}`
        return html`<li>
          <div class="bundle-compare-code-repointed-spec">
            <code data-tooltip-truncated data-tooltip=${row.specifier}>${row.specifier}</code>
            <span data-tooltip-truncated data-tooltip=${context}>${context}</span>
          </div>
          <div class="bundle-compare-code-repointed-targets">
            <span class="before"><span>Before</span>${target(row.baseTarget)}</span>
            <span aria-hidden="true">→</span>
            <span class="after"><span>After</span>${target(row.otherTarget)}</span>
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
      <code>${source.length <= 240 && typeof markup === 'string' ? appMarkup(controlMarkup(markup, true)) : sourceText(`${at > 0 ? '…' : ''}${source.slice(at, at + 240)}${source.length > at + 240 ? '…' : ''}`, true)}</code>
    </button>`
  }

  _goToLine(line) {
    // A line past the rows shown brings them in first.
    if (this._reach(`${this._current}\0source`, line - 1)) this.requestUpdate()
    void this.updateComplete.then(() => this.querySelector(`.bundle-compare-diff [data-line="${line}"]`)?.scrollIntoView({ block: 'center' }))
  }

  // An unchanged file, as the Code tab would show it: one column of
  // numbered lines, the ones importing a repointed specifier marked.
  _renderSource(path, text, repointed, { key: modelKeyed, pretty }) {
    const model = this._model(modelKeyed, text, text)
    const lit = { model, b: this._highlighted(this._textSide(path), path, text, pretty?.status === 'ready' ? 'pretty' : '') }
    const marked = new Set([...this._importLines(repointed, model.b).values()].flat())
    const key = `${path}\0source`
    // A search hit picked in this file: its line to scroll to, once for each model it is drawn from.
    const sought = this._sought?.path === path && this._sought.key !== modelKeyed ? this._soughtLine(path, this._entries.get(path), pretty, model) : null
    if (this._sought?.path === path) this._sought.key = modelKeyed
    if (sought && sought.line < model.b.length) {
      this._reach(key, sought.line)
      this._soughtRow = { path, index: sought.line }
    }
    const limit = this._limits.get(key) ?? ROW_LIMIT
    const lines = model.b.length > limit ? model.b.slice(0, limit) : model.b
    return html`<div class="bundle-compare-diff-table single" data-path=${path}
        style=${styleMap({ '--diff-num-width': `${String(model.b.length).length + 1}ch` })} role="table" aria-label="Source">
        ${repeat(lines, (_, i) => i, (_, i) => html`<div class=${classMap({ 'diff-row': true, ctx: true, 'is-import': marked.has(i) })} role="row" data-line=${i + 1}>
          <span class="diff-num">${i + 1}</span>${this._codeCell(lit, 'b', i, null)}
        </div>`)}
      </div>
      ${this._moreRows(key, limit, lines.length, model.b.length, 'lines')}`
  }

  // "Show more" under a diff whose `total` rows are more than those `shown`.
  _moreRows(key, limit, shown, total, noun) {
    return total > shown ? html`<div class="bundle-compare-code-more">
        ${action(`Show ${Math.min(ROW_LIMIT, total - shown).toLocaleString()} more ${noun}`, () => { this._limits.set(key, limit + ROW_LIMIT); this.requestUpdate() })}
        <span>${(total - shown).toLocaleString()} not shown</span>
      </div>` : nothing
  }

  // What the diff hides, a named switch each where it has use: renamed names
  // where hiding them hides any (the old side given the new side's names
  // where a minifier renamed alike throughout, rather than marking the lines
  // differing in them alone), whitespace where diff -b hides a change, and
  // type-only changes where the server proved any.
  _hides(renamed, whitespace, types) {
    const switches = [
      renamed && ['Renames', HIDE_RENAMES, prefs.ignoreRenames, () => this._setRenames(!prefs.ignoreRenames)],
      whitespace && ['Whitespace', HIDE_WHITESPACE, prefs.ignoreWhitespace, () => this._setWhitespace(!prefs.ignoreWhitespace)],
      types && ['Type-only', HIDE_TYPES, prefs.ignoreTypes, () => this._setTypes(!prefs.ignoreTypes)],
    ].filter(Boolean)
    if (switches.length === 0) return nothing
    return html`<span class="bundle-compare-code-hide" role="group" aria-label="Hide"><span class="bundle-compare-code-hide-label" aria-hidden="true">Hide:</span>${switches.map(([label, name, on, toggle]) => html`<mode-switch compact borderless .checked=${on} accessible-label=${name} label=${label} @click=${toggle}></mode-switch>`)}</span>`
  }

  _setWhitespace(value) {
    prefs.ignoreWhitespace = value
    this._viewChanged()
  }

  _setTypes(value) {
    prefs.ignoreTypes = value
    this._viewChanged()
  }

  _setRenames(value) {
    prefs.ignoreRenames = value
    if (value) retryRenameDiffs()
    this._viewChanged()
  }

  // A view setting changed here (prefs, pretty-printing): drawn anew, and
  // told with `compare-view-change`, for a page whose URL names it (Review's).
  _viewChanged() {
    this.requestUpdate()
    this.dispatchEvent(new CustomEvent('compare-view-change', { bubbles: true, composed: true }))
  }

  _renderDiff(path, entry, { after, before, key, model, pretty, changes, hiding, warned = [], whitespace = null }) {
    const { kind, basePath = path } = entry
    const split = prefs.layout === 'split'
    // A search hit picked in this file: its row, opened and shown, to scroll
    // to, once for each model it is drawn from.
    const sought = this._sought?.path === path && this._sought.key !== key ? this._soughtLine(path, entry, pretty, model) : null
    if (this._sought?.path === path) this._sought.key = key
    const folds = model.typeFolds
    const seek = sought ? this._seekRows(key, model, sought, split) : null
    if (seek?.index >= 0) this._soughtRow = { path, index: seek.index + (split ? 1 : 0) }
    const expansion = this._expansions.get(key) ?? new Map()
    const rows = seek?.rows ?? diffRows(model, expansion, { split })
    const limit = this._limits.get(key) ?? ROW_LIMIT
    const shown = rows.length > limit ? rows.slice(0, limit) : rows
    // Its lines colored, those of one whose types are set aside taken for the lines it shows.
    const shownLines = (lines, side) => (lines && folds ? folds.lineOf[side].map(line => lines[line]) : lines)
    const lit = {
      model,
      a: kind === 'added' ? null : shownLines(this._highlighted(this.base, basePath, before,
        hiding ? `renamed\0${this.other.integrity}\0${path}` : pretty?.status === 'ready' ? 'pretty' : ''), 'a'),
      b: kind === 'removed' ? null : shownLines(this._highlighted(this.other, path, after, pretty?.status === 'ready' ? 'pretty' : ''), 'b'),
      expand: (run, change) => {
        const next = new Map(expansion)
        next.set(run, change === 'all' ? { all: true } : { ...next.get(run), [change]: (next.get(run)?.[change] ?? 0) + EXPAND_STEP })
        this._expansions.set(key, next)
        this.requestUpdate()
      },
    }
    const lines = folds?.lines ?? { a: model.a.length, b: model.b.length }
    const digits = String(Math.max(lines.a, lines.b, 1)).length
    return html`${prefs.ignoreRenames && changes?.reason ? html`<p class="bundle-compare-code-note">Renamed names are shown: ${RENAME_REASONS[changes.reason] ?? changes.reason}.</p>` : nothing}
      ${whitespace === 'mixed' ? html`<p class="bundle-compare-code-note">${MIXED_KEPT}</p>` : nothing}
      ${warned.length > 0 ? html`<p class="bundle-compare-code-note">${readsSaid(warned)} <button type="button" @click=${() => this._setRenames(false)}>Show them marked</button></p>` : nothing}
      <div class=${classMap({ 'bundle-compare-diff-table': true, split, unified: !split })} data-path=${path}
        style=${styleMap({ '--diff-num-width': `${digits + 1}ch` })} role="table" aria-label="Diff">
        ${split ? html`<div class="diff-row diff-split-head" role="row">
          <span class="diff-half">Before<strong data-tooltip-truncated data-tooltip=${this.baseName}>${this.baseName}</strong></span>
          <span class="diff-half">After<strong data-tooltip-truncated data-tooltip=${this.otherName}>${this.otherName}</strong></span>
        </div>` : nothing}
        ${repeat(shown, row => this._rowKey(row), row => this._row(row, lit, split))}
      </div>
      ${this._moreRows(key, limit, shown.length, rows.length, 'rows')}`
  }

  _rowKey(row) {
    if (row.kind === 'fold') return `f${row.run}:${row.a}`
    if (row.kind === 'types') return `t${row.a?.from ?? ''}:${row.b?.from ?? ''}`
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
    if (typeof markup === 'string') return appMarkup(controlMarkup(markHighlighted(markup, ranges), end))
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
    return html`<span class="diff-num">${lineNumber(lit.model, side, line)}</span><span class="diff-sign">${sign}</span>${this._codeCell(lit, side, line, ranges)}`
  }

  // Lines of types alone set aside between those that run, by their lines on
  // the new side, else on the old.
  _types({ a, b }) {
    const { from, to } = b ?? a
    return html`<div class="diff-row diff-types" role="row">
      <span>Only types here · ${to - from === 1 ? `line ${from + 1}` : `lines ${from + 1}–${to}`}${b ? '' : ' before'}</span>
      ${action('Show type-only changes', () => this._setTypes(false))}
    </div>`
  }


  _fold(row, lit) {
    const more = `Show ${EXPAND_STEP} more lines`, some = row.count > EXPAND_STEP
    // A button showing more lines one way; Show all's is the row's own.
    const button = (change, label, tooltip, path) => html`<button type="button" aria-label=${label} data-tooltip=${tooltip} @click=${() => lit.expand(row.run, change)}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${path}></path></svg>
        </button>`
    return html`<div class="diff-row diff-fold" role="row">
      <span class="diff-fold-actions">
        ${some && row.down ? button('top', `${more} below`, more, 'M8 3v9m-4-4 4 4 4-4') : nothing} ${some && row.up ? button('bottom', `${more} above`, more, 'M8 13V4M4 8l4-4 4 4') : nothing} <button type="button" aria-label=${`Show all ${row.count} unchanged lines`} data-tooltip="Show all"
          @click=${() => lit.expand(row.run, 'all')}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4-4 4 4M4 10l4 4 4-4"></path></svg>
        </button>
      </span>
      <span class="diff-fold-label">${row.count.toLocaleString()} unchanged ${row.count === 1 ? 'line' : 'lines'} · ${row.b + 1}–${row.b + row.count}</span>
    </div>`
  }

  // A diff row, its two sides apart where `split`.
  _row(row, lit, split) {
    const { model } = lit
    if (row.kind === 'fold') return this._fold(row, lit)
    if (row.kind === 'types') return this._types(row)
    if (row.kind === 'ctx') {
      return split ? html`<div class="diff-row ctx" role="row">
        <span class="diff-half">${this._cell(lit, 'a', row.a, ' ', null)}</span>
        <span class="diff-half">${this._cell(lit, 'b', row.b, ' ', null)}</span>
      </div>` : html`<div class="diff-row ctx" role="row"><span class="diff-num">${lineNumber(model, 'a', row.a)}</span>${this._cell(lit, 'b', row.b, ' ', null)}</div>`
    }
    const renamed = model.marked?.has(row.change)
    let cells
    if (split) {
      const words = row.paired ? this._words(model, row.left, row.right) : null
      cells = html`<span class=${classMap({ 'diff-half': true, del: row.left !== null, blank: row.left === null })}>${this._cell(lit, 'a', row.left, '−', words?.a)}</span>
      <span class=${classMap({ 'diff-half': true, add: row.right !== null, blank: row.right === null })}>${this._cell(lit, 'b', row.right, '+', words?.b)}</span>`
    } else {
      const del = row.kind === 'del', [side, line] = del ? ['a', row.a] : ['b', row.b], number = lineNumber(model, side, line)
      const words = del ? this._words(model, row.a, row.pair)?.a : this._words(model, row.pair, row.b)?.b
      cells = html`<span class="diff-num">${del ? number : nothing}</span><span class="diff-num">${del ? nothing : number}</span><span class="diff-sign">${del ? '−' : '+'}</span>${this._codeCell(lit, side, line, words)}`
    }
    return html`<div class=${`diff-row ${row.kind}${renamed ? ' renamed' : ''}`} role="row"
      data-tooltip=${renamed ? 'Renamed names alone' : nothing}>
      ${cells}
    </div>`
  }

  _codeCell(lit, side, line, ranges) {
    const lines = lit.model[side], markup = lit[side]?.[line], text = lines[line]
    // A last line with no newline after it, marked so.
    const noEol = lit.model.noEol[side] && line === lines.length - 1
    let drawn = drawnCode.get(lines)
    if (!drawn) drawnCode.set(lines, drawn = new Map())
    let code = drawn.get(line)
    if (!code || code.markup !== markup || code.ranges !== ranges || code.noEol !== noEol) {
      drawn.set(line, code = { markup, ranges, noEol, drawn: this._code(text, markup, ranges, !noEol) })
    }
    return html`<span class=${classMap({ 'diff-code': true, 'diff-long': text.length > LONG_LINE })}>${code.drawn}${noEol ? html`<span class="diff-no-eol" data-tooltip="No newline at end of file" aria-label="No newline at end of file">⊘</span>` : nothing}</span>`
  }
}

customElements.define('bundle-compare-code', BundleCompareCode)
