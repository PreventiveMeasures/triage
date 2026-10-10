// What the npm package Overview shows beyond the bundle one
// (render-bundle.js renderNpmPackageOverview): the package's downloads and
// its GitHub repository's figures, its advisories across every version, its
// file extensions, and its binary files in a column of their own.
import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { bundleFileSizes } from '../../common/bundle-sources.js'
import { advisoryCwes, advisoryRail, advisoryReference } from './advisory-parts.js'
import { compareSemver } from './bundle-compare-diff.js'
import { fetchNpmAdvisories, fetchNpmStats } from './client-managed.js'
import { NPM_LICENSE_FILE, npmPackageData } from './npm-package.js'
import { render } from './render.js'
import { sourceFileIcon } from './source-file-icon.js'
import { npmDownloadWeeks } from './npm-downloads-chart.js'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const SEVERITIES = new Set(['critical', 'high', 'moderate', 'low'])
// Groups of the Advisories column, in order, each headed by what it holds.
const ADVISORY_GROUPS = [
  ['affects', version => `Affects ${version}`],
  ['later', () => 'Later versions only'],
  ['fixed', version => `Fixed in ${version}`],
]

// A package's figures for this session: `downloads` and `github`, each null
// where the server could not have them.
function npmPackageStats(name) {
  return npmPackageData('stats', name, () => fetchNpmStats(name), data => ({ downloads: data.downloads ?? null, github: data.github ?? null }))
}

// A package's advisories for this session, across its published versions,
// which each one's `affected` indexes.
function npmPackageAdvisories(name) {
  return npmPackageData('advisories', name, () => fetchNpmAdvisories(name),
    data => ({ versions: data.versions ?? [], advisories: data.advisories ?? [], repository: data.repository !== false }))
}

function stat(label, value, title = nothing) {
  return html`<div class="npm-stat"><dt>${label}</dt><dd data-tooltip=${title}>${value}</dd></div>`
}

// The package's figures in the summary: its downloads beside its weekly
// downloads over the last year, with `actions` (the tarball's download)
// under them. While they load, the card holds its place, so nothing around
// it moves when they arrive.
export function npmStatsRow(entry, actions) {
  const stats = npmPackageStats(entry.npm.name)
  const ready = stats.status === 'ready'
  const { downloads = null } = ready ? stats : {}
  const pending = stats.status === 'loading' ? '…' : '—'
  const week = npmDownloadWeeks(downloads).at(-1)?.total ?? 0
  const year = (downloads?.days ?? []).reduce((sum, count) => sum + count, 0)
  const exact = count => count.toLocaleString('en')
  return html`<div class="npm-figures"><section class="npm-insights" aria-label="Package figures">
    <dl class="npm-stats">
      ${stat('Weekly downloads', downloads ? compact.format(week) : pending, downloads ? exact(week) : nothing)}
      ${stat('Downloads, 12 months', downloads ? compact.format(year) : pending, downloads ? exact(year) : nothing)}
    </dl>
    ${ready && !downloads ? nothing : html`<figure class="npm-downloads" aria-label="Weekly downloads, last 12 months">
      <npm-downloads-chart .downloads=${downloads}></npm-downloads-chart>
    </figure>`}
  </section><div class="npm-figures-actions">${actions}</div></div>`
}

const STAR_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="m8 1.75 1.9 3.9 4.3.6-3.1 3 .75 4.25L8 11.5l-3.85 2 .75-4.25-3.1-3 4.3-.6Z"/></svg>`
const ISSUE_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/></svg>`
const PULL_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6M12 11V6a2 2 0 0 0-2-2H7m1.5-1.5L7 4l1.5 1.5"/></svg>`
const FORK_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="4.5" cy="3.25" r="1.5"/><circle cx="11.5" cy="3.25" r="1.5"/><circle cx="8" cy="12.75" r="1.5"/><path d="M4.5 4.75v.75a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-.75M8 7.5v3.75"/></svg>`

// Its repository's stars, forks, open issues and pull requests, beside the
// repository in the facts (npm-package.js npmOverviewMeta), each linking to
// GitHub's list of them; nothing until they arrive, or where GitHub has none
// to give.
export function npmGithubFigures(entry) {
  if (!entry.npm.manifest.github?.github) return nothing
  const stats = npmPackageStats(entry.npm.name)
  const github = stats.status === 'ready' ? stats.github : null
  if (!github) return nothing
  const repo = github.repo.split('/').map(encodeURIComponent).join('/')
  const figure = (icon, count, noun, path) => html`<a class="bundle-origin-link npm-github-figure" href=${`https://github.com/${repo}/${path}`}
    data-tooltip=${`${count.toLocaleString('en')} ${noun}`} target="_blank" rel="noopener noreferrer">${icon}<span>${compact.format(count)}</span></a>`
  // GitHub counts open pull requests among open issues: apart where it says
  // how many there are, together where it doesn't.
  const pulls = typeof github.openPulls === 'number' ? github.openPulls : null
  const issues = pulls === null ? github.openIssues : Math.max(github.openIssues - pulls, 0)
  return html`${figure(STAR_ICON, github.stars, github.stars === 1 ? 'star' : 'stars', 'stargazers')}
    ${figure(FORK_ICON, github.forks, github.forks === 1 ? 'fork' : 'forks', 'forks')}
    ${figure(ISSUE_ICON, issues, pulls === null ? 'open issues and pull requests' : issues === 1 ? 'open issue' : 'open issues', 'issues')}
    ${pulls === null ? nothing : figure(PULL_ICON, pulls, pulls === 1 ? 'open pull request' : 'open pull requests', 'pulls')}
    ${github.archived ? html`<span class="npm-github-archived">Archived</span>` : nothing}`
}

// How an advisory stands for the version shown: it `affects` it; it is
// `fixed` in it, covering only older versions; or it covers only `later` ones.
export function npmAdvisoryStatus(advisory, versions, version) {
  const affected = advisory.affected.map(i => versions[i]).filter(Boolean)
  if (affected.includes(version)) return 'affects'
  return affected.some(other => compareSemver(other, version) < 0) ? 'fixed' : 'later'
}

// Each advisory's status for a version, kept with the advisories answered.
const statusesKept = new WeakMap()
function advisoryStatuses(data, version) {
  let byVersion = statusesKept.get(data)
  if (!byVersion) statusesKept.set(data, byVersion = new Map())
  if (!byVersion.has(version)) byVersion.set(version, data.advisories.map(advisory => npmAdvisoryStatus(advisory, data.versions, version)))
  return byVersion.get(version)
}

// The package's advisories across every version, npm's and its repository's
// on GitHub, grouped by how they stand for the version shown: those affecting
// it first and marked, those it fixes last and struck through.
export function npmAdvisoriesColumn(entry) {
  const { name, version } = entry.npm
  const data = npmPackageAdvisories(name)
  const ready = data.status === 'ready'
  const advisories = ready ? data.advisories : []
  const statuses = ready ? advisoryStatuses(data, version) : []
  const groups = ADVISORY_GROUPS.map(([status, heading]) => ({
    status, heading: heading(version), advisories: advisories.filter((_, i) => statuses[i] === status),
  })).filter(group => group.advisories.length > 0)
  const active = statuses.filter(status => status === 'affects').length
  const unchecked = ready && !data.repository
    ? html`<p class="npm-advisories-note">GitHub's repository advisories couldn't be checked; npm's are shown.</p>` : nothing
  const body = data.status === 'loading' ? html`<p class="bundles-overview-col-empty">Checking advisories…</p>`
    : data.status === 'error' ? html`<p class="bundles-overview-col-empty">Couldn't check advisories.</p>`
    : groups.length === 0 ? html`${unchecked}<p class="bundles-overview-col-empty">No advisories for any version.</p>`
    : html`${unchecked}${groups.map(group => html`<section class=${`npm-advisory-group is-${group.status}`}>
      <h4 class="npm-advisory-group-head">${group.heading} <span class="bundles-overview-col-count">${group.advisories.length}</span></h4>
      <ul class="bundle-advisories-rows">${group.advisories.map(npmAdvisoryRow)}</ul>
    </section>`)}`
  return html`<section class="bundles-overview-col npm-advisories-col">
    <header class="bundles-overview-col-head">
      <span class="bundles-overview-col-title">Advisories <span class="bundles-overview-col-count">${ready ? advisories.length : '…'}</span>
        ${ready ? html`<span class=${`npm-advisories-active${active > 0 ? ' is-active' : ''}`}
          data-tooltip=${`${active} affecting ${version}`}>${active} active</span>` : nothing}</span>
    </header>
    <div class="bundles-overview-col-body">${body}</div>
  </section>`
}

// As a bundle's advisory row has it: severity and CVSS in a rail of their
// own, so titles line up; its source and GHSA beside the title; the range it
// covers and its CWEs under it.
function npmAdvisoryRow(advisory) {
  const severity = SEVERITIES.has(advisory.severity) ? advisory.severity : 'unknown'
  const cwes = advisoryCwes(advisory.cwe)
  return html`<li class="bundle-advisory-row">
    ${advisoryRail(severity, advisory.cvss)}
    <div class="bundle-advisory-body">
      <div class="bundle-advisory-header">
        <span class="bundle-advisory-title">${advisory.title ?? advisory.id}</span>
        ${advisoryReference(advisory)}
      </div>
      ${advisory.range || cwes !== nothing ? html`<div class="bundle-advisory-meta">
        ${advisory.range ? html`<span>Affected <span class="mono">${advisory.range}</span></span>` : nothing}
        ${cwes}
      </div>` : nothing}
    </div>
  </li>`
}

// What a text holds beyond printing characters and its line breaks: the C0
// controls other than tab, line feed and carriage return, DEL, the C1
// controls, and the bidirectional controls that can make code read other than
// it runs ("Trojan Source").
const CONTROL = /(?![\t\n\r])\p{Cc}|[\u202A-\u202E\u2066-\u2069]/u
const CONTROLS = new RegExp(CONTROL.source, 'gu')
const NON_ASCII = /\P{ASCII}/u

// A file's text: `kind` 'ascii' or 'utf8', by whether it holds anything past
// ASCII, else 'binary' (which the server tells by its bytes, sending no
// text); `controls` the control characters a text holds, how often by code
// point, or null for none.
export function npmTextEncoding(text) {
  if (typeof text !== 'string') return { kind: 'binary', controls: null }
  const kind = NON_ASCII.test(text) ? 'utf8' : 'ascii'
  if (!CONTROL.test(text)) return { kind, controls: null }
  const controls = new Map()
  for (const [char] of text.matchAll(CONTROLS)) controls.set(char.codePointAt(0), (controls.get(char.codePointAt(0)) ?? 0) + 1)
  return { kind, controls }
}

// Lines longer than anyone writes by hand.
export const NPM_LONG_LINE = 1000
// Prose, which wraps where it is read: its long lines are paragraphs.
const PROSE = /(?:\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|textile)|(?:^|\/)(?:licen[cs]e|copying|notice|authors|contributors|readme|changelog|changes|history)(?:[-.][^/]*)?)$/iu
const SOURCE_MAP_COMMENT = /^\s*(?:\/\/|\/\*)[#@] sourceMappingURL=/u
const SOURCE_MAP = /\.map$/iu
const MINIFIED_NAME = /\.min\.[^/.]+$/iu

// How a file reads, as its `category`, the first of these that holds:
//   binary    not UTF-8, or holding a NUL: no text to read at all
//   controls  text holding control or bidirectional characters, which can make
//             it read other than it runs
//   map       a source map
//   minified  code most of whose text sits on long lines, or named .min. and
//             holding any
//   long      code with lines longer than anyone writes among readable ones,
//             where something can sit past the edge of any editor
//   utf8      readable, holding characters past ASCII
//   ascii     readable ASCII
// Prose is readable whatever its lines' lengths, and a sourceMappingURL
// comment's line counts for none. With `kind` and `controls` as
// npmTextEncoding has them, and for text, its `longest` line's length and how
// many `longLines` it has.
export function npmFileReadability(path, text) {
  const encoding = npmTextEncoding(text)
  if (encoding.kind === 'binary') return { ...encoding, category: 'binary', longest: 0, longLines: 0 }
  let longChars = 0, longLines = 0, longest = 0
  for (let at = 0; at <= text.length;) {
    const next = text.indexOf('\n', at)
    const end = next === -1 ? text.length : next
    const length = end - at - (text[end - 1] === '\r' ? 1 : 0)
    if (length > NPM_LONG_LINE && !SOURCE_MAP_COMMENT.test(text.slice(at, at + 40))) {
      longest = Math.max(longest, length)
      longLines++
      longChars += length
    } else longest = Math.max(longest, Math.min(length, NPM_LONG_LINE))
    at = end + 1
  }
  const read = { ...encoding, longest, longLines }
  if (encoding.controls) return { ...read, category: 'controls' }
  if (SOURCE_MAP.test(path)) return { ...read, category: 'map' }
  if (longLines === 0 || PROSE.test(path)) return { ...read, category: encoding.kind }
  return { ...read, category: longChars / text.length >= .5 || MINIFIED_NAME.test(path) ? 'minified' : 'long' }
}

// Each category: its name, its tag in the Files list, and how it is marked,
// `warn` for what to look into, `notice` for what can't be reviewed by
// reading it either way.
const READABILITY = new Map([
  ['binary', { name: 'Not UTF-8', tag: 'Not UTF-8', mark: 'warn' }],
  ['controls', { name: 'Control characters', tag: 'Controls', mark: 'warn' }],
  ['long', { name: 'Unexpected long lines', tag: 'Long lines', mark: 'warn' }],
  ['minified', { name: 'Minified', tag: 'Minified', mark: 'notice' }],
  ['map', { name: 'Source maps', tag: 'Map', mark: 'notice' }],
  ['utf8', { name: 'UTF-8', tag: 'UTF-8', mark: null }],
  ['ascii', { name: 'ASCII', tag: 'ASCII', mark: null }],
])
// Those that can't be reviewed by reading, the warning's, and those that can.
const UNREADABLE = [...READABILITY].filter(([, { mark }]) => mark !== null).map(([category]) => category)
const READABLE = [...READABILITY].filter(([, { mark }]) => mark === null).map(([category]) => category)

// What the Overview reads of a version's files, read once a version: each
// file's readability (npmFileReadability) by path, how many files each
// category has, and its file types (npmFileTypes).
const readabilities = new WeakMap()
function filesRead(details) {
  let known = readabilities.get(details)
  if (!known) {
    const { sources, sourcesContent } = details.json
    const byPath = new Map(sources.map((path, i) => [path, npmFileReadability(path, sourcesContent[i])]))
    const counts = new Map()
    for (const { category } of byPath.values()) counts.set(category, (counts.get(category) ?? 0) + 1)
    known = { byPath, counts, types: npmFileTypes(sources, bundleFileSizes(details)) }
    readabilities.set(details, known)
  }
  return known
}

export const npmFilesReadability = details => filesRead(details).byPath

function controlsNote(controls) {
  const found = [...controls].toSorted((a, b) => b[1] - a[1] || a[0] - b[0])
  const named = found.slice(0, 6).map(([point, times]) => `U+${point.toString(16).toUpperCase().padStart(4, '0')} ×${times.toLocaleString('en')}`)
  return `Control characters: ${named.join(', ')}${found.length > 6 ? `, and ${found.length - 6} more` : ''}`
}

function readabilityNote(readability) {
  const lines = `${readability.longLines.toLocaleString('en')} ${readability.longLines === 1 ? 'line' : 'lines'} over ${NPM_LONG_LINE} characters, the longest ${readability.longest.toLocaleString('en')}`
  switch (readability.category) {
    case 'binary': return 'Not UTF-8 text, or holding a NUL: there is no text to read'
    case 'controls': return controlsNote(readability.controls)
    case 'map': return 'A source map'
    case 'minified': return `Minified: ${lines}`
    case 'long': return `${lines}, among readable ones`
    default: return nothing
  }
}

// A file's tag in the Files list, marked where it can't be read as it is,
// saying why.
export function npmReadabilityTag(readability) {
  if (!readability) return nothing
  const { tag, mark } = READABILITY.get(readability.category)
  return html`<span class=${`npm-encoding-tag${mark ? ` is-${mark}` : ''}`} data-tooltip=${readabilityNote(readability)}>${tag}</span>`
}

// What the Files list is narrowed to, for the version shown: a category or
// an extension, as `{ kind, value }`, or null for every file.
let filesShown = { key: null, filter: null }
const shownKey = entry => `${entry.npm.name}@${entry.npm.version}`
const shownFilter = entry => filesShown.key === shownKey(entry) ? filesShown.filter : null
const isShown = (entry, kind, value) => shownFilter(entry)?.kind === kind && shownFilter(entry)?.value === value

// A chip's click: narrows to its files, or back to every file where it
// already does.
function showFiles(entry, kind, value) {
  filesShown = { key: shownKey(entry), filter: isShown(entry, kind, value) ? null : { kind, value } }
  render()
}

// The Files list's narrowing, for renderBundleSourcesPanel: null for every file.
export function npmFilesFilter(entry, details) {
  const filter = shownFilter(entry)
  if (filter === null) return null
  const clear = () => { filesShown = { key: null, filter: null }; render() }
  if (filter.kind === 'type') return { label: 'Package', keeps: isNpmPackageFile, clear }
  if (filter.kind === 'extension') return { label: filter.value || 'No extension', keeps: path => npmFileExtension(path) === filter.value, clear }
  const known = npmFilesReadability(details)
  return { label: READABILITY.get(filter.value).name, keeps: path => known.get(path)?.category === filter.value, clear }
}

// A chip narrowing the Files list to its files: `kind` and `value` what it
// narrows by, `label` its content, `classes` its marks beyond a chip's.
function filterChip(entry, kind, value, label, count, { classes = '', tooltip = 'Show only these in Files' } = {}) {
  return html`<li><button type="button" class=${`npm-extension npm-category${classes}`} aria-pressed=${String(isShown(entry, kind, value))}
    data-tooltip=${tooltip} @click=${() => showFiles(entry, kind, value)}>${label}<span class="npm-extension-count">${count.toLocaleString('en')}</span></button></li>`
}

// A category's chip.
function categoryChip(entry, category, count) {
  const { name, mark } = READABILITY.get(category)
  return filterChip(entry, 'category', category, html`<span>${name}</span>`, count, { classes: mark ? ` is-${mark}` : '' })
}

// Over the summary, where any file can't be reviewed by reading it: how many,
// each category's chip showing which.
export function npmReadabilityWarning(entry, details) {
  const { counts } = filesRead(details)
  const present = UNREADABLE.filter(category => counts.has(category))
  if (present.length === 0) return nothing
  const unreadable = present.reduce((sum, category) => sum + counts.get(category), 0)
  const warn = present.some(category => READABILITY.get(category).mark === 'warn')
  return html`<div class=${`npm-readability-warning${warn ? ' is-warn' : ''}`} role="note">
    <span class="npm-readability-warning-text"><strong>${unreadable.toLocaleString('en')} of ${details.json.sources.length.toLocaleString('en')} files</strong>
      can't be reviewed by reading them:</span>
    <ul class="npm-extensions">${present.map(category => categoryChip(entry, category, counts.get(category)))}</ul>
  </div>`
}

// The readable files, as chips, UTF-8 and ASCII apart.
function npmReadableRow(entry, details) {
  const { counts } = filesRead(details)
  const present = READABLE.filter(category => counts.has(category))
  if (present.length === 0) return nothing
  return html`<ul class="npm-extensions" aria-label="Readable files">${present.map(category => categoryChip(entry, category, counts.get(category)))}</ul>`
}

// A file's extension, as the Overview lists them: what follows the last dot
// of its name, a declaration file's `.d.ts` (or `.d.mts`, `.d.cts`) whole,
// and '' for a name with no dot past its first character, such as `LICENSE`
// or `.npmignore`.
export function npmFileExtension(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const declaration = /\.d\.[cm]?ts$/iu.exec(name)
  if (declaration && declaration.index > 0) return declaration[0].toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

// The package's extensions, most files first, then by name: `{ extension,
// files, bytes }`, sizes as `sizes` has them, by path.
export function npmFileExtensions(paths, sizes) {
  const byExtension = new Map()
  for (const path of paths) {
    const extension = npmFileExtension(path)
    const row = byExtension.get(extension) ?? { extension, files: 0, bytes: 0 }
    row.files++
    row.bytes += sizes.get(path) ?? 0
    byExtension.set(extension, row)
  }
  return [...byExtension.values()].toSorted((a, b) => b.files - a.files || a.extension.localeCompare(b.extension))
}

// The files every package has, at its root: its manifest, readme and license
// files (npm-package.js NPM_LICENSE_FILE).
const PACKAGE_FILE = /^(?:package\.json|readme(?:\.md)?)$/iu
export const isNpmPackageFile = path => PACKAGE_FILE.test(path) || NPM_LICENSE_FILE.test(path)

// The package's file types: its own files (isNpmPackageFile) as `package`,
// where it has any, then its extensions as npmFileExtensions has them. An
// extension only its own files have is left out; one other files have too
// counts its own files as well.
export function npmFileTypes(paths, sizes) {
  const own = paths.filter(isNpmPackageFile)
  const others = new Set(paths.filter(path => !isNpmPackageFile(path)).map(npmFileExtension))
  return {
    package: own.length > 0 ? { files: own.length, bytes: own.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0) } : null,
    extensions: npmFileExtensions(paths, sizes).filter(row => others.has(row.extension)),
  }
}

const filesNote = (files, bytes) => `${files.toLocaleString('en')} ${files === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}: show only these in Files`

// The package's file types, as chips under its summary, each narrowing the
// Files list to its files as a category's does.
function npmFileTypesRow(entry, details) {
  const { types } = filesRead(details)
  if (!types.package && types.extensions.length === 0) return nothing
  return html`<ul class="npm-extensions" aria-label="File types">
    ${types.package ? filterChip(entry, 'type', 'package', html`<span>Package</span>`, types.package.files,
      { tooltip: `package.json, readme and license: ${filesNote(types.package.files, types.package.bytes)}` }) : nothing}
    ${types.extensions.map(({ extension, files, bytes }) => filterChip(entry, 'extension', extension,
      html`<span class="npm-extension-name">${extension || 'no extension'}</span>`, files, { tooltip: filesNote(files, bytes) }))}
  </ul>`
}

// What the package holds, under its facts and labelled as they are: its
// languages by lines (`languages`, the bar the bundle Overview draws), its
// readable files, and their types.
export function npmContents(entry, languages, details) {
  const rows = [['Languages', languages], ['Readable', npmReadableRow(entry, details)], ['File types', npmFileTypesRow(entry, details)]]
    .filter(([, body]) => body !== nothing)
  if (rows.length === 0) return nothing
  return html`<dl class="npm-contents" aria-label="Contents">${rows.map(([label, body]) => html`<dt>${label}</dt><dd>${body}</dd>`)}</dl>`
}

// The binary files, which the server tells from text by their bytes: not
// UTF-8, or holding a NUL. Listed apart from the Files column's text, and
// only where the package has any.
export function npmBinaryColumn(paths, sizes) {
  if (paths.length === 0) return nothing
  const sorted = paths.toSorted((a, b) => a.localeCompare(b))
  return html`<section class="bundles-overview-col npm-binary-col">
    <header class="bundles-overview-col-head">
      <span class="bundles-overview-col-title">Binary files <span class="bundles-overview-col-count">${paths.length}</span></span>
    </header>
    <div class="bundles-overview-col-body bundles-overview-col-body--list"><ul class="bundles-sources-list">${sorted.map(path => html`<li>
      <div class="bundles-source-row is-resource">
        ${sourceFileIcon(path)}<span class="bundles-source-path" data-tooltip-truncated data-tooltip=${path}>${path}</span>
        ${sizes.has(path) ? html`<span class="bundles-source-size">${formatBytes(sizes.get(path))}</span>` : nothing}
      </div>
    </li>`)}</ul></div>
  </section>`
}
