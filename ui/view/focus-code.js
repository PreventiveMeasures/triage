// Lazy source loader for finding panels and previews. Managed views fetch only
// report-selected files into session memory; local/e2e views retain their
// existing bundle loader. Neither changes the active bundle view.
import { bundleFilePath, bundlesForFileHash, isManagedUiMode, readBundleIndex, state } from '#client/index.js'
import { fetchReportSources, readReportSources } from './client-managed.js'
import { activeTabFor } from './group.js'
import { buildBundleDetails } from './bundle-load.js'
import { parseBundleMetadata } from './bundle-metadata.js'
import { bundleFilesAsMap, bundlePackageDirs, bundlePackageRepos, bundleSourcesAsMap } from './bundle-sources.js'
import { bundleSourceImports, sourceLinkResolver } from '../../common/bundle-source-links.js'
import { controlMarkup } from './control-chars.js'
import { historyFor } from './focus-code-history.js'
import { readKept, trimKept } from './kept-entries.js'
import { lineRange } from './format.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { render } from './render.js'
import { report } from './dom.js'
import { revealCitedLines } from './reveal-cited.js'

// integrity → { sources, packageFiles, packageDirs, imports, formats, loading, error }:
// the bundles read last, KEPT_BUNDLE_SOURCES of them, each holding all its
// files, those still loading and those shown kept too, however many; one let
// go is read again once asked.
const KEPT_BUNDLE_SOURCES = 4
const sourcesCache = new Map()
// The bundles the last pass of reads read (a render's: those its previews and
// panel show), and those the pass under way reads.
let shownSources = new Set()
let showingSources = null
function readSources(integrity) {
  if (!showingSources) {
    showingSources = new Set()
    queueMicrotask(() => {
      shownSources = showingSources
      showingSources = null
    })
  }
  showingSources.add(integrity)
  return readKept(sourcesCache, integrity)
}
// Past KEPT_BUNDLE_SOURCES, the least recently read let go, its files' colors
// with it; none shown, which a repaint would read again at once.
function trimSources() {
  const held = (entry, integrity) => entry.loading || shownSources.has(integrity) || showingSources?.has(integrity)
  trimKept(sourcesCache, KEPT_BUNDLE_SOURCES, held, integrity => {
    sourcesCache.delete(integrity)
    for (const key of [...highlightCache.keys()]) if (key.startsWith(`${integrity}\0`)) highlightCache.delete(key)
  })
}

// integrity\0file → highlighted HTML string, or null when prism
// can't highlight this language (caller renders plain text).
// Async populated; the first `getFocusCode` call kicks the work,
// subsequent calls pick up the cached result.
const highlightCache = new Map()
const highlightPending = new Set()
// Weak ownership gives highlighted managed bodies their response's lifetime.
const managedHighlights = new WeakMap()
const managedLoads = new Set()

function kickHighlight(integrity, file, content, format, resolveString, cache = highlightCache, pending = highlightPending) {
  const key = `${integrity}\0${file}`
  if (cache.has(key) || pending.has(key)) return
  const lang = langForPath(file, format, content)
  if (!lang) {
    cache.set(key, null)
    return
  }
  pending.add(key)
  ;(async () => {
    const html = await prismHighlight(content, lang, resolveString)
    pending.delete(key)
    // Not of a bundle let go meanwhile, which would hold it for none.
    if (cache === highlightCache && !sourcesCache.has(integrity)) return
    cache.set(key, typeof html === 'string' ? controlMarkup(html) : null)
    state.focusCodeTick++
    queueMicrotask(render)
  })()
}

async function loadSources(integrity) {
  // Already loaded or in-flight — nothing to do. Intentionally don't
  // cache the "state.bundles hasn't listed this integrity" miss below:
  // that list populates asynchronously on first sidebar render and may
  // lag a focus-view click, so the next render's call should retry.
  const existing = sourcesCache.get(integrity)
  if (existing && (existing.loading || existing.sources)) return
  const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
  if (!entry) return
  sourcesCache.set(integrity, { sources: null, loading: true, error: null })
  try {
    const details = await buildBundleDetails(integrity, entry)
    rememberPackageRepos(integrity, details)
    const sources = bundleSourcesAsMap(details)
    sourcesCache.set(integrity, { sources, packageFiles: bundleFilesAsMap(details), packageDirs: bundlePackageDirs(details), imports: bundleSourceImports(details, sources), formats: details.kind === 'stasis' ? details.bundle?.formats : null, loading: false, error: details.error ?? null })
  } catch (err) {
    sourcesCache.set(integrity, { sources: null, loading: false, error: err.message })
  }
  trimSources()
  // Defer to a fresh microtask so render runs outside the await-
  // resolution stack. Run mid-chain, the parent template's Lit diff
  // occasionally commits before the focus-pane-code branch sees the
  // new cache, leaving the panel on "Loading…" until the next manual
  // render (navigation, filter change). The state tick also re-flows
  // observer-util consumers on the page.
  state.focusCodeTick++
  queueMicrotask(render)
  // Scroll the cited lines into view after the render above commits
  // them. setFocusGid tries this right after its own render(), but on
  // a cache miss the panel isn't painted yet and the elements don't
  // exist. A second microtask (FIFO after the render above) retries
  // once the content has landed.
  queueMicrotask(revealFocusCodeLines)
}

// Bring the cited lines into view in the focus panel's code body.
// `.focus-code-body` is the box that scrolls; the rule for where the
// block lands in it is shared with the card's previews (see
// reveal-cited.js).
export function revealFocusCodeLines() {
  const rows = report.querySelectorAll('.focus-code-line-active')
  if (rows.length === 0) return
  revealCitedLines(rows[0].closest('.focus-code-body'), rows)
}

// The repository and commit each package of a local bundle records
// (bundlePackageRepos), for the evidence rows in it: integrity →
// `{ dirs, repos }` (every package's directory, longest first, so a path's
// own package is the first that holds it), null for a bundle recording
// none, or a pending read. Kept for the session: a handful of strings per
// package, read off the bundle's index (bundle-metadata.js), or off the
// bundle itself when the panel loads it anyway.
const packageRepoCache = new Map()

function rememberPackageRepos(integrity, details) {
  const repos = bundlePackageRepos(details)
  packageRepoCache.set(integrity, repos.size === 0 ? null
    : { dirs: [...details.bundle.modules.keys()].filter((dir) => dir !== '.').toSorted((a, b) => b.length - a.length), repos })
}

// Only the index: a bundle without a current one is not opened for this,
// and the panel's own load (loadSources) answers for it when it runs.
function loadPackageRepos(integrity) {
  const known = packageRepoCache.get(integrity)
  if (known instanceof Promise) return known
  if (known !== undefined) return Promise.resolve()
  const job = (async () => {
    let details = null
    try {
      const data = await readBundleIndex(integrity)
      details = data ? parseBundleMetadata(data, integrity) : null
    } catch { details = null }
    // The panel's load may have answered while this read.
    if (packageRepoCache.get(integrity) !== job) return
    if (details && !details.stale) rememberPackageRepos(integrity, details)
    else packageRepoCache.set(integrity, null)
    state.focusCodeTick++
    queueMicrotask(render)
  })()
  packageRepoCache.set(integrity, job)
  return job
}

// Where a finding's bundle places one of its evidence rows in a
// dependency: `{ file, repo }`, the row's path in its package and the
// repository and commit that package records, for format.js evidenceUrl
// (`shipped`). Null where the bundle has no such row, records no
// repository and commit for its package, or has not been read yet.
//
// Reads what is ALREADY loaded. Locally it then reads the bundle's index,
// once, a small file, and renders again; a managed view does not ask the
// server for a report's sources for this — those come with the panel and
// previews, and the issue dialog asks first (loadBundleDependencyRepos).
export function bundleDependencyRepo(f, row) {
  const bundle = attachedBundle(f)
  if (!bundle || typeof row?.file !== 'string' || row.file === '') return null
  if (bundle.reportId) {
    const data = readReportSources(bundle.reportId)?.data
    const path = data ? data.paths.get(row.file) ?? (data.sources.has(row.file) ? row.file : null) : null
    const dir = path === null ? null : data.packageDirs.get(path)
    const repo = dir ? data.packageRepos?.get(dir) : null
    return repo ? { file: path.slice(dir.length + 1), repo } : null
  }
  if (isManagedUiMode()) return null
  const known = packageRepoCache.get(bundle.integrity)
  if (known === undefined) void loadPackageRepos(bundle.integrity)
  if (!known || known instanceof Promise) return null
  const path = bundleFilePath(bundle.integrity, row.file)
  const dir = typeof path === 'string' ? known.dirs.find((d) => path.startsWith(`${d}/`)) : null
  const repo = dir ? known.repos.get(dir) : null
  return repo ? { file: path.slice(dir.length + 1), repo } : null
}

// Settles once what the finding's bundle records for its dependencies is
// in hand, or there is none to read: what the issue dialog waits on
// before it drafts the evidence.
export async function loadBundleDependencyRepos(f) {
  const bundle = attachedBundle(f)
  if (!bundle) return
  if (bundle.reportId) await fetchReportSources(bundle.reportId).catch(() => null)
  else if (!isManagedUiMode()) await loadPackageRepos(bundle.integrity)
}

// The bundle attached to a finding, as `{ integrity, file, reportId? }`, or null.
// Managed source paths are resolved by the report endpoint without a hash index.
// "Attached" means the analyzer ran against a bundle (`_bundleHashes`,
// stamped at ingest) that carries a source with this finding's
// `fileHash` — so the match is by CONTENT, not by path, and the `file`
// it comes back with is that bundle's own key for it.
//
// The one definition of the question "do we have this finding's code",
// asked by the focus view's inline panel, the card's `Code` shortcut,
// and the source previews beside its links.
export function attachedBundle(f) {
  if (isManagedUiMode()) {
    if (!f?._managedReportId || !Array.isArray(f._bundleHashes) || f._bundleHashes.length === 0) return null
    void state.focusCodeTick
    const entry = readReportSources(f._managedReportId)
    if (entry?.data === null || entry?.error) return null
    const bundle = { integrity: entry?.data?.integrity ?? null, reportId: f._managedReportId }
    const locations = [f, ...(Array.isArray(f.evidence) ? f.evidence : [])]
    for (const location of locations) {
      const file = findingSourcePath(bundle, location?.file)
      if (file) return { ...bundle, file, line: location.line }
    }
    return null
  }
  const allowed = f?._bundleHashes
  if (!f?.fileHash || !Array.isArray(allowed) || allowed.length === 0) return null
  // `includes` over a Set: a finding names the one or two bundles the
  // analyzer saw, and this runs twice per card on every render of a
  // list that can be thousands long — building a Set to ask about two
  // strings costs more than the scan it saves.
  return bundlesForFileHash(f.fileHash).find(({ integrity }) => allowed.includes(integrity)) ?? null
}

export function findingSourcePath(bundle, path) {
  if (typeof path !== 'string' || !path) return null
  if (!bundle.reportId) return bundleFilePath(bundle.integrity, path)
  const entry = readReportSources(bundle.reportId)
  if (!entry || entry.data === undefined && !entry.error) return path
  const data = entry.data
  return data?.paths.get(path) ?? (data?.sources.has(path) ? path : null)
}

function managedSource(reportId, file, kick) {
  if (!isManagedUiMode()) return null
  const entry = readReportSources(reportId)
  if (!entry || entry.data === undefined && !entry.error) {
    if (kick && !managedLoads.has(reportId)) {
      managedLoads.add(reportId)
      fetchReportSources(reportId).catch(() => {}).finally(() => {
        managedLoads.delete(reportId)
        state.focusCodeTick++
        queueMicrotask(render)
        queueMicrotask(revealFocusCodeLines)
      })
    }
    return kick ? { loading: true } : null
  }
  const data = entry.data
  if (!data) return null
  file = data.paths.get(file) ?? file
  const content = data.sources.get(file)
  if (typeof content !== 'string') return null
  let highlights = managedHighlights.get(data)
  if (!highlights) { highlights = { cache: new Map(), pending: new Set() }; managedHighlights.set(data, highlights) }
  kickHighlight(data.integrity, file, content, data.formats?.get(file), sourceLinkResolver(data.sources, file, data.imports, data.sources, data.packageDirs), highlights.cache, highlights.pending)
  return { content, highlighted: highlights.cache.get(`${data.integrity}\0${file}`) ?? null, loading: false }
}

// One file out of a bundle. Returns:
//   { content, highlighted, loading: false } — ready to render.
//      `highlighted` is the prism HTML, `null` for a language the
//      bundle carries no grammar for, `undefined` until it settles.
//   { loading: true } — first load in flight; the load triggers
//      render() on settle, so a caller renders a placeholder and
//      picks the content up on the next pass.
//   null — the bundle isn't one we can load, or has no such file.
//
// Reading triggers loadSources / kickHighlight as side-effects, which
// is safe inside render(): both deduplicate, and their follow-up
// render() is a microtask so it doesn't recurse this frame.
//
// `kick: false` asks what we ALREADY have, and answers null rather
// than starting a load. For a caller that renders one file per mark on
// a card and would otherwise pull a bundle off disk for every one of
// them before the reader has asked for any — see render-finding.js,
// where the hover tooltip peeks and the pointer does the kicking.
export function bundleSource(integrity, file, { kick = true, reportId = null } = {}) {
  if (reportId) return managedSource(reportId, file, kick)
  if (isManagedUiMode()) return null
  const cached = readSources(integrity)
  if (!cached) {
    if (!kick) return null
    // First sight of this integrity — kick the load and report
    // pending. The cache flips to loading:true synchronously inside
    // loadSources so a sibling call on the same pass doesn't double-fire.
    void loadSources(integrity)
    return { loading: true }
  }
  if (cached.loading && !kick) return null
  if (cached.loading) return { loading: true }
  if (!cached.sources) return null
  const content = cached.sources.get(file)
  if (typeof content !== 'string') return null
  // Kick Prism highlight if we haven't yet — render() runs again when
  // the highlighted HTML lands and the second pass picks it up.
  kickHighlight(integrity, file, content, cached.formats?.get(file), sourceLinkResolver(cached.sources, file, cached.imports, cached.packageFiles, cached.packageDirs))
  const key = `${integrity}\0${file}`
  return {
    content,
    highlighted: highlightCache.has(key) ? highlightCache.get(key) : undefined,
    loading: false,
  }
}

// The finding's own file, with its lines marked — where the panel
// starts, and what focusCodePosition measures the history against.
//
// A RANGE, not a line: a report citing `20-30` means the span, and
// marking only line 20 hides what it was pointing at (format.js
// lineRange).
function basePosition(f) {
  const match = attachedBundle(f)
  // Managed loading placeholders may fetch/preview sources, but cannot seed
  // navigation until the endpoint resolves the actual bundle and file paths.
  if (!match?.integrity) return null
  return { integrity: match.integrity, file: match.file, range: lineRange(match.reportId ? match.line : f.line) }
}

// Where the panel starts for a finding: the active tab's own file.
function focusCodeBase(focusedGroup) {
  if (!focusedGroup) return null
  return basePosition(activeTabFor(focusedGroup))
}

// The panel's history for the finding on screen, as state — the rules
// themselves are in focus-code-history.js, which knows nothing about
// state or the DOM and is where they are tested.
//
// Read-only, deliberately: this runs inside render(), where writing
// state would either be lost to observer-util's tracking or loop
// through it. Anything that MOVES the panel writes the state instead
// (events.js pushFocusCode / stepFocusCode).
export function focusCodeHistory(focusedGroup) {
  const base = focusCodeBase(focusedGroup)
  if (!base) return null
  return { base, ...historyFor(state.focusCodeStack, state.focusCodeAt, base) }
}

// Where the panel is right now, for a finding — the same answer
// `getFocusCode` draws, without the source behind it.
//
// For the evidence list, which marks the row the panel is on. It takes
// the active FINDING rather than the group because that is what the
// card has in hand, and the active tab is what the base is computed
// from either way.
export function focusCodePosition(f) {
  const base = basePosition(f)
  if (!base) return null
  return historyFor(state.focusCodeStack, state.focusCodeAt, base).pos
}

// A link belongs to the panel's current bundle/file, never the separately
// selected bundle view. Managed targets must be in this report's source set.
export function focusCodeLinkPosition(group, integrity, parent, file) {
  const history = focusCodeHistory(group)
  if (!history || history.pos.integrity !== integrity || history.pos.file !== parent) return null
  const finding = activeTabFor(group)
  const source = bundleSource(integrity, file, { kick: false, reportId: finding?._managedReportId })
  return source && !source.loading ? { integrity, file, range: null } : null
}

// The focus view's inline code panel: whatever file the history says
// it is on, whole, with that position's lines marked. Same three
// answers as bundleSource above, plus the file / integrity / range the
// panel's header and gutter need.
export function getFocusCode(focusedGroup) {
  const finding = focusedGroup && activeTabFor(focusedGroup)
  const bundle = attachedBundle(finding)
  if (bundle?.reportId && !bundle.integrity) return managedSource(bundle.reportId, bundle.file, true)
  const history = focusCodeHistory(focusedGroup)
  if (!history) return null
  const { pos } = history
  const source = bundleSource(pos.integrity, pos.file, { reportId: finding?._managedReportId })
  if (!source || source.loading) return source
  return { ...source, file: pos.file, integrity: pos.integrity, range: pos.range }
}
