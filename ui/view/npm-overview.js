// What the npm package Overview shows beyond the bundle one
// (render-bundle.js renderNpmPackageOverview): the package's downloads and
// its GitHub repository's figures, its advisories across every version, its
// file extensions, and its binary files in a column of their own.
import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { advisoryCwes, advisoryRail, advisoryReference } from './advisory-parts.js'
import { compareSemver } from './bundle-compare-diff.js'
import { fetchNpmAdvisories, fetchNpmStats } from './client-managed.js'
import { npmPackageData } from './npm-package.js'
import './npm-downloads-chart.js'

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
export function npmPackageStats(name) {
  return npmPackageData('stats', name, () => fetchNpmStats(name), data => ({ downloads: data.downloads ?? null, github: data.github ?? null }))
}

// A package's advisories for this session, across its published versions,
// which each one's `affected` indexes.
export function npmPackageAdvisories(name) {
  return npmPackageData('advisories', name, () => fetchNpmAdvisories(name),
    data => ({ versions: data.versions ?? [], advisories: data.advisories ?? [], repository: data.repository !== false }))
}

function stat(label, value, title = nothing) {
  return html`<div class="npm-stat"><dt>${label}</dt><dd data-tooltip=${title}>${value}</dd></div>`
}

// The package's figures under its summary: downloads and its repository's,
// beside its weekly downloads over the last year. While they load, the row
// holds its place, so nothing below it moves when they arrive.
export function npmStatsRow(entry) {
  const stats = npmPackageStats(entry.npm.name)
  const ready = stats.status === 'ready'
  const { downloads = null, github = null } = ready ? stats : {}
  const pending = stats.status === 'loading' ? '…' : '—'
  const days = downloads?.days ?? []
  const week = days.slice(-7).reduce((sum, count) => sum + count, 0)
  const year = days.reduce((sum, count) => sum + count, 0)
  const exact = count => count.toLocaleString('en')
  const repo = github ?? (ready ? null : entry.npm.manifest.github?.github ? {} : null)
  return html`<section class="npm-insights" aria-label="Package figures">
    <dl class="npm-stats">
      ${stat('Weekly downloads', downloads ? compact.format(week) : pending, downloads ? exact(week) : nothing)}
      ${stat('Downloads, 12 months', downloads ? compact.format(year) : pending, downloads ? exact(year) : nothing)}
      ${repo ? html`
        ${stat('GitHub stars', github ? compact.format(github.stars) : pending, github ? exact(github.stars) : nothing)}
        ${stat('Forks', github ? compact.format(github.forks) : pending, github ? exact(github.forks) : nothing)}
        ${stat('Open issues & PRs', github ? compact.format(github.openIssues) : pending, github ? exact(github.openIssues) : nothing)}
        ${github?.archived ? stat('Repository', 'Archived') : nothing}` : nothing}
    </dl>
    ${ready && !downloads ? nothing : html`<figure class="npm-downloads">
      <figcaption>Weekly downloads, last 12 months</figcaption>
      <npm-downloads-chart .downloads=${downloads}></npm-downloads-chart>
    </figure>`}
  </section>`
}

// How an advisory stands for the version shown: it `affects` it; it is
// `fixed` in it, covering only older versions; or it covers only `later` ones.
export function npmAdvisoryStatus(advisory, versions, version) {
  const affected = advisory.affected.map(i => versions[i]).filter(Boolean)
  if (affected.includes(version)) return 'affects'
  return affected.some(other => compareSemver(other, version) < 0) ? 'fixed' : 'later'
}

// The package's advisories across every version, npm's and its repository's
// on GitHub, grouped by how they stand for the version shown: those affecting
// it first and marked, those it fixes last and struck through.
export function npmAdvisoriesColumn(entry) {
  const { name, version } = entry.npm
  const data = npmPackageAdvisories(name)
  const ready = data.status === 'ready'
  const statuses = ready ? data.advisories.map(advisory => npmAdvisoryStatus(advisory, data.versions, version)) : []
  const groups = ADVISORY_GROUPS.map(([status, heading]) => ({
    status, heading: heading(version), advisories: data.advisories?.filter((_, i) => statuses[i] === status) ?? [],
  })).filter(group => group.advisories.length > 0)
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
      <span class="bundles-overview-col-title">Advisories <span class="bundles-overview-col-count">${ready ? data.advisories.length : '…'}</span></span>
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
const ENCODING_LABELS = { ascii: 'ASCII', utf8: 'UTF-8', binary: 'Binary' }
const ENCODING_ORDER = ['ASCII', 'UTF-8', 'ASCII + controls', 'UTF-8 + controls', 'Binary']

// A file as the Files list tags it: `kind` 'ascii' or 'utf8' for text, by
// whether it holds anything past ASCII, else 'binary' (which the server tells
// by its bytes); `controls` the control characters a text holds, how often by
// code point, or null for none.
export function npmTextEncoding(text) {
  if (typeof text !== 'string') return { kind: 'binary', controls: null }
  const kind = NON_ASCII.test(text) ? 'utf8' : 'ascii'
  if (!CONTROL.test(text)) return { kind, controls: null }
  const controls = new Map()
  for (const [char] of text.matchAll(CONTROLS)) controls.set(char.codePointAt(0), (controls.get(char.codePointAt(0)) ?? 0) + 1)
  return { kind, controls }
}

export const npmEncodingLabel = ({ kind, controls }) => `${ENCODING_LABELS[kind]}${controls ? ' + controls' : ''}`

// A version's files by path, as npmTextEncoding tags them, read once a version.
const encodings = new WeakMap()
export function npmFileEncodings(details) {
  let known = encodings.get(details)
  if (!known) {
    const { sources, sourcesContent } = details.json
    known = new Map(sources.map((path, i) => [path, npmTextEncoding(sourcesContent[i])]))
    encodings.set(details, known)
  }
  return known
}

function controlsNote(controls) {
  const found = [...controls].toSorted((a, b) => b[1] - a[1] || a[0] - b[0])
  const named = found.slice(0, 6).map(([point, times]) => `U+${point.toString(16).toUpperCase().padStart(4, '0')} ×${times.toLocaleString('en')}`)
  return `Control characters: ${named.join(', ')}${found.length > 6 ? `, and ${found.length - 6} more` : ''}`
}

// A file's tag in the Files list; text with control characters is marked, and
// names them.
export function npmEncodingTag(encoding) {
  if (!encoding) return nothing
  const strange = encoding.controls !== null
  return html`<span class=${`npm-encoding-tag is-${encoding.kind}${strange ? ' is-strange' : ''}`}
    data-tooltip=${strange ? controlsNote(encoding.controls) : nothing}>${npmEncodingLabel(encoding)}</span>`
}

// How many files each tag has, as chips under the summary.
export function npmEncodingsRow(details) {
  const counts = new Map()
  for (const encoding of npmFileEncodings(details).values()) counts.set(npmEncodingLabel(encoding), (counts.get(npmEncodingLabel(encoding)) ?? 0) + 1)
  const rows = ENCODING_ORDER.filter(label => counts.has(label))
  if (rows.length === 0) return nothing
  return html`<ul class="npm-extensions npm-encodings" aria-label="File encodings">
    ${rows.map(label => html`<li class=${`npm-extension${label.endsWith('controls') ? ' is-strange' : ''}`}>
      <span>${label}</span><span class="npm-extension-count">${counts.get(label).toLocaleString('en')}</span>
    </li>`)}
  </ul>`
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

// Every extension in the package, as chips under its summary.
export function npmExtensionsRow(paths, sizes) {
  const rows = npmFileExtensions(paths, sizes)
  if (rows.length === 0) return nothing
  return html`<ul class="npm-extensions" aria-label="File extensions">
    ${rows.map(({ extension, files, bytes }) => html`<li class="npm-extension" data-tooltip=${`${files.toLocaleString()} ${files === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}`}>
      <span class="npm-extension-name">${extension || 'no extension'}</span><span class="npm-extension-count">${files.toLocaleString()}</span>
    </li>`)}
  </ul>`
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
        <span class="bundles-source-path" data-tooltip-truncated data-tooltip=${path}>${path}</span>
        ${sizes.has(path) ? html`<span class="bundles-source-size">${formatBytes(sizes.get(path))}</span>` : nothing}
      </div>
    </li>`)}</ul></div>
  </section>`
}
