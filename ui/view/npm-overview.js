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
import { openNpmCompareAdvisoriesDialog } from './dialogs/npm-compare-advisories-dialog.js'
import { sourceFileIcon } from './source-file-icon.js'
import { overviewColumn } from './bundle-overview-column.js'
import { encodePath } from './bundle-origin-links.js'
import { compact, npmDownloadTier, npmLastMonth, npmTierLevel, npmTierName } from './npm-downloads-chart.js'
import { READABILITY, npmFileReadability, npmReadabilityTag } from './file-readability.js'

export { npmReadabilityTag } from './file-readability.js'

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
// lowest of them, each with the score from which it is green (socketLevel)
// and the bar under which Compare flags the open version's, out of 100: supply chain under
// 85, and vulnerability under 85 where it tells of worse than the
// advisories found (vulnerabilityBeyond), both green from 85; quality under
// 70 (a sabotaged release such as faker's 6.6.6 scores 38, most widely used
// packages 70 and up), maintenance under 70 (a deprecated or abandoned
// package's 50, a finished one's 75 and up), and license under 80 (a
// copyleft or unusual license's 70, as AGPL's or WTFPL's; most are 100).
const SOCKET_SCORES = [['supplyChain', 'Supply chain', 85, 85], ['vulnerability', 'Vulnerability', 85, 85], ['quality', 'Quality', 70, 80],
  ['maintenance', 'Maintenance', 70, 80], ['license', 'License', 80, 80]]

// A score's tint: green from `good`, then 50 and over, and under 50, that
// one in red; a full score's number green.
const socketLevel = (score, good) => score === 100 ? 'is-good is-max' : score >= good ? 'is-good' : score >= 50 ? 'is-fair' : 'is-poor'
// A ring filled to a score.
const socketGauge = score => html`<svg class="npm-socket-gauge" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" pathLength="100"></circle>
  <circle class="npm-socket-gauge-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray=${`${score} 100`}></circle></svg>`

// Its Socket scores, out of 100, each a chip as wide as its text, after a
// ring filled to it, tinted by how it stands (socketLevel).
function npmSocketRow(entry) {
  const scores = npmSocketReport(entry)?.scores
  if (!scores) return nothing
  return html`<ul class="npm-extensions npm-socket-scores" aria-label="Socket scores">${SOCKET_SCORES.map(([key, label, , good]) => {
    const score = Math.round(scores[key] * 100)
    return html`<li><a class=${`npm-extension npm-socket-score ${socketLevel(score, good)}`} href=${npmSocketHref(entry)} target="_blank" rel="noopener noreferrer">
      ${socketGauge(score)}<span>${label}</span><span class="npm-extension-count">${score}</span></a></li>`
  })}</ul>`
}

// Socket's severities, as advisories name theirs.
const SOCKET_SEVERITIES = new Map([['critical', 'critical'], ['high', 'high'], ['middle', 'moderate'], ['low', 'low']])
// `installScripts` → `Install scripts`.
const socketAlertName = type => type.replaceAll(/(?<=[a-z])(?=[A-Z])/gu, ' ').toLowerCase().replace(/^./u, first => first.toUpperCase())

// Socket's alerts on a version's files (`npm`, an entry's or its details'),
// by the path each names: none for a private package, or until its report
// arrives. One map a report, so a view drawing them redraws when it comes.
const NO_ALERTS = new Map()
const alertsByReport = new WeakMap()
export function npmSocketFileAlerts(npm) {
  const report = npm ? npmSocketReport({ npm }) : null
  if (!report) return NO_ALERTS
  if (!alertsByReport.has(report)) alertsByReport.set(report, Map.groupBy(report.alerts.filter(alert => alert.file), alert => alert.file))
  return alertsByReport.get(report)
}

// A file's Socket alerts, each named in its severity's color, its note in
// its tooltip.
export const npmSocketFileTags = (alerts = []) => alerts.map(alert => {
  const severity = SOCKET_SEVERITIES.get(alert.severity) ?? 'low'
  return html`<span class=${`npm-socket-file-alert sev-${severity}`}
    data-tooltip=${`Socket: ${socketAlertName(alert.type)}, ${severity}${alert.note ? ` · ${alert.note}` : ''}`}>${socketAlertName(alert.type)}</span>`
})

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

// Whether the session the advisories are read in is still the current one:
// what shows them is discarded once it isn't.
function sessionCheck() {
  const session = state.managedSession?.id
  return () => state.managedSession?.id === session
}

// An advisory's row, as the Advisories tab draws a bundle's, its text, where
// it has one, opening in the dialog the tab opens, until the session changes.
function npmAdvisoryRow(advisory, isCurrent) {
  return advisoryRow({ ...advisory, title: advisory.title ?? advisory.id, severity: SEVERITIES.has(advisory.severity) ? advisory.severity : 'unknown',
    cvss: { score: advisory.cvss }, vulnerable_versions: advisory.range },
  ({ title, severity, details: markdown }) => openAdvisoryDetailsDialog({ heading: title, severity, markdown, isCurrent }))
}

// The package's advisories across every version, npm's and its repository's
// on GitHub, grouped by how they stand for the version shown: those affecting
// it first and marked, those it fixes last and struck through.
export function npmAdvisoriesColumn(entry) {
  const { name, version } = entry.npm
  const data = npmPackageAdvisories(name)
  const isCurrent = sessionCheck()
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
      <ul class="bundle-advisories-rows">${group.advisories.map(advisory => npmAdvisoryRow(advisory, isCurrent))}</ul>
    </section>`)}`
  return overviewColumn({ title: 'Advisories', count: ready ? advisories.length : '…', body, className: 'npm-advisories-col',
    extra: ready ? html` <span class=${`npm-advisories-active${active > 0 ? ' is-active' : ''}`}>${active} active</span>` : nothing })
}


// Those that can be hard to review by reading, the warning's, and those that can.
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

// Where any of `total` files (`files` naming them) can be hard to review by
// reading it, as `counts` has each category's: how many, each category's
// `chip` showing which.
function readabilityWarning(counts, total, files, chip) {
  const present = UNREADABLE.filter(category => counts.has(category))
  if (present.length === 0) return nothing
  const unreadable = present.reduce((sum, category) => sum + counts.get(category), 0)
  const warn = present.some(category => READABILITY.get(category).mark === 'warn')
  return html`<div class=${`npm-readability-warning${warn ? ' is-warn' : ''}`} role="note">
    <span class="npm-readability-warning-text"><strong>${unreadable.toLocaleString('en')} of ${total.toLocaleString('en')} ${files}</strong>
      can be hard to review by reading them:</span>
    <ul class="npm-extensions">${present.map(chip)}</ul>
  </div>`
}

// Over the summary, where any file can be hard to review by reading it.
export function npmReadabilityWarning(entry, details) {
  return readabilityWarning(npmFilesRead(details).counts, details.json.sources.length, 'files', category => categoryChip(entry, details, category))
}

// Compare's files (bundle-compare.js `source.files`) as the Overview's: each
// one's type icon and Socket's alerts on it, the tag of one the open version
// adds or changes, and over them, where any of those can be hard to review by reading it, the Overview's
// warning, counting those alone.
export const npmCompareFiles = {
  icon: sourceFileIcon,
  // Socket's alerts on a side's files, and their tags (npmSocketFileAlerts).
  alerts: details => npmSocketFileAlerts(details?.npm),
  alertTags: npmSocketFileTags,
  tag: (details, path) => npmReadabilityTag(npmFilesRead(details).byPath.get(path)),
  warning(details, paths) {
    const { byPath } = npmFilesRead(details)
    const counts = new Map()
    for (const path of paths) {
      const category = byPath.get(path)?.category
      if (category) counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    return readabilityWarning(counts, paths.length, paths.length === 1 ? 'file added or changed' : 'files added or changed', category => {
      const { name, mark } = READABILITY.get(category)
      return html`<li><span class=${`npm-extension is-${mark}`}><span>${name}</span><span class="npm-extension-count">${counts.get(category).toLocaleString('en')}</span></span></li>`
    })
  },
}

// What calls for a look at Compare's two versions (bundle-compare.js
// `source.badges`), from the one compared with (`base`) to the open one
// (`other`), each side's details: a publisher that changed, the advisories
// that affect either,
// Socket's scores either has under its bar (SOCKET_SCORES), and the
// package's tier by downloads where it is orange or red. Each once it
// arrives.
export function npmCompareBadges(base, other) {
  if (!base?.npm || !other?.npm) return nothing
  const sides = [base.npm, other.npm]
  const affecting = advisoriesAffecting(sides)
  const chips = [publisherBadge(sides), advisoriesBadge(sides, affecting), ...socketBadges(sides, affecting), popularityBadge(other.npm.name)].filter(chip => chip !== nothing)
  return chips.length === 0 ? nothing : html`<ul class="npm-extensions npm-compare-badges" aria-label="Versions at a glance">${chips}</ul>`
}

// The advisories affecting each side's version, as the Advisories column
// has them: none where they couldn't be had, and null until they arrive.
function advisoriesAffecting(sides) {
  const data = npmPackageAdvisories(sides[1].name)
  if (data.status === 'loading') return null
  return sides.map(({ version }) => {
    const at = data.status === 'ready' ? data.versions.indexOf(version) : -1
    return at === -1 ? [] : data.advisories.filter(advisory => advisory.affected.includes(at))
  })
}

// `2 → 0`, or one number where both sides have it; `–` for a side that has none.
const fromTo = (was, now) => was === now ? `${now ?? '–'}` : `${was ?? '–'} → ${now ?? '–'}`

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'unknown']
const severityOf = advisory => SEVERITIES.has(advisory.severity) ? advisory.severity : 'unknown'
// The most severe of `advisories`, undefined for none.
const worstOf = advisories => SEVERITY_ORDER.find(severity => advisories.some(advisory => severityOf(advisory) === severity))

// The npm account that published each version, where npm says for both and
// they differ, as when a package changes hands, or is taken over: linking
// to the open version's publisher's profile.
function publisherBadge([from, to]) {
  const now = to.manifest?.publisher, was = from.manifest?.publisher
  if (!was || !now || was === now) return nothing
  return html`<li><a class="npm-extension is-warn npm-compare-publisher" href=${`https://www.npmjs.com/~${encodeURIComponent(now)}`} target="_blank" rel="noopener noreferrer"
    data-tooltip=${`Published by ~${was} (${from.version}), then ~${now} (${to.version})`}
    .tooltipContent=${compareTip('Published by', [from, to], [`~${was}`, `~${now}`], 'A different npm account published the open version')}>
    <span>Publisher</span><span class="npm-extension-count">~${was} → ~${now}</span></a></li>`
}

// The advisories affecting each version, tinted by the worst still affecting
// the open one, or green where none does; each version's, by severity, and
// how many the open one brings and fixes, in its tooltip; a click lists them
// (npm-compare-advisories-dialog.js).
function advisoriesBadge(sides, affecting) {
  if (!affecting) return nothing
  const [was, now] = affecting
  if (was.length === 0 && now.length === 0) return nothing
  const tint = now.length === 0 ? 'is-cleared' : `sev-${worstOf(now)}`
  const brought = now.filter(advisory => !was.includes(advisory)).length, fixed = was.filter(advisory => !now.includes(advisory)).length
  const tooltip = compareTip('Advisories affecting', sides, affecting.map(list => list.length === 0 ? html`<span class="compare-tip-none">none</span>`
    : html`<span class="compare-tip-count">${list.length}</span><span class="compare-tip-severities">${SEVERITY_ORDER
      .map(severity => [severity, list.filter(advisory => severityOf(advisory) === severity).length]).filter(([, count]) => count > 0)
      .map(([severity, count]) => html`<span class=${`compare-tip-severity sev-${severity}`}>${count} ${severity}</span>`)}</span>`),
  `${brought} new · ${fixed} fixed`)
  return html`<li><button type="button" class=${`npm-extension npm-compare-advisories ${tint}`} aria-haspopup="dialog"
    data-tooltip=${`Advisories affecting ${sides[0].version}: ${was.length}, ${sides[1].version}: ${now.length}`} .tooltipContent=${tooltip}
    @click=${() => openCompareAdvisories(sides, affecting)}>
    <span>Advisories</span><span class="npm-extension-count">${fromTo(was.length, now.length)}</span></button></li>`
}

// A badge's styled tooltip: its `head`, a row for each side's version and
// what is said of it, and a `note` under them.
const compareTip = (head, sides, said, note) => html`<div class="compare-tip">
  <div class="compare-tip-head">${head}</div>
  <div class="compare-tip-rows">${sides.map(({ version }, i) => html`<span class="compare-tip-version">${version}</span><span class="compare-tip-said">${said[i]}</span>`)}</div>
  <div class="compare-tip-note">${note}</div>
</div>`

// The advisories between the two versions, in a dialog: those the open one
// brings, those it still has, and those it fixes.
function openCompareAdvisories([from, to], [was, now]) {
  const isCurrent = sessionCheck()
  const groups = [
    ['new', `New in ${to.version}`, now.filter(advisory => !was.includes(advisory))],
    ['kept', `Still affecting ${to.version}`, now.filter(advisory => was.includes(advisory))],
    ['fixed', `Fixed in ${to.version}`, was.filter(advisory => !now.includes(advisory))],
  ].filter(([, , list]) => list.length > 0).map(([status, heading, list]) => ({ status, heading, rows: list.map(advisory => npmAdvisoryRow(advisory, isCurrent)) }))
  void openNpmCompareAdvisoriesDialog({ heading: `Advisories · ${from.name} ${from.version} → ${to.version}`, groups, isCurrent })
}

// Whether Socket's vulnerability score on a version under `bar` tells of
// worse than the advisories found affecting it (`ours`): a score is Socket's
// count of much the same advisories, under 85 for a high one (84 for one
// alone), and 25, its floor, for a critical one or many high, as on lodash
// 4.17.11 or axios 1.7.3.
function vulnerabilityBeyond(score, ours, bar) {
  if (score === null || score >= bar) return false
  const worst = worstOf(ours)
  return worst === undefined || SEVERITY_ORDER.indexOf(score <= 25 ? 'critical' : 'high') < SEVERITY_ORDER.indexOf(worst)
}

// Socket's scores the open version has under its bar, each from the one
// compared with to the open one, its ring, tint and link the open one's;
// none for a private package. Vulnerability only where it tells of worse
// than the advisories found affecting it (vulnerabilityBeyond), once they
// arrive, as the Advisories badge has the rest.
function socketBadges([from, to], affecting) {
  const [was, now] = [from, to].map(npm => npmSocketReport({ npm })?.scores ?? null)
  if (!now) return []
  return SOCKET_SCORES.flatMap(([key, label, bar, good]) => {
    const scores = [was, now].map(side => side ? Math.round(side[key] * 100) : null)
    const [before, after] = scores
    if (after === null || after >= bar) return []
    if (key === 'vulnerability' && !(affecting && vulnerabilityBeyond(after, affecting[1], bar))) return []
    return [html`<li><a class=${`npm-extension npm-socket-score ${socketLevel(after, good)}`} href=${npmSocketHref({ npm: to })} target="_blank" rel="noopener noreferrer"
      data-tooltip=${`Socket's ${label.toLowerCase()} score: ${before ?? 'none'} for ${from.version}, ${after} for ${to.version}`}
      .tooltipContent=${compareTip(`Socket's ${label.toLowerCase()} score`, [from, to], scores.map(score => score === null ? html`<span class="compare-tip-none">none</span>`
        : html`<span class=${`compare-tip-score ${socketLevel(score, good)}`}>${socketGauge(score)}${score}</span>`),
      key === 'vulnerability' ? `Shown under ${bar}, where worse than the advisories found` : `Shown under ${bar}`)}>
      ${socketGauge(after)}<span>${label}</span><span class="npm-extension-count">${fromTo(before, after)}</span></a></li>`]
  })
}

// The package's tier by downloads where it is orange or red (past the top
// 20,000), its last complete month's downloads in its tooltip, over the
// month's name.
function popularityBadge(name) {
  const stats = npmPackageStats(name)
  const tier = stats.status === 'ready' ? npmDownloadTier(stats.downloads) : null
  const level = tier === null ? null : npmTierLevel(tier)
  if (level !== 'is-low' && level !== 'is-unpopular') return nothing
  const last = npmLastMonth(stats.downloads), total = last?.total.toLocaleString('en')
  return html`<li><span class=${`npm-downloads-tier ${level}`} data-tooltip=${last ? `${total} downloads/month, ${last.month}` : nothing}
    .tooltipContent=${last ? html`<div><strong>${total}</strong> downloads/month</div><div class="compare-tip-note">${last.month}</div>` : null}>${npmTierName(tier)}</span></li>`
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
