// The managed npm viewer. A published package version opens in the bundle
// view, as a bundle whose files are its tarball's, with the Overview, Code,
// Compare and Treemap tabs; `/npm` alone is a lookup page for one. The server decides
// which packages a reader may open (server-managed/npm-packages.ts). What it
// answered is kept in memory only for the versions shown and compared, and
// for no longer than the session and role it answered.
import { LitElement, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { isManagedUiMode, state } from '#client/index.js'
import { isNpmPackageName, isNpmPackageSpec } from '../../common/managed/npm-packages.js'
import { NPM_TABS, compareModeField, compareModeOf } from '../../common/managed/routes.js'
import { fetchNpmPackage, fetchNpmTags, fetchNpmVersions } from './client-managed.js'
import { selectBundle } from './bundle-load.js'
import { cleanupGraph2 } from './graph/state.js'
import { COMMIT_ICON_SVG, GITHUB_ICON_SVG, NPM_ICON_SVG, TAG_ICON_SVG } from './icons.js'
import { managedTabLocation } from './managed-bundle-navigation.js'
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
import { npmAlias, npmDependencies, npmDependencyChanges, npmDependencyFlagTags } from './npm-dependency-checks.js'
import { npmRisk } from './npm-risk.js'

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

// The file a package's Code tab opens on: what `main` names, resolved as
// require would for the usual spellings, else `module`, else `index.js`.
export function npmPackageEntries(manifest, paths) {
  const files = new Set(paths)
  const entries = []
  for (const field of [manifest?.main, manifest?.module, 'index.js']) {
    if (typeof field !== 'string') continue
    const found = npmEntryFile(field, files)
    if (found && !entries.includes(found)) entries.push(found)
  }
  return entries
}


// The bundle view's entry for a package version. It has no managed id, so
// nothing reads it through the bundle routes; `npm` names the version, and
// when it was published where the server had that (else null).
export function npmPackageEntry(data) {
  return {
    integrity: data.integrity, kind: 'sourcemap', name: `${data.name}@${data.version}`, size: data.tarballSize,
    npm: { name: data.name, version: data.version, private: data.private === true, published: typeof data.published === 'string' ? data.published : null,
      manifest: data.manifest ?? {} },
  }
}

// Its parsed details, in the shape of a sourcemap carrying its sources: one
// source per file, text inline, and every file's size from its bytes, so a
// file that is not text still lists with its size. Those carry a digest of
// their bytes instead (`npmBinaries`), which Compare compares them by.
export function npmPackageDetails(entry, data) {
  const files = Array.isArray(data.files) ? data.files : []
  const sources = files.map(([path]) => path)
  return {
    integrity: entry.integrity, kind: 'sourcemap', size: entry.size, npm: entry.npm,
    json: { version: 3, sources, sourcesContent: files.map(([, , text]) => typeof text === 'string' ? text : null) },
    fileSizes: new Map(files.map(([path, size]) => [path, size])),
    npmBinaries: new Map(files.filter(([, , text, digest]) => typeof text !== 'string' && typeof digest === 'string')
      .map(([path, size, , digest]) => [path, { size, digest }])),
    npmEntries: npmPackageEntries(entry.npm.manifest, sources),
    // What the server's risk tells of it, once it arrives (file-risk.js).
    risk: () => npmRisk(entry.npm),
  }
}

// The route of the version an entry names, on `tab`, at `location`.
export function npmPackageRoute(entry, tab = 'overview', location = null) {
  if (!entry?.npm) return null
  return { view: 'npm', packageName: entry.npm.name, packageSpec: entry.npm.version, bundleTab: NPM_TABS.has(tab) ? tab : 'overview', ...location }
}

// Versions read and version lists, for the session and role that read them:
// the public version shown and those compared with it, so swapping the two,
// or returning to one, opens it at once. A private version is asked for each
// time it opens, so the server checks again access the reader may have lost
// since, as to a team's npm scopes.
const KEPT_VERSIONS = 3
const keptVersions = new Map()
// What else is read about a package (its version list, figures, advisories),
// by kind and name.
const packageData = new Map()
// What failed is asked for again after a pause, twice as long after each
// failure in a row, on a render scheduled for then: not on every render,
// which each answer brings.
const DATA_RETRY_MS = 10_000
const DATA_RETRY_MAX_MS = 5 * 60_000
let keptFor = null

function sessionKept() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    keptVersions.clear()
    packageData.clear()
    keptFor = session
  }
  return keptVersions
}

function keep(entry, details) {
  const kept = sessionKept()
  kept.delete(entry.name)
  kept.set(entry.name, { entry, details })
  while (kept.size > KEPT_VERSIONS) kept.delete(kept.keys().next().value)
}

// A version, as read before in this session or else from the server: `spec`
// an exact version or a dist-tag, which only the server resolves.
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

// What the server sent with a version about its package (npm-insights.ts
// npmKnown), each part as its own request answers it, kept as if asked for:
// where the session has none of it yet, or only one being asked for, whose
// answer then gives way.
function keepKnown({ name, version, known }) {
  if (!known || typeof known !== 'object') return
  const keys = { stats: name, advisories: name, tags: `${name}@${version}`, socket: `${name}@${version}`, provenance: `${name}@${version}` }
  for (const [kind, of] of Object.entries(keys)) {
    const key = `${kind}\0${of}`
    if (known[kind] && packageData.get(key)?.status !== 'ready') packageData.set(key, { status: 'known', data: known[kind] })
  }
}

// Something read about a package for this session, as `ask` answers and
// `shape` keeps it: `{ status }` while the server is asked ('loading', then
// 'ready' with what `shape` gives, or 'error' until a retry), each a new
// object, so the view repaints when it arrives. What came with a version
// (keepKnown) is ready without asking.
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
    () => {
      const failures = loading.failures + 1
      const wait = Math.min(DATA_RETRY_MS * 2 ** (failures - 1), DATA_RETRY_MAX_MS)
      return { status: 'error', failures, wait, retryAt: Date.now() + wait }
    },
  ).then(answer => {
    if (packageData.get(key) !== loading) return null
    packageData.set(key, answer)
    // A page left open repaints when the retry is due, and asks again if it
    // still shows the package.
    if (answer.status === 'error') setTimeout(() => { if (packageData.get(key) === answer) render() }, answer.wait)
    repaint()
    return null
  }).catch(() => {})
  return loading
}

// One repaint for answers arriving together, as those of one request for
// many packages do.
let repaintQueued = false
function repaint() {
  if (repaintQueued) return
  repaintQueued = true
  queueMicrotask(() => { repaintQueued = false; render() })
}

// A package's versions, newest first, and dist-tags, when each was
// published (`times`) and its first was (`created`, null where the server
// didn't say), whether the registry has it only for the server's token
// (`private`), and whether a team lists its scope (`teamScoped`).
export function npmVersionList(name) {
  return npmPackageData('versions', name, () => fetchNpmVersions(name),
    data => ({ versions: data.versions ?? [], distTags: data.distTags ?? {}, times: data.times ?? {}, created: typeof data.created === 'string' ? data.created : null,
      private: data.private === true, teamScoped: data.teamScoped === true }))
}

function tagsByVersion(distTags = {}) {
  const tags = new Map()
  for (const [tag, version] of Object.entries(distTags)) tags.set(version, [...tags.get(version) ?? [], tag])
  return tags
}

// A package's versions to pick from, newest first, `version` among them
// though the list has not (or not yet) got it: `{ id, detail, date, age? }`,
// its dist-tags as its detail, the day it was published, and how long ago
// where that was too recently to trust yet (npmRecentRelease).
function versionChoices(list, version, now = Date.now()) {
  const tags = tagsByVersion(list.distTags)
  const versions = list.versions?.includes(version) ? list.versions : [version, ...list.versions ?? []]
  return versions.map(id => {
    const time = list.times?.[id]
    return { id, detail: tags.get(id)?.join(', ') ?? '', ...time && { date: time.slice(0, 10) },
      ...time && npmRecentRelease(list, time, now) && { age: npmAge(time, now) } }
  })
}

// Too new to trust yet (risk/npm/release.js npmTooNew), under risk's
// minimum release age, two weeks. Those of a scope a team lists are its own,
// trusted however new (a minimum age of 0); nor is any flagged until the
// version list says whether it is one.
export function npmRecentRelease(list, time, now = Date.now()) {
  return list.status === 'ready' && npmTooNew(time, { minimumReleaseAge: list.teamScoped ? 0 : DEFAULT_MINIMUM_RELEASE_AGE, now })
}

const ago = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

// When a version was published (an ISO date), and how long ago, in days up
// to two months, then months up to two years, then years.
export function npmPublished(time, now = Date.now()) {
  const days = Math.floor((now - Date.parse(time)) / DAY_MS)
  const age = days < 60 ? ago.format(-days, 'day') : days < 730 ? ago.format(-Math.floor(days / 30.44), 'month') : ago.format(-Math.floor(days / 365.25), 'year')
  return `${fullDate(Date.parse(time))} · ${age}`
}

const since = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
// How long ago a recent version was published, in minutes, then hours, then
// days: `3 days ago`.
export function npmAge(time, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(time)) / 60_000))
  return minutes < 60 ? since.format(-minutes, 'minute') : minutes < 24 * 60 ? since.format(-Math.floor(minutes / 60), 'hour') : since.format(-Math.floor(minutes / (24 * 60)), 'day')
}
export const npmPublishedDay = time => fullDate(Date.parse(time))
export const npmPublishedOn = time => `Published on ${npmPublishedDay(time)}`

// What Compare offers a package version (bundle-compare.js `source`): the
// package's other versions, newest first, compared with by their numbers,
// and for its own side, every version, its own among them.
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

// Opens a version on `bundleTab`, with the route's other `fields` (what it
// is compared with); the lookup where no package is named.
export function navigateToNpm(packageName = null, packageSpec = null, bundleTab = 'overview', fields = {}) {
  if (!isManagedUiMode() || !managedHistory?.active) return
  void managedHistory.navigate(packageName == null ? { view: 'npm' }
    : { view: 'npm', packageName, packageSpec, bundleTab, ...fields })
}

function showLookup(lookup) {
  state.currentView = 'npm'
  state.npmLookup = lookup
  state.currentManagedTeam = null
  state.currentManagedReport = null
  document.body.classList.remove('report-fullscreen')
  render({ animate: false })
}

// Open a `/npm` route: the lookup page, or a package version, which replaces
// whatever bundle was shown. Answers the route the page ends on, the version
// exact, or false. A version that fails to open leaves the lookup page saying
// why, at `/npm`.
export async function openNpmRoute(route, isCurrent, renderSidebar) {
  const { packageName: name, packageSpec: spec = null, bundleTab: tab = 'overview' } = route
  if (name == null) {
    showLookup({ input: state.npmLookup?.input ?? '', pending: false, error: null })
    renderSidebar()
    return { view: 'npm' }
  }
  const input = `${name}${spec == null ? '' : `@${spec}`}`
  const shown = state.currentView === 'bundles' && state.bundleDetails?.npm
  // Another tab of the version shown, as Back gives, keeps it.
  let entry = shown && state.bundles?.[0]?.npm?.name === name && state.bundles[0].npm.version === spec ? state.bundles[0] : null
  let details = entry ? state.bundleDetails : null
  if (!entry) {
    // Another version keeps the one shown until it opens.
    const kept = spec != null && sessionKept().has(`${name}@${spec}`)
    if (!shown && !kept) {
      showLookup({ input, pending: true, error: null })
      renderSidebar()
    }
    try { ({ entry, details } = await loadNpmVersion(name, spec ?? 'latest', { signal: currentViewSignal() })) }
    catch (err) {
      if (err?.name === 'AbortError' || !isCurrent()) return false
      searching = null
      showLookup({ input, pending: false, error: err.message })
      return { view: 'npm' }
    }
    if (!isCurrent() || !isManagedUiMode()) return false
  }
  if (searching?.name === name && searching.spec === spec) {
    saveRecentSearches([input, ...npmRecentSearches().filter(other => other !== input)])
    searching = null
  }
  cleanupGraph2()
  // What the version's Compare compared with stays while another of its tabs
  // is open, as Back gives, for Compare to open with again.
  const compared = state.bundleCompare?.bundle === entry.integrity ? state.bundleCompare : null
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
  state.npmLookup = { input: entry.name, pending: false, error: null }
  state.currentManagedTeam = null
  state.currentManagedReport = null
  state.reports = []
  document.body.classList.remove('report-fullscreen')
  render({ animate: false })
  renderSidebar()
  document.querySelector('#main-content')?.scrollTo({ top: 0 })
  return npmPackageRoute(entry, state.bundleDetailsTab, managedTabLocation(state))
}

// The lookup's recent searches, newest first: kept in this browser for each
// user signed in to it, a convenience rather than anything to guard.
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
    state.npmLookup = { input: text ?? '', pending: false, error: 'Enter a package name, like lodash, @scope/name or name@1.2.3.' }
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

// The lookup page: a package to open, why the last one did not, and the
// recent searches to open again or remove.
export function renderNpmLookup() {
  const lookup = state.npmLookup ?? { input: '', pending: false, error: null }
  const privileged = ['admin', 'manage'].includes(state.managedSession?.role)
  const recent = npmRecentSearches()
  return html`<section class="npm-lookup" aria-labelledby="npm-lookup-title">
    <header class="npm-lookup-head">
      <span class="npm-lookup-icon" aria-hidden="true">${unsafeHTML(NPM_ICON_SVG)}</span>
      <h1 id="npm-lookup-title">npm packages</h1>
    </header>
    <p class="npm-lookup-intro">Open a published version to read its files, as its tarball has them.
      ${privileged ? nothing : 'You can open public packages, and private ones in npm scopes your teams list.'}</p>
    <form class="npm-lookup-form" @submit=${submitLookup}>
      <input name="package" type="text" aria-label="Package" autocomplete="off" spellcheck="false" maxlength="500"
        placeholder="lodash, @scope/name@1.2.3 or an npmjs.com link" .value=${lookup.input ?? ''} ?disabled=${lookup.pending}>
      <button type="submit" ?disabled=${lookup.pending}>Open</button>
    </form>
    <div class="npm-lookup-message">
      <p class="npm-lookup-status" role="status">${lookup.pending ? `Opening ${lookup.input}…` : nothing}</p>
      ${lookup.error ? html`<p class="npm-lookup-error" role="alert">${lookup.error}</p>` : nothing}
    </div>
    ${recent.length > 0 ? html`<section class="npm-lookup-recent" aria-labelledby="npm-lookup-recent-title">
      <h2 id="npm-lookup-recent-title">Recent searches</h2>
      <ul>${recent.map(search => html`<li>
        <button type="button" class="npm-lookup-recent-open" ?disabled=${lookup.pending} @click=${() => searchNpm(search)}>${search}</button>
        <button type="button" class="npm-lookup-recent-remove" aria-label=${`Remove ${search} from recent searches`}
          @click=${() => forgetNpmSearch(search)}>×</button>
      </li>`)}</ul>
    </section>` : nothing}
  </section>`
}

// What two versions' dependencies differ in (npmDependencyChanges), `base`
// and `other` each one's details, those the open one adds or changes as the
// server's risk tells them (npm-risk.js npmRisk), flagged where they call for
// a look, a new one's package's tier and age with them, none flagged until
// it arrives: Compare's in place of Packages. Each it adds carries the two
// versions (`compared`, their `{ name, version, published }`), for when its
// package was first published beside them (npm-overview.js
// npmDependencyTags).
function npmFlaggedDependencyChanges(base, other) {
  const changes = npmDependencyChanges(base?.npm?.manifest, other?.npm?.manifest)
  const told = base?.npm && other?.npm ? npmRisk(other.npm, base.npm.version)?.dependencies : null
  const compared = [base?.npm, other?.npm]
  const flagged = (rows, of) => rows.map(row => ({ flags: [], ...of?.find(({ key }) => key === row.key), ...row }))
  return { removed: changes.removed, added: flagged(changes.added, told?.added).map(row => ({ ...row, compared })), changed: flagged(changes.changed, told?.changed) }
}

// Each dependency of a version (`npm`) flagged where it calls for a look, as
// the server's risk tells it of the version alone (npm-risk.js npmRisk,
// npm-dependency-checks.js): its flags by its key (npmDependencyChanges),
// none until it arrives.
const dependencyFlags = npm => new Map((npmRisk(npm)?.dependencies.added ?? []).map(({ key, flags }) => [key, flags]))
const keyOf = ({ kind, name }) => `${kind ?? ''}\0${name}`

// The version a range names, where it names one: `1.2.3`, or the lowest it
// takes (`^1.2.3`, `~1.2.3`), an alias's (`npm:pkg@^1.2.3`) too.
const RANGE_VERSION = /^(?:[\^~]|=)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/u
export const npmRangeVersion = range => RANGE_VERSION.exec(npmAlias(range)?.spec ?? range.trim())?.[1] ?? null
const aliasOf = range => npmAlias(range)?.name ?? null

// A dependency Compare lists opens its package, as the Overview's do; a
// changed one whose ranges each name a version of the same package opens
// its Compare between those.
function openDependency({ opens, from, to }) {
  if (!opens) return
  const after = to && npmRangeVersion(to), before = from && npmRangeVersion(from)
  if (!before || !after || before === after || aliasOf(from) !== aliasOf(to)) navigateToNpm(opens)
  else navigateToNpm(opens, after, 'compare', { compareSpec: before })
}

// The Overview's Dependencies column, in place of the Packages one a single
// package has no use for, where it has any (npmOverviewExtras says where it
// has none). Each dependency opens in the viewer, at its latest, flagged
// where it calls for a look, as the server's risk tells it (dependencyFlags).
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

// The checks a version's dependencies are flagged by (npm-dependency-checks.js),
// as the Overview counts them.
const DEPENDENCY_CHECKS = [['source', 'Non-registry', () => 'From elsewhere than npm\'s registry'], ['unimported', 'Unimported', version => `Imported by nothing of ${version}`]]

// Beside how many dependencies a version (`npm`) has, a chip for each check
// any of them is flagged by (dependencyFlags), counting them, which in its
// tooltip.
export function npmDependencyChecks(npm) {
  const told = dependencyFlags(npm)
  const flagged = Map.groupBy(npmDependencies(npm.manifest).flatMap(row => (told.get(keyOf(row)) ?? []).map(({ check }) => ({ ...row, check }))), ({ check }) => check)
  return DEPENDENCY_CHECKS.filter(([check]) => flagged.has(check)).map(([check, label, note]) => html`<span class="npm-extension is-warn npm-dependency-check"
    data-tooltip=${`${note(npm.version)}: ${flagged.get(check).map(({ name, range }) => `${name} ${range}`).join(', ')}`}>
    <span>${label}</span><span class="npm-extension-count">${flagged.get(check).length}</span></span>`)
}

// The tags pointing to a version's publish commit, after it as a bundle's
// follow its commit, each linking to its release on GitHub; nothing until
// they arrive, or where the server has none (npm-insights.ts npmCommitTags).
function npmCommitTags(entry, github) {
  const { name, version } = entry.npm
  const data = npmPackageData('tags', `${name}@${version}`, () => fetchNpmTags(name, version),
    answer => ({ tags: Array.isArray(answer.tags) ? answer.tags.filter(tag => typeof tag === 'string' && tag) : [] }))
  if (data.status !== 'ready' || data.tags.length === 0) return nothing
  return html`<span class="bundle-origin-tags">${data.tags.map(tag => html`<a class="bundle-origin-link bundle-tag-link"
    href=${githubTagHref(github, tag)} target="_blank" rel="noopener noreferrer">${unsafeHTML(TAG_ICON_SVG)}<span>${tag}</span></a>`)}</span>`
}

// A file of the package, as a fact names it: a button opening it in the
// source viewer where the package has it (`files`, by path, none until its
// files are read), its path in its tooltip (`./LICENSE`) where its label is
// another, else its name.
export function factFile(path, files, label = path) {
  const tooltip = label === path || label === `./${path}` ? nothing : `./${path}`
  return files?.has(path) ? html`<button type="button" class="bundle-entry-point" data-bundle-view-source=${path} data-tooltip=${tooltip}>${label}</button>` : label
}


// An npm account, linking its profile: green where it's known to publish
// one of npm's most downloaded packages (npm-packages.ts npmManifest's
// `knownAccounts`), else yellow.
function npmAccount(manifest, account, label) {
  const known = manifest.knownAccounts?.includes(account)
  return html`<a class=${`bundle-origin-link npm-account ${known ? 'is-known' : 'is-unknown'}`} href=${`https://www.npmjs.com/~${encodeURIComponent(account)}`}
    data-tooltip=${known ? 'Publishes one of npm\'s most downloaded packages' : 'Publishes none of npm\'s most downloaded packages'}
    target="_blank" rel="noopener noreferrer"><span>${label}</span></a>`
}

// npm's placeholder deprecation message: past its first sentence it only
// sends readers to npm's support page, so that much is left off. Any other
// message reads as written.
const NPM_DEFAULT_DEPRECATION = /^\s*(Package no longer supported\.)\s+Contact Support at https:\/\/www\.npmjs\.com\/support for more info\.\s*$/u
export const npmDeprecation = message => message.replace(NPM_DEFAULT_DEPRECATION, '$1')

// The Overview's metadata for a package version, beside the file inventory
// the bundle Overview lists: `meta` names it, `extras` describes it. `files`
// are the package's file paths, once read.
export function npmOverviewMeta(entry, { prefix = '', githubFigures = nothing, provenance = nothing, provenanceNamesBuilder = false, files = null } = {}) {
  const { manifest } = entry.npm
  const github = manifest.github?.github
  // Its repository, at the commit it was published from where npm recorded
  // one, and in the directory its repository names, as a bundle's links.
  const origin = github ? bundleOriginLinks({ repo: { github, directory: manifest.github.directory ?? '', commit: manifest.gitHead } })[0] : null
  // When it was published: as it came with the version, else once the
  // package's versions arrive, which say too whether it's recent enough to
  // flag.
  const list = npmVersionList(entry.npm.name)
  const published = entry.npm.published ?? list.times?.[entry.npm.version]
  // Its name and version are the header's (render-bundle.js), the version
  // to switch to there too.
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
      <a class="bundle-origin-link" href=${origin.href} target="_blank" rel="noopener noreferrer">${unsafeHTML(GITHUB_ICON_SVG)}<span>${origin.text}</span></a>
      ${githubFigures}
    </dd>
    <dt>Commit</dt><dd class="bundle-origin-row">${origin.commit
      ? html`<a class="bundle-origin-link bundle-commit-link" href=${origin.commit.href} data-tooltip=${origin.commit.hash} data-tooltip-icon="commit" target="_blank" rel="noopener noreferrer">${unsafeHTML(COMMIT_ICON_SVG)}<span>${origin.commit.text}</span></a>
        ${npmCommitTags(entry, github)}`
      : html`<span class="npm-commit-missing">Not recorded at publish</span>`}</dd>` : nothing}
    ${provenance === nothing ? nothing : html`<dt>Provenance</dt><dd class="bundle-origin-row">${provenance}</dd>`}
    ${manifest.homepage && /^https?:\/\//iu.test(manifest.homepage) ? html`<dt>Homepage</dt><dd><a class="bundle-origin-link" href=${manifest.homepage} target="_blank" rel="noopener noreferrer"><span>${manifest.homepage}</span></a></dd>` : nothing}
    <dt>Integrity</dt><dd class="mono bundle-integrity" data-tooltip-truncated data-tooltip=${entry.integrity}>${entry.integrity}</dd>
    ${prefix ? html`<dt>Prefix</dt><dd class="mono">${prefix}</dd>` : nothing}
  </dl>`
}

// An install script's command, each word naming a file of the package
// opening it.
const scriptCommand = (command, files) => command.split(/(\s+)/u).map(word => {
  const path = word.replace(/^\.\//u, '')
  return files?.has(path) ? factFile(path, files, word) : word
})

// The package's entry points, each with its file's icon, Main and Module in
// one row where they name the same file; its kind of module, bins, engines,
// install scripts, each with its command, and how many dependencies it has,
// sized as its files are, with a chip for what calls for a look at them
// (dependencyChecks), once its files (`details`) are read for imports.
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

// The version shown, in the header, with the package's other versions to
// switch to (npmVersionList), as Compare's pickers offer them: searchable,
// newest first, each with its dist-tags. Switching keeps the tab shown. Until
// they arrive, or without them, as when the registry can't be reached, it
// holds just the version, disabled.
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
