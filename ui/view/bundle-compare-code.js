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
// The rail's search filters the tree by path, or, as the Code tab's does in
// its Code mode, searches the code the diffs show (bundle-compare-search.js),
// a hit opening its file at its line.
// Light DOM, like the slide, so the tree takes the Code tab's styles and
// the copy button reaches the document-level [data-copy-path] delegate.
import { LitElement, html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './style-map.js'
import { appMarkup } from './markup.js'
import { hidesMixedWhitespace, layoutDir, renameParts, rootLabel, wordRanges } from '@preventive/compare/view.js'
import { comparisonEntries, fileContents } from './bundle-compare-files.js'
export { fileEntries, fileContents } from './bundle-compare-files.js'
import { state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { bundleFileByteLength, bundleFilesAsMap } from './bundle-sources.js'
import { buildBundleSourceTree, bundleSourceTreePrefix, compactSourceDirectory, filterBundleSourceTree, navigateBundleSourceTree, orderedComparisonFiles, compareDirectoryOrder } from './bundle-source-tree.js'
import { fileIconFormat, isNotTextFormat, sourceFileIcon, sourcePackageIcon } from './source-file-icon.js'
import { highlight, langForPath, splitHighlightedLines } from './prism-highlight.js'
import { LONG_LINE, sourceText } from './source-text.js'
import { controlMarkup } from './control-chars.js'
import { EXPAND_STEP, alignedBlock, diffRows, fileLineCounts, hidesWhitespace, lineDiff, markHighlighted, markedCounts, markSegments, textLines, whitespaceHidden, whitespaceInsensitive } from './bundle-compare-code-model.js'
import { changeBlocks } from '../../common/line-diff.js'
import { buildSearchMatcher } from './bundle-search-scan.js'
import { SEARCH_MAX_FILES, searchCompareFiles } from './bundle-compare-search.js'
import { railHitText } from './search-marks.js'
import { PRETTY_ICON, comparedCopy, prettyPrintable, prettySettled, prettyTooltip, togglePrettySource } from './pretty-source.js'
import { MAX_PRETTY_BYTES, prettyExtension } from '../../common/pretty-print.js'
import { utf8ByteLength } from '../../common/utf8.js'
import { READABILITY, npmEncodingTag, npmFileFlagTags, npmFileReadabilityOf, npmFileReadabilityRead, npmReadabilityFlags, npmTaggedCategory, npmTextKindTag } from './file-readability.js'
import { npmFileRunsCode, npmRunsCodeTags } from './file-runs-code.js'
import { npmExfiltrationTag, npmFileExfiltration } from './file-hosts.js'
import { packageJsonInstallScripts } from '../../risk/npm/install-scripts.js'
import { NPM_LICENSE_FILE, npmEntryFile, npmLicenseParts } from './npm-entries.js'
import { renameDiff, renameDiffable, retryRenameDiffs } from './rename-diff.js'
import './mode-switch.js'
import { typeOnly } from './type-only.js'
import { renameTemplate, rootTemplate } from './bundle-compare-rename.js'
import { fileMetaTags, metaSentences } from './bundle-compare-meta.js'
import { bundleFileGithub, githubFileLink } from './bundle-file-github.js'
import './bundle-code-splitter.js'
import { CODE_MODE_ICON, COLLAPSE_DIRS_ICON, COPY_ICON, FILES_MODE_ICON, NEXT_ICON, PREV_ICON } from './lit-icons.js'

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
// Time a render of the tree spends counting its files' lines (_lineCounts),
// or a search diffing the files it found (_searchResults), before leaving
// the rest to the next.
const COUNT_BUDGET_MS = 30
// The rail search's modes, as the Code tab's rail names them
// (bundle-code-search.js): filter the tree by path, or search code.
const SEARCH_MODES = [
  { mode: 'files', label: 'Filter files', placeholder: 'Filter changed files', icon: FILES_MODE_ICON },
  { mode: 'code', label: 'Search code', placeholder: 'Search changed code', icon: CODE_MODE_ICON },
]
// Lines a hit opens its fold by past itself, so it isn't at the fold's edge.
const SEEK_MARGIN = EXPAND_STEP / 2
// Characters of a minified line a hit's match is looked for in at a time,
// in a pretty-printed copy's text as published (_soughtLine).
const SEEK_CHUNK = 65_536
// The lines asked for from without (`seek`) already sought, by any Code drawn.
const seeksTaken = new WeakSet()
// Why a file's hits aren't as its diff shows them (_searchResults): a changed
// file's unsigned, the lines it removed not searched, its diff too large to
// show unasked or of its pretty-printed copies, whose lines and changes
// differ from the file's; another's numbered as published, where it shows
// pretty-printed.
const UNSIGNED = {
  large: 'A large diff, not shown yet: the lines it removed aren\'t searched.',
  printed: 'Shown pretty-printed: its lines as published, unsigned, the lines it removed not searched.',
  numbered: 'Shown pretty-printed: its lines numbered as published.',
}
// A search hit's sign as its row is classed and read.
const SIGNS = { '+': { name: 'add', label: 'Added' }, '−': { name: 'del', label: 'Removed' }, ' ': { name: 'ctx', label: 'Unchanged' } }

// View preferences shared by every comparison, and by the Diff view
// (bundle-compare-all.js), reset on page reload like the rail's width.
export const prefs = { layout: 'unified', ignoreWhitespace: false, ignoreRenames: false, ignoreTypes: false }
// The settings whether a diff of printed copies has rows depends on (_noteRowless).
const rowlessSettings = () => `${prefs.ignoreWhitespace}\0${prefs.ignoreRenames}`
// Hiding whitespace changes is diff -b, only in code whose whitespace means
// nothing (JavaScript, CSS, JSON and the like): a line re-indented, or with
// blanks added to a run of them or at its end, reads as unchanged; blanks put
// between other characters or taken from between them still show. The toggle
// says it in a few words, and a note why a file whose changes it would hide
// shows them all as their blanks mix kinds (_fileState).
const HIDE_RENAMES = 'Hide renamed names', HIDE_TYPES = 'Hide type-only changes', HIDE_WHITESPACE = 'Hide whitespace changes'
// The settings a file's diff is drawn under, as the tree keeps its counts by
// them; and what of a file's changes those set aside, as its state drawn or
// counted says (_fileState): printed, its whitespace, renamed names or
// changes in types alone hidden.
const countSettings = () => `${!!state.bundleSourcePretty}\0${prefs.ignoreWhitespace}\0${prefs.ignoreRenames}\0${prefs.ignoreTypes}`
const setAside = ({ pretty, spacesHidden, hiding, typesHidden }) => [pretty?.status === 'ready' && 'Pretty-print', spacesHidden && HIDE_WHITESPACE, hiding && HIDE_RENAMES,
  typesHidden && HIDE_TYPES].filter(Boolean)
const WHITESPACE_KEPT = {
  mixed: 'Whitespace changes are shown: hiding them would hide blanks of more than one kind changing.',
}
// The format a stasis bundle records for one of its files, its own spelling
// of the file's language; undefined for another kind of bundle, or a file it
// records none for.
const stasisFormat = (details, path) => (details?.kind === 'stasis' ? details.bundle?.formats?.get(path) : undefined)
// Renamed names are hidden in JavaScript alone, what a minifier renames: in
// another language a short word (a CSS selector, a tag, prose) is no binding.
const renamable = path => /\.[cm]?js$/iu.test(path)
const hidesRenames = (path, { ignoreRenames } = prefs) => ignoreRenames && renamable(path)
// Whether a text was minified, as read here (file-readability.js
// npmFileReadabilityRead), its short names then a minifier's, not its
// author's.
const minified = (details, path, text) => npmFileReadabilityRead(details, path, text).category === 'minified'

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
// What a file reads names through (renamedDiff's `reads`: a function's name,
// told where one is renamed, its source, a stack), where its renamed names are hidden.
const readsSaid = reads => `Renamed names are hidden, though the file reads ${reads.map(read => `.${read}`).join(', ')}, which a rename may change.`

// A file's line model by what it was diffed with: the settings, and whether
// its sides were pretty-printed (see _pretty).
export const modelKey = (path, pretty, settings = prefs) => `${path}\0${settings.ignoreWhitespace}\0${hidesRenames(path, settings)}\0${!!settings.markRenames}\0${pretty}`

// `${integrity}\0${path}` → the text colored and its highlighted lines, or
// null when Prism has no grammar for it or it is too large to color.
const highlightCache = new Map()
const highlightPending = new Set()
// Each line's code as _code draws it, by its side's lines (a line model's `a`
// or `b`) and line, while its markup, marked words and end stay the same: a
// diff drawn again marks no line again, as a long one takes a while to.
const drawnCode = new WeakMap()

function countLines(text) {
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

// Whether a text is no larger than the server formats (MAX_PRETTY_BYTES):
// its UTF-8 counted only where its length leaves it in doubt, each of its
// UTF-16 units one to three bytes.
const printableSize = text => text.length * 3 <= MAX_PRETTY_BYTES || (text.length <= MAX_PRETTY_BYTES && utf8ByteLength(text) <= MAX_PRETTY_BYTES)

// The pretty-print toggle a file shown has (_fileState): where printing
// changes its diff, its copies' state while they are drawn, else off; none
// where printing would change nothing.
export const prettyToggle = file => (file.printing?.applies ? file.pretty ?? { status: 'off' } : null)

// The files a toggle drawing many applies to, on lines after its own: listed,
// as many as AFFECTS_LISTED, else counted.
const AFFECTS_LISTED = 5
const affectedFiles = paths => (paths ? (paths.length > AFFECTS_LISTED ? `\nAffects files: ${paths.length.toLocaleString()}` : `\nAffects files:\n${paths.join('\n')}`) : '')

// Lines added and removed, as a diff's head counts them.
export const diffCounts = (additions, deletions) => html`<span class="bundle-compare-code-counts" aria-label=${`${additions} added, ${deletions} removed lines`}>
  <span class="add">+${additions.toLocaleString()}</span><span class="del">−${deletions.toLocaleString()}</span>
</span>`

// Whether hiding whitespace changes hides one in a file drawn with them
// hidden (hidesWhitespace), its model's lines and blocks those of the two
// texts: kept on the model, as whether they mix kinds of blank is (_fileState).
const hidesAnyWhitespace = (model, before, after) => (model.hideable ??= hidesWhitespace(before, after, model.blocks))

// A diff too large to compute before it is asked for.
export const isLargeDiff = (before, after) => before.length + after.length > LARGE_CHARS || countLines(before) + countLines(after) > LARGE_LINES

// Whether a file reads as its source in place of a diff, a file at a time:
// its only change a repointed import, moved there by a rename or not, its
// record the same (see _renderFile).
const readsAsSource = entry => entry.kind === 'repointed' || (entry.kind === 'renamed' && !entry.modified && !!entry.repointed && !entry.meta)

// Whether a Lit value draws anything: not `nothing`, null, false or '', nor
// an array or a template holding only those.
const draws = value => Array.isArray(value) ? value.some(draws)
  : value?.strings ? value.strings.some(text => text.trim() !== '') || value.values.some(draws)
  : value != null && value !== nothing && value !== false && value !== ''

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
    // The reason scope the files are compared within (bundle-comparison.js),
    // the server's pairs of them found within it too.
    scope: { attribute: false },
    resolutions: { attribute: false },
    // Alerts on each side's files, by path, and their tags: Socket's, on an
    // npm version's (npm-overview.js npmSocketFileAlerts).
    baseAlerts: { attribute: false },
    otherAlerts: { attribute: false },
    alertTags: { attribute: false },
    // The hosts each file of the open side names that the other's named in
    // none of its files, by path, `[{ host, line }]` each, and their tag: an
    // npm version's, as the pair's risk finds them (npm-overview.js
    // npmNewHosts).
    newHosts: { attribute: false },
    newHostTag: { attribute: false },
    // A source's dependency changes, `{ removed, added, changed }`
    // (npm-package.js npmDependencyChanges, with npm-dependency-checks.js's
    // `flags`), what opens one, and what tags one (npm-overview.js
    // npmDependencyTags).
    dependencies: { attribute: false },
    openDependency: { attribute: false },
    dependencyTags: { attribute: false },
    // Optional review UI: row decorations, filters, progress, and file actions.
    // File display, tree navigation and source features remain shared.
    extensions: { attribute: false },
    baseName: {},
    otherName: {},
    path: {},
    // A line to open at, `{ path, line, query }` (line from 0, the open
    // version's; bundle-compare.js _openLine): sought as a search hit is, once.
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
    this.baseAlerts = null
    this.otherAlerts = null
    this.alertTags = null
    this.newHosts = null
    this.newHostTag = null
    this.extensions = null
    this._treeLimit = 300
    this._treeRemaining = Infinity
    this.path = null
    this._query = ''
    this._kinds = new Set(KINDS.map(entry => entry.kind))
    this._mode = 'files'
    // A changed file's change blocks, as the search found them, by whitespace
    // setting and path; and its last results (_searchResults).
    this._blocks = new Map()
    this._found = null
    // Path → the settings a diff of its printed copies was last drawn under
    // without rows, which the search can't diff itself (_noteRowless); and
    // a count of its changes, for the results to be found again.
    this._rowless = new Map()
    this._rowlessCount = 0
    // A changed file's blocks, as the search kept them → what their split
    // rows are kept on (alignedBlock): the diff drawn of them, or else the
    // search's own `{ a, b, blocks }`, so no block is aligned twice.
    this._aligned = new WeakMap()
    // A search hit picked, `{ path, side, line, at, query, key }`, until its
    // file's diff draws (`key` the model last sought in), and while what it
    // draws is still coming (`_soughtSettling`); then that row, `{ path,
    // index }`, until it is scrolled to.
    this._sought = null
    this._soughtRow = null
    // Directory path → open, for the disclosures the user toggled.
    this._open = new Map()
    this._models = new Map()
    this._modelCap = MODEL_CACHE
    // Path → the tree's line counts for it (_lineCounts), for these entries;
    // a model's key → its blocks as the tree counts them (_counts); path →
    // its counts as its diff draws them, with what they were found under
    // (_shownCounts); and path → its counts as its diff last drew them, with
    // the settings it drew under (_noteDrawn), for a file too large for the
    // tree to count itself (_largeCounts).
    this._counted = new Map()
    this._countModels = new Map()
    this._drawnCounts = new Map()
    this._drawnTotals = new Map()
    // What diff -b would hide in the texts a file shows (_whitespaceHidden).
    this._spaced = new Map()
    // Whether a file's printed copies diff in fewer lines than it (_smaller).
    this._shorter = new Map()
    // Whether the texts a file shows are too large to diff unasked (_large).
    this._larges = new Map()
    // A model's key (modelKey) → fold run → lines revealed, and the rows
    // shown before "Show more"; large files the user asked to diff anyway.
    this._expansions = new Map()
    this._limits = new Map()
    this._forced = new Set()
    this._shownPath = null
  }

  willUpdate(changed) {
    // What is kept by a file's path is of the texts the path named, which
    // the files listed name anew too: another scope pairs a renamed file
    // with another old file, or lists a changed one as added where its old
    // side is out of the scope, the bundles the same.
    const pair = `${this.base?.integrity}|${this.other?.integrity}`
    if (pair !== this._pair || changed.has('files')) {
      this._pair = pair
      this._models.clear()
      this._spaced.clear()
      this._shorter.clear()
      this._larges.clear()
      this._expansions.clear()
      this._limits.clear()
      this._forced.clear()
    }
    if (['files', 'resolutions', 'base', 'other'].some(name => changed.has(name))) {
      this._entries = comparisonEntries(this.base, this.other, this.files, this.resolutions ?? [])
      this._counted = new Map()
      this._countModels = new Map()
      this._drawnCounts = new Map()
      this._drawnTotals = new Map()
      this._treeLimit = this.extensions?.treePageSize ?? Infinity
      // A path may name another pair of files now (another scope pairs a
      // renamed file anew), so what the search kept of it is found again,
      // and a hit still sought in the files as they were is let go.
      this._blocks.clear()
      this._rowless.clear()
      this._sought = this._soughtRow = null
      this._soughtSettling = false
    }
    // Sought as a hit picked in the rail is (_seek), at its query's first
    // match on the line, but by the file Compare opens (`path`); and once,
    // not again where Code is drawn anew with it.
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

  // The row of a search hit picked (see _seek), once drawn, scrolled into
  // view and flashed; a hit whose file drew no diff, dropped, but while that
  // diff is still to be drawn (_soughtSettling): the diff drawn then seeks it
  // again.
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

  // The format a file's icon reads (fileIconFormat): one either side marks as
  // not text, Stasis's or npm's, each side read under its own path, as the
  // Overview's file list reads it (npm-overview.js `npmCompareFiles`); else
  // the shown side's.
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
    const strip = path => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    const tree = buildBundleSourceTree(shown.map(strip), shown, modules)
    this._treeKey = key
    this._treeMemo = { prefix, root, tree, shown: shown.length, allOrder: orderedComparisonFiles(tree) }
    return this._treeMemo
  }

  _select(path) {
    if (!path || path === this._current || this.extensions?.canSelect?.() === false) return
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
    const { prefix, root, tree, shown, allOrder } = this._tree()
    const filtered = filterBundleSourceTree(tree, this._mode === 'files' ? this._query : '', prefix, this.extensions?.fileFilter)
    return { prefix, root, tree, shown, filtered, order: filtered === tree ? allOrder : filtered ? orderedComparisonFiles(filtered) : [], allOrder }
  }

  // The rail: the files that differ as a tree, filtered by path and kind,
  // `current` marked, and the splitter beside it. Picking a file is _select.
  _renderRail({ prefix, root, tree, shown, filtered, order }, current) {
    this._countUntil = null
    this._treeRemaining = this.extensions?.treePageSize ? this._treeLimit : Infinity
    this._treeTruncated = false
    const treeContent = this._mode === 'code' ? nothing : filtered ? this._renderTree(filtered, current, 0, !!this._query || shown <= (this.extensions?.openAllMax ?? OPEN_ALL_MAX)) : html`<div class="bundle-code-search-empty">No changed files match.</div>`
    const counts = Object.fromEntries(KINDS.map(({ kind }) => [kind, 0]))
    for (const entry of this._entries.values()) {
      if (entry.kind !== 'repointed') counts[entry.kind]++
      if (entry.modified) counts.changed++
      if (entry.repointed) counts.repointed++
    }
    const search = SEARCH_MODES.find(({ mode }) => mode === this._mode)
    return html`<aside class="bundle-code-rail">
        <div class="bundle-code-rail-head">
          <span class="bundle-code-rail-label">${this.extensions?.railLabel ?? 'Changes'}</span>
          <span class="bundle-code-rail-count">${this._entries.size.toLocaleString()}</span>
          <span class="bundle-code-rail-actions">
            <button type="button" class="bundle-code-rail-action" aria-label=${this.extensions?.collapseLabel ?? 'Collapse directories'} data-tooltip="Collapse directories"
              ?disabled=${this._mode !== 'files' || !!this._query && !this.extensions?.collapseClearsSearch || tree.dirs.size === 0} @click=${() => this._collapseAll(tree)}>
              ${COLLAPSE_DIRS_ICON}
            </button>
          </span>
        </div>
        ${root.from ? html`<div class="bundle-code-rail-prefix mono" data-tooltip=${`Root moved: ${root.from} → ${root.to}`}>${rootTemplate(root)}</div>`
          : prefix ? html`<div class="bundle-code-rail-prefix mono" data-tooltip-truncated data-tooltip=${prefix}>${prefix}</div>` : nothing}
        <div class="bundle-compare-code-filter">
          <label class="bundle-compare-code-search">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>
            <input type="search" placeholder=${this._mode === 'files' ? this.extensions?.searchPlaceholder ?? search.placeholder : search.placeholder} aria-label=${this._mode === 'files' ? this.extensions?.searchLabel ?? search.placeholder : search.placeholder} spellcheck="false" autocomplete="off"
              .value=${live(this._query)} @input=${e => { this._query = e.target.value; this._treeLimit = this.extensions?.treePageSize ?? Infinity }}>
            <span class="bundle-code-search-modes" role="tablist">
              ${SEARCH_MODES.map(({ mode, label, icon }) => html`<button type="button" class=${classMap({ 'bundle-code-search-mode': true, active: mode === this._mode })}
                role="tab" aria-selected=${String(mode === this._mode)} aria-label=${label} data-tooltip=${label} @click=${() => { this._mode = mode }}>${icon}</button>`)}
            </span>
          </label>
          ${this.extensions?.filters ?? html`<div class="bundle-compare-code-kinds" role="group" aria-label="Show changes">
            ${KINDS.filter(({ kind }) => counts[kind] > 0).map(({ kind, label }) => html`<button type="button" class=${`bundle-compare-code-kind ${kind}`}
              aria-pressed=${String(this._kinds.has(kind))} data-tooltip=${`${this._kinds.has(kind) ? 'Hide' : 'Show'} ${label.toLowerCase()} files`}
              @click=${() => this._toggleKind(kind)}>${label.toLowerCase()}</button>`)}
          </div>`}
        </div>
        <div class="bundle-code-rail-body bundle-compare-code-tree">${this._mode === 'code' ? this._renderSearch(order, current, prefix) : treeContent}
          ${this._mode === 'files' && this._treeTruncated ? html`<button type="button" class="bundle-compare-code-action" @click=${() => { this._treeLimit += this.extensions.treePageSize; this.requestUpdate() }}>Show more files</button>` : nothing}
        </div>
        ${this.extensions?.footer?.(path => { this._query = ''; this._select(path) }) ?? nothing}
      </aside>
      <bundle-code-splitter role="separator" tabindex="0" aria-orientation="vertical"
        aria-label="Resize file tree" data-tooltip="Drag to resize · double-click to reset"></bundle-code-splitter>`
  }

  // Painted again as a diff it asked for comes, fails or is dropped, while it is
  // shown: a view gone, painted, would ask for its diffs again (rename-diff.js).
  // What came for the view (printed copies, the server's diffs), counted, so
  // the tree counts its files again (_shownCounts).
  _arrived = 0
  // Whether the file drawn asks for its diff with renamed names hidden alone,
  // while its comparison's come (rename-diff.js): the one this view shows.
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
    return html`<div class="bundle-code-view bundle-compare-code">
      ${this._renderRail(rail, current)}
      <div class="bundle-code-main">
        ${main}
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
    if (this.extensions?.collapseClearsSearch) this._query = ''
    this._treeLimit = this.extensions?.treePageSize ?? Infinity
    const walk = node => {
      for (const child of node.dirs.values()) { this._open.set(child.path, false); walk(child) }
    }
    walk(tree)
    this.requestUpdate()
  }

  // ── Code search ──────────────────────────────────────────────────

  // Code mode's results: each file with lines that match, under its name,
  // each line with its number and sign as its diff shows them (a line removed
  // numbered in the old text); a pick opens the file there (_seek).
  _renderSearch(order, current, prefix) {
    if (!this._query) return html`<div class="bundle-code-search-hint">Type to search the code of the changed files.</div>`
    const { files, hits, truncated, unsigned } = this._searchResults(order)
    if (files.length === 0) return html`<div class="bundle-code-search-empty">No matches.</div>`
    const strip = path => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    return html`<div class="bundle-code-search-results bundle-compare-search">
      <div class="bundle-code-search-summary">${hits.toLocaleString()} ${hits === 1 ? 'hit' : 'hits'} in ${files.length.toLocaleString()} ${files.length === 1 ? 'file' : 'files'}${truncated ? `, the first ${SEARCH_MAX_FILES}` : ''}</div>
      ${repeat(files, file => file.path, ({ path, hits: lines }) => html`<div class=${classMap({ 'bundle-code-search-file': true, current: path === current })}>
        <button type="button" class=${`bundle-code-search-file-name bundle-compare-code-name ${this._entries.get(path).kind}`}
          data-tooltip-truncated data-tooltip=${path} @click=${() => this._select(path)}>${strip(path)}</button>
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

  // The search's results over the files the rail lists (`order`) whose text
  // this view shows (_searchable), as searchCompareFiles finds them there.
  // Kept while the query, the files and the kinds shown are, the large diffs
  // asked for, the layout, the whitespace and pretty-print settings, and the
  // printed copies come or failed. A changed file is diffed as this view
  // diffs it, its whitespace changes hidden where the
  // view hides them; but one whose diff here is of its pretty-printed copies
  // (_prettyShown), or too large to show unasked (isLargeDiff) until asked
  // for, lists its new text's lines alone, unsigned, so the rail claims no
  // sign nor removed line its diff doesn't show, and none at all where that
  // diff, drawn under the settings it is searched under, has no rows
  // (_noteRowless); and an added or removed file shown pretty-printed lists
  // its lines numbered as published. The
  // reason is in `unsigned` by path (UNSIGNED). Diffs are found a little at a time, as the
  // tree's line counts are, a render's budget counted from its first: a file
  // past it lists its new text's lines unsigned, and another render signs
  // them.
  _searchResults(order) {
    const drawn = rowlessSettings()
    const key = `${this._query}\0${this._forced.size}\0${drawn}\0${prefs.layout}\0${!!state.bundleSourcePretty}\0${prettySettled()}\0${this._rowlessCount}\0${order.join('\0')}`
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
    else this._searchLater ??= setTimeout(() => { this._searchLater = null; this.requestUpdate() })
    return result
  }

  // Whether a file's text shows here, to be searched: its diff, where its
  // bytes changed, or its source, where it reads as one (readsAsSource).
  _searchable(entry) {
    return entry.modified !== false || readsAsSource(entry)
  }

  // Whether a file's diff here is of its pretty-printed copies (_printing),
  // the toggle on: not where a copy of either side failed, when the diff is
  // of the file as published.
  _prettyShown(path, entry, contents) {
    if (!state.bundleSourcePretty) return false
    const printing = this._printing(path, entry, contents)
    return !!printing?.applies && printing.copies.status !== 'error'
  }

  // A diff of a file's printed copies drawn (_fileState), noted where it has
  // no rows (`rowless`), the copies the same or their changes all hidden (as
  // whitespace or renamed names), with the settings it was drawn under, for
  // the search to leave the file out while they hold (_searchResults).
  _noteRowless(path, rowless) {
    const drawn = rowless ? rowlessSettings() : undefined
    if (this._rowless.get(path) === drawn) return
    if (drawn === undefined) this._rowless.delete(path)
    else this._rowless.set(path, drawn)
    this._rowlessCount++
  }

  // A search hit picked: its file opened, its line brought into view where
  // the file's diff draws (see _seekRows), asked for there where it is too
  // large to show unasked (_fileState).
  _seek(path, hit) {
    this._sought = { path, side: hit.side, line: hit.line, at: hit.ranges[0]?.[0] ?? 0, query: this._query }
    if (path === this._current) this.requestUpdate()
    else this._select(path, false)
  }

  // The line a hit names in the text a file's diff shows, `{ side, line }`:
  // in a pretty-printed copy, the line holding the same match, counted in
  // order on its side with whitespace taken out of the query and both texts,
  // which pretty-printing respaces (`a+b` as `a + b`, a string's `"a+b"` as
  // it was); where the printer changed the match itself, the line its first
  // character falls on, counted the same way, in the characters it moves but
  // keeps; null past the copy's end.
  _soughtLine(path, entry, pretty, model) {
    const { side, line, at, query } = this._sought
    if (pretty?.status !== 'ready') return { side, line }
    const solid = text => text.replaceAll(/\s+/gu, '')
    const raw = textLines(fileContents(this.base, this.other, path, entry)[side === 'a' ? 'before' : 'after'] ?? '')
    const offset = raw.slice(0, line).reduce((sum, text) => sum + solid(text).length, 0) + solid(raw[line]?.slice(0, at) ?? '').length
    const needle = solid(query).toLowerCase()
    // The first match in a text's characters other than whitespace, case
    // folded as the search matches, that `found(index, start)` takes, its
    // `{ index, start }`: read a piece at a time (a line, or SEEK_CHUNK of a
    // minified one), so neither read nor folded further, however common the
    // query or large the text. Kept of what was read: what a match may
    // still start in (`text`, from `past`).
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

  // A sought line's row among a diff's `rows`, a fold it is in opened past
  // it, and the rows shown taken to it: `{ rows, index }`, `index` -1 where
  // it isn't among them. `key` names the diff's model, as its expansions and
  // limit are kept.
  _seekRows(key, model, { side, line }, split) {
    const shows = row => side === 'b'
      ? ((row.kind === 'ctx' || row.kind === 'add') && row.b === line) || (row.kind === 'change' && row.right === line)
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
    const limit = this._limits.get(key) ?? ROW_LIMIT
    if (index >= limit) this._limits.set(key, Math.ceil((index + 1) / ROW_LIMIT) * ROW_LIMIT)
    return { rows, index }
  }

  _takeTreeRow(required = false) {
    if (this._treeRemaining-- > 0) return true
    this._treeTruncated = true
    return required
  }

  _renderTree(node, current, depth, openAll) {
    const dirs = [...node.dirs.entries()].toSorted(compareDirectoryOrder)
    const files = [...node.files.entries()].toSorted(([a], [b]) => a.localeCompare(b))
    const directories = dirs.flatMap(([name, child]) => {
      const compact = compactSourceDirectory(name, child, depth)
      const pkg = child.package
      const vendored = pkg?.ecosystem === 'cargo' || pkg?.ecosystem === 'composer' || pkg?.ecosystem === 'soldeer'
      const open = this._query ? true : this._open.get(child.path) ?? (openAll || depth === 0 || containsFile(child, current))
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
            ${pkg ? sourcePackageIcon(pkg.ecosystem) : nothing}
            <span class=${classMap({ 'bundle-code-tree-dirname': true, 'bundle-code-tree-package': !!pkg, 'bundle-code-tree-package-vendored': vendored, 'bundle-compare-code-name': true, removed: dirKind === 'removed' })}
              data-tooltip-truncated data-tooltip=${compact.node.sourcePath}>
              ${pkg ? html`<span class="bundle-code-tree-package-name">${pkg.name}</span>${pkg.version ? html`<span class="bundle-code-tree-package-version">${vendored ? '- ' : '@'}${pkg.version}</span>` : nothing}` : compact.names.map((part, index) => html`${index > 0 ? html`<span class="bundle-code-tree-separator">/</span>` : nothing}${part}`)}
            </span>
            ${pkg?.variant ? html`<span class="bundle-code-tree-variant">variant ${pkg.variant}</span>` : nothing}
            <span class="bundle-compare-code-dir-count" data-tooltip=${`${child.fileCount} changed ${child.fileCount === 1 ? 'file' : 'files'}`}>${this.extensions?.directorySummary?.(compact.node) ?? child.fileCount}</span>
            ${dirKind ? html`<span class=${`bundle-compare-code-letter ${dirKind}`} data-tooltip=${`${pkg ? 'Package' : 'Directory'} ${dirKind}`}>${KIND[dirKind].letter}</span>` : nothing}
          </summary>
          ${open || !this.extensions?.treePageSize ? this._renderTree(compact.node, current, depth + 1, openAll) : nothing}
        </details>
      </li>`
      return [{ key: child.path, content }]
    })
    const leaves = files.flatMap(([name, full]) => {
      if (!this._takeTreeRow(full === current)) return []
      const { kind, repointed, renamedFrom, modified } = this._entries.get(full)
      const imports = repointed ? `${repointed.length} repointed ${repointed.length === 1 ? 'import' : 'imports'}` : ''
      const content = html`<li class="bundle-code-tree-file">
        <button type="button" class=${classMap({ 'bundle-code-tree-link': true, current: full === current })}
          aria-label=${this.extensions?.fileLabel?.(full) ?? nothing} aria-current=${full === current ? 'true' : nothing} @click=${() => this._select(full)}>
          ${this.extensions?.filePrefix?.(full) ?? nothing}${sourceFileIcon(full, this._format(full))}<span class=${`bundle-code-tree-name bundle-compare-code-name ${kind}`} data-tooltip-truncated data-tooltip=${full}>${name}</span>
          ${this.extensions?.fileSuffix?.(full) ?? nothing}
          ${renamedFrom ? html`<span class="bundle-compare-code-oldname" data-tooltip-truncated data-tooltip=${`Renamed from ${renamedFrom}`}>← ${renameParts(renamedFrom, full, { extension: false }).from}</span>` : nothing}
          ${this._fileTags(full, this._entries.get(full), true)}
          ${this._treeCounts(full, this._entries.get(full))}
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

  // A file's lines added and removed as its diff draws them (_shownCounts),
  // else as published: `=` for one renamed, or recorded otherwise, as it was,
  // and `≈` for one whose changes the settings drawing it set aside, all of
  // them, or marked as differing in renamed names alone; the counts as
  // published told where they differ, and the lines marked. One too large to
  // count here as its diff drew it (_largeCounts), its counts as published
  // told where it drew them so.
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
  // draws it otherwise than as published (_fileState counting): printed where
  // the toggle prints it, its whitespace or renamed names hidden, with those
  // settings (`aside`), and lines differing in renamed names alone marked,
  // counted apart (`renamed`), as its head counts them (_fileFigures). Null
  // where none does, or till its copies come, or where it is too large to
  // diff unasked: counted as published then. Kept for the settings and what
  // came for the view since (`_arrived`); undefined where the tree's budget
  // is spent (_lineCounts), to be counted on a later render.
  _shownCounts(path, entry) {
    if (!(state.bundleSourcePretty || prefs.ignoreWhitespace || prefs.ignoreRenames || prefs.ignoreTypes)) return null
    const settings = `${countSettings()}\0${this._arrived}\0${this._forced.size}`
    const kept = this._drawnCounts.get(path)
    if (kept?.settings === settings) return kept.counts
    const now = performance.now()
    this._countUntil ??= now + COUNT_BUDGET_MS
    if (now > this._countUntil) {
      this._countLater ??= setTimeout(() => { this._countLater = null; this.requestUpdate() })
      return undefined
    }
    const counted = this._countingState(path, entry), { model } = counted
    const aside = setAside(counted)
    const counts = model && aside.length > 0 ? { additions: model.additions, deletions: model.deletions, renamed: model.renamed, aside } : null
    this._drawnCounts.set(path, { settings, counts })
    return counts
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

  // A file's lines as its diff drew them (_fileState), kept with the settings
  // it drew under for the tree, where it is too large to count (_largeCounts).
  _noteDrawn(path, drawn) {
    const { model } = drawn
    if (model) this._drawnTotals.set(path, { settings: countSettings(), counts: { additions: model.additions, deletions: model.deletions, renamed: model.renamed, aside: setAside(drawn) } })
    return drawn
  }

  // A file too large for the tree to count (fileLineCounts) counted as its
  // diff last drew it under these settings (_noteDrawn): as published where
  // they set nothing of it aside, else as shown; none changed, shown, where
  // its changes in types alone are hidden (type-only.js), drawn or not; else
  // none, no diff of it found here.
  _largeCounts(path, entry) {
    const drawn = this._drawnTotals.get(path)
    if (drawn?.settings === countSettings()) return drawn.counts.aside.length === 0 ? { published: drawn.counts, shown: null } : { published: null, shown: drawn.counts }
    const contents = prefs.ignoreTypes ? fileContents(this.base, this.other, path, entry) : null
    const types = typeof contents?.before === 'string' && typeof contents.after === 'string' && typeOnly(this.base, this.other, path, entry, contents, this._repaint, this.scope)
    return { published: null, shown: types ? { additions: 0, deletions: 0, renamed: 0, aside: [HIDE_TYPES] } : null }
  }

  // ── The selected file ────────────────────────────────────────────

  // `options` as lineDiff takes them: the server's blocks, with renamed names
  // hidden, or those it marks (rename-diff.js); found with whitespace changes
  // hidden or not as `ignoreWhitespace` is. Kept by `key` with the texts and
  // the blocks or marks it was found from, and found again where any differ
  // (a copy printed again, another diff of it): never drawn for other lines
  // than its own.
  _model(key, before, after, options = {}, ignoreWhitespace = prefs.ignoreWhitespace) {
    const given = options.changes?.blocks ?? options.marks ?? null
    // Re-inserted on every use, so the cache drops the least recent.
    let kept = this._models.get(key)
    this._models.delete(key)
    if (!(kept?.before === before && kept.after === after && kept.given === given)) {
      kept = { model: lineDiff(before, after, { ...options, ignoreWhitespace }), before, after, given }
    }
    this._models.set(key, kept)
    if (this._models.size > this._modelCap) this._models.delete(this._models.keys().next().value)
    return kept.model
  }

  // A file's change blocks as _model would find them, for the tree's counts:
  // kept apart from the models drawn, one for each of a comparison's files
  // and settings, so counting the tree evicts none of those.
  _counts(key, before, after, options, ignoreWhitespace) {
    const given = options.changes?.blocks ?? options.marks ?? null
    const kept = this._countModels.get(key)
    if (kept?.before === before && kept.after === after && kept.given === given) return kept.model
    const blocks = options.changes?.blocks ?? changeBlocks(before, after, ignoreWhitespace)
    const model = { blocks, ...markedCounts(blocks, options.marks) }
    this._countModels.set(key, { model, before, after, given })
    return model
  }

  // A file's two sides, pretty-printed where the toggle has them so, and its
  // line model where it has one to draw: none for a file that is not text,
  // nor for one too large to diff unasked. `counting`, for the tree's counts
  // (_shownCounts), finds its change blocks alone, and those marked, kept
  // apart from the models drawn (_counts), and leaves alone what a file drawn
  // sets: a hit sought, the search's blocks, whether hiding whitespace would
  // hide any. A file drawn first asks for its renamed names alone while its
  // comparison's come (_renamesAlone). One that changed in types alone, as
  // the server proved (`types`, type-only.js), draws nothing where those
  // changes are hidden (`typesHidden`).
  _fileState(path, entry, counting = false) {
    const contents = fileContents(this.base, this.other, path, entry)
    const textual = typeof contents.before === 'string' && typeof contents.after === 'string'
    const types = textual && typeOnly(this.base, this.other, path, entry, contents, this._repaint, this.scope)
    if (types && prefs.ignoreTypes) {
      const model = { a: [], b: [], blocks: [], additions: 0, deletions: 0, renamed: 0, marked: new Set(), noEol: { a: false, b: false }, words: new Map() }
      if (counting) return { pretty: null, hiding: false, model, spacesHidden: false, typesHidden: true }
      return this._noteDrawn(path, { ...contents, textual, large: false, printing: null, pretty: null, key: null, generated: false, renamed: false, warned: [], hiding: false, changes: null,
        model, whitespace: null, spacesHidden: false, types, typesHidden: true })
    }
    // Its printed copies drawn where the toggle is on and printing changes
    // its diff (_printing); counted, not asked for where it is off.
    const printing = textual && (!counting || state.bundleSourcePretty) ? this._printing(path, entry, contents) : null
    const pretty = state.bundleSourcePretty && printing?.applies ? printing.copies : null
    const { before, after } = pretty?.status === 'ready' ? pretty : contents
    // Renamed names are found by the server, in the copies it pretty-printed
    // (rename-diff.js), once those came: the lines that differ in them alone
    // marked, the diff of the files as they are drawn till then, or hidden
    // where the viewer asks. A file whose copies failed has none found.
    const generated = textual && renamable(path) && renamable(entry.basePath ?? path) && ['ready', 'loading', 'error'].includes(pretty?.status)
      && this._generated(path, entry, contents)
    const renames = generated && pretty.status === 'ready'
    // A hit sought here asks for a diff too large to show unasked, as "Show
    // diff" does: large as the texts it shows are, printed or as published.
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
      // Where either side reads names (`f.name`, `f.toString()`), a rename may
      // change what the code does, which hiding renamed names could hide: it is
      // said (`warned`), the renamed lines offered marked.
      const warned = hiding && changes.reason === null ? changes.reads : []
      // Hide renamed names is offered where it hides any: lines that differ in
      // renamed names alone, marked otherwise, or, while it is on, names it
      // gave in lines that differ besides; and while it is on, in any file it
      // is for that it hides none in yet, to be turned off: its copies or the
      // server's diff coming or failed, or no names given, as it said why.
      const renamed = ready && changes.reason === null ? changes.marks.length > 0 || (prefs.ignoreRenames && changes.before !== before) : prefs.ignoreRenames && generated
      const key = modelKey(path, pretty?.status === 'ready', { ...prefs, ignoreWhitespace, ignoreRenames: hiding, markRenames: marked })
      // The old side as the server diffed it, given the new side's names, where they are hidden.
      const shown = hiding ? changes.before : before
      const options = hiding ? { changes: { blocks: changes.blocks } } : marked ? { marks: changes.marks } : {}
      const model = textual && !large && (!changes || ready || !prefs.ignoreRenames)
        ? (counting ? this._counts(key, shown, after, options, ignoreWhitespace) : this._model(key, shown, after, options, ignoreWhitespace)) : null
      return { key, changes, warned, renamed, hiding, shown, model, ignoreWhitespace }
    }
    // Whitespace changes are hidden as diff -b hides them, only in a file whose
    // whitespace means nothing, on both sides (whitespaceInsensitive), and not
    // where that would hide blanks of more than one kind changing
    // (hidesMixedWhitespace): others are diffed with them shown.
    const unlisted = this._unlisted(path, entry, contents)
    let found = diffed(prefs.ignoreWhitespace && !unlisted)
    const mixed = prefs.ignoreWhitespace && !unlisted && !!found.model && (found.model.mixed ??= hidesMixedWhitespace(found.shown, after, found.model.blocks))
    if (mixed) found = diffed(false)
    const { key, changes, warned, renamed, hiding, shown, model } = found
    if (counting) return { pretty, hiding, model, spacesHidden: found.ignoreWhitespace }
    if (pretty?.status === 'ready' && model) this._noteRowless(path, model.blocks.length === 0)
    // The texts as published diffed as the search diffs them (_searchResults):
    // their blocks kept for it, not found again, however large.
    else if (model) {
      this._blocks.set(`${prefs.ignoreWhitespace}\0${path}`, model.blocks)
      this._aligned.set(model.blocks, model)
    }
    // What hiding them does here: hides one (`hideable`), where the diff shown
    // does or diff -b would while they show (_whitespaceHidden); or would, but
    // may not as blanks of more than one kind change (`mixed`), said while they
    // are to be hidden. Where it would hide none, or none it may (a file whose
    // whitespace may mean something, plain to see), it is not offered.
    const off = model && !unlisted && !prefs.ignoreWhitespace ? this._whitespaceHidden(`${path}\0${pretty?.status === 'ready'}\0${hiding}`, shown, after) : null
    const whitespace = model === null || unlisted ? null
      : mixed ? 'mixed'
      : prefs.ignoreWhitespace ? (hidesAnyWhitespace(model, shown, after) ? 'hideable' : null)
      : off.hides && !off.mixed ? 'hideable' : null
    // A hit sought here waits while its diff isn't drawn yet: its printed
    // copies still coming, or its renamed names, to be hidden, coming or
    // failed to hide, until they are shown (see _scrollSought); marked, they
    // leave its rows as they are.
    if (this._sought?.path === path) this._soughtSettling = pretty?.status === 'loading' || (prefs.ignoreRenames && (changes?.status === 'loading' || changes?.status === 'error'))
    return this._noteDrawn(path, { before: shown, after, textual, large, printing, pretty, key, generated, renamed, warned, hiding, changes, model, whitespace,
      spacesHidden: found.ignoreWhitespace, types })
  }

  // Whether a file's whitespace may mean something on either side, so its
  // whitespace changes show whatever the setting (see _fileState).
  _unlisted(path, { basePath = path }, { before, after }) {
    return !whitespaceInsensitive(path, after, stasisFormat(this.other, path))
      || !whitespaceInsensitive(basePath, before, stasisFormat(this.base, basePath))
  }

  // What diff -b would hide between the texts a file shows (whitespaceHidden),
  // `key` naming them, kept as their models are: with the texts, and found
  // again for others (_model).
  _whitespaceHidden(key, before, after) {
    let kept = this._spaced.get(key)
    if (!(kept?.before === before && kept.after === after)) kept = { before, after, hidden: whitespaceHidden(before, after) }
    this._spaced.delete(key)
    this._spaced.set(key, kept)
    if (this._spaced.size > this._modelCap) this._spaced.delete(this._spaced.keys().next().value)
    return kept.hidden
  }

  // Whether a file's names are a minifier's on both sides, each minified, and
  // the server can diff it: renamed names are hidden there alone, an
  // author's renamed to a minifier's (or to another author's) a change.
  _generated(path, { kind, basePath = path }, { before, after }) {
    return kind !== 'repointed' && renameDiffable(this.base, this.other) && minified(this.base, basePath, before) && minified(this.other, path, after)
  }

  // A file's two sides pretty-printed, as the server prints every pair that
  // changed between two managed bundles or two versions of a package
  // (pretty-source.js comparedCopy), the toggle on or not, and whether
  // printing them changes its diff (`applies`): where either side is
  // minified, as the Code tab prints a file (`minified`), or, where both
  // sides have text and once both copies came, where their diff has fewer
  // changed lines than the files' (`smaller`: formatting changed, as a
  // semicolon added to every line; an added file has nothing to compare). Its
  // copies (`copies`): the first failure of either, else one still coming,
  // else their texts and hashes. Null for a file whose sides can't both be
  // printed.
  _printing(path, entry, contents) {
    const { kind, basePath = path, modified } = entry, { before, after } = contents
    if (kind === 'repointed' || modified === false || typeof before !== 'string' || typeof after !== 'string' || before === after || !renameDiffable(this.base, this.other)) return null
    const sides = [['base', this.base, basePath, before], ['other', this.other, path, after]]
    if (!sides.every(([, , file, text]) => text === '' || (prettyExtension(file) !== null && printableSize(text)))) return null
    const unreadable = sides.some(([, details, file, text]) => text !== '' && prettyPrintable(details, details, file, text))
    const both = sides.map(([side, , file, text]) => (text === '' ? { status: 'ready', text } : comparedCopy(this.base, this.other, side, file, text, this._repaint)))
    const copies = both.find(copy => copy.status === 'error') ?? both.find(copy => copy.status === 'loading')
      ?? { status: 'ready', before: both[0].text, after: both[1].text, hashes: both.map(copy => copy.hash) }
    const smaller = !unreadable && before !== '' && after !== '' && copies.status === 'ready' && this._smaller(path, contents, copies)
    return { copies, minified: unreadable, smaller, applies: unreadable || smaller }
  }

  // Whether the texts a file shows are too large to diff unasked
  // (isLargeDiff), kept with the texts it was found for, as _smaller keeps
  // its answer: every render asks it of every file it lists, and counting a
  // large file's lines takes a while.
  _large(path, before, after) {
    const kept = this._larges.get(path)
    if (kept?.before === before && kept.after === after) return kept.large
    const large = isLargeDiff(before, after)
    this._larges.set(path, { before, after, large })
    return large
  }

  // Whether a file's printed copies' diff has fewer changed lines than its
  // texts' as published, whitespace changes shown: false where either is too
  // large to diff unasked. Kept with the texts it was found for, as models
  // are (_model).
  _smaller(path, { before, after }, printed) {
    const kept = this._shorter.get(path)
    if (kept?.before === before && kept.after === after && kept.printed === printed.before && kept.printedAfter === printed.after) return kept.smaller
    const changed = (a, b) => changeBlocks(a, b).reduce((sum, { a0, a1, b0, b1 }) => sum + a1 - a0 + b1 - b0, 0)
    const smaller = !isLargeDiff(before, after) && !isLargeDiff(printed.before, printed.after) && changed(printed.before, printed.after) < changed(before, after)
    // One for each changed file, as the tree finds them all (_shownCounts).
    this._shorter.set(path, { before, after, printed: printed.before, printedAfter: printed.after, smaller })
    return smaller
  }

  // What a file shows in place of a diff: why there is none, or how to have
  // one; null where there is a diff to show.
  _fileMessage(path, { kind, modified, meta }, { before, after, textual, large, model, pretty, hiding, warned = [], changes, whitespace, typesHidden = false }) {
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
    // Proven by the server to change types alone, what runs left as it was (type-only.js).
    if (typesHidden) {
      return html`<div class="bundle-compare-code-message">
        <p>Only types changed in this file.${recorded ? ` ${recorded}` : ''}</p>
        <button type="button" class="bundle-compare-code-action" @click=${() => this._setTypes(false)}>Show type-only changes</button>
      </div>`
    }
    if (changes?.status === 'loading' && prefs.ignoreRenames) return html`<div class="bundle-compare-code-message" aria-busy="true">Hiding renamed names…</div>`
    if (changes?.status === 'error' && prefs.ignoreRenames) {
      return html`<div class="bundle-compare-code-message">
        <p>Couldn't hide renamed names: ${changes.message}</p>
        <button type="button" class="bundle-compare-code-action" @click=${() => this._setRenames(false)}>Show renamed names</button>
      </div>`
    }
    if (model.blocks.length > 0) return null
    // Its printed copies the same, its texts not: its layout changed alone, the
    // copies each checked by the server to read as its text does.
    const reformatted = pretty?.status === 'ready' && pretty.before === pretty.after
    const spaced = !reformatted && prefs.ignoreWhitespace && whitespace === 'hideable'
    const renamed = !reformatted && hiding
    const hidden = [spaced && 'whitespace', renamed && 'renamed names'].filter(Boolean)
    const told = reformatted ? 'No actual code changes in this file.' : hidden.length > 0 ? `Only ${hidden.join(' and ')} changed in this file.` : null
    return html`<div class="bundle-compare-code-message">
      <p>${told ? `${told}${recorded ? ` ${recorded}` : ''}` : same}</p>
      ${warned.length > 0 ? html`<p>${readsSaid(warned)}</p>` : nothing}
      ${reformatted ? html`<button type="button" class="bundle-compare-code-action" @click=${() => { togglePrettySource(); this.requestUpdate() }}>Show as published</button>` : nothing}
      ${spaced ? html`<button type="button" class="bundle-compare-code-action" @click=${() => this._setWhitespace(false)}>Show whitespace changes</button>` : nothing}
      ${renamed ? html`<button type="button" class="bundle-compare-code-action" @click=${() => this._setRenames(false)}>Show renamed names</button>` : nothing}
    </div>`
  }

  // A file's kind, icon and path, `prefix` left off, and how it reads.
  _fileName(path, entry, prefix) {
    const strip = file => prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
    return html`<span class=${classMap({ 'bundle-compare-code-pill': true, [entry.kind]: true, pure: entry.kind === 'renamed' && !entry.modified })}>${KIND[entry.kind].label}</span>
      ${sourceFileIcon(path, this._format(path))}
      <span class="bundle-code-main-path mono" data-tooltip-truncated data-tooltip=${entry.renamedFrom ? `${entry.renamedFrom} → ${path}` : path}>${entry.renamedFrom ? renameTemplate(strip(entry.renamedFrom), strip(path)) : strip(path)}</span>
      ${this._fileTags(path, entry)}${this._githubLink(path, entry)}`
  }

  // All comparison file chips, shared by Compare and Review in headers and trees.
  // The tree uses the same signals, with shorter labels where needed, and tags
  // a file Large only where it has no other tag, as Large says least of one.
  _fileTags(path, entry, compact = false) {
    if (!compact) return html`${this._entryTags(path, entry)}${this._alertTags(path, entry)}${this._runsTags(path, entry)}${this._newHostTags(path, entry)}${this._flagTags(path, entry)}${this._readability(path, entry)}${this._installTags(path, entry)}${fileMetaTags(entry.meta)}`
    const tags = [this._alertTags(path, entry), this._runsTags(path, entry), this._newHostTags(path, entry), this._flagTags(path, entry, false), this._treeTag(path, entry), this._installTags(path, entry, true), fileMetaTags(entry.meta, true)]
    return draws(tags) ? tags : this._flagTags(path, entry)
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

  // The hosts a file names that the one compared with named in none of its
  // files (`newHosts`), in its head and in the tree; none for one removed.
  _newHostTags(path, { kind }) {
    const hosts = kind === 'removed' ? null : this.newHosts?.get(path)
    return hosts && this.newHostTag ? this.newHostTag(hosts) : nothing
  }

  // What a file's code can run beyond itself (file-runs-code.js: eval,
  // Function, child_process) and an exfiltration host it names
  // (file-hosts.js), in its head and in the tree: as it is now (as it was,
  // for one removed), each the one compared with didn't hold saying so, all
  // of an added file's.
  _runsTags(path, entry) {
    return [[npmFileRunsCode, npmRunsCodeTags], [npmFileExfiltration, npmExfiltrationTag]].map(([read, tags]) => {
      const { was, now } = this._reads(path, entry, read)
      return entry.kind === 'removed' ? tags(was) : tags(now, was)
    })
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

  // How a file reads (file-readability.js), or what it runs (`of`), on the
  // sides it has: `was`, as the bundle compared with has it, and `now`; null
  // for a side without it, `was` undefined where its contents are unknown.
  _reads(path, entry, of = npmFileReadabilityOf) {
    const { kind, basePath = path } = entry
    const { before, after } = fileContents(this.base, this.other, path, entry)
    return {
      was: kind === 'added' ? null : before === undefined ? undefined : of(this.base, basePath, before),
      now: kind === 'removed' || after === undefined ? null : of(this.other, path, after),
    }
  }

  // A file's head tags how it reads, as the npm Overview tags a file (ASCII,
  // UTF-8, Minified, Controls, ...), and how its text is encoded beside a tag
  // that says something else (Minified ASCII, file-readability.js
  // npmTextKindTag): as it reads now, after how it read where that differs;
  // every other label it has as it reads now (its controls and long lines,
  // minified or not) beside that, as Obfuscated is (npmReadabilityFlags).
  _readability(path, entry) {
    const { was, now } = this._reads(path, entry)
    const reads = read => html`${npmEncodingTag(read)}${npmTextKindTag(read)}`
    const tag = !was || !now || (npmTaggedCategory(was) === npmTaggedCategory(now) && was.kind === now.kind) ? reads(now ?? was)
      : html`<span class="bundle-compare-code-readability">${reads(was)}<span aria-hidden="true">→</span>${reads(now)}</span>`
    return html`${npmReadabilityFlags(now ?? was)}${tag}`
  }

  // What a file is beyond how it reads, as the npm Files list tags it
  // (file-readability.js npmFileFlagTags), in its head and the tree: as it is
  // now, or was, for one removed. `large` false leaves Large out.
  _flagTags(path, entry, large = true) {
    return entry.kind === 'removed' ? npmFileFlagTags(this.base, entry.basePath ?? path, entry.baseBytes, large) : npmFileFlagTags(this.other, path, entry.otherBytes, large)
  }

  // The tree tags a file as its head does where it can be hard to review by
  // reading it as it reads now (as it read, for one removed), more briefly:
  // its controls and unexpected long lines, those it warns of, and its tag,
  // ASCII and UTF-8 going untagged there, as does Map, which a source map's
  // name says already; Minified as Min.
  _treeTag(path, entry) {
    const { was, now } = this._reads(path, entry)
    const shown = now ?? was
    if (!shown) return nothing
    const tagged = shown.category !== 'map' && READABILITY.get(npmTaggedCategory(shown)).mark
    return html`${npmReadabilityFlags(shown, ['warn'])}${tagged ? npmEncodingTag(shown, true) : nothing}`
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
  // given another file's names (`renamed` and that file). Taken only for the
  // text it colored: another under the same name (a copy printed again,
  // another diff's old side) is colored anew, never drawn as the one before.
  _highlighted(details, path, text, copy = '') {
    if (!text) return null
    const lang = langForPath(path, stasisFormat(details, path), text)
    if (!lang) return null
    const key = `${details.integrity}\0${path}${copy ? `\0${copy}` : ''}`
    const kept = highlightCache.get(key)
    if (kept?.text === text) return kept.lines
    if (!highlightPending.has(key)) {
      highlightPending.add(key)
      void (async () => {
        const markup = await highlight(text, lang)
        const lines = typeof markup === 'string' ? splitHighlightedLines(markup) : null
        highlightCache.set(key, { text, lines: lines?.length === text.split('\n').length ? lines : null })
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
    const asSource = readsAsSource(entry)
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
        ${this._toggles(diffable, prettyToggle(file), file.renamed, file.whitespace === 'hideable', file.types)}
      </header>
      <div class="bundle-compare-diff" tabindex="0" aria-label=${`Changes in ${display}`}>
        ${this._dependencyChanges(path)}
        ${entry.repointed ? this._renderRepointed(path, entry.repointed, [after, before].find(text => typeof text === 'string' && text !== '') ?? null, textual && !diffable) : nothing}
        ${body}
      </div>`
  }

  // The diff's hiding, pretty-print and layout controls, as the file shown, or
  // any of those listed, has use for them: what it hides (_hides), then
  // pretty-printing a minified file (`pretty` from _pretty), as pressing it
  // can show or hide them, and a diff its layout, last. Lines always wrap.
  _toggles(diffable, pretty = null, renamed = false, whitespace = false, types = false) {
    return html`${diffable ? this._hides(renamed, whitespace, types) : nothing}
        ${pretty ? html`<button type="button" class=${classMap({ 'bundle-compare-code-toggle': true, 'is-loading': pretty.status === 'loading', 'is-error': pretty.status === 'error' })}
          aria-pressed=${String(!!state.bundleSourcePretty)} aria-busy=${pretty.status === 'loading' ? 'true' : nothing} aria-label="Pretty-print"
          data-tooltip=${`${prettyTooltip(pretty)}${affectedFiles(pretty.affects)}`}
          @click=${() => { togglePrettySource(); this.requestUpdate() }}>${PRETTY_ICON}</button>` : nothing}
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
  // Overview's Dependencies rows do, and tagged as the source tags it
  // (`dependencyTags`), the head counting its `flags`, what calls for a look
  // at it (npm-dependency-checks.js), too.
  _dependencyChanges(path) {
    if (path !== 'package.json' || !this.dependencies) return nothing
    const { added, changed, removed } = this.dependencies
    const chips = [...added.map(row => ['added', row]), ...changed.map(row => ['changed', row]), ...removed.map(row => ['removed', row])]
    if (chips.length === 0) return nothing
    const counts = [[added, 'new'], [changed, 'updated'], [removed, 'removed']].filter(([rows]) => rows.length > 0).map(([rows, noun]) => `${rows.length} ${noun}`)
    const flagged = Map.groupBy(chips.flatMap(([, row]) => row.flags ?? []), ({ label }) => label)
    const open = this.openDependency
    return html`<section class="bundle-compare-code-deps" aria-label="Dependency changes">
      <h4>Dependencies <span>${counts.join(' · ')}</span>${[...flagged].map(([label, flags]) => html`<span class="bundle-compare-code-deps-flagged">${flags.length} ${label}</span>`)}</h4>
      <ul>${chips.map(([kind, row]) => {
        const range = kind === 'changed'
          ? html`<span class="bundle-compare-code-dep-range">${row.from} → <b>${row.to}</b></span>`
          : html`<span class="bundle-compare-code-dep-range">${row.range}</span>`
        const content = html`<span class="bundle-compare-code-dep-name">${row.name}</span>${row.kind ? html`<span class="npm-dependency-kind">${row.kind}</span>` : nothing}${range}${this.dependencyTags?.(row, kind) ?? nothing}`
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
      <code>${source.length <= 240 && typeof markup === 'string' ? appMarkup(controlMarkup(markup, true)) : sourceText(`${at > 0 ? '…' : ''}${source.slice(at, at + 240)}${source.length > at + 240 ? '…' : ''}`, true)}</code>
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
    // A search hit picked in this file: its line, shown, to scroll to, once
    // for each model it is drawn from.
    const sought = this._sought?.path === path && this._sought.key !== modelKeyed ? this._soughtLine(path, this._entries.get(path), pretty, model) : null
    if (this._sought?.path === path) this._sought.key = modelKeyed
    if (sought && sought.line < model.b.length) {
      if (sought.line >= (this._limits.get(key) ?? ROW_LIMIT)) this._limits.set(key, Math.ceil((sought.line + 1) / ROW_LIMIT) * ROW_LIMIT)
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
      ${model.b.length > lines.length ? html`<div class="bundle-compare-code-more">
        <button type="button" class="bundle-compare-code-action" @click=${() => { this._limits.set(key, limit + ROW_LIMIT); this.requestUpdate() }}>Show ${Math.min(ROW_LIMIT, model.b.length - lines.length).toLocaleString()} more lines</button>
        <span>${(model.b.length - lines.length).toLocaleString()} not shown</span>
      </div>` : nothing}`
  }

  // What the diff hides, in one frame, Hide: each a named switch (mode-switch,
  // as the treemap's Sunburst), there where it has use: renamed
  // names where hiding them hides any (`renamed`, see _fileState), which gives
  // the old side the new side's names wherever a minifier renamed a variable
  // alike throughout, an old one no new one stands for named apart (r_old),
  // rather than marking the lines that differ in them alone; whitespace where
  // hiding it, as diff -b, hides a change (`whitespace`); changes in types
  // alone where the server proved any (`types`).
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
    this.requestUpdate()
  }

  _setTypes(value) {
    prefs.ignoreTypes = value
    this.requestUpdate()
  }

  _setRenames(value) {
    prefs.ignoreRenames = value
    if (value) retryRenameDiffs()
    this.requestUpdate()
  }


  _renderDiff(path, entry, { after, before, key, model, pretty, changes, hiding, warned = [], whitespace = null }) {
    const { kind, basePath = path } = entry
    const split = prefs.layout === 'split'
    // A search hit picked in this file: its row, opened and shown, to scroll
    // to, once for each model it is drawn from.
    const sought = this._sought?.path === path && this._sought.key !== key ? this._soughtLine(path, entry, pretty, model) : null
    if (this._sought?.path === path) this._sought.key = key
    const seek = sought ? this._seekRows(key, model, sought, split) : null
    if (seek?.index >= 0) this._soughtRow = { path, index: seek.index + (split ? 1 : 0) }
    const expansion = this._expansions.get(key) ?? new Map()
    const rows = seek?.rows ?? diffRows(model, expansion, { split })
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
    return html`${prefs.ignoreRenames && changes?.reason ? html`<p class="bundle-compare-code-note">Renamed names are shown: ${RENAME_REASONS[changes.reason] ?? changes.reason}.</p>` : nothing}
      ${WHITESPACE_KEPT[whitespace] ? html`<p class="bundle-compare-code-note">${WHITESPACE_KEPT[whitespace]}</p>` : nothing}
      ${warned.length > 0 ? html`<p class="bundle-compare-code-note">${readsSaid(warned)} <button type="button" @click=${() => this._setRenames(false)}>Show them marked</button></p>` : nothing}
      <div class=${classMap({ 'bundle-compare-diff-table': true, split, unified: !split })} data-path=${path}
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
    const lines = lit.model[side], markup = lit[side]?.[line], text = lines[line]
    const noEol = this._noEol(lit.model, side, line)
    let drawn = drawnCode.get(lines)
    if (!drawn) drawnCode.set(lines, drawn = new Map())
    let code = drawn.get(line)
    if (!code || code.markup !== markup || code.ranges !== ranges || code.noEol !== noEol) {
      drawn.set(line, code = { markup, ranges, noEol, drawn: this._code(text, markup, ranges, !noEol) })
    }
    return html`<span class=${classMap({ 'diff-code': true, 'diff-long': text.length > LONG_LINE })}>${code.drawn}${noEol ? html`<span class="diff-no-eol" data-tooltip="No newline at end of file" aria-label="No newline at end of file">⊘</span>` : nothing}</span>`
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
