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
import { fetchNpmPackage, fetchNpmVersions } from './client-managed.js'
import { selectBundle } from './bundle-load.js'
import { cleanupGraph2 } from './graph/state.js'
import { COMMIT_ICON_SVG, GITHUB_ICON_SVG, NPM_ICON_SVG } from './icons.js'
import { managedTabLocation } from './managed-bundle-navigation.js'
import { managedHistory } from './managed-history.js'
import { render } from './render.js'
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
    const base = field.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')
    const found = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`].find(path => path && files.has(path))
    if (found && !entries.includes(found)) entries.push(found)
  }
  return entries
}

// The bundle view's entry for a package version. It has no managed id, so
// nothing reads it through the bundle routes; `npm` names the version.
export function npmPackageEntry(data) {
  return {
    integrity: data.integrity, kind: 'sourcemap', name: `${data.name}@${data.version}`, size: data.tarballSize,
    npm: { name: data.name, version: data.version, private: data.private === true, manifest: data.manifest ?? {} },
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
  }
}

const NPM_ROUTE_TABS = new Set(['overview', 'code', 'compare', 'treemap'])

// The route of the version an entry names, on `tab`, at `location`.
export function npmPackageRoute(entry, tab = 'overview', location = null) {
  if (!entry?.npm) return null
  return { view: 'npm', packageName: entry.npm.name, packageSpec: entry.npm.version, bundleTab: NPM_ROUTE_TABS.has(tab) ? tab : 'overview', ...location }
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
  return { entry, details }
}

// Something read about a package for this session, as `ask` answers and
// `shape` keeps it: `{ status }` while the server is asked ('loading', then
// 'ready' with what `shape` gives, or 'error' until a retry), each a new
// object, so the view repaints when it arrives.
export function npmPackageData(kind, name, ask, shape) {
  sessionKept()
  const key = `${kind}\0${name}`
  const known = packageData.get(key)
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
    render()
    return null
  }).catch(() => {})
  return loading
}

// A package's versions, newest first, and dist-tags.
export function npmVersionList(name) {
  return npmPackageData('versions', name, () => fetchNpmVersions(name), data => ({ versions: data.versions ?? [], distTags: data.distTags ?? {} }))
}

function tagsByVersion(distTags = {}) {
  const tags = new Map()
  for (const [tag, version] of Object.entries(distTags)) tags.set(version, [...tags.get(version) ?? [], tag])
  return tags
}

// What Compare offers a package version (bundle-compare.js `source`): the
// package's other versions, newest first, compared with by their numbers,
// and for its own side, every version, its own among them.
export function npmCompareSource(entry) {
  const { name, version } = entry.npm
  const list = npmVersionList(name)
  const tags = tagsByVersion(list.distTags)
  const option = id => ({ id, name: `${name}@${id}`, format: 'npm', detail: tags.get(id)?.join(', ') ?? '' })
  const versions = list.versions?.includes(version) ? list.versions : [version, ...list.versions ?? []]
  return {
    noun: 'version',
    base: version,
    pending: list.status === 'loading',
    error: list.status === 'error' ? `Couldn't list the versions of ${name}.` : null,
    options: versions.filter(other => other !== version).map(option),
    choices: versions.map(option),
    name: id => id === entry.integrity || id === version ? entry.name : `${name}@${id}`,
    load: async id => (await loadNpmVersion(name, id)).details,
    // In place of Packages, which a single package has no use for.
    dependencies: (base, other) => npmDependencyChanges(base?.npm?.manifest, other?.npm?.manifest),
    // A swap or a pick on this side opens `base`, compared with `target`.
    open: (base, target, mode) => {
      if (!isManagedUiMode() || !managedHistory?.active) return
      void managedHistory.navigate({ view: 'npm', packageName: name, packageSpec: base, bundleTab: 'compare',
        ...(target ? { compareSpec: target, ...(mode === 'code' ? { compareMode: 'code' } : {}) } : {}) })
    },
  }
}

export function navigateToNpm(packageName = null, packageSpec = null) {
  if (!isManagedUiMode() || !managedHistory?.active) return
  void managedHistory.navigate(packageName == null ? { view: 'npm' }
    : { view: 'npm', packageName, packageSpec, bundleTab: 'overview' })
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
      showLookup({ input, pending: false, error: err.message })
      return { view: 'npm' }
    }
    if (!isCurrent() || !isManagedUiMode()) return false
  }
  cleanupGraph2()
  state.bundles = [entry]
  selectBundle(entry.integrity, tab)
  if (tab === 'code' && route.file != null) {
    state.bundleCodeFileRequest = { bundle: entry.integrity, file: route.file,
      ...(route.line == null ? {} : { line: route.line }), ...(route.endLine == null ? {} : { endLine: route.endLine }) }
  }
  if (tab === 'compare' && route.compareSpec != null) {
    state.bundleCompare = { bundle: entry.integrity, target: route.compareSpec, mode: route.compareMode === 'code' ? 'code' : 'overview' }
  }
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

function submitLookup(event) {
  event.preventDefault()
  const field = event.currentTarget.querySelector('input[name="package"]')
  const parsed = parseNpmPackageInput(field?.value)
  if (!parsed) {
    state.npmLookup = { input: field?.value ?? '', pending: false, error: 'Enter a package name, like lodash, @scope/name or name@1.2.3.' }
    render()
    return
  }
  navigateToNpm(parsed.name, parsed.spec)
}

// The lookup page: a package to open, and why the last one did not.
export function renderNpmLookup() {
  const lookup = state.npmLookup ?? { input: '', pending: false, error: null }
  const privileged = ['admin', 'manage'].includes(state.managedSession?.role)
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
    ${lookup.pending ? html`<p class="npm-lookup-status" role="status">Opening ${lookup.input}…</p>` : nothing}
    ${lookup.error ? html`<p class="npm-lookup-error" role="alert">${lookup.error}</p>` : nothing}
  </section>`
}

const DEPENDENCY_KINDS = [['dependencies', null], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional']]

// A version's dependencies, each `{ name, range, kind, opens }`, in name
// order: `kind` null for a plain dependency, else 'peer' or 'optional';
// `opens` the package the viewer opens for it, the one an `npm:` alias
// names, or null when it names none.
export function npmDependencies(manifest) {
  const rows = []
  for (const [field, kind] of DEPENDENCY_KINDS) {
    for (const [name, range] of Object.entries(manifest?.[field] ?? {})) {
      const alias = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@|$)/u.exec(range)?.[1]
      const opens = alias ?? name
      rows.push({ name, range, kind, opens: isNpmPackageName(opens) ? opens : null })
    }
  }
  return rows.toSorted((a, b) => a.name.localeCompare(b.name) || (a.kind ?? '').localeCompare(b.kind ?? ''))
}

// What two versions' dependencies differ in, by name and kind: those only
// `base` has, those only `other` has, and those whose range changed.
export function npmDependencyChanges(base, other) {
  const index = manifest => new Map(npmDependencies(manifest).map(row => [`${row.kind ?? ''}\0${row.name}`, row]))
  const after = index(other), before = index(base)
  const added = [], changed = [], removed = []
  for (const [key, { name, kind, range }] of before) {
    const next = after.get(key)
    if (!next) removed.push({ key, name, kind, range })
    else if (next.range !== range) changed.push({ key, name, kind, from: range, to: next.range })
  }
  for (const [key, { name, kind, range }] of after) if (!before.has(key)) added.push({ key, name, kind, range })
  return { removed, added, changed }
}

// The Overview's Dependencies column, in place of the Packages one a single
// package has no use for. Each dependency opens in the viewer, at its latest.
export function npmDependenciesColumn(entry) {
  const rows = npmDependencies(entry.npm.manifest)
  return html`<section class="bundles-overview-col">
    <header class="bundles-overview-col-head">
      <span class="bundles-overview-col-title">Dependencies <span class="bundles-overview-col-count">${rows.length}</span></span>
    </header>
    <div class="bundles-overview-col-body bundles-overview-col-body--list">${rows.length === 0
      ? html`<p class="bundles-overview-col-empty">No dependencies.</p>`
      : html`<ul class="bundles-sources-list">${rows.map(({ name, range, kind, opens }) => {
        const row = html`<span class="bundles-source-path" data-tooltip-truncated data-tooltip=${name}>${name}</span>
          ${kind ? html`<span class="npm-dependency-kind">${kind}</span>` : nothing}
          <span class="bundles-source-size" data-tooltip-truncated data-tooltip=${range}>${range}</span>`
        return html`<li>${opens
          ? html`<button type="button" class="bundles-source-row npm-dependency-row" data-npm-dependency=${opens} @click=${() => navigateToNpm(opens)}>${row}</button>`
          : html`<div class="bundles-source-row npm-dependency-row is-resource">${row}</div>`}</li>`
      })}</ul>`}</div>
  </section>`
}

// The Overview's metadata for a package version, beside the file inventory
// the bundle Overview lists: `meta` names it, `extras` describes it.
export function npmOverviewMeta(entry, prefix = '') {
  const { name, version, manifest } = entry.npm
  const github = manifest.github?.github
  // The commit it was published from, where npm recorded one, and the
  // directory it sits in, where its repository names one.
  const directory = manifest.github?.directory ?? ''
  const tree = github && (manifest.gitHead || directory)
    ? `https://github.com/${github}/tree/${manifest.gitHead ?? 'HEAD'}${directory ? `/${directory.split('/').map(encodeURIComponent).join('/')}` : ''}`
    : github ? `https://github.com/${github}` : null
  return html`<dl class="bundles-detail-meta">
    <dt>Package</dt><dd class="mono">${name}</dd>
    <dt>Version</dt><dd><npm-version-select .name=${name} .version=${version} .list=${npmVersionList(name)}></npm-version-select></dd>
    ${entry.npm.private ? html`<dt>Access</dt><dd>Private</dd>` : nothing}
    ${manifest.deprecated ? html`<dt>Deprecated</dt><dd class="npm-deprecated">${manifest.deprecated}</dd>` : nothing}
    ${manifest.description ? html`<dt>Description</dt><dd>${manifest.description}</dd>` : nothing}
    ${manifest.license ? html`<dt>License</dt><dd>${manifest.license}</dd>` : nothing}
    ${manifest.author ? html`<dt>Author</dt><dd>${manifest.author}</dd>` : nothing}
    ${tree ? html`<dt>GitHub</dt><dd class="bundle-origin-row">
      <a class="bundle-origin-link" href=${tree} target="_blank" rel="noopener noreferrer">${unsafeHTML(GITHUB_ICON_SVG)}<span>${github}${directory ? `/${directory}` : ''}</span></a>
      ${manifest.gitHead ? html`<a class="bundle-origin-link bundle-commit-link" href=${`https://github.com/${github}/commit/${manifest.gitHead}`} data-tooltip=${manifest.gitHead} data-tooltip-icon="commit" target="_blank" rel="noopener noreferrer">${unsafeHTML(COMMIT_ICON_SVG)}<span>${manifest.gitHead.slice(0, 7)}</span></a>` : nothing}
    </dd>` : nothing}
    ${manifest.homepage && /^https?:\/\//iu.test(manifest.homepage) ? html`<dt>Homepage</dt><dd><a class="bundle-origin-link" href=${manifest.homepage} target="_blank" rel="noopener noreferrer"><span>${manifest.homepage}</span></a></dd>` : nothing}
    <dt>npm</dt><dd><a class="bundle-origin-link" href=${`https://www.npmjs.com/package/${name}/v/${version}`} target="_blank" rel="noopener noreferrer"><span>npmjs.com/package/${name}</span></a></dd>
    <dt>Integrity</dt><dd class="mono bundle-integrity">${entry.integrity}</dd>
    ${prefix ? html`<dt>Prefix</dt><dd class="mono">${prefix}</dd>` : nothing}
  </dl>`
}

export function npmOverviewExtras(entry) {
  const { manifest } = entry.npm
  const entryFields = ['main', 'module', 'types', 'type'].filter(field => manifest[field])
  const bins = Object.keys(manifest.bin ?? {})
  const scripts = Object.keys(manifest.installScripts ?? {})
  return html`
    ${entryFields.map(field => html`<dt>${field[0].toUpperCase()}${field.slice(1)}</dt><dd class="mono">${manifest[field]}</dd>`)}
    ${bins.length > 0 ? html`<dt>Bin</dt><dd class="mono">${bins.join(', ')}</dd>` : nothing}
    ${manifest.engines ? html`<dt>Engines</dt><dd class="mono">${Object.entries(manifest.engines).map(([engine, range]) => `${engine} ${range}`).join(', ')}</dd>` : nothing}
    ${scripts.length > 0 || manifest.hasInstallScript ? html`<dt>Install scripts</dt><dd class="mono npm-install-scripts"
      data-tooltip=${scripts.map(script => `${script}: ${manifest.installScripts[script]}`).join('\n') || nothing}>${scripts.join(', ') || 'yes'}</dd>` : nothing}`
}

// The version shown, with the package's other versions to switch to
// (npmVersionList). Until they arrive, or without them, as when the registry
// can't be reached, the same select holds just the version, disabled, so the
// row keeps its height when they do.
class NpmVersionSelect extends LitElement {
  static properties = { name: {}, version: {}, list: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.name = ''
    this.version = ''
    this.list = null
  }

  render() {
    const data = this.list?.status === 'ready' ? this.list : { versions: [], distTags: {} }
    const tags = tagsByVersion(data.distTags)
    const versions = data.versions.includes(this.version) ? data.versions : [this.version, ...data.versions]
    return html`<select class="npm-version-select mono" aria-label=${`Version of ${this.name}`} ?disabled=${versions.length <= 1}
      aria-busy=${this.list?.status === 'loading' ? 'true' : nothing} @change=${event => navigateToNpm(this.name, event.target.value)}>
      ${versions.map(version => html`<option value=${version} ?selected=${version === this.version}>${version}${tags.has(version) ? ` (${tags.get(version).join(', ')})` : ''}</option>`)}
    </select>`
  }
}
if (!customElements.get('npm-version-select')) customElements.define('npm-version-select', NpmVersionSelect)
