// What the npm package Overview shows beyond the bundle one
// (render-bundle.js renderNpmPackageOverview): the package's downloads and
// its GitHub repository's figures, its advisories across every version, its
// file extensions, and its binary files in a column of their own.
import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { bundleFileSizes } from '../../common/bundle-sources.js'
import { bundleLineCounts } from '../../common/bundle-metadata.js'
import { EXTERNAL_LINK_ICON, advisoryRow } from './advisory-parts.js'
import { compareSemver } from './bundle-compare-diff.js'
import { fetchNpmAdvisories, fetchNpmSocket, fetchNpmStats } from './client-managed.js'
import { NPM_LICENSE_FILE, factFile, npmPackageData } from './npm-package.js'
import { render } from './render.js'
import { state } from '#client/index.js'
import { openAdvisoryDetailsDialog } from './dialogs/advisory-details-dialog.js'
import { sourceFileIcon } from './source-file-icon.js'
import { overviewColumn } from './bundle-overview-column.js'
import { encodePath } from './bundle-origin-links.js'
import { compact } from './npm-downloads-chart.js'

const SEVERITIES = new Set(['critical', 'high', 'moderate', 'low'])
// Groups of the Advisories column, in order, each headed by what it holds.
const ADVISORY_GROUPS = [
  ['affects', version => `Affects ${version}`],
  ['later', () => 'Later versions'],
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

// The version's pages elsewhere: npm's, and Socket's report on it where the
// package is public.
export function npmPackageLinks(entry) {
  const { name, version } = entry.npm
  const link = (href, text) => html`<a class="npm-package-link" href=${href} target="_blank" rel="noopener noreferrer">${text}${EXTERNAL_LINK_ICON}</a>`
  return html`<span class="npm-package-links">
    ${link(`https://www.npmjs.com/package/${name}/v/${encodeURIComponent(version)}`, 'npmjs')}
    ${entry.npm.private ? nothing : link(npmSocketHref(entry), 'socket.dev')}
  </span>`
}

const npmSocketHref = entry => `https://socket.dev/npm/package/${entry.npm.name}/overview/${encodeURIComponent(entry.npm.version)}`

// Socket's report on the version, for a public package (npm-insights.ts
// npmSocketReport): null until it arrives, and where Socket has none.
function npmSocketReport(entry) {
  const { name, version } = entry.npm
  if (entry.npm.private) return null
  const data = npmPackageData('socket', `${name}@${version}`, () => fetchNpmSocket(name, version), answer => ({ socket: answer.socket ?? null }))
  return data.status === 'ready' ? data.socket : null
}

// Its five, as Socket's page shows them: its overall score is only the
// lowest of them.
const SOCKET_SCORES = [['supplyChain', 'Supply chain'], ['vulnerability', 'Vulnerability'], ['quality', 'Quality'], ['maintenance', 'Maintenance'], ['license', 'License']]

// Its Socket scores, out of 100, each a chip as wide as its text, after a
// ring filled to it, tinted by how it stands: 80 and over, 50 and over, and
// under 50, that one in red; a full score's number green.
function npmSocketRow(entry) {
  const scores = npmSocketReport(entry)?.scores
  if (!scores) return nothing
  return html`<ul class="npm-extensions npm-socket-scores" aria-label="Socket scores">${SOCKET_SCORES.map(([key, label]) => {
    const score = Math.round(scores[key] * 100)
    const level = score === 100 ? 'is-good is-max' : score >= 80 ? 'is-good' : score >= 50 ? 'is-fair' : 'is-poor'
    return html`<li><a class=${`npm-extension npm-socket-score ${level}`} href=${npmSocketHref(entry)} target="_blank" rel="noopener noreferrer">
      <svg class="npm-socket-gauge" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" pathLength="100"></circle>
        <circle class="npm-socket-gauge-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray=${`${score} 100`}></circle></svg>
      <span>${label}</span><span class="npm-extension-count">${score}</span></a></li>`
  })}</ul>`
}

// Socket's severities, as advisories name theirs.
const SOCKET_SEVERITIES = new Map([['critical', 'critical'], ['high', 'high'], ['middle', 'moderate'], ['low', 'low']])
// `installScripts` → `Install scripts`.
const socketAlertName = type => type.replaceAll(/(?<=[a-z])(?=[A-Z])/gu, ' ').toLowerCase().replace(/^./u, first => first.toUpperCase())

// A version npm publishes in place of a package its security team took down,
// as it does for malicious code: a "security holding package" from
// npm/security-holder, published by npm, or by one of its staff as
// `0.0.1-security`.
export function npmTakenDown({ npm: { version, manifest } }) {
  const npms = manifest.description === 'security holding package' || manifest.github?.github?.toLowerCase() === 'npm/security-holder'
  return npms && (manifest.publisher === 'npm' || /-security(?:\.\d+)?$/u.test(version))
}

// Over the summary: where npm took the package down, saying so, its readme
// (npm's word on it) opening where the package has it (`files`); and where
// Socket raises alerts on the version, as on malware, each with its severity,
// the file it names, opening it as well, and Socket's note on it. Socket's
// say nothing more of npm's placeholder, holding no files but the ones every
// package has, so they are left out there; a version that only looks like
// one keeps them.
export function npmAlerts(entry, files) {
  const takenDown = npmTakenDown(entry)
  const placeholder = takenDown && files !== null && [...files].every(isNpmPackageFile)
  const alerts = placeholder ? [] : npmSocketReport(entry)?.alerts ?? []
  if (!takenDown && alerts.length === 0) return nothing
  const readme = [...files ?? []].find(path => /^readme(?:\.md)?$/iu.test(path))
  return html`<div class="npm-alerts">
    ${takenDown ? html`<p class="npm-alert" role="note"><strong>Taken down by npm.</strong> npm's security team removed this package's
      versions, as it does for malicious code, and serves this placeholder in their place${readme ? html`: ${factFile(readme, files, 'its readme')}` : ''}.</p>` : nothing}
    ${alerts.length > 0 ? npmSocketAlerts(entry, alerts, files) : nothing}
  </div>`
}

function npmSocketAlerts(entry, alerts, files) {
  return html`<div class="npm-alert npm-socket-alerts" role="note">
    <span class="npm-socket-alerts-head"><strong>Socket raises ${alerts.length === 1 ? 'an alert' : `${alerts.length} alerts`} on this version</strong>
      <a class="npm-package-link" href=${npmSocketHref(entry)} target="_blank" rel="noopener noreferrer">socket.dev${EXTERNAL_LINK_ICON}</a></span>
    <ul>${alerts.map(alert => {
      const severity = SOCKET_SEVERITIES.get(alert.severity) ?? 'info'
      return html`<li>
        <span class=${`bundle-advisory-severity sev-${severity}`}>${severity}</span>
        <span class="npm-socket-alert-type">${socketAlertName(alert.type)}</span>
        ${alert.file ? html`<span class="npm-socket-alert-file">in ${factFile(alert.file, files)}</span>` : nothing}
        ${alert.note ? html`<p class="npm-socket-alert-note">${alert.note}</p>` : nothing}
      </li>`
    })}</ul>
  </div>`
}

// The package's downloads in the summary, in a card (npm-downloads-chart.js),
// with its pages elsewhere and `actions` (the tarball's download) under it.
export function npmStatsRow(entry, actions) {
  const stats = npmPackageStats(entry.npm.name)
  return html`<div class="npm-figures">
    <npm-downloads-chart role="region" aria-label="Downloads" .downloads=${stats.downloads} .status=${stats.status}></npm-downloads-chart>
    <div class="npm-figures-actions">${npmPackageLinks(entry)}${actions}</div>
  </div>`
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
  const figure = (icon, count, noun, path) => html`<a class="bundle-origin-link npm-github-figure" href=${`https://github.com/${encodePath(github.repo)}/${path}`}
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
// `fixed` in it, covering only older versions; or it covers `later` ones,
// whether or not older ones too (its ranges can leave the version shown
// between them).
export function npmAdvisoryStatus(advisory, versions, version) {
  const affected = advisory.affected.map(i => versions[i]).filter(Boolean)
  if (affected.includes(version)) return 'affects'
  return affected.length > 0 && affected.every(other => compareSemver(other, version) < 0) ? 'fixed' : 'later'
}

// The package's advisories across every version, npm's and its repository's
// on GitHub, grouped by how they stand for the version shown: those affecting
// it first and marked, those it fixes last and struck through.
export function npmAdvisoriesColumn(entry) {
  const { name, version } = entry.npm
  const data = npmPackageAdvisories(name)
  // Its text, where it has one, in the dialog the Advisories tab opens, until
  // the session changes.
  const session = state.managedSession?.id
  const showDetails = ({ title, severity, details: markdown }) => openAdvisoryDetailsDialog({ heading: title, severity, markdown, isCurrent: () => state.managedSession?.id === session })
  const ready = data.status === 'ready'
  const advisories = ready ? data.advisories : []
  const statuses = advisories.map(advisory => npmAdvisoryStatus(advisory, data.versions, version))
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
      <ul class="bundle-advisories-rows">${group.advisories.map(advisory => advisoryRow({ ...advisory, title: advisory.title ?? advisory.id,
        severity: SEVERITIES.has(advisory.severity) ? advisory.severity : 'unknown', cvss: { score: advisory.cvss }, vulnerable_versions: advisory.range }, showDetails))}</ul>
    </section>`)}`
  return overviewColumn({ title: 'Advisories', count: ready ? advisories.length : '…', body, className: 'npm-advisories-col',
    extra: ready ? html` <span class=${`npm-advisories-active${active > 0 ? ' is-active' : ''}`}>${active} active</span>` : nothing })
}


// What a text holds beyond printing characters and its line breaks: the C0
// controls other than tab, line feed and carriage return, DEL, the C1
// controls, and the bidirectional controls that can make code read other than
// it runs ("Trojan Source").
const CONTROLS = /(?![\t\n\r])\p{Cc}|[\u202A-\u202E\u2066-\u2069]/gu
const NON_ASCII = /\P{ASCII}/u

// A file's text: `kind` 'ascii' or 'utf8', by whether it holds anything past
// ASCII, else 'binary' (which the server tells by its bytes, sending no
// text); `controls` the control characters a text holds, how often by code
// point, or null for none.
export function npmTextEncoding(text) {
  if (typeof text !== 'string') return { kind: 'binary', controls: null }
  const controls = new Map()
  for (const [char] of text.matchAll(CONTROLS)) controls.set(char.codePointAt(0), (controls.get(char.codePointAt(0)) ?? 0) + 1)
  return { kind: NON_ASCII.test(text) ? 'utf8' : 'ascii', controls: controls.size > 0 ? controls : null }
}

// Lines longer than anyone writes by hand.
export const NPM_LONG_LINE = 1000
// Prose, which wraps where it is read: its long lines are paragraphs.
const PROSE = /(?:\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|textile)|(?:^|\/)(?:licen[cs]e|copying|notice|authors|contributors|readme|changelog|changes|history)(?:[-.][^/]*)?)$/iu
const SOURCE_MAP_COMMENT = /^\s*(?:\/\/|\/\*)[#@] sourceMappingURL=/u
// A line that is all one, the map in it as a data: URL, base64 or
// percent-encoded: not code that writes one.
const INLINE_SOURCE_MAP = /^\s*(?:\/\/|\/\*)[#@] sourceMappingURL=data:[^\s,]*,[\w+/=%.~-]*\s*(?:\*\/)?\s*$/u
const SOURCE_MAP = /\.map$/iu
const MINIFIED_NAME = /\.min\.[^/.]+$/iu
// Code minified into lines shorter than NPM_LONG_LINE: outside its strings and
// comments (`/* @__PURE__ */`), its lines average more than anyone writes and
// next to none of its spaces are ones a minifier drops. Told only in what
// minifiers write, as GitHub Linguist tells minified files only in JavaScript
// and CSS, each by its strings and comments (matched in one pass, so that
// neither starts inside the other, a comment with the spaces around it) and
// the spaces it can do without.
const MINIFIED_AVERAGE = 110
const MINIFIED_SPACES = .01
const JS = {
  stringOrComment: /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|[ \t]*(?:\/\*[\s\S]*?\*\/|\/\/.*)[ \t]*/gu,
  // Beside punctuation (`a, b`, `x = 1`), not between two words (`return a`).
  droppable: /(?<![\w$])[ \t]+|[ \t]+(?![\w$])/gu,
}
const CSS = {
  // No `//` comments, so `url(https://…)` is code.
  stringOrComment: /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|[ \t]*\/\*[\s\S]*?\*\/[ \t]*/gu,
  // Beside braces, `;`, `,`, `>`, parentheses and after `:` (`a { color: red }`),
  // not those a selector or a value needs (`.a .b`, `1px solid #fff`, `a :hover`).
  droppable: /(?<=[{};,:>(])[ \t]+|[ \t]+(?=[{};,>)!])/gu,
}
const minifiable = path => /\.[cm]?js$/iu.test(path) ? JS : /\.css$/iu.test(path) ? CSS : null
function minifiedCode(text, { stringOrComment, droppable }) {
  const code = text.replaceAll(stringOrComment, (_, string) => string === undefined ? '' : '""').replaceAll(/^[ \t]+/gmu, '')
  const lines = code.split('\n').filter(line => line.trim() !== '').length
  // Counted by character: a run aligning `=` is as many spaces as it is wide.
  return code.length > MINIFIED_AVERAGE * lines && (code.match(droppable) ?? []).join('').length < MINIFIED_SPACES * code.length
}

// How a file reads, as its `category`, the first that holds (READABILITY):
// binary (no text), controls (text holding control or bidirectional
// characters), map (a source map), long (code with some lines longer than
// anyone writes), inline-map (code with its source map in it, minified or
// not), minified (code mostly on long lines, or named .min., or minified
// into shorter lines: see MINIFIED_AVERAGE), else utf8 or ascii. Prose is
// readable whatever its lines' lengths, and an inline source map's line
// counts for none, nor for how much of the code is on long lines. With
// npmTextEncoding's `kind` and `controls`, its `longest` line's length and
// `longLines`, its non-blank lines' `average` length, and how long its
// inline map is (`inlineMap`, 0 for none).
export function npmFileReadability(path, text) {
  const encoding = npmTextEncoding(text)
  if (encoding.kind === 'binary') return { ...encoding, category: 'binary', longest: 0, longLines: 0, average: 0, inlineMap: 0 }
  let codeChars = 0, codeLines = 0, inlineMap = 0, longChars = 0, longLines = 0, longest = 0
  for (let at = 0; at <= text.length;) {
    const next = text.indexOf('\n', at)
    const end = next === -1 ? text.length : next
    const length = end - at - (text[end - 1] === '\r' ? 1 : 0)
    if (SOURCE_MAP_COMMENT.test(text.slice(at, at + 64)) && INLINE_SOURCE_MAP.test(text.slice(at, end))) inlineMap += length
    else {
      if (length > NPM_LONG_LINE) {
        longLines++
        longChars += length
      }
      longest = Math.max(longest, length)
      if (text.slice(at, end).trim() !== '') {
        codeLines++
        codeChars += length
      }
    }
    at = end + 1
  }
  const read = { ...encoding, longest, longLines, average: codeLines === 0 ? 0 : Math.round(codeChars / codeLines), inlineMap }
  if (encoding.controls) return { ...read, category: 'controls' }
  if (SOURCE_MAP.test(path)) return { ...read, category: 'map' }
  if (PROSE.test(path)) return { ...read, category: inlineMap > 0 ? 'inline-map' : encoding.kind }
  if (longLines === 0) {
    // Its lines as a whole first, which is cheaper.
    const language = minifiable(path)
    const minified = language !== null && codeChars > MINIFIED_AVERAGE * codeLines && minifiedCode(text, language)
    return { ...read, category: inlineMap > 0 ? 'inline-map' : minified ? 'minified' : encoding.kind }
  }
  if (longChars / (text.length - inlineMap) < .5 && !MINIFIED_NAME.test(path)) return { ...read, category: 'long' }
  return { ...read, category: inlineMap > 0 ? 'inline-map' : 'minified' }
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
  ['inline-map', { name: 'Inline source maps', tag: 'Inline map', mark: 'notice' }],
  ['utf8', { name: 'UTF-8', tag: 'UTF-8', mark: null }],
  ['ascii', { name: 'ASCII', tag: 'ASCII', mark: null }],
])
// Those that can't be reviewed by reading, the warning's, and those that can.
const UNREADABLE = [...READABILITY].filter(([, { mark }]) => mark !== null).map(([category]) => category)
const READABLE = [...READABILITY].filter(([, { mark }]) => mark === null).map(([category]) => category)

// What the Overview reads of a version's files, once a version: their
// `paths`, each one's readability (npmFileReadability) and extension by path,
// how many files each category has, the `binaries`, sorted, its file types
// (npmFileTypes), and its `content`: its text files, their lines of code and
// all its files' bytes (`unpacked`), the package's own files
// (isNpmPackageFile) left out, as every package has them.
const readabilities = new WeakMap()
export function npmFilesRead(details) {
  let known = readabilities.get(details)
  if (!known) {
    const { sources, sourcesContent } = details.json
    const byPath = new Map(sources.map((path, i) => [path, npmFileReadability(path, sourcesContent[i])]))
    const counts = new Map()
    for (const { category } of byPath.values()) counts.set(category, (counts.get(category) ?? 0) + 1)
    const lines = bundleLineCounts(details), sizes = bundleFileSizes(details)
    const content = { files: 0, lines: 0, unpacked: 0 }
    for (const path of sources.filter(source => !isNpmPackageFile(source))) {
      if (byPath.get(path).category !== 'binary') content.files++
      content.lines += lines.get(path) ?? 0
      content.unpacked += sizes.get(path) ?? 0
    }
    known = {
      paths: new Set(sources), byPath, counts, extensions: new Map(sources.map(path => [path, npmFileExtension(path)])),
      binaries: new Set(sources.filter(path => byPath.get(path).category === 'binary').toSorted((a, b) => a.localeCompare(b))),
      types: npmFileTypes(sources, sizes, lines), content,
    }
    readabilities.set(details, known)
  }
  return known
}

function controlsNote(controls) {
  const found = [...controls].toSorted((a, b) => b[1] - a[1] || a[0] - b[0])
  const named = found.slice(0, 6).map(([point, times]) => `U+${point.toString(16).toUpperCase().padStart(4, '0')} ×${times.toLocaleString('en')}`)
  return `Control characters: ${named.join(', ')}${found.length > 6 ? `, and ${found.length - 6} more` : ''}`
}

function readabilityNote({ average, category, controls, longLines, longest, inlineMap }) {
  const lines = () => `${longLines.toLocaleString('en')} ${longLines === 1 ? 'line' : 'lines'} over ${NPM_LONG_LINE} characters, the longest ${longest.toLocaleString('en')}`
  switch (category) {
    case 'binary': return 'Not UTF-8 text, or holding a NUL: there is no text to read'
    case 'controls': return controlsNote(controls)
    case 'map': return 'A source map'
    case 'inline-map': return `Inline source map, ${formatBytes(inlineMap)}${longLines > 0 ? `; minified: ${lines()}` : ''}`
    case 'minified': return `Minified: ${longLines > 0 ? lines() : `its lines ${average.toLocaleString('en')} characters long on average, with few spaces`}`
    case 'long': return `${lines()}, among readable ones`
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

// What the Files list is narrowed to, for the version shown: the chip last
// pressed, `{ id, label, keeps }`, or null for every file.
let filesShown = { key: null, chip: null }
const shownKey = entry => `${entry.npm.name}@${entry.npm.version}`
const shownChip = entry => filesShown.key === shownKey(entry) ? filesShown.chip : null

// The Files list's narrowing, for renderBundleSourcesPanel: null for every file.
export function npmFilesFilter(entry) {
  const chip = shownChip(entry)
  return chip && { label: chip.label, keeps: chip.keeps, clear: () => { filesShown = { key: null, chip: null }; render() } }
}

// A chip narrowing the Files list to the files `chip.keeps`, or back to
// every file where it already does: `content` its label, `classes` its marks
// beyond a chip's, `tooltip` what its label doesn't say.
function filterChip(entry, chip, content, count, { classes = '', tooltip = nothing } = {}) {
  const pressed = shownChip(entry)?.id === chip.id
  return html`<li><button type="button" class=${`npm-extension npm-category${classes}`} aria-pressed=${String(pressed)} data-tooltip=${tooltip}
    @click=${() => { filesShown = { key: shownKey(entry), chip: pressed ? null : chip }; render() }}>${content}<span class="npm-extension-count">${count.toLocaleString('en')}</span></button></li>`
}

// A category's chip.
function categoryChip(entry, details, category) {
  const { name, mark } = READABILITY.get(category)
  const { byPath, counts } = npmFilesRead(details)
  return filterChip(entry, { id: `category:${category}`, label: name, keeps: path => byPath.get(path)?.category === category },
    html`<span>${name}</span>`, counts.get(category), { classes: mark ? ` is-${mark}` : '' })
}

// Over the summary, where any file can't be reviewed by reading it: how many,
// each category's chip showing which.
export function npmReadabilityWarning(entry, details) {
  const { counts } = npmFilesRead(details)
  const present = UNREADABLE.filter(category => counts.has(category))
  if (present.length === 0) return nothing
  const unreadable = present.reduce((sum, category) => sum + counts.get(category), 0)
  const warn = present.some(category => READABILITY.get(category).mark === 'warn')
  return html`<div class=${`npm-readability-warning${warn ? ' is-warn' : ''}`} role="note">
    <span class="npm-readability-warning-text"><strong>${unreadable.toLocaleString('en')} of ${details.json.sources.length.toLocaleString('en')} files</strong>
      can't be reviewed by reading them:</span>
    <ul class="npm-extensions">${present.map(category => categoryChip(entry, details, category))}</ul>
  </div>`
}

// The readable files, as chips, UTF-8 and ASCII apart.
function npmReadableRow(entry, details) {
  const { counts } = npmFilesRead(details)
  const present = READABLE.filter(category => counts.has(category))
  if (present.length === 0) return nothing
  return html`<ul class="npm-extensions" aria-label="Readable files">${present.map(category => categoryChip(entry, details, category))}</ul>`
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
// files, bytes, lines }`, sizes as `sizes` has them and lines of code as
// `lines` has them, by path, `lines` null where none of its files is text.
export function npmFileExtensions(paths, sizes, lines = new Map()) {
  const byExtension = new Map()
  for (const path of paths) {
    const extension = npmFileExtension(path)
    const row = byExtension.get(extension) ?? { extension, files: 0, bytes: 0, lines: null }
    row.files++
    row.bytes += sizes.get(path) ?? 0
    if (lines.has(path)) row.lines = (row.lines ?? 0) + lines.get(path)
    byExtension.set(extension, row)
  }
  return [...byExtension.values()].toSorted((a, b) => b.files - a.files || a.extension.localeCompare(b.extension))
}

// The files every package has, at its root: its manifest, readme and license
// files (npm-package.js NPM_LICENSE_FILE).
const PACKAGE_FILE = /^(?:package\.json|readme(?:\.md)?)$/iu
export const isNpmPackageFile = path => PACKAGE_FILE.test(path) || NPM_LICENSE_FILE.test(path)

// The package's file types: its own files (isNpmPackageFile) as `package`,
// where it has any, then its extensions, each as npmFileExtensions has them.
// An extension only its own files have is left out; one other files have too
// counts its own files as well.
export function npmFileTypes(paths, sizes, lines = new Map()) {
  const own = paths.filter(isNpmPackageFile)
  const others = new Set(paths.filter(path => !isNpmPackageFile(path)).map(npmFileExtension))
  const { files, bytes, lines: ownLines } = npmFileExtensions(own, sizes, lines).reduce((sum, row) => ({
    files: sum.files + row.files, bytes: sum.bytes + row.bytes, lines: row.lines === null ? sum.lines : (sum.lines ?? 0) + row.lines,
  }), { files: 0, bytes: 0, lines: null })
  return {
    package: own.length > 0 ? { files, bytes, lines: ownLines } : null,
    extensions: npmFileExtensions(paths, sizes, lines).filter(row => others.has(row.extension)),
  }
}

// A file type's size, and its lines of code where its files are text.
const typeNote = ({ bytes, lines }) => lines === null ? formatBytes(bytes) : `${formatBytes(bytes)} · ${lines.toLocaleString('en')} LoC`

// The package's file types, as chips under its summary, each narrowing the
// Files list to its files as a category's does, its files' size in its tooltip.
function npmFileTypesRow(entry, details) {
  const { types, extensions } = npmFilesRead(details)
  if (!types.package && types.extensions.length === 0) return nothing
  return html`<ul class="npm-extensions" aria-label="File types">
    ${types.package ? filterChip(entry, { id: 'package', label: 'Package', keeps: isNpmPackageFile }, html`<span>Package</span>`, types.package.files,
      { tooltip: `package.json, readme and license: ${typeNote(types.package)}` }) : nothing}
    ${types.extensions.map(type => filterChip(entry, { id: `extension:${type.extension}`, label: type.extension || 'No extension', keeps: path => extensions.get(path) === type.extension },
      html`<span class="npm-extension-name">${type.extension || 'no extension'}</span>`, type.files, { tooltip: typeNote(type) }))}
  </ul>`
}

// What the package holds, under its facts and labelled as they are: its
// languages by lines (`languages`, the bar the bundle Overview draws), its
// readable files and their types; then Socket's scores for it.
export function npmContents(entry, languages, details) {
  const rows = [['languages', 'Languages', languages], ['readable', 'Readable', npmReadableRow(entry, details)], ['types', 'File types', npmFileTypesRow(entry, details)],
    ['socket', 'Socket', npmSocketRow(entry)]]
    .filter(([, , body]) => body !== nothing)
  if (rows.length === 0) return nothing
  return html`<dl class="npm-contents" aria-label="Contents">${rows.map(([key, label, body]) => html`<div class=${`npm-contents-${key}`}><dt>${label}</dt><dd>${body}</dd></div>`)}</dl>`
}

// The binary files (`paths`, sorted), which the server tells from text by
// their bytes: not UTF-8, or holding a NUL. Listed apart from the Files
// column's text, and only where the package has any.
export function npmBinaryColumn(paths, sizes) {
  if (paths.size === 0) return nothing
  return overviewColumn({ title: 'Binary files', count: paths.size, list: true, body: html`<ul class="bundles-sources-list">${[...paths].map(path => html`<li>
      <div class="bundles-source-row is-resource">
        ${sourceFileIcon(path)}<span class="bundles-source-path" data-tooltip-truncated data-tooltip=${path}>${path}</span>
        ${sizes.has(path) ? html`<span class="bundles-source-size">${formatBytes(sizes.get(path))}</span>` : nothing}
      </div>
    </li>`)}</ul>` })
}
