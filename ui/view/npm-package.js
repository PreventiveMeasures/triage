// The managed npm viewer: a published version opens in the bundle view as a
// bundle of its tarball's files; `/npm` alone is a lookup page. The server
// decides which packages a reader may open (server-managed/npm-packages.ts);
// its answers are kept in memory only for the versions shown and compared,
// and only for the session and role they answered.
import { LitElement, html, nothing } from 'lit'
import { appMarkup } from './markup.js'
import { isManagedUiMode, state } from '#client/index.js'
import { isNpmPackageName, isNpmPackageSpec } from '../../common/managed/npm-packages.js'
import { NPM_TABS, compareModeField, compareModeOf } from '../../common/managed/routes.js'
import { fetchNpmPackage, fetchNpmTags, fetchNpmVersions } from './client-managed.js'
import { selectBundle } from './bundle-load.js'
import { fileRowDetails } from '../../common/bundle-sources.js'
import { cleanupGraph2 } from './graph/state.js'
import { COMMIT_ICON_SVG, GITHUB_ICON_SVG, NPM_ICON_SVG, TAG_ICON_SVG } from './icons.js'
import { managedTabLocation } from './managed-bundle-navigation.js'
import { prefs } from './bundle-compare-prefs.js'
import { setPrettySource } from './pretty-source.js'
import { managedHistory } from './managed-history.js'
import { render } from './render.js'
import { bundleOriginLinks, githubTagHref } from './bundle-origin-links.js'
import { fileIconFormat, sourceFileIcon } from './source-file-icon.js'
import { overviewColumn } from './bundle-overview-column.js'
import { npmSized } from './npm-size-class.js'
import { npmInstallScripts } from '../../risk/npm/install-scripts.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, npmTooNew } from '../../risk/npm/release.js'
import { DAY_MS } from '../../risk/npm/downloads.js'
import { fullDate } from './npm-downloads-chart.js'
import { npmEntryFile, npmEntryPath, npmLicenseParts } from './npm-entries.js'
import { npmDependencyFlagTags } from './npm-dependency-checks.js'
import { npmDependencies, npmDependencyChanges } from '../../risk/npm/dependencies.js'
import { npmAlias } from '../../risk/npm/specs.js'
import { npmRisk } from './npm-risk.js'
import { sessionKept as keptForSession } from './activity-reads.js'

import './bundle-selector.js'
import { currentViewSignal } from './view-navigation.js'

const NPM_PACKAGE_URL = /^https?:\/\/(?:www\.)?npmjs\.(?:com|org)\/package\/((?:@[^/]+\/)?[^/?#]+)(?:\/v\/([^/?#]+))?\/?(?:[?#].*)?$/u

// A package as typed: `name`, `name@version` or `name@tag`, scoped or not,
// or its npmjs.com page. Null when it names none.
export function parseNpmPackageInput(text) {
  const value = String(text ?? '').trim()
  const url = NPM_PACKAGE_URL.exec(value)
  let name, spec = null
  if (url) {
    try { [name, spec] = [decodeURIComponent(url[1]), url[2] ? decodeURIComponent(url[2]) : null] } catch { return null }
  } else {
    const at = value.indexOf('@', 1)
    ;[name, spec] = at === -1 ? [value, null] : [value.slice(0, at), value.slice(at + 1)]
  }
  if (!isNpmPackageName(name) || (spec !== null && !isNpmPackageSpec(spec))) return null
  return { name, spec }
}

// A package as typed, `spec` its version or dist-tag where it names one.
export const npmPackageInput = (name, spec = null) => spec == null ? name : `${name}@${spec}`

// The file a package's Code tab opens on: what `main` names, resolved as
// require would for the usual spellings, else `module`, else `index.js`.
export function npmPackageEntries(manifest, paths) {
  const files = new Set(paths)
  return [...new Set([manifest?.main, manifest?.module, 'index.js'].filter(field => typeof field === 'string').map(field => npmEntryFile(field, files)).filter(Boolean))]
}

// The bundle view's entry for a package version (no managed id, so no
// bundle route reads it); `npm` names the version and when it was published.
export function npmPackageEntry(data) {
  return {
    integrity: data.integrity, kind: 'sourcemap', name: `${data.name}@${data.version}`, size: data.tarballSize,
    npm: { name: data.name, version: data.version, private: data.private === true, published: typeof data.published === 'string' ? data.published : null,
      manifest: data.manifest ?? {} },
  }
}

// Its parsed details (bundle-sources.js fileRowDetails), Code opening on
// what `main` names.
export function npmPackageDetails(entry, data) {
  const details = fileRowDetails(entry, data.files)
  return {
    ...details, npm: entry.npm,
    npmEntries: npmPackageEntries(entry.npm.manifest, details.json.sources),
    // What the server's risk tells of it, once it arrives (file-risk.js).
    risk: () => npmRisk(entry.npm),
  }
}

// The route of the version an entry names, on `tab`, at `location`.
export function npmPackageRoute(entry, tab = 'overview', location = null) {
  if (!entry?.npm) return null
  return { view: 'npm', packageName: entry.npm.name, packageSpec: entry.npm.version, bundleTab: NPM_TABS.has(tab) ? tab : 'overview', ...location }
}

// Public versions read, for the session and role that read them, so swapping
// or returning to one opens it at once. A private version is asked for each
// time, so the server checks again access the reader may have lost since.
const KEPT_VERSIONS = 3
const keptVersions = new Map()
// What else is read about a package (version list, figures, advisories), by kind and name.
const packageData = new Map()
// What failed is asked again after a pause doubling with each failure in a
// row, on a render scheduled for then, not on every render.
const DATA_RETRY_MS = 10_000
const DATA_RETRY_MAX_MS = 5 * 60_000
const sessionKept = keptForSession(keptVersions, packageData)

function keep(entry, details) {
  const kept = sessionKept()
  kept.delete(entry.name)
  kept.set(entry.name, { entry, details })
  while (kept.size > KEPT_VERSIONS) kept.delete(kept.keys().next().value)
}

// A version, as read before in this session, else from the server: `spec` an
// exact version or a dist-tag, which only the server resolves.
export async function loadNpmVersion(name, spec, options) {
  const kept = sessionKept().get(`${name}@${spec}`)
  if (kept) {
    keep(kept.entry, kept.details)
    return kept
  }
  const data = await fetchNpmPackage(name, spec, options)
  const entry = npmPackageEntry(data)
  const details = npmPackageDetails(entry, data)
  if (!entry.npm.private) keep(entry, details)
  keepKnown(data)
  return { entry, details }
}

// A version's files as a pnpm patch changes them (`patch` as a review's route
// names it, `{ hash, repoId, commit, path }`, all but its hash optional), as
// Review reads them: details of their own (`npmPatch` the patch as the server
// read it), none of the version's own risk, which is of the version as npm has it.
export async function loadPatchedNpmVersion(entry, patch, options) {
  const data = await fetchNpmPackage(entry.npm.name, entry.npm.version, { ...options, patch })
  return { ...fileRowDetails({ integrity: `${entry.integrity} patch:${patch.hash}`, size: entry.size }, data.files),
    npmPatch: { name: entry.npm.name, version: entry.npm.version, integrity: entry.integrity, patch: { ...patch, ...data.patch } } }
}

// What the server sent with a version about its package (npm-insights.ts
// npmKnown), kept as if asked for, where the session has none ready yet.
function keepKnown({ name, version, known }) {
  if (!known || typeof known !== 'object') return
  const keys = { stats: name, advisories: name, tags: `${name}@${version}`, socket: `${name}@${version}`, provenance: `${name}@${version}` }
  for (const [kind, of] of Object.entries(keys)) {
    const key = `${kind}\0${of}`
    if (known[kind] && packageData.get(key)?.status !== 'ready') packageData.set(key, { status: 'known', data: known[kind] })
  }
}

// Something read about a package for this session, as `ask` answers and
// `shape` keeps it: `{ status }`, 'loading', then 'ready' with what `shape`
// gives, or 'error' until a retry; each a new object, so the view repaints.
// One aborted is not kept, and asked again when next wanted.
export function npmPackageData(kind, name, ask, shape) {
  sessionKept()
  const key = `${kind}\0${name}`
  const known = packageData.get(key)
  if (known?.status === 'known') {
    const ready = { status: 'ready', ...shape(known.data) }
    packageData.set(key, ready)
    return ready
  }
  if (known && !(known.status === 'error' && Date.now() >= known.retryAt)) return known
  const loading = { status: 'loading', failures: known?.failures ?? 0 }
  packageData.set(key, loading)
  ask().then(
    data => ({ status: 'ready', ...shape(data) }),
    err => {
      if (err?.name === 'AbortError') return null
      const failures = loading.failures + 1
      const wait = Math.min(DATA_RETRY_MS * 2 ** (failures - 1), DATA_RETRY_MAX_MS)
      return { status: 'error', failures, wait, retryAt: Date.now() + wait }
    },
  ).then(answer => {
    if (packageData.get(key) !== loading) return null
    if (answer === null) {
      packageData.delete(key)
      return null
    }
    packageData.set(key, answer)
    // A page left open repaints when the retry is due, asking again if it still shows the package.
    if (answer.status === 'error') setTimeout(() => { if (packageData.get(key) === answer) render() }, answer.wait).unref?.()
    repaint()
    return null
  }).catch(() => {})
  return loading
}

// One repaint for answers arriving together.
let repaintQueued = false
function repaint() {
  if (repaintQueued) return
  repaintQueued = true
  queueMicrotask(() => { repaintQueued = false; render() })
}

// A package's versions, newest first, dist-tags, publish `times`, when its
// first was (`created`), whether only the server's token reaches it
// (`private`), and whether a team lists its scope (`teamScoped`). `signal`
// gives up the request where this is the first to ask.
export function npmVersionList(name, signal = undefined) {
  return npmPackageData('versions', name, () => fetchNpmVersions(name, { signal }),
    data => ({ versions: data.versions ?? [], distTags: data.distTags ?? {}, times: data.times ?? {}, created: typeof data.created === 'string' ? data.created : null,
      private: data.private === true, teamScoped: data.teamScoped === true }))
}

// A package's versions to pick from, newest first, `version` among them
// however the list stands: `{ id, detail, date, age? }`, its dist-tags its
// detail, and how long ago where too recently to trust yet.
function versionChoices(list, version, now = Date.now()) {
  const tags = Map.groupBy(Object.entries(list.distTags ?? {}), ([, tagged]) => tagged)
  const versions = list.versions?.includes(version) ? list.versions : [version, ...list.versions ?? []]
  return versions.map(id => {
    const time = list.times?.[id]
    return { id, detail: tags.get(id)?.map(([tag]) => tag).join(', ') ?? '', ...time && { date: time.slice(0, 10) },
      ...time && npmRecentRelease(list, time, now) && { age: npmAge(time, now) } }
  })
}

// Too new to trust yet (risk/npm/release.js npmTooNew): under two weeks old;
// a team-scoped package's trusted however new, none flagged till the list says.
export function npmRecentRelease(list, time, now = Date.now()) {
  return list.status === 'ready' && npmTooNew(time, { minimumReleaseAge: list.teamScoped ? 0 : DEFAULT_MINIMUM_RELEASE_AGE, now })
}

const ago = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

// When a version was published, and how long ago: days, months past two, years past two.
export function npmPublished(time, now = Date.now()) {
  const days = Math.floor((now - Date.parse(time)) / DAY_MS)
  const age = days < 60 ? ago.format(-days, 'day') : days < 730 ? ago.format(-Math.floor(days / 30.44), 'month') : ago.format(-Math.floor(days / 365.25), 'year')
  return `${fullDate(Date.parse(time))} · ${age}`
}

const since = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
// How long ago a recent version was published: `3 days ago`.
export function npmAge(time, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(time)) / 60_000))
  return minutes < 60 ? since.format(-minutes, 'minute') : minutes < 24 * 60 ? since.format(-Math.floor(minutes / 60), 'hour') : since.format(-Math.floor(minutes / (24 * 60)), 'day')
}
export const npmPublishedDay = time => fullDate(Date.parse(time))
export const npmPublishedOn = time => `Published on ${npmPublishedDay(time)}`

// What Compare offers a package version (bundle-compare.js `source`): its
// package's other versions to compare with, and every version for its own side.
export function npmCompareSource(entry) {
  const { name, version } = entry.npm
  const list = npmVersionList(name)
  const choices = versionChoices(list, version).map(({ id, detail, date, age }) => ({ id, name: `${name}@${id}`, displayLabel: id, format: 'npm', detail,
    ...date && { date }, ...age && { dateWarning: age } }))
  return {
    noun: 'version',
    base: version,
    // As long a version as most are, tagged as the latest often is.
    widest: { name: `${name}@10.90.90`, detail: 'latest' },
    pending: list.status === 'loading',
    error: list.status === 'error' ? `Couldn't list the versions of ${name}.` : null,
    options: choices.filter(choice => choice.id !== version),
    choices,
    name: id => id === entry.integrity || id === version ? entry.name : `${name}@${id}`,
    load: async id => (await loadNpmVersion(name, id)).details,
    // In place of Packages, which a single package has no use for.
    dependencies: npmFlaggedDependencyChanges,
    openDependency,
    // A swap or a pick on this side opens `base`, compared with `target`.
    open: (base, target, mode) => navigateToNpm(name, base, 'compare', target ? { compareSpec: target, ...compareModeField(mode) } : {}),
  }
}

// Opens a version on `bundleTab`, with the route's other `fields`; the lookup where none is named.
export function navigateToNpm(packageName = null, packageSpec = null, bundleTab = 'overview', fields = {}) {
  if (!isManagedUiMode() || !managedHistory?.active) return
  void managedHistory.navigate(packageName == null ? { view: 'npm' }
    : { view: 'npm', packageName, packageSpec, bundleTab, ...fields })
}

// The lookup page, or a version opening (render-bundle.js renderNpmOpening).
function showNpmPage(lookup, opening = null) {
  state.currentView = 'npm'
  state.npmLookup = lookup
  state.npmOpening = opening
  state.currentManagedTeam = null
  state.currentManagedReport = null
  document.body.classList.remove('report-fullscreen')
  render({ animate: false })
}

// A version as npm's registry names it (`4.18.1`, `1.0.0-rc.1`), not a
// dist-tag; none has build metadata, which npm's publish strips.
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u
// The tabs whose first render reads the version's own risk.
const RISK_TABS = new Set(['overview', 'compare'])

// Open a `/npm` route: the lookup page, or a package version in place of the
// bundle shown, its header showing while it opens. Answers the route the
// page ends on, the version exact, or false; one that fails to open leaves
// the lookup page saying why.
export async function openNpmRoute(route, isCurrent, renderSidebar) {
  const { packageName: name, packageSpec: spec = null, bundleTab: tab = 'overview' } = route
  if (name == null) {
    showNpmPage({ input: state.npmLookup?.input ?? '', error: null })
    renderSidebar()
    return { view: 'npm' }
  }
  const input = npmPackageInput(name, spec)
  const shown = state.currentView === 'bundles' && state.bundleDetails?.npm
  // Another tab of the version shown, as Back gives, keeps it.
  let entry = shown && state.bundles?.[0]?.npm?.name === name && state.bundles[0].npm.version === spec ? state.bundles[0] : null
  let details = entry ? state.bundleDetails : null
  if (!entry) {
    // Another version keeps the one shown until it opens.
    const kept = spec != null && sessionKept().has(`${name}@${spec}`)
    if (!shown && !kept) {
      showNpmPage({ input, error: null }, { name, spec, tab })
      renderSidebar()
    }
    // What its first render asks for, asked beside the version rather than
    // after: its package's versions, and its risk where the route names it
    // exactly on a tab that reads it, kept for that render (npmPackageData).
    // Given up where the route is left first, as the server reads only a
    // few at once; apart from the view's signal, which opening renews.
    const early = new AbortController()
    npmVersionList(name, early.signal)
    if (spec != null && EXACT_VERSION.test(spec) && RISK_TABS.has(tab)) npmRisk({ name, version: spec }, null, early.signal)
    try { ({ entry, details } = await loadNpmVersion(name, spec ?? 'latest', { signal: currentViewSignal() })) }
    catch (err) {
      early.abort()
      if (err?.name === 'AbortError' || !isCurrent()) return false
      searching = null
      showNpmPage({ input, error: err.message })
      return { view: 'npm' }
    }
    if (!isCurrent() || !isManagedUiMode()) {
      early.abort()
      return false
    }
  }
  if (searching?.name === name && searching.spec === spec) {
    saveRecentSearches([input, ...npmRecentSearches().filter(other => other !== input)])
    searching = null
  }
  cleanupGraph2()
  // What the version's Compare compared with stays while another of its tabs is open.
  const compared = state.bundleCompare?.bundle === entry.integrity ? state.bundleCompare : null
  if (tab === 'review') {
    state.npmReview = { bundle: entry.integrity,
      ...(route.reviewPackage ? { reviewPackage: route.reviewPackage, reviewSpec: route.reviewSpec ?? null } : {}), ...(route.patch ? { patch: route.patch } : {}),
      ...(route.basePatch ? { basePatch: route.basePatch } : {}) }
    // Its diff drawn as its URL names it, what it doesn't name off
    // (common/managed/routes.js), as Review's own links carry its view.
    prefs.ignoreWhitespace = route.hideWhitespace === true
    prefs.ignoreTypes = route.hideTypes === true
    setPrettySource(route.pretty ?? false)
  }
  state.bundles = [entry]
  selectBundle(entry.integrity, tab)
  if (tab === 'code' && route.file != null) {
    state.bundleCodeFileRequest = { bundle: entry.integrity, file: route.file,
      ...(route.line == null ? {} : { line: route.line }), ...(route.endLine == null ? {} : { endLine: route.endLine }) }
  }
  if (tab === 'compare' && route.compareSpec != null) {
    state.bundleCompare = { bundle: entry.integrity, target: route.compareSpec, mode: compareModeOf(route.compareMode) }
  } else if (compared) state.bundleCompare = compared
  state.bundleDetails = details
  state.npmLookup = { input: entry.name, error: null }
  state.npmOpening = null
  state.currentManagedTeam = null
  state.currentManagedReport = null
  state.reports = []
  document.body.classList.remove('report-fullscreen')
  render({ animate: false })
  renderSidebar()
  document.querySelector('#main-content')?.scrollTo({ top: 0 })
  return npmPackageRoute(entry, state.bundleDetailsTab, managedTabLocation(state))
}

// The lookup's recent searches, newest first, kept in this browser per user: a convenience, nothing to guard.
const RECENT_SEARCHES = 10
const recentKey = () => `deepview.npm.recent.${state.managedSession?.id ?? 'anonymous'}`
// The search last made, until the version it names opens (openNpmRoute).
let searching = null

export function npmRecentSearches() {
  try {
    const list = JSON.parse(localStorage.getItem(recentKey()) ?? '[]')
    return Array.isArray(list) ? list.filter(search => typeof search === 'string' && parseNpmPackageInput(search)) : []
  } catch { return [] }
}

function saveRecentSearches(list) {
  try { localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, RECENT_SEARCHES))) } catch {}
}

export function forgetNpmSearch(search) {
  saveRecentSearches(npmRecentSearches().filter(other => other !== search))
  render()
}

// Opens what `text` names, kept among the recent searches once it opens.
export function searchNpm(text) {
  const parsed = parseNpmPackageInput(text)
  if (!parsed) {
    state.npmLookup = { input: text ?? '', error: 'Enter a package name, like lodash, @scope/name or name@1.2.3.' }
    render()
    return
  }
  searching = parsed
  navigateToNpm(parsed.name, parsed.spec)
}

function submitLookup(event) {
  event.preventDefault()
  searchNpm(event.currentTarget.querySelector('input[name="package"]')?.value)
}

// The lookup page: a package to open, why the last didn't, and recent searches.
export function renderNpmLookup() {
  const lookup = state.npmLookup ?? { input: '', error: null }
  const privileged = ['admin', 'manage'].includes(state.managedSession?.role)
  const recent = npmRecentSearches()
  return html`<section class="npm-lookup" aria-labelledby="npm-lookup-title">
    <header class="npm-lookup-head">
      <span class="npm-lookup-icon" aria-hidden="true">${appMarkup(NPM_ICON_SVG)}</span>
      <h1 id="npm-lookup-title">npm packages</h1>
    </header>
    <p class="npm-lookup-intro">Open a published version to read its files, as its tarball has them.
      ${privileged ? nothing : 'You can open public packages, and private ones in npm scopes your teams list.'}</p>
    <form class="npm-lookup-form" @submit=${submitLookup}>
      <input name="package" type="text" aria-label="Package" autocomplete="off" spellcheck="false" maxlength="500"
        placeholder="lodash, @scope/name@1.2.3 or an npmjs.com link" .value=${lookup.input ?? ''}>
      <button type="submit">Open</button>
    </form>
    <div class="npm-lookup-message">
      ${lookup.error ? html`<p class="npm-lookup-error" role="alert">${lookup.error}</p>` : nothing}
    </div>
    ${recent.length > 0 ? html`<section class="npm-lookup-recent" aria-labelledby="npm-lookup-recent-title">
      <h2 id="npm-lookup-recent-title">Recent searches</h2>
      <ul>${recent.map(search => html`<li>
        <button type="button" class="npm-lookup-recent-open" @click=${() => searchNpm(search)}>${search}</button>
        <button type="button" class="npm-lookup-recent-remove" aria-label=${`Remove ${search} from recent searches`}
          @click=${() => forgetNpmSearch(search)}>×</button>
      </li>`)}</ul>
    </section>` : nothing}
  </section>`
}

// What two versions' dependencies differ in, Compare's in place of Packages:
// those the open one adds or changes flagged as risk tells them (none till
// it arrives), each added one carrying the two versions (`compared`), for
// when its package was first published beside them (npm-overview.js npmDependencyTags).
function npmFlaggedDependencyChanges(base, other) {
  const changes = npmDependencyChanges(base?.npm?.manifest, other?.npm?.manifest)
  const told = base?.npm && other?.npm ? npmRisk(other.npm, base.npm.version)?.dependencies : null
  const compared = [base?.npm, other?.npm]
  const flagged = (rows, of) => rows.map(row => ({ flags: [], ...of?.find(({ key }) => key === row.key), ...row }))
  return { removed: changes.removed, added: flagged(changes.added, told?.added).map(row => ({ ...row, compared })), changed: flagged(changes.changed, told?.changed) }
}

// Each dependency of a version flagged as its risk tells it (`held`, else
// `added`): its flags by its key, none until it arrives.
const dependencyFlags = npm => {
  const told = npmRisk(npm)?.dependencies
  return new Map((told?.held ?? told?.added ?? []).map(({ key, flags }) => [key, flags]))
}
const keyOf = ({ kind, name }) => `${kind ?? ''}\0${name}`

// The version a range names: `1.2.3`, or the lowest it takes (`^1.2.3`), an alias's too.
const RANGE_VERSION = /^(?:[\^~]|=)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/u
export const npmRangeVersion = range => RANGE_VERSION.exec(npmAlias(range)?.spec ?? range.trim())?.[1] ?? null
const aliasOf = range => npmAlias(range)?.name ?? null

// A dependency Compare lists opens its package; a changed one whose ranges
// each name a version of the same package opens its Compare between those.
function openDependency({ opens, from, to }) {
  if (!opens) return
  const after = to && npmRangeVersion(to), before = from && npmRangeVersion(from)
  if (!before || !after || before === after || aliasOf(from) !== aliasOf(to)) navigateToNpm(opens)
  else navigateToNpm(opens, after, 'compare', { compareSpec: before })
}

// The Overview's Dependencies column in place of Packages, each opening at
// its latest, flagged as risk tells it.
export function npmDependenciesColumn(entry) {
  const rows = npmDependencies(entry.npm.manifest)
  if (rows.length === 0) return nothing
  const told = dependencyFlags(entry.npm)
  return overviewColumn({ title: 'Dependencies', count: rows.length, list: true, body: html`<ul class="bundles-sources-list npm-dependency-list">${rows.map(row => {
      const { name, range, kind, opens } = row
      const flags = told.get(keyOf(row)) ?? []
      const content = html`<span class="npm-dependency-name"><span class="bundles-source-path" data-tooltip-truncated data-tooltip=${name}>${name}</span>${npmDependencyFlagTags(flags)}</span>
        ${kind ? html`<span class="npm-dependency-kind">${kind}</span>` : nothing}
        <span class="bundles-source-size" data-tooltip-truncated data-tooltip=${range}>${range}</span>`
      return html`<li>${opens
        ? html`<button type="button" class="bundles-source-row npm-dependency-row" data-npm-dependency=${opens} @click=${() => navigateToNpm(opens)}>${content}</button>`
        : html`<div class="bundles-source-row npm-dependency-row is-resource">${content}</div>`}</li>`
    })}</ul>` })
}

// The checks a version's dependencies are flagged by, as the Overview counts them.
const DEPENDENCY_CHECKS = [['source', 'Non-registry', () => 'From elsewhere than npm\'s registry'], ['unimported', 'Unimported', version => `Imported by nothing of ${version}`]]

// Beside a version's dependency count, a chip per check any is flagged by, which in its tooltip.
export function npmDependencyChecks(npm) {
  const told = dependencyFlags(npm)
  const flagged = Map.groupBy(npmDependencies(npm.manifest).flatMap(row => (told.get(keyOf(row)) ?? []).map(({ check }) => ({ ...row, check }))), ({ check }) => check)
  return DEPENDENCY_CHECKS.filter(([check]) => flagged.has(check)).map(([check, label, note]) => html`<span class="npm-extension is-warn npm-dependency-check"
    data-tooltip=${`${note(npm.version)}: ${flagged.get(check).map(({ name, range }) => `${name} ${range}`).join(', ')}`}>
    <span>${label}</span><span class="npm-extension-count">${flagged.get(check).length}</span></span>`)
}

// The tags pointing to a version's publish commit, each linking to its
// release on GitHub; nothing until they arrive (npm-insights.ts npmCommitTags).
function npmCommitTags(entry, github) {
  const { name, version } = entry.npm
  const data = npmPackageData('tags', `${name}@${version}`, () => fetchNpmTags(name, version),
    answer => ({ tags: Array.isArray(answer.tags) ? answer.tags.filter(tag => typeof tag === 'string' && tag) : [] }))
  if (data.status !== 'ready' || data.tags.length === 0) return nothing
  return html`<span class="bundle-origin-tags">${data.tags.map(tag => html`<a class="bundle-origin-link bundle-tag-link"
    href=${githubTagHref(github, tag)} target="_blank" rel="noopener noreferrer">${appMarkup(TAG_ICON_SVG)}<span>${tag}</span></a>`)}</span>`
}

// A file of the package as a fact names it: a button opening it in the
// source viewer where the package has it, its path in its tooltip where its label is another.
export function factFile(path, files, label = path) {
  const tooltip = label === path || label === `./${path}` ? nothing : `./${path}`
  return files?.has(path) ? html`<button type="button" class="bundle-entry-point" data-bundle-view-source=${path} data-tooltip=${tooltip}>${label}</button>` : label
}

// An npm account linking its profile: green where known to publish one of
// npm's most downloaded packages, else yellow, an unknown publisher.
function npmAccount(manifest, account, label) {
  const known = manifest.knownAccounts?.includes(account)
  return html`<a class=${`bundle-origin-link npm-account ${known ? 'is-known' : 'is-unknown'}`} href=${`https://www.npmjs.com/~${encodeURIComponent(account)}`}
    data-tooltip=${known ? 'Publishes one of npm\'s most downloaded packages' : 'Unknown publisher'}
    target="_blank" rel="noopener noreferrer"><span>${label}</span></a>`
}

// npm's placeholder deprecation message, past its first sentence only a link to support, left off.
const NPM_DEFAULT_DEPRECATION = /^\s*(Package no longer supported\.)\s+Contact Support at https:\/\/www\.npmjs\.com\/support for more info\.\s*$/u
export const npmDeprecation = message => message.replace(NPM_DEFAULT_DEPRECATION, '$1')

// The Overview's facts for a package version; `files` its file paths, once read.
export function npmOverviewMeta(entry, { prefix = '', githubFigures = nothing, provenance = nothing, provenanceNamesBuilder = false, files = null } = {}) {
  const { manifest } = entry.npm
  const github = manifest.github?.github
  // Its repository, at the commit npm recorded, in the directory it names.
  const origin = github ? bundleOriginLinks({ repo: { github, directory: manifest.github.directory ?? '', commit: manifest.gitHead } })[0] : null
  // When it was published: as it came with the version, else once the list arrives.
  const list = npmVersionList(entry.npm.name)
  const published = entry.npm.published ?? list.times?.[entry.npm.version]
  // Its name and version are the header's (render-bundle.js).
  return html`<dl class="bundles-detail-meta npm-facts">
    ${entry.npm.private ? html`<dt>Access</dt><dd>Private</dd>` : nothing}
    ${manifest.deprecated ? html`<dt>Deprecated</dt><dd class="npm-deprecated">${npmDeprecation(manifest.deprecated)}</dd>` : nothing}
    ${manifest.description ? html`<dt>Description</dt><dd>${manifest.description}</dd>` : nothing}
    ${manifest.license ? html`<dt>License</dt><dd>${npmLicenseParts(manifest.license, [...files ?? []]).map(({ text, file }) => factFile(file, files, text))}</dd>` : nothing}
    ${manifest.author ? html`<dt>Author</dt><dd class="bundle-origin-row">${manifest.authorAccount
      ? html`${npmAccount(manifest, manifest.authorAccount, manifest.author)}${manifest.author === manifest.authorAccount ? nothing : html`<span class="npm-publisher">~${manifest.authorAccount}</span>`}`
      : manifest.author}</dd>` : nothing}
    ${manifest.publisher && manifest.publisher !== manifest.authorAccount
      ? html`<dt>Publisher</dt><dd class="bundle-origin-row">${npmAccount(manifest, manifest.publisher, `~${manifest.publisher}`)}</dd>`
      // A CI npm trusts, which its provenance names where that's read.
      : manifest.trustedPublisher && !provenanceNamesBuilder ? html`<dt>Publisher</dt><dd class="npm-trusted-publisher">${manifest.trustedPublisher}</dd>` : nothing}
    ${published ? html`<dt>Published</dt><dd>${npmRecentRelease(list, published)
      ? html`<span class="npm-recent">${npmPublished(published)}</span>` : npmPublished(published)}</dd>` : nothing}
    ${origin ? html`<dt>GitHub</dt><dd class="bundle-origin-row">
      <a class="bundle-origin-link" href=${origin.href} target="_blank" rel="noopener noreferrer">${appMarkup(GITHUB_ICON_SVG)}<span>${origin.text}</span></a>
      ${githubFigures}
    </dd>
    <dt>Commit</dt><dd class="bundle-origin-row">${origin.commit
      ? html`<a class="bundle-origin-link bundle-commit-link" href=${origin.commit.href} data-tooltip=${origin.commit.hash} data-tooltip-icon="commit" target="_blank" rel="noopener noreferrer">${appMarkup(COMMIT_ICON_SVG)}<span>${origin.commit.text}</span></a>
        ${npmCommitTags(entry, github)}`
      : html`<span class="npm-commit-missing">Not recorded at publish</span>`}</dd>` : nothing}
    ${provenance === nothing ? nothing : html`<dt>Provenance</dt><dd class="bundle-origin-row">${provenance}</dd>`}
    ${manifest.homepage && /^https?:\/\//iu.test(manifest.homepage) ? html`<dt>Homepage</dt><dd><a class="bundle-origin-link" href=${manifest.homepage} target="_blank" rel="noopener noreferrer"><span>${manifest.homepage}</span></a></dd>` : nothing}
    <dt>Integrity</dt><dd class="mono bundle-integrity" data-tooltip-truncated data-tooltip=${entry.integrity}>${entry.integrity}</dd>
    ${prefix ? html`<dt>Prefix</dt><dd class="mono">${prefix}</dd>` : nothing}
  </dl>`
}

// An install script's command, each word naming a file of the package opening it.
const scriptCommand = (command, files) => command.split(/(\s+)/u).map(word => {
  const path = word.replace(/^\.\//u, '')
  return files?.has(path) ? factFile(path, files, word) : word
})

// The package's entry points (Main and Module one row where they name the
// same file), its module type, bins, engines, install scripts and its
// dependency count with chips for what calls for a look at them.
export function npmOverviewExtras(entry, files = null, details = null) {
  const { manifest } = entry.npm
  const entries = ['main', 'module', 'types'].filter(field => typeof manifest[field] === 'string')
    .map(field => ({ label: `${field[0].toUpperCase()}${field.slice(1)}`, path: manifest[field], file: npmEntryFile(manifest[field], files) ?? npmEntryPath(manifest[field]) }))
  const main = entries.find(row => row.label === 'Main'), module = entries.find(row => row.label === 'Module')
  if (main && module && main.file === module.file) {
    main.label = 'Main, Module'
    entries.splice(entries.indexOf(module), 1)
  }
  const bins = Object.keys(manifest.bin ?? {})
  const scripts = npmInstallScripts(manifest, files)
  const dependencies = npmDependencies(manifest).length
  return html`
    ${entries.map(({ label, path, file }) => html`<dt>${label}</dt><dd class="mono"><span class="npm-entry-point">${sourceFileIcon(file, fileIconFormat(details, file))}${factFile(file, files, path)}</span></dd>`)}
    ${manifest.type ? html`<dt>Type</dt><dd class="mono">${manifest.type}</dd>` : nothing}
    ${bins.length > 0 ? html`<dt>Bin</dt><dd class="mono">${bins.join(', ')}</dd>` : nothing}
    ${manifest.engines ? html`<dt>Engines</dt><dd class="mono">${Object.entries(manifest.engines).map(([engine, range]) => `${engine} ${range}`).join(', ')}</dd>` : nothing}
    ${scripts.length > 0 || manifest.hasInstallScript ? html`<dt>Install scripts</dt><dd class="npm-install-scripts">${scripts.length === 0 ? 'Yes'
      : scripts.map(([script, command]) => html`<div class="npm-install-script"><span class="npm-install-script-name">${script}</span><code>${scriptCommand(command, files)}</code></div>`)}</dd>` : nothing}
    <dt>Dependencies</dt><dd class="npm-dependencies-fact">${npmSized('dependencies', dependencies, dependencies === 0 ? 'None' : dependencies)}${npmDependencyChecks(entry.npm)}</dd>`
}

// The version shown in the header, with the package's others to switch to as
// Compare's pickers offer them, keeping the tab; just the version, disabled,
// until they arrive.
class NpmVersionSelect extends LitElement {
  static properties = { name: {}, version: {}, tab: {}, list: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.name = ''
    this.version = ''
    this.tab = 'overview'
    this.list = null
  }

  render() {
    const list = this.list?.status === 'ready' ? this.list : { versions: [], distTags: {} }
    const options = versionChoices(list, this.version).map(({ id, detail, date, age }) => ({ value: id, label: id, detail, secondary: date,
      ...age && { secondaryWarning: age } }))
    return html`<bundle-selector .options=${options} .value=${this.version} noun="version" versions
      label=${`Version of ${this.name}`} placeholder=${this.version} ?disabled=${options.length <= 1}
      aria-busy=${this.list?.status === 'loading' ? 'true' : nothing}
      @bundle-change=${event => { if (event.detail.value !== this.version) navigateToNpm(this.name, event.detail.value, this.tab) }}></bundle-selector>`
  }
}
if (!customElements.get('npm-version-select')) customElements.define('npm-version-select', NpmVersionSelect)
