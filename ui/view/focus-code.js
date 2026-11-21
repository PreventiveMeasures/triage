// Lazy source loader for finding panels and previews. Managed views fetch only
// report-selected files into session memory; local/e2e views retain their
// existing bundle loader. Neither changes the active bundle view.
import { bundleFilePath, bundlesForFileHash, isManagedUiMode, readBundleIndex, state } from '#client/index.js'
import { fetchReportSources, readReportSources } from './client-managed.js'
import { activeTabFor } from './group.js'
import { buildBundleDetails } from './bundle-load.js'
import { parseBundleMetadata } from '../../common/bundle-metadata.js'
import { bundleFilesAsMap, bundlePackageDirs, bundlePackageRepos, bundleSourcesAsMap } from '../../common/bundle-sources.js'
import { bundleSourceImports, sourceLinkResolver } from '../../common/bundle-source-links.js'
import { controlMarkup } from './control-chars.js'
import { historyFor } from './focus-code-history.js'
import { lineRange } from './format.js'
import { langForPath, highlight as prismHighlight } from './prism-highlight.js'
import { render } from './render.js'
import { report } from './dom.js'
import { revealCitedLines } from './reveal-cited.js'

// integrity → { sources, packageFiles, packageDirs, imports, formats, loading, error }
const sourcesCache = new Map()

// integrity\0file → prism's HTML, or null for a language it can't
// highlight; filled asynchronously, as first asked for.
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
    cache.set(key, typeof html === 'string' ? controlMarkup(html) : null)
    pending.delete(key)
    state.focusCodeTick++
    queueMicrotask(render)
  })()
}

async function loadSources(integrity) {
  // A bundle `state.bundles` doesn't list yet isn't remembered: the list
  // fills on the sidebar's first render, perhaps after a focus-view click.
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
  // Rendered on a fresh microtask, outside the await chain, whose Lit diff
  // could commit before the panel sees the cache and stay on "Loading…";
  // the tick tells observer-util's readers. The cited lines revealed on the
  // next, once painted (setFocusGid's own try found no panel yet).
  state.focusCodeTick++
  queueMicrotask(render)
  queueMicrotask(revealFocusCodeLines)
}

// The cited lines brought into view in the focus panel's scrolling
// `.focus-code-body`, as the card's previews are (reveal-cited.js).
export function revealFocusCodeLines() {
  const rows = report.querySelectorAll('.focus-code-line-active')
  if (rows.length === 0) return
  revealCitedLines(rows[0].closest('.focus-code-body'), rows)
}

// The repository and commit each package of a local bundle records
// (bundlePackageRepos), for its evidence rows: integrity → `{ dirs, repos }`
// (directories longest first, so a path's own package holds it first), null
// for none, or a pending read; off the bundle's index, or the bundle itself
// when the panel loads it anyway.
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

// Where a finding's bundle places an evidence row in a dependency, for
// format.js evidenceUrl (`shipped`): `{ file, repo }`, its path in its
// package and the repository and commit that records; else null. From what
// is loaded: locally the bundle's small index is then read once; managed,
// the report's sources come with the panel, or the issue dialog's ask
// (loadBundleDependencyRepos).
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

// The bundle attached to a finding, `{ integrity, file, reportId? }`, else
// null: the one answer to "do we have its code", for the focus panel, the
// card's Code button and its previews. A bundle the analyzer ran against
// (`_bundleHashes`) holding its `fileHash`, matched by content, `file` that
// bundle's key; managed, the report endpoint's paths, with no hash index.
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
  // `includes`, not a Set: one or two bundles, asked twice per card per
  // render of a list of thousands.
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

// One file out of a bundle: `{ content, highlighted, loading: false }`
// (`highlighted` prism's HTML, null for no grammar, undefined till it
// settles); `{ loading: true }` while it first loads, render() following;
// null for a bundle that can't load or holds no such file. Safe in
// render(): the loads deduplicate and render a microtask later. `kick:
// false` answers from what is loaded alone, null rather than a load, as the
// card's hover peeks (render-finding.js).
export function bundleSource(integrity, file, { kick = true, reportId = null } = {}) {
  if (reportId) return managedSource(reportId, file, kick)
  if (isManagedUiMode()) return null
  const cached = sourcesCache.get(integrity)
  if (!cached) {
    if (!kick) return null
    // loadSources marks it loading at once, so a sibling call doesn't load it twice.
    void loadSources(integrity)
    return { loading: true }
  }
  if (cached.loading && !kick) return null
  if (cached.loading) return { loading: true }
  if (!cached.sources) return null
  const content = cached.sources.get(file)
  if (typeof content !== 'string') return null
  kickHighlight(integrity, file, content, cached.formats?.get(file), sourceLinkResolver(cached.sources, file, cached.imports, cached.packageFiles, cached.packageDirs))
  const key = `${integrity}\0${file}`
  return {
    content,
    highlighted: highlightCache.has(key) ? highlightCache.get(key) : undefined,
    loading: false,
  }
}

// The finding's own file, its cited range marked (format.js lineRange):
// where the panel starts. None for a managed placeholder until the
// endpoint resolves the bundle and its paths.
function basePosition(f) {
  const match = attachedBundle(f)
  if (!match?.integrity) return null
  return { integrity: match.integrity, file: match.file, range: lineRange(match.reportId ? match.line : f.line) }
}

// The panel's history for the finding on screen (focus-code-history.js),
// from its active tab's file. Read-only, as it runs in render(); what moves
// the panel writes the state (events.js pushFocusCode / stepFocusCode).
export function focusCodeHistory(focusedGroup) {
  const base = focusedGroup ? basePosition(activeTabFor(focusedGroup)) : null
  if (!base) return null
  return { base, ...historyFor(state.focusCodeStack, state.focusCodeAt, base) }
}

// Where the panel is now for a finding, without the source, for the
// evidence list to mark the row it shows.
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

// The focus panel's file, where its history is, whole: bundleSource's
// answers, with the file, integrity and range its header and gutter need.
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
