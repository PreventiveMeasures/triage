// What the npm package Overview shows beyond the bundle one
// (render-bundle.js renderNpmPackageOverview): the package's downloads and
// its GitHub repository's figures, its advisories across every version, its
// file extensions, and its binary files in a column of their own.
import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { bundleFileSizes } from '../../common/bundle-sources.js'
import { bundleLineCounts } from '../../common/bundle-metadata.js'
import { EXTERNAL_LINK_ICON, advisoryRow } from './advisory-parts.js'
import { compareSemver } from '../../common/bundle-compare-versions.js'
import { fetchNpmAdvisories, fetchNpmProvenance, fetchNpmSocket, fetchNpmStats } from './client-managed.js'
import { factFile, npmAge, npmDeprecation, npmPackageData, npmPublishedDay, npmPublishedOn } from './npm-package.js'
import { NPM_LICENSE_FILE } from './npm-entries.js'
import { PULL_ICON_SVG } from './icons.js'
import { appMarkup } from './markup.js'
import { npmDependencyFlagTags } from './npm-dependency-checks.js'
import { render } from './render.js'
import { state } from '#client/index.js'
import { openAdvisoryDetailsDialog, openNpmCompareAdvisoriesDialog } from './lazy-dialogs.js'
import { fileIconFormat, isNotTextFormat, sourceFileIcon } from './source-file-icon.js'
import { overviewColumn } from './bundle-overview-column.js'
import { encodePath } from './bundle-origin-links.js'
import { compact, npmLastMonth, npmMonthSaid, npmTierName } from './npm-downloads-chart.js'
import { READABILITY, npmFileFlagTags, npmFileReadabilityOf, npmLabelMark, npmListedReadabilityTag, npmObfuscationFound, npmReadabilityLabels } from './file-readability.js'
import { npmRisk } from './npm-risk.js'
import { fileRiskOf, npmFilesRisk } from './file-risk.js'
import { npmCredentialsSaid, npmFileRunsCode, npmRunsCodeKinds, npmRunsCodeSaid, npmRunsCodeTags } from './file-runs-code.js'
import { npmExfiltrationNames, npmExfiltrationSaid, npmExfiltrationTag, npmFileExfiltration } from './file-hosts.js'
import { HOST_TAGS, npmHostSeverity, npmHostTags } from '../../risk/files/hosts.js'
import { npmHostFinding } from '../../risk/npm/held.js'
import { npmReviewVerdictLimit, npmTakenDown } from '../../common/dependency-reviews.js'

// Advisories' severities, most severe first, and an advisory's (`unknown` where it gives none).
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'unknown']
const severityOf = advisory => SEVERITY_ORDER.includes(advisory.severity) ? advisory.severity : 'unknown'
// Groups of the Advisories column, in order, each headed by what it holds.
const ADVISORY_GROUPS = [
  ['affects', version => `Affects ${version}`],
  ['later', () => 'Later versions'],
  ['fixed', version => `Fixed in ${version}`],
]

// A package's `downloads` and `github` figures, each null where the server has none.
function npmPackageStats(name) {
  return npmPackageData('stats', name, () => fetchNpmStats(name), data => ({ downloads: data.downloads ?? null, github: data.github ?? null }))
}

// A package's advisories across its versions, which each one's `affected`
// indexes; `keptAt`, where its repository's are as GitHub last listed them, when.
function npmPackageAdvisories(name) {
  return npmPackageData('advisories', name, () => fetchNpmAdvisories(name),
    data => ({ versions: data.versions ?? [], advisories: data.advisories ?? [], repository: data.repository !== false, keptAt: data.keptAt ?? null }))
}

// The version's pages elsewhere: npm's, and Socket's where the package is public.
export function npmPackageLinks(entry) {
  const { name, version } = entry.npm
  const link = (href, text) => html`<a class="npm-package-link" href=${href} target="_blank" rel="noopener noreferrer">${text}${EXTERNAL_LINK_ICON}</a>`
  return html`<span class="npm-package-links">
    ${link(`https://www.npmjs.com/package/${name}/v/${encodeURIComponent(version)}`, 'npmjs')}
    ${entry.npm.private ? nothing : link(npmSocketHref(entry), 'socket.dev')}
  </span>`
}

const npmSocketHref = entry => `https://socket.dev/npm/package/${entry.npm.name}/overview/${encodeURIComponent(entry.npm.version)}`

// Socket's report on a public version (npm-insights.ts): null until it arrives, and where Socket has none.
function npmSocketReport(entry) {
  const { name, version } = entry.npm
  if (entry.npm.private) return null
  const data = npmPackageData('socket', `${name}@${version}`, () => fetchNpmSocket(name, version), answer => ({ socket: answer.socket ?? null }))
  return data.status === 'ready' ? data.socket : null
}

// Socket's five scores (its overall one is only the lowest), each `[key,
// label, bar, good]`: Compare flags the open version's under `bar`, and it is
// green from `good`, out of 100. Quality's 70: a sabotaged release (faker
// 6.6.6) scores 38, most widely used packages 70 and up; maintenance's 70: a
// deprecated or abandoned package's 50, a finished one's 75 and up; license's
// 80: a copyleft or unusual license's 70, most 100.
const SOCKET_SCORES = [['supplyChain', 'Supply chain', 85, 85], ['vulnerability', 'Vulnerability', 85, 85], ['quality', 'Quality', 70, 80],
  ['maintenance', 'Maintenance', 70, 80], ['license', 'License', 80, 80]]
// Socket's maintenance score for a deprecated version for that alone: one no
// lower says no more than the Deprecated chip.
const DEPRECATED_MAINTENANCE = 50

// A score's tint: green from `good`, fair from 50, else red; a full score's number green.
const socketLevel = (score, good) => score === 100 ? 'is-good is-max' : score >= good ? 'is-good' : score >= 50 ? 'is-fair' : 'is-poor'
// A ring filled to a score.
const socketGauge = score => html`<svg class="npm-socket-gauge" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" pathLength="100"></circle>
  <circle class="npm-socket-gauge-fill" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray=${`${score} 100`}></circle></svg>`

// Its Socket scores, a chip each with a ring filled to it, tinted (socketLevel).
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

// Socket's alerts on a version's files by path: none for a private package
// or till its report arrives; one map a report, so a view redraws when it comes.
const NO_ALERTS = new Map()
const alertsByReport = new WeakMap()
export function npmSocketFileAlerts(npm) {
  const report = npm ? npmSocketReport({ npm }) : null
  if (!report) return NO_ALERTS
  if (!alertsByReport.has(report)) alertsByReport.set(report, Map.groupBy(report.alerts.filter(alert => alert.file), alert => alert.file))
  return alertsByReport.get(report)
}

// A file's Socket alerts, each in its severity's color, its note in its tooltip.
export const npmSocketFileTags = (alerts = []) => alerts.map(alert => {
  const severity = SOCKET_SEVERITIES.get(alert.severity) ?? 'low'
  return html`<span class=${`npm-socket-file-alert sev-${severity}`}
    data-tooltip=${`Socket: ${socketAlertName(alert.type)}, ${severity}${alert.note ? ` · ${alert.note}` : ''}`}>${socketAlertName(alert.type)}</span>`
})

export function npmReviewLimit(entry, base) {
  return npmReviewVerdictLimit(entry.npm, npmPackageAdvisories(entry.npm.name), npmSocketReport(entry), npmRisk(entry.npm, base ? base.npm?.version ?? '(empty)' : null))
}

// Over the summary: that npm took the package down, its readme (npm's word)
// opening; and Socket's alerts on the version, each with its severity, file
// and note. Socket's say nothing more of npm's placeholder (no files but
// every package's), so they are left out there.
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

// The package's downloads card (npm-downloads-chart.js), its tier yellow at
// most where risk says it is known (knownNote), its links and `actions` under it.
export function npmStatsRow(entry, actions, badges = nothing) {
  const stats = npmPackageStats(entry.npm.name)
  const known = knownNote(npmRisk(entry.npm)?.findings.find(({ id }) => id === 'popularity'))
  return html`<div class="npm-figures">
    <npm-downloads-chart role="region" aria-label="Downloads" .downloads=${stats.downloads} .status=${stats.status} .known=${known}></npm-downloads-chart>
    <div class="npm-figures-actions">${npmPackageLinks(entry)}${actions}</div>
    ${badges}
  </div>`
}

const STAR_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="m8 1.75 1.9 3.9 4.3.6-3.1 3 .75 4.25L8 11.5l-3.85 2 .75-4.25-3.1-3 4.3-.6Z"/></svg>`
const ISSUE_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/></svg>`
const PULL_ICON = appMarkup(PULL_ICON_SVG)
const FORK_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="4.5" cy="3.25" r="1.5"/><circle cx="11.5" cy="3.25" r="1.5"/><circle cx="8" cy="12.75" r="1.5"/><path d="M4.5 4.75v.75a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2v-.75M8 7.5v3.75"/></svg>`

// Its repository's stars, forks, open issues and pull requests beside it in
// the facts, each linking to GitHub's list; nothing until they arrive.
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

// npm's provenance for a public version npm lists it for; null for any other.
const provenanceOf = ({ name, version, private: hidden, manifest }) => hidden || !manifest.provenance ? null
  : npmPackageData('provenance', `${name}@${version}`, () => fetchNpmProvenance(name, version), answer => ({ provenance: answer.provenance ?? null }))

// Whether the version's provenance names what built it, or may yet: then no
// other fact need name the CI that published it (npm-package.js npmOverviewMeta).
export function npmProvenanceNamesBuilder(npm) {
  const data = provenanceOf(npm)
  return data !== null && (data.status === 'loading' || Boolean(data.provenance?.builder))
}

// What built a version, by its builder's id and runner (npm-provenance.ts):
// GitHub Actions, hosted or self-hosted, or GitLab CI (`<project>/-/runners/<id>`).
function builderName(builder, runner) {
  if (!builder) return null
  if (/^https:\/\/github\.com\/actions\/runner(?:\/github-hosted)?$/u.test(builder)) return 'GitHub Actions'
  if (builder.startsWith('https://github.com/actions/runner/')) return 'GitHub Actions, self-hosted runner'
  if (builder.startsWith('https://gitlab.com/') || builder.includes('/-/runners/')) return runner === 'self-hosted' ? 'GitLab CI, self-hosted runner' : 'GitLab CI'
  return new URL(builder).host
}
// Built on its provider's own runners, as its certificate says, else as GitHub's builder id does.
const isHosted = (built, runner) => runner ? runner === 'github-hosted' || runner === 'gitlab-hosted' : built === 'GitHub Actions'

// npm's provenance for a public version, in the Overview's facts: what built
// it, from which repository and commit, by which workflow and run, and its
// transparency log entry, flagged where built from another repository than
// the package names, or listed with no statement the server reads (nothing
// vouches for it then); nothing for a private package.
export function npmProvenanceFact(entry) {
  if (entry.npm.private) return nothing
  const data = provenanceOf(entry.npm)
  if (!data) return html`<span class="npm-commit-missing">None</span>`
  if (data.status === 'loading') return html`<span class="npm-commit-missing">Checking…</span>`
  if (data.status === 'error') return html`<span class="npm-commit-missing">Couldn't be read</span>`
  if (!data.provenance) {
    return html`<span class="npm-provenance-warning" data-tooltip="npm lists provenance for this version, but no statement naming its tarball could be read">Listed, but none for this tarball</span>`
  }
  const { manifest } = entry.npm
  const { repository, commit, workflow, ref, builder, run, logIndex, runner } = data.provenance
  const link = (href, text, tooltip = nothing) => html`<a class="bundle-origin-link" href=${href} data-tooltip=${tooltip} target="_blank" rel="noopener noreferrer"><span>${text}</span></a>`
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/u.exec(repository)?.[1] ?? null
  const built = builderName(builder, runner)
  const gitlab = built?.startsWith('GitLab CI')
  const shown = github ?? repository.replace(/^https:\/\//u, '')
  // The repository the package names, GitHub's or GitLab's.
  const named = manifest.github?.github ?? (manifest.gitlab ? `gitlab.com/${manifest.gitlab}` : null)
  const elsewhere = named && named.toLowerCase() !== shown.toLowerCase()
  // What built it and from where (green on its provider's runners from the
  // repository it names), then how: its workflow by its file's name, its run
  // and its log entry.
  const file = workflow?.split('/').at(-1)
  const how = [workflow ? (github && commit ? link(`${repository}/blob/${commit}/${workflow.split('/').map(encodeURIComponent).join('/')}`, file, workflow === file ? nothing : workflow)
    : html`<span class="mono" data-tooltip=${workflow === file ? nothing : workflow}>${file}</span>`) : nothing,
  run ? link(run, 'Run') : nothing,
  logIndex === null ? nothing : link(`https://search.sigstore.dev/?logIndex=${logIndex}`, 'Transparency log')].filter(item => item !== nothing)
  return html`<span class="npm-provenance">
    <span class="npm-provenance-line">
      ${built ? html`<span class=${isHosted(built, runner) && !elsewhere ? 'npm-provenance-builder is-hosted' : 'npm-provenance-builder'}>${built}</span>` : nothing}
      <span class="npm-provenance-sep">from</span>
      ${commit ? link(github ? `${repository}/commit/${commit}` : gitlab ? `${repository}/-/commit/${commit}` : repository, `${shown}@${commit.slice(0, 7)}`,
        `${repository} at ${commit}${ref ? ` (${ref})` : ''}`) : link(repository, shown)}
      ${elsewhere ? html`<span class="npm-provenance-warning" data-tooltip=${`The package names ${named}`}>Not the repository it names</span>` : nothing}</span>
    ${how.length > 0 ? html`<span class="npm-provenance-line is-how">${how.map((item, i) => i === 0 ? item : html`<span class="npm-provenance-sep" aria-hidden="true">·</span>${item}`)}</span>`
      : nothing}
  </span>`
}

// How an advisory stands for the version shown: it `affects` it, is `fixed`
// in it (covering only older ones), or covers `later` ones (perhaps older too).
export function npmAdvisoryStatus(advisory, versions, version) {
  const affected = advisory.affected.map(i => versions[i]).filter(Boolean)
  if (affected.includes(version)) return 'affects'
  return affected.length > 0 && affected.every(other => compareSemver(other, version) < 0) ? 'fixed' : 'later'
}

// Whether the session the advisories are read in is still current.
function sessionCheck() {
  const session = state.managedSession?.id
  return () => state.managedSession?.id === session
}

// An advisory's row as the Advisories tab draws a bundle's, its text opening in a dialog.
function npmAdvisoryRow(advisory, isCurrent) {
  return advisoryRow({ ...advisory, title: advisory.title ?? advisory.id, severity: severityOf(advisory),
    cvss: { score: advisory.cvss }, vulnerable_versions: advisory.range },
  ({ title, severity, details: markdown }) => openAdvisoryDetailsDialog({ heading: title, severity, markdown, isCurrent }))
}

// The package's advisories across every version, npm's and its GitHub
// repository's, grouped by how they stand for the version shown.
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
  // Where the repository's advisories are as GitHub last listed them, how long ago, or missing.
  const unchecked = ready && data.keptAt
    ? html`<p class="npm-advisories-note">GitHub's repository advisories are as of ${npmSpan(Date.now() - Date.parse(data.keptAt))} ago: they couldn't be checked now.</p>`
    : ready && !data.repository ? html`<p class="npm-advisories-note">GitHub's repository advisories couldn't be checked; npm's are shown.</p>` : nothing
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

// How many of `readabilities` each label has (npmReadabilityLabels), each
// marked as the most it is on one of them (npmLabelMark), and how many files
// can be hard to review by reading (`unreadable`).
const MARKS = [null, 'notice', 'warn']
function readabilityCounts(readabilities) {
  const counts = new Map(), marks = new Map()
  let unreadable = 0
  for (const readability of readabilities) {
    const labels = npmReadabilityLabels(readability)
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
      const mark = npmLabelMark(readability, label)
      if (MARKS.indexOf(mark) > MARKS.indexOf(marks.get(label) ?? null)) marks.set(label, mark)
    }
    if (labels.some(label => READABILITY.get(label).mark)) unreadable++
  }
  return { counts, marks, unreadable }
}

// What the Overview reads of a version's files, again once its risk arrives
// (npmFilesRisk): paths, readability, extension and size by path, counts by
// category (readabilityCounts), the sorted `binaries`, its file types, and
// its `content` (text files, lines of code and bytes, the package's own
// files left out, as every package has them).
const readabilities = new WeakMap()
export function npmFilesRead(details) {
  const of = details.npm ? npmFilesRisk(details) : details
  let known = readabilities.get(details)
  if (known?.of !== of) {
    const { sources, sourcesContent } = details.json
    const byPath = new Map(sources.map((path, i) => [path, npmFileReadabilityOf(details, path, sourcesContent[i])]).filter(([, read]) => read))
    const binaries = new Set(sources.filter((_, i) => typeof sourcesContent[i] !== 'string'))
    const { counts, marks, unreadable } = readabilityCounts(byPath.values())
    const lines = bundleLineCounts(details), sizes = bundleFileSizes(details)
    const content = { files: 0, lines: 0, unpacked: 0 }
    for (const path of sources.filter(source => !isNpmPackageFile(source))) {
      if (!binaries.has(path)) content.files++
      content.lines += lines.get(path) ?? 0
      content.unpacked += sizes.get(path) ?? 0
    }
    known = {
      of, paths: new Set(sources), byPath, counts, marks, unreadable, sizes, extensions: new Map(sources.map(path => [path, npmFileExtension(path)])),
      binaries: new Set([...binaries].toSorted((a, b) => a.localeCompare(b))),
      types: npmFileTypes(sources, sizes, lines), content,
    }
    readabilities.set(details, known)
  }
  return known
}

// The chip last pressed narrowing the Files list for the version shown, `{ id, label, keeps }`.
let filesShown = { key: null, chip: null }
const shownKey = entry => `${entry.npm.name}@${entry.npm.version}`
const shownChip = entry => filesShown.key === shownKey(entry) ? filesShown.chip : null

// The Files list's narrowing, for renderBundleSourcesPanel: null for every file.
export function npmFilesFilter(entry) {
  const chip = shownChip(entry)
  return chip && { label: chip.label, keeps: chip.keeps, clear: () => { filesShown = { key: null, chip: null }; render() } }
}

// A chip narrowing the Files list to the files `chip.keeps`, or back to every file.
function filterChip(entry, chip, content, count, { classes = '', tooltip = nothing } = {}) {
  const pressed = shownChip(entry)?.id === chip.id
  return html`<li><button type="button" class=${`npm-extension npm-category${classes}`} aria-pressed=${String(pressed)} data-tooltip=${tooltip}
    @click=${() => { filesShown = { key: shownKey(entry), chip: pressed ? null : chip }; render() }}>${content}<span class="npm-extension-count">${count.toLocaleString('en')}</span></button></li>`
}

// A category's chip, finding each file labelled with it.
function categoryChip(entry, details, category) {
  const { name } = READABILITY.get(category)
  const { byPath, counts, marks } = npmFilesRead(details)
  const mark = marks.get(category)
  return filterChip(entry, { id: `category:${category}`, label: name, keeps: path => byPath.has(path) && npmReadabilityLabels(byPath.get(path)).includes(category) },
    html`<span>${name}</span>`, counts.get(category), { classes: mark ? ` is-${mark}` : '' })
}

// Where any of `total` files can be hard to review by reading, how many, a `chip` per category.
function readabilityWarning({ counts, marks, unreadable }, total, files, chip) {
  const present = UNREADABLE.filter(category => counts.has(category))
  if (present.length === 0) return nothing
  const warn = present.some(category => marks.get(category) === 'warn')
  return html`<div class=${`npm-readability-warning${warn ? ' is-warn' : ''}`} role="note">
    <span class="npm-readability-warning-text"><strong>${unreadable.toLocaleString('en')} of ${total.toLocaleString('en')} ${files}</strong>
      can be hard to review by reading them:</span>
    <ul class="npm-extensions">${present.map(chip)}</ul>
  </div>`
}

// Over the summary, where any file can be hard to review by reading it.
export function npmReadabilityWarning(entry, details) {
  return readabilityWarning(npmFilesRead(details), details.json.sources.length, 'files', category => categoryChip(entry, details, category))
}

// A file's tags in the Files list and Compare's: what it runs beyond itself,
// the services it names, its flags, then how it reads; with `opens` (the
// Files list) the first two opening its code there; with `base` (Compare's,
// the file as the version compared with has it, null for one it adds) a tag
// naming a service new to it a level higher.
export function npmFileTags(details, path, opens = false, base = undefined) {
  const { byPath, sizes } = npmFilesRead(details)
  const at = opens ? path : undefined
  return html`${npmRunsCodeTags(npmFileRunsCode(details, path), undefined, at)}${npmExfiltrationTag(npmFileExfiltration(details, path), hostsWas(base), at)}${npmFileFlagTags(details, path, sizes.get(path))}${npmListedReadabilityTag(byPath.get(path))}`
}

// The services a file named as the version compared with has it: null for
// one it adds, undefined where nothing is compared or its risk hasn't arrived.
const hostsWas = base => base === undefined || (base?.details.npm && !npmFilesRisk(base.details)) ? undefined
  : base && npmFileExfiltration(base.details, base.path)

// A file's flags as its tags show them (file-flags.js): Socket's `alerts` on
// it, then risk's stamps (fileRiskOf), a hosts' tag's a level higher where it
// names a service new to the file (`base` as npmFileTags has it).
export function npmFileFlags(details, path, alerts = [], base = undefined) {
  const { stamps, exfiltration } = fileRiskOf(details, path), was = hostsWas(base)
  const hosts = was === undefined ? null : new Map(npmHostTags(exfiltration).map(([tag, services]) => [tag, npmHostSeverity(tag, services, was)]))
  return [...alerts.map(alert => ({ name: socketAlertName(alert.type), severity: SOCKET_SEVERITIES.get(alert.severity) ?? 'low' })),
    ...stamps.map(stamp => hosts?.has(stamp.name) ? { ...stamp, severity: hosts.get(stamp.name) } : stamp)]
}

// The hosts each file of the open version names that none of the compared
// one's named (the pair's `new-hosts` finding), by path, `[{ host, line, was
// }]` each: null until it arrives. Kept by risk read, so Compare's files are
// handed the same map until another arrives.
const newHostsRead = new WeakMap()
function npmNewHosts(base, other) {
  const risk = base && other?.npm ? npmRisk(other.npm, base.npm?.version ?? '(empty)') : null
  if (!risk) return null
  if (!newHostsRead.has(risk)) {
    const byPath = new Map()
    for (const { host, places } of findingsOf(risk).get('new-hosts')?.hosts ?? []) {
      for (const { path, line } of places) byPath.set(path, [...byPath.get(path) ?? [], { host, line, was: base.npm?.version ?? null }])
    }
    newHostsRead.set(risk, byPath)
  }
  return newHostsRead.get(risk)
}

// A file's New host tag in Compare's tree and head (npmNewHosts), its
// tooltip a row per host and line, the version none of whose files named them under.
function npmNewHostTag(hosts) {
  if (!hosts?.length) return nothing
  const label = hosts.length === 1 ? 'New host' : 'New hosts'
  const { was } = hosts[0]
  const note = `${was ? `None of ${was}'s files` : 'No file of the version compared with'} named ${hosts.length === 1 ? 'it' : 'them'}`
  return html`<span class="npm-new-host" data-tooltip=${`${label}: ${hosts.map(({ host, line }) => `${host}, line ${line}`).join('; ')} · ${note}`}
    .tooltipContent=${tipBox(label, tipFiles(hosts.map(({ host, line }) => [host, `line ${line}`])), note)}>${label}</span>`
}

// Compare's files (bundle-compare.js `source.files`) as the Overview's: type
// icons, Socket's alerts, the tags and flags of those the open version adds
// or changes, the hosts they name anew, and over them the Overview's
// readability warning, counting those alone.
export const npmCompareFiles = {
  // A file either side holds as not text is no license, whatever its name.
  icon: (path, sides) => sourceFileIcon(path, sides.map(([details, at]) => fileIconFormat(details, at)).find(isNotTextFormat)),
  alerts: details => npmSocketFileAlerts(details?.npm),
  alertTags: npmSocketFileTags,
  newHosts: npmNewHosts,
  newHostTag: npmNewHostTag,
  // Its tags, and its flags for its lists' Flags order.
  tag: (details, path, base) => npmFileTags(details, path, false, base),
  flags: (details, path, base) => npmFileFlags(details, path, [], base),
  warning(details, paths) {
    const { byPath } = npmFilesRead(details)
    const read = readabilityCounts(paths.filter(path => byPath.has(path)).map(path => byPath.get(path)))
    const { counts, marks } = read
    return readabilityWarning(read, paths.length, paths.length === 1 ? 'file added or changed' : 'files added or changed', category => {
      const { name } = READABILITY.get(category), mark = marks.get(category)
      return html`<li><span class=${`npm-extension is-${mark}`}><span>${name}</span><span class="npm-extension-count">${counts.get(category).toLocaleString('en')}</span></span></li>`
    })
  },
}

// Each finding by its chip's label, as the risk score's tooltip lists what raised it.
const FINDING_LABELS = new Map([['malware', 'Malware'], ['deprecated', 'Deprecated'], ['publisher', 'Publisher'], ['provenance-lost', 'Provenance lost'],
  ['held-install-scripts', 'Install scripts'], ['held-non-registry-deps', 'Non-registry deps'], ['held-unused-deps', 'Unused deps'], ['held-runs-code', 'Runs code'],
  ['held-credentials', 'Credentials'], ['held-exfiltration', 'Exfiltration'], ['held-remote', 'Remote'], ['held-ip-lookup', 'IP lookup'], ['held-obfuscated', 'Obfuscated'], ['large-code', 'Large new code'],
  ['now-unreadable', 'Now unreadable'], ['binary-code', 'Binary code'], ['new-hosts', 'New hosts'], ['popularity', 'Few downloads']])
const SCORE_TINTS = { critical: 'is-critical', high: 'is-warn', moderate: 'is-moderate', low: 'is-low' }
// How long a version has been out, roughly: `7 years`, `3 months`, `20 days`.
const outFor = days => days >= 730 ? `${Math.floor(days / 365)} years` : days >= 60 ? `${Math.floor(days / 30)} months` : `${days} days`

// The open version's risk score of 100 (risk/npm/score.js), first among its
// chips, its tooltip each finding that raised it and what lowered it.
function scoreBadge(risk) {
  const score = risk?.score
  if (!score) return nothing
  const { score: value, level, raised, lowered } = score
  const said = raised.map(({ id, severity }) => [FINDING_LABELS.get(id) ?? id, severity])
  const note = lowered && said.length > 0 ? `Lowered by ${Math.round(lowered.by * 100)}%: out ${outFor(lowered.days)}${lowered.tier === null ? '' : `, its package npm's ${npmTierName(lowered.tier)} by downloads`}` : null
  const tooltip = [`Risk ${value} of 100`, ...said.length === 0 ? ['Nothing found that calls for a look'] : said.map(([label, severity]) => `${label}, ${severity}`), ...note ? [note] : []].join('\n')
  return html`<li><span class=${`npm-extension npm-risk-score ${SCORE_TINTS[level]}`} data-tooltip=${tooltip} .tooltipContent=${tipBox(`Risk ${value} of 100`,
    said.length === 0 ? html`<span class="compare-tip-none">Nothing found that calls for a look</span>`
      : html`<div class="compare-tip-rows">${said.map(([label, severity]) => html`<span class="npm-risk-finding">${label}</span><span class=${`compare-tip-said npm-risk-severity sev-${severity}`}>${severity}</span>`)}</div>`,
    note)}>${socketGauge(value)}<span>Risk</span><span class="npm-extension-count">${value}</span></span></li>`
}

// What calls for a look at a version as the server's risk tells it, chips
// alike in the Overview and Compare: `sides` its versions (the one compared
// with first), `found` its findings by id. What it holds is always told, as
// no change hides any of it, what is new of it marked.
const riskChips = (sides, found) => [malwareBadge(found.get('malware')), deprecatedBadge(found.get('deprecated')), publisherBadge(sides, found.get('publisher')),
  provenanceBadge(sides, found.get('provenance-lost')), installScriptsBadge(sides, found.get('held-install-scripts')), ...dependencyBadges(sides, found),
  ...fileBadges(sides, found), hostsBadge(found.get('new-hosts')), recentBadge(found.get('too-new'))]
const findingsOf = risk => new Map((risk?.findings ?? []).map(finding => [finding.id, finding]))

// What calls for a look at Compare's two versions (`source.badges`), from
// `base` to `other`: the risk score and chips of the pair, the advisories
// affecting either, Socket's scores under their bars, and the package's tier
// by downloads where orange or red. Each once it arrives.
export function npmCompareBadges(base, other) {
  if (!base || !other?.npm) return nothing
  // A review may start from no package. Its display-only baseline has no
  // advisories or Socket report; never request an invented version upstream.
  const sides = [base.npm ?? { name: other.npm.name, version: 'Empty package', private: true }, other.npm]
  const affecting = advisoriesAffecting(sides)
  const risk = npmRisk(other.npm, base.npm?.version ?? '(empty)')
  const found = findingsOf(risk)
  const chips = [scoreBadge(risk), ...riskChips(sides, found), advisoriesBadge(sides, affecting), ...socketBadges(sides, affecting, found.get('malware')),
    popularityBadge(other.npm.name, found.get('popularity'))].filter(chip => chip !== nothing)
  return chips.length === 0 ? nothing : html`<ul class="npm-extensions npm-compare-badges" aria-label="Versions at a glance">${chips}</ul>`
}

// What calls for a look at a version on its own, in the Overview: Compare's
// chips against the version risk picks to compare it with (the one most
// likely free of an attack, risk/npm/old-version.js), its advisories and
// Socket's scores; its tier is its downloads card's.
export function npmOverviewBadges(entry) {
  const { npm } = entry
  const affecting = advisoriesAffecting([npm])
  const risk = npmRisk(npm)
  const found = findingsOf(risk)
  const sides = risk?.oldVersion ? [{ name: npm.name, version: risk.oldVersion }, npm] : [npm]
  const chips = [scoreBadge(risk), ...riskChips(sides, found), advisoriesBadge([npm], affecting), ...socketBadges([npm], affecting, found.get('malware'))].filter(chip => chip !== nothing)
  return chips.length === 0 ? nothing : html`<ul class="npm-extensions npm-overview-badges" aria-label="Version at a glance">${chips}</ul>`
}

// The files become unreadable, red, or orange where risk says less of them,
// each with its longest line before and now.
function unreadableBadge(finding) {
  const rows = finding?.files ?? []
  const said = row => [`${row.was.toLocaleString('en')} → ${row.now.toLocaleString('en')} characters`,
    ...row.rebuilt ? ['its source map rebuilt with it'] : [], ...finding.major ? ['in a major release'] : []]
  const tint = finding?.severity === 'critical' || !finding ? 'npm-compare-file' : `${SEVERITY_CHIPS[finding.severity]} npm-held-file`
  return listBadge(`${tint} npm-compare-unreadable`, 'Now unreadable', rows, said)
}

// A chip for each hosts' tag (Exfiltration, Remote, IP lookup) the open
// version's files name services under, in its severity's color, the services
// new to a file said so.
const SEVERITY_CHIPS = { critical: 'is-critical', high: 'is-warn', moderate: 'is-moderate' }
const hostBadges = found => [...HOST_TAGS.keys()].map(tag => {
  const finding = found.get(`held-${npmHostFinding(tag)}`), rows = finding?.files ?? []
  const was = row => row.added ? new Map([...row.found].filter(([service]) => !row.added.has(service))) : undefined
  return listBadge(`${SEVERITY_CHIPS[finding?.severity]} npm-held-file npm-files-${npmHostFinding(tag)}`, tag, rows, row => npmExfiltrationSaid(row.found, was(row)),
    npmExfiltrationNames(rows.map(row => row.found)))
})

// The advisories affecting each side's version: none where they couldn't be had, null until they arrive.
function advisoriesAffecting(sides) {
  const data = npmPackageAdvisories(sides.at(-1).name)
  if (data.status === 'loading') return null
  return sides.map(({ version }) => {
    const at = data.status === 'ready' ? data.versions.indexOf(version) : -1
    return at === -1 ? [] : data.advisories.filter(advisory => advisory.affected.includes(at))
  })
}

// `2 → 0`, or one number where both sides have it; `–` for a side that has none.
const fromTo = (was, now) => was === now ? `${now ?? '–'}` : `${was ?? '–'} → ${now ?? '–'}`

// The most severe of `advisories`, undefined for none.
const worstOf = advisories => SEVERITY_ORDER.find(severity => advisories.some(advisory => severityOf(advisory) === severity))

// Malware in the open version (risk/npm/malware.js): taken down by npm, and
// the malware advisories naming it, in solid red, in place of Socket's scores.
function malwareBadge(finding) {
  if (!finding) return nothing
  const said = [...finding.takenDown ? ['Taken down by npm'] : [], ...(finding.advisories ?? []).map(({ id, title }) => title ? `${id}: ${title}` : id)]
  return html`<li><span class="npm-extension npm-malware" data-tooltip=${said.join('\n')}>Malware</span></li>`
}

// The open version, where npm says it is deprecated, its message in the tooltip.
function deprecatedBadge(finding) {
  if (!finding) return nothing
  return html`<li><span class="npm-extension npm-compare-deprecated" data-tooltip=${npmDeprecation(finding.message)}>Deprecated</span></li>`
}

// The npm accounts that published each version, where they differ (a
// package changing hands, or taken over), linking the open one's profile.
// Each account by its standing (risk/npm/release.js npmAccountStanding):
// green known, yellow a maintainer, else orange; the chip in its severity's
// tint (risk/npm/compare.js): red where a known account gave way to one that isn't.
const PUBLISHER_TINTS = { critical: 'is-from-known', high: 'is-to-unknown' }
const ACCOUNT_TINTS = { known: 'is-known', maintainer: 'is-maintainer' }
const ACCOUNT_NOTES = { known: 'one that publishes one of npm\'s most downloaded packages', maintainer: 'one of the package\'s maintainers',
  new: 'an unknown publisher, new to the package', unknown: 'an unknown publisher' }
function publisherBadge([from, to], finding) {
  if (!finding) return nothing
  const { was, now, wasKnown, nowKnown, severity, major } = finding
  const wasStanding = finding.wasStanding ?? (wasKnown ? 'known' : 'unknown')
  const nowStanding = finding.nowStanding ?? (nowKnown ? 'known' : 'unknown')
  const account = (name, standing) => html`<span class=${`npm-compare-account ${ACCOUNT_TINTS[standing] ?? 'is-unknown'}`}>~${name}</span>`
  const tint = PUBLISHER_TINTS[severity] ?? 'is-to-known'
  const note = html`A different npm account published the open version,<br>${ACCOUNT_NOTES[nowStanding]},<br>after ${ACCOUNT_NOTES[wasStanding]}${major ? html`<br>in a major release` : nothing}`
  return html`<li><a class=${`npm-extension npm-compare-publisher ${tint}`} href=${`https://www.npmjs.com/~${encodeURIComponent(now)}`} target="_blank" rel="noopener noreferrer"
    data-tooltip=${`Published by ~${was} (${from.version}), then ~${now} (${to.version})`}
    .tooltipContent=${compareTip('Published by', [from, to], [account(was, wasStanding), account(now, nowStanding)], note)}>
    <span>Publisher</span><span class="npm-extension-count">${account(was, wasStanding)} → ${account(now, nowStanding)}</span></a></li>`
}

// Provenance the one compared with has and the open version hasn't, as a
// version published by hand with a stolen token wouldn't.
function provenanceBadge([from, to], finding) {
  if (!finding) return nothing
  return html`<li><span class="npm-extension npm-compare-provenance"
    data-tooltip=${`npm lists provenance for ${from.version}, none for ${to.version}`}
    .tooltipContent=${compareTip('npm provenance', [from, to], ['Listed by npm', html`<span class="compare-tip-none">None</span>`],
      'The open version was published without the provenance the one compared with has')}>Provenance lost</span></li>`
}

// The scripts npm runs installing the open version, those added or changed
// since the one compared with said so (combined.js `flagged`), their commands
// in its tooltip, the compared one's too where any changed.
function installScriptsBadge(sides, finding) {
  if (!finding) return nothing
  const { scripts, flagged = [], was } = finding
  const before = new Map(was ?? [])
  const shown = was ? sides : sides.slice(-1)
  const lists = was ? [was, scripts] : [scripts]
  const said = (list, marked) => list.length === 0 ? html`<span class="compare-tip-none">None</span>` : tipLines(list.map(([script, command]) => [script, command, marked.includes(script)]))
  const summary = scripts.map(([script]) => flagged.includes(script) ? `${script} ${before.has(script) ? 'changed' : 'added'}` : script).join(', ')
  return html`<li><span class="npm-extension is-warn npm-compare-install"
    data-tooltip=${shown.map(({ version }, i) => `${version}: ${lists[i].map(([script, command]) => `${script}: ${command}`).join('; ') || 'none'}`).join(' · ')}
    .tooltipContent=${compareTip('Install scripts', shown, lists.map((list, i) => said(list, i === lists.length - 1 ? flagged : [])))}>
    <span>${scripts.length === 1 ? 'Install script' : 'Install scripts'}</span><span class="npm-extension-count">${summary}</span></span></li>`
}

// Files a chip's styled tooltip lists before counting the rest.
const TIP_FILES = 8

// What the open version's files hold that calls for a look (risk/npm/held.js,
// combined.js), each in its severity's color, red where it changed: code run
// beyond itself, credentials reached for, services named, large new code,
// files become unreadable, obfuscation, and code files that aren't text. Each
// lists its files in its tooltip, what is new to one said so.
function fileBadges(sides, found) {
  const rows = id => found.get(id)?.files ?? []
  const tinted = (id, kind) => `${SEVERITY_CHIPS[found.get(id)?.severity]} npm-held-file ${kind}`
  return [
    listBadge(tinted('held-runs-code', 'npm-files-runs'), 'Runs code', rows('held-runs-code'), row => npmRunsCodeSaid(row.found, row.added),
      npmRunsCodeKinds(rows('held-runs-code').map(row => row.found)), null, false),
    listBadge(tinted('held-credentials', 'npm-files-credentials'), 'Credentials', rows('held-credentials'), row => npmCredentialsSaid(row.found, row.added)),
    ...hostBadges(found),
    listBadge('npm-compare-file npm-compare-large', 'Large new code', rows('large-code'), row => formatBytes(row.bytes)),
    unreadableBadge(found.get('now-unreadable')),
    listBadge(tinted('held-obfuscated', 'npm-files-obfuscated'), 'Obfuscated', rows('held-obfuscated'),
      row => `${npmObfuscationFound(row.found)}${row.added ? `, new since ${sides[0].version}` : ''}`),
    listBadge('npm-compare-file npm-compare-binary', 'Binary code', rows('binary-code'), row => `${formatBytes(row.bytes)}, not UTF-8 or holding a NUL`),
  ]
}

// The hosts the open version's code names that none of the compared one's
// named (risk/npm/compare.js npmNewHosts), each with its files and first line
// in the tooltip; one host in one place alone opens it there in Compare's
// Code (`compare-open-line`).
function hostsBadge(finding) {
  const hosts = finding?.hosts ?? []
  const rows = hosts.map(({ host, places }) => {
    const shown = places.slice(0, TIP_FILES).map(({ path, line }) => `${path}, line ${line}`)
    return { path: host, at: places.length > shown.length ? [...shown, `and ${(places.length - shown.length).toLocaleString('en')} more files`] : shown }
  })
  const [only] = hosts
  const place = hosts.length === 1 && only.places.length === 1 ? { path: only.path, line: only.line, query: only.host } : null
  return listBadge('is-warn npm-compare-hosts', rows.length === 1 ? 'New host' : 'New hosts', rows, row => row.at, rows.length === 1 ? rows[0].path : null,
    place && (event => event.currentTarget.dispatchEvent(new CustomEvent('compare-open-line', { detail: place, bubbles: true, composed: true }))))
}


// A chip on `rows`, each with a `path`, counting them (or saying `value`),
// the rows in its tooltip each with what `said` of it (a line or a list); a
// button where it can `open` what it says. Not `labelled`, its `value` alone shows.
function listBadge(classes, label, rows, said, value = null, open = null, labelled = true) {
  if (rows.length === 0) return nothing
  const shown = rows.slice(0, TIP_FILES)
  const more = rows.length > shown.length ? `and ${(rows.length - shown.length).toLocaleString('en')} more` : null
  const lines = row => [said(row)].flat()
  const tooltip = `${label}: ${[...shown.map(row => `${row.path} (${lines(row).join('; ')})`), ...more ? [more] : []].join(', ')}`
  const content = tipBox(label, tipFiles(shown.map(row => [row.path, lines(row).length > 1
    ? html`<span class="compare-tip-lines">${lines(row).map(line => html`<span>${line}</span>`)}</span>` : said(row)])), more)
  const inner = html`${labelled ? html`<span>${label}</span>` : html`<span class="sr-only">${label}</span>`}${value !== null || rows.length > 1
    ? html`<span class="npm-extension-count">${value ?? rows.length.toLocaleString('en')}</span>` : nothing}`
  return tipChip(open ? `is-open ${classes}` : classes, tooltip, content, inner, open)
}

// A chip with a styled tooltip (`tip`, `tooltip` its text): a button where
// `click` opens what it says (`popup` the kind it opens), else a span.
const tipChip = (classes, tooltip, tip, content, click = null, popup = nothing) => click
  ? html`<li><button type="button" class=${`npm-extension ${classes}`} aria-haspopup=${popup}
    data-tooltip=${tooltip}
    .tooltipContent=${tip} @click=${click}>${content}</button></li>`
  : html`<li><span class=${`npm-extension ${classes}`}
    data-tooltip=${tooltip}
    .tooltipContent=${tip}>${content}</span></li>`

// What risk tells of an unimported dependency's package
// (risk/npm/new-dependency.js): new since the version compared with and how
// old, else its tier; the version it installs where that runs install
// scripts; its spec before; that risk doesn't count it; null where it tells none.
const unusedSaid = (sides, { created, gap, level, tier, installs, missing, was, severity }) => [
  severity === 'notice' ? 'no risk counted' : null,
  was === undefined ? null : `was ${was}`,
  created ? `new package, ${gap >= 0 ? `${npmSpan(gap)} old` : 'published later'}` : missing ? 'no package npm has' : level ? `npm's ${npmTierName(tier ?? Infinity)}` : null,
  installs?.scripts ? `installs ${installs.version}${installs.latest && installs.latest !== installs.version ? ` (its latest ${installs.latest})` : ''}`
    + `${installs.new ? `, published since ${sides[0].version}` : ''}, running its install scripts` : null,
].filter(Boolean).join('; ') || null

// `Non-registry deps`, those the open version takes from elsewhere than npm's
// registry, and `Unused deps`, those nothing of it imports, which npm installs
// all the same, install scripts and all (risk/npm/combined.js); their names
// and specs in their tooltips, those new since the one compared with in bold.
function dependencyBadges(sides, found) {
  const { version } = sides.at(-1)
  const fetched = found.get('held-non-registry-deps')?.dependencies ?? [], unused = found.get('held-unused-deps')
  const unimported = unused?.dependencies ?? []
  const anew = rows => rows.some(row => row.added) ? `; new since ${sides[0].version}: ${rows.filter(row => row.added).map(({ name }) => name).join(', ')}` : ''
  const chips = []
  if (fetched.length > 0) {
    const was = fetched.filter(row => row.added).map(row => `${row.name} was ${row.was ?? 'none'}`)
    chips.push(tipChip('is-warn npm-compare-registry', `From elsewhere than npm's registry: ${fetched.map(row => `${row.name} ${row.now}`).join(', ')}${anew(fetched)}`,
      compareTip('From elsewhere than npm\'s registry', [sides.at(-1)], [tipLines(fetched.map(row => [row.name, row.now, row.added]))],
        was.length > 0 ? `New since ${sides[0].version}: ${was.join(', ')}` : null), html`
      <span>Non-registry deps</span><span class="npm-extension-count">${fetched.length.toLocaleString('en')}</span>`))
  }
  if (unimported.length > 0) {
    const [it, its] = unimported.length === 1 ? ['it', 'its'] : ['them', 'their']
    const named = row => row.kind ? `${row.name} (${row.kind})` : row.name
    chips.push(tipChip(`${unused.severity === 'notice' ? 'is-notice' : SEVERITY_CHIPS[unused.severity] ?? 'is-warn'} npm-compare-unimported`,
      `Imported by nothing of ${version}: ${unimported.map(row => `${row.name} ${row.range}${unusedSaid(sides, row) ? ` (${unusedSaid(sides, row)})` : ''}`).join(', ')}${anew(unimported)}`,
      compareTip(`Nothing imports ${it}`, [sides.at(-1)], [tipLines(unimported.map(row => [[named(row), unusedSaid(sides, row)].filter(Boolean).join(', '), row.range, row.added]))],
        `No code file of ${version} names ${it} as an import would, nor does an install script; npm installs ${it} all the same, running ${its} install scripts`), html`
      <span>Unused deps</span><span class="npm-extension-count">${unimported.length.toLocaleString('en')}</span>`))
  }
  return chips
}

// The open version, too new to trust yet (risk/npm/release.js npmTooNew): how long ago it was published.
function recentBadge(finding) {
  if (!finding) return nothing
  return html`<li><span class="npm-extension is-warn npm-compare-published" data-tooltip=${npmPublishedOn(finding.published)}>${npmAge(finding.published)}</span></li>`
}

// The advisories affecting each version, tinted by the worst still affecting
// the open one (green for none), each's by severity and how many it brings
// and fixes in the tooltip; of two, a click lists them.
function advisoriesBadge(sides, affecting) {
  if (!affecting) return nothing
  const now = affecting.at(-1), was = sides.length > 1 ? affecting[0] : now
  if (was.length === 0 && now.length === 0) return nothing
  const tint = now.length === 0 ? 'is-cleared' : `sev-${worstOf(now)}`
  const brought = now.filter(advisory => !was.includes(advisory)).length, fixed = was.filter(advisory => !now.includes(advisory)).length
  const tooltip = compareTip('Advisories affecting', sides, affecting.map(list => list.length === 0 ? html`<span class="compare-tip-none">none</span>`
    : html`<span class="compare-tip-count">${list.length}</span><span class="compare-tip-severities">${SEVERITY_ORDER
      .map(severity => [severity, list.filter(advisory => severityOf(advisory) === severity).length]).filter(([, count]) => count > 0)
      .map(([severity, count]) => html`<span class=${`compare-tip-severity sev-${severity}`}>${count} ${severity}</span>`)}</span>`),
  sides.length > 1 ? `${brought} new · ${fixed} fixed` : null)
  const text = `Advisories affecting ${sides.map(({ version }, i) => `${version}: ${affecting[i].length}`).join(', ')}`
  const content = html`<span>Advisories</span><span class="npm-extension-count">${fromTo(was.length, now.length)}</span>`
  return tipChip(`npm-compare-advisories ${tint}`, text, tooltip, content, sides.length > 1 ? () => openCompareAdvisories(sides, affecting) : null, 'dialog')
}

// A tooltip's `[name, value, flagged]` lines, `name: value`, bold where flagged, muted where none.
const tipLines = lines => html`<span class="compare-tip-lines">${lines.map(([name, value, flagged]) => value == null
  ? html`<span class="compare-tip-none">${name}: none</span>` : html`<span class=${flagged ? 'is-flagged' : nothing}>${name}: <code>${value}</code></span>`)}</span>`

// A styled tooltip: its `head`, its `body`, and a `note` under them where it has one.
const tipBox = (head, body, note = null) => html`<div class="compare-tip">
  <div class="compare-tip-head">${head}</div>
  ${body}
  ${note ? html`<div class="compare-tip-note">${note}</div>` : nothing}
</div>`
// Its rows of files (or hosts), `[path, said]` each.
const tipFiles = rows => html`<div class="compare-tip-rows is-files">${rows.map(([path, said]) => html`<span class="compare-tip-path">${path}</span><span class="compare-tip-said">${said}</span>`)}</div>`
// A badge's: a row per side's version, what is `said` of it beside.
const compareTip = (head, sides, said, note = null) => tipBox(head, html`<div class="compare-tip-rows">${sides.map(({ version }, i) => html`<span class="compare-tip-version">${version}</span><span class="compare-tip-said">${said[i]}</span>`)}</div>`, note)

// The advisories between the two versions in a dialog: those brought, kept and fixed.
function openCompareAdvisories([from, to], [was, now]) {
  const isCurrent = sessionCheck()
  const groups = [
    ['new', `New in ${to.version}`, now.filter(advisory => !was.includes(advisory))],
    ['kept', `Still affecting ${to.version}`, now.filter(advisory => was.includes(advisory))],
    ['fixed', `Fixed in ${to.version}`, was.filter(advisory => !now.includes(advisory))],
  ].filter(([, , list]) => list.length > 0).map(([status, heading, list]) => ({ status, heading, rows: list.map(advisory => npmAdvisoryRow(advisory, isCurrent)) }))
  void openNpmCompareAdvisoriesDialog({ heading: `Advisories · ${from.name} ${from.version} → ${to.version}`, groups, isCurrent })
}

// Whether Socket's vulnerability score under `bar` tells of worse than the
// advisories found (`ours`): it scores under 85 for a high one, and 25, its
// floor, for a critical one or many high (lodash 4.17.11, axios 1.7.3).
function vulnerabilityBeyond(score, ours, bar) {
  if (score === null || score >= bar) return false
  const worst = worstOf(ours)
  return worst === undefined || SEVERITY_ORDER.indexOf(score <= 25 ? 'critical' : 'high') < SEVERITY_ORDER.indexOf(worst)
}

// Socket's scores the open version has under their bars, from the one
// compared with; vulnerability only where worse than the advisories found
// (vulnerabilityBeyond). None for a private package, nor where `malware` says more.
function socketBadges(sides, affecting, malware = null) {
  const to = sides.at(-1)
  const reports = sides.map(npm => npmSocketReport({ npm })?.scores ?? null)
  if (!reports.at(-1) || malware) return []
  return SOCKET_SCORES.flatMap(([key, label, bar, good]) => {
    const scores = reports.map(side => side ? Math.round(side[key] * 100) : null)
    const after = scores.at(-1), before = sides.length > 1 ? scores[0] : after
    if (after === null || after >= bar) return []
    if (key === 'vulnerability' && !(affecting && vulnerabilityBeyond(after, affecting.at(-1), bar))) return []
    if (key === 'maintenance' && to.manifest?.deprecated && after >= DEPRECATED_MAINTENANCE) return []
    return [html`<li><a class=${`npm-extension npm-socket-score ${socketLevel(after, good)}`} href=${npmSocketHref({ npm: to })} target="_blank" rel="noopener noreferrer"
      data-tooltip=${`Socket's ${label.toLowerCase()} score: ${sides.map(({ version }, i) => `${scores[i] ?? 'none'} for ${version}`).join(', ')}`}
      .tooltipContent=${compareTip(`Socket's ${label.toLowerCase()} score`, sides, scores.map(score => score === null ? html`<span class="compare-tip-none">none</span>`
        : html`<span class=${`compare-tip-score ${socketLevel(score, good)}`}>${socketGauge(score)}${score}</span>`),
      key === 'vulnerability' ? `Shown under ${bar}, where worse than the advisories found` : `Shown under ${bar}`)}>
      ${socketGauge(after)}<span>${label}</span><span class="npm-extension-count">${fromTo(before, after)}</span></a></li>`]
  })
}

// A popularity chip's tint by its finding's severity, as its tier's tag's beside its downloads.
const POPULARITY_LEVELS = { critical: 'is-unpopular', high: 'is-low', moderate: 'is-mid' }

// Why a version's popularity is yellow at most (its `popularity` finding): a
// known account published it, or, with provenance, it is in a known scope; null where neither.
function knownNote({ known, scope, account } = {}) {
  if (!known) return null
  return account ? `Published with provenance in ${scope}, the scope of ~${account}, an account that publishes one of npm's most downloaded packages`
    : scope ? `Published with provenance in ${scope}, the scope of one of npm's most downloaded packages, which only its owner publishes in`
    : 'Published by an account that publishes one of npm\'s most downloaded packages'
}

// A package's tier among npm's by downloads (`{ tier, level }`), its `last`
// complete month's downloads in its tooltip; as a `chip`, tinted by its
// finding's severity, yellow at most where known (knownNote).
function tierTag(finding, last = null, chip = false) {
  const { tier, level, severity } = finding
  const total = last?.total.toLocaleString('en')
  const kind = chip ? `npm-extension npm-popularity npm-downloads-tier ${POPULARITY_LEVELS[severity] ?? 'is-low'}` : `npm-downloads-tier ${level}`
  const note = chip ? knownNote(finding) : null
  const tooltip = [last && `${total} downloads/month, ${last.month}`, note].filter(Boolean).join(' · ')
  return html`<span class=${kind} data-tooltip=${tooltip || nothing}
    .tooltipContent=${last || note ? html`${last ? html`<div><strong>${total}</strong> downloads/month</div><div class="compare-tip-note">${last.month}</div>` : nothing}${
      note ? html`<div class="compare-tip-note">${note}</div>` : nothing}` : null}>${npmTierName(tier ?? Infinity)}</span>`
}

// The package's tier where orange or red, its last month's downloads in its tooltip.
function popularityBadge(name, finding) {
  const stats = npmPackageStats(name)
  if (!finding) return nothing
  return html`<li>${tierTag(finding, stats.status === 'ready' && stats.downloads ? npmLastMonth(stats.downloads) : null, true)}</li>`
}

// A new dependency's tier where npm counts none of its downloads yet, as it
// counts from the day after first publish (axios 1.14.1 named plain-crypto-js,
// published the morning before): as unpopular as can be.
const UNCOUNTED_TAG = html`<span class="npm-downloads-tier is-unpopular"
  data-tooltip="No downloads counted by npm, which counts a package's from the day after it was first published">unpopular</span>`

// How long `ms` is: minutes, hours, days, then months past two, years past two (`18 hours`).
const spanIn = unit => new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'long' })
const SPANS = { minute: spanIn('minute'), hour: spanIn('hour'), day: spanIn('day'), month: spanIn('month'), year: spanIn('year') }
function npmSpan(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(minutes / (24 * 60))
  return minutes < 60 ? SPANS.minute.format(minutes) : minutes < 24 * 60 ? SPANS.hour.format(Math.floor(minutes / 60))
    : days < 60 ? SPANS.day.format(days) : days < 730 ? SPANS.month.format(Math.floor(days / 30.44)) : SPANS.year.format(Math.floor(days / 365.25))
}

// A new dependency whose package didn't exist when the version compared with
// was published (risk/npm/new-dependency.js): how old it was when the open
// one was, or that it came after, as a name taken once a release named it would.
function newPackageTag({ compared }, { created, gap }) {
  if (!created) return nothing
  const [base, open] = compared, span = npmSpan(Math.abs(gap))
  const lines = [`First published on ${npmPublishedDay(created)}`, `${span} ${gap >= 0 ? 'before' : 'after'} ${open.version} was`]
  const note = `npm had no package by its name when ${gap >= 0 ? base.version : 'either version'} was published`
  return html`<span class="npm-dependency-flag is-new" data-tooltip=${[...lines, note].join(' · ')}
    .tooltipContent=${html`<div class="compare-tip"><div class="compare-tip-head">New package</div>${lines.map(line => html`<div>${line}</div>`)}<div class="compare-tip-note">${note}</div></div>`}
    >${gap >= 0 ? `${span} old` : 'published later'}</span>`
}

// What tags a dependency Compare lists (`source.dependencyTags`): its flags,
// and for a new one its package's tier and age as risk tells them. No tier
// for one changed or removed, nor one risk tells none of (not from the
// registry, its name's package's downloads not its own).
export function npmDependencyTags(row, kind) {
  const flags = npmDependencyFlagTags(row.flags)
  if (kind !== 'added' || !row.level) return [flags, nothing]
  const month = row.month ? npmMonthSaid({ total: row.month.total, from: new Date(row.month.from) }) : null
  return [flags, row.uncounted ? UNCOUNTED_TAG : tierTag(row, month), row.compared ? newPackageTag(row, row) : nothing]
}

// The readable files, as chips, UTF-8 and ASCII apart.
function npmReadableRow(entry, details) {
  const { counts } = npmFilesRead(details)
  const present = READABLE.filter(category => counts.has(category))
  if (present.length === 0) return nothing
  return html`<ul class="npm-extensions" aria-label="Readable files">${present.map(category => categoryChip(entry, details, category))}</ul>`
}

// A file's extension: what follows its name's last dot, `.d.ts` (`.d.mts`,
// `.d.cts`) whole, '' for none past its first character (`LICENSE`, `.npmignore`).
export function npmFileExtension(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const declaration = /\.d\.[cm]?ts$/iu.exec(name)
  if (declaration && declaration.index > 0) return declaration[0].toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

// The package's extensions, most files first, then by name: `{ extension,
// files, bytes, lines }`, `lines` null where none of its files is text.
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

// The files every package has at its root: its manifest, readme and license files.
const PACKAGE_FILE = /^(?:package\.json|readme(?:\.md)?)$/iu
const isNpmPackageFile = path => PACKAGE_FILE.test(path) || NPM_LICENSE_FILE.test(path)

// The package's file types: its own files as `package`, then its extensions,
// one only its own files have left out.
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

// The package's file types as chips, each narrowing the Files list, its files' size in its tooltip.
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

// What the package holds, under its facts: its languages, readable files and
// file types, then Socket's scores.
export function npmContents(entry, languages, details) {
  const rows = [['languages', 'Languages', languages], ['readable', 'Readable', npmReadableRow(entry, details)], ['types', 'File types', npmFileTypesRow(entry, details)],
    ['socket', 'Socket', npmSocketRow(entry)]]
    .filter(([, , body]) => body !== nothing)
  if (rows.length === 0) return nothing
  return html`<dl class="npm-contents" aria-label="Contents">${rows.map(([key, label, body]) => html`<div class=${`npm-contents-${key}`}><dt>${label}</dt><dd>${body}</dd></div>`)}</dl>`
}

// The binary files (`paths`, sorted: not UTF-8, or holding a NUL), in a column of their own.
export function npmBinaryColumn(paths, sizes) {
  if (paths.size === 0) return nothing
  return overviewColumn({ title: 'Binary files', count: paths.size, list: true, body: html`<ul class="bundles-sources-list">${[...paths].map(path => html`<li>
      <div class="bundles-source-row is-resource">
        ${sourceFileIcon(path, 'binary')}<span class="bundles-source-path" data-tooltip-truncated data-tooltip=${path}>${path}</span>
        ${sizes.has(path) ? html`<span class="bundles-source-size">${formatBytes(sizes.get(path))}</span>` : nothing}
      </div>
    </li>`)}</ul>` })
}
