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
import { fetchNpmAdvisories, fetchNpmProvenance, fetchNpmSocket, fetchNpmStats } from './client-managed.js'
import { factFile, npmAge, npmDependencyChecks, npmDeprecation, npmPackageData, npmPublishedDay, npmPublishedOn } from './npm-package.js'
import { NPM_LICENSE_FILE } from './npm-entries.js'
import { npmDependencyFlagTags } from './npm-dependency-checks.js'
import { render } from './render.js'
import { state } from '#client/index.js'
import { openAdvisoryDetailsDialog } from './dialogs/advisory-details-dialog.js'
import { openNpmCompareAdvisoriesDialog } from './dialogs/npm-compare-advisories-dialog.js'
import { fileIconFormat, isNotTextFormat, sourceFileIcon } from './source-file-icon.js'
import { overviewColumn } from './bundle-overview-column.js'
import { encodePath } from './bundle-origin-links.js'
import { compact, npmLastMonth, npmMonthSaid, npmTierName } from './npm-downloads-chart.js'
import { READABILITY, npmFileFlagTags, npmFileReadabilityOf, npmLabelMark, npmListedReadabilityTag, npmObfuscationFound, npmReadabilityLabels } from './file-readability.js'
import { npmRisk } from './npm-risk.js'
import { fileRiskOf, npmFilesRisk } from './file-risk.js'
import { npmFileRunsCode, npmRunsCodeKinds, npmRunsCodeSaid, npmRunsCodeTags } from './file-runs-code.js'
import { npmExfiltrationNames, npmExfiltrationSaid, npmExfiltrationTag, npmFileExfiltration } from './file-hosts.js'
import { HOST_TAGS, npmHostSeverity, npmHostTags } from '../../risk/files/hosts.js'
import { npmHostFinding } from '../../risk/npm/held.js'

// Advisories' severities, most severe first, and an advisory's (`unknown`
// where it gives none of them).
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'unknown']
const severityOf = advisory => SEVERITY_ORDER.includes(advisory.severity) ? advisory.severity : 'unknown'
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
// which each one's `affected` indexes; `keptAt`, where its repository's are
// as GitHub last listed them, when that was.
function npmPackageAdvisories(name) {
  return npmPackageData('advisories', name, () => fetchNpmAdvisories(name),
    data => ({ versions: data.versions ?? [], advisories: data.advisories ?? [], repository: data.repository !== false, keptAt: data.keptAt ?? null }))
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
// Socket's maintenance score for a deprecated version, for that alone: one no
// lower says no more than Compare's Deprecated chip does.
const DEPRECATED_MAINTENANCE = 50

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
export function npmStatsRow(entry, actions, badges = nothing) {
  const stats = npmPackageStats(entry.npm.name)
  return html`<div class="npm-figures">
    <npm-downloads-chart role="region" aria-label="Downloads" .downloads=${stats.downloads} .status=${stats.status}></npm-downloads-chart>
    <div class="npm-figures-actions">${npmPackageLinks(entry)}${actions}</div>
    ${badges}
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

// What built a version, as its provenance names its builder: GitHub Actions,
// on a runner GitHub hosts or one of the publisher's own, or GitLab CI.
// npm's provenance for a public version npm lists it for, as the session
// has it; null for any other.
const provenanceOf = ({ name, version, private: hidden, manifest }) => hidden || !manifest.provenance ? null
  : npmPackageData('provenance', `${name}@${version}`, () => fetchNpmProvenance(name, version), answer => ({ provenance: answer.provenance ?? null }))

// Whether the version's provenance names what built it, or may yet, being
// asked for: where it does, no other fact need name the CI that published
// it (npm-package.js npmOverviewMeta).
export function npmProvenanceNamesBuilder(npm) {
  const data = provenanceOf(npm)
  return data !== null && (data.status === 'loading' || Boolean(data.provenance?.builder))
}

// What built a version, by its builder's id and its runner's (npm-provenance.ts
// `runner`): GitHub's names its own runners or the publisher's; GitLab's
// names the runner in its project (`<project>/-/runners/<id>`), whoever's.
function builderName(builder, runner) {
  if (!builder) return null
  if (/^https:\/\/github\.com\/actions\/runner(?:\/github-hosted)?$/u.test(builder)) return 'GitHub Actions'
  if (builder.startsWith('https://github.com/actions/runner/')) return 'GitHub Actions, self-hosted runner'
  if (builder.startsWith('https://gitlab.com/') || builder.includes('/-/runners/')) return runner === 'self-hosted' ? 'GitLab CI, self-hosted runner' : 'GitLab CI'
  return new URL(builder).host
}
// Built on its provider's own runners, as its certificate says, or, where
// it doesn't, as GitHub's builder id does.
const isHosted = (built, runner) => runner ? runner === 'github-hosted' || runner === 'gitlab-hosted' : built === 'GitHub Actions'

// npm's provenance for the version, in the Overview's facts, for a public
// package (npm-provenance.ts): what built it, from which repository at
// which commit, by which workflow, in which run, and its transparency log
// entry, flagged where it was built from another repository than the one
// the package names. A version npm keeps none for says so; one npm lists
// it for but whose statement the server doesn't read (as when it names
// another tarball) is flagged, as nothing vouches for it; nothing for a
// private package, which can't have any.
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
  // The repository the package names, GitHub's or GitLab's, as its source
  // reads.
  const named = manifest.github?.github ?? (manifest.gitlab ? `gitlab.com/${manifest.gitlab}` : null)
  const elsewhere = named && named.toLowerCase() !== shown.toLowerCase()
  // What built it and from where, then how, beside it where that fits, else
  // on a line of its own: its workflow, by its file's name (its whole path
  // in its tooltip, where that says more), its run and its log entry. Built
  // on GitHub's or GitLab's own runners from the repository it names, it is
  // green.
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
  return advisoryRow({ ...advisory, title: advisory.title ?? advisory.id, severity: severityOf(advisory),
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
  // Where the repository's advisories are as GitHub last listed them, how
  // long ago; where they couldn't be had, that npm's are alone.
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

// How many of `readabilities` each category has, a file under each label it
// has (npmReadabilityLabels), each category marked as the most it is on one of
// them (npmLabelMark: long lines a warning where some are unexpected), and
// how many files can be hard to review by reading them, each once
// (`unreadable`).
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

// What the Overview reads of a version's files, once a version and once its
// risk arrives (file-risk.js npmFilesRisk): their `paths`, each one's readability
// (npmFileReadabilityOf) where it is known, extension and size by path, how
// many files each category has and how many can be hard to review by reading
// them (readabilityCounts), the `binaries`, those with no text, sorted, its
// file types (npmFileTypes), and its `content`: its text files, their lines
// of code and all its files' bytes (`unpacked`), the package's own files
// (isNpmPackageFile) left out, as every package has them.
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

// A category's chip, finding each file labelled with it.
function categoryChip(entry, details, category) {
  const { name } = READABILITY.get(category)
  const { byPath, counts, marks } = npmFilesRead(details)
  const mark = marks.get(category)
  return filterChip(entry, { id: `category:${category}`, label: name, keeps: path => byPath.has(path) && npmReadabilityLabels(byPath.get(path)).includes(category) },
    html`<span>${name}</span>`, counts.get(category), { classes: mark ? ` is-${mark}` : '' })
}

// Where any of `total` files (`files` naming them) can be hard to review by
// reading it, as readabilityCounts has them: how many, each category's
// `chip` showing which.
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

// A file's tags in the Files list and Compare's: what it can run beyond itself
// (npmRunsCode), the services it names under the hosts' tags
// (npmExfiltration), its flags (npmFileFlagTags), then how it reads; with
// `opens`, for the Files list, whose rows open a file's code, the first two on
// one line opening it there; with `base`, Compare's, the file as the version
// compared with has it (`{ details, path }`, null for one it adds), a tag
// naming a service new to it a level higher.
export function npmFileTags(details, path, opens = false, base = undefined) {
  const { byPath, sizes } = npmFilesRead(details)
  const at = opens ? path : undefined
  return html`${npmRunsCodeTags(npmFileRunsCode(details, path), undefined, at)}${npmExfiltrationTag(npmFileExfiltration(details, path), hostsWas(base), at)}${npmFileFlagTags(details, path, sizes.get(path))}${npmListedReadabilityTag(byPath.get(path))}`
}

// The services a file named as the version compared with has it (`base`,
// `{ details, path }`): null for one it adds (`base` null), and undefined
// where nothing is compared, or that version's risk hasn't arrived.
const hostsWas = base => base === undefined || (base?.details.npm && !npmFilesRisk(base.details)) ? undefined
  : base && npmFileExfiltration(base.details, base.path)

// A file's flags as its tags show them (file-flags.js): Socket's `alerts` on
// it, by their severity, where the list draws them (the Files list's, not
// Compare's), then its stamps, as risk read it (file-risk.js fileRiskOf), with
// `base` as npmFileTags has it, a hosts' tag's a level higher where it names
// a service new to the file.
export function npmFileFlags(details, path, alerts = [], base = undefined) {
  const { stamps, exfiltration } = fileRiskOf(details, path), was = hostsWas(base)
  const hosts = was === undefined ? null : new Map(npmHostTags(exfiltration).map(([tag, services]) => [tag, npmHostSeverity(tag, services, was)]))
  return [...alerts.map(alert => ({ name: socketAlertName(alert.type), severity: SOCKET_SEVERITIES.get(alert.severity) ?? 'low' })),
    ...stamps.map(stamp => hosts?.has(stamp.name) ? { ...stamp, severity: hosts.get(stamp.name) } : stamp)]
}

// Compare's files (bundle-compare.js `source.files`) as the Overview's: each
// one's type icon and Socket's alerts on it, the tags of one the open version
// adds or changes, and over them, where any of those can be hard to review by reading it, the Overview's
// warning, counting those alone.
export const npmCompareFiles = {
  // A file either side holds as not text, under that side's path, is no
  // license, whatever its name.
  icon: (path, sides) => sourceFileIcon(path, sides.map(([details, at]) => fileIconFormat(details, at)).find(isNotTextFormat)),
  // Socket's alerts on a side's files, and their tags (npmSocketFileAlerts).
  alerts: details => npmSocketFileAlerts(details?.npm),
  alertTags: npmSocketFileTags,
  // Its tags, and its flags as they show them, for its lists' Flags order,
  // `base` the file as the version compared with has it (npmFileTags).
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

// What calls for a look at Compare's two versions (bundle-compare.js
// `source.badges`), from the one compared with (`base`) to the open one
// (`other`), each side's details: what the server's risk finds of the pair
// (npm-risk.js npmRisk; risk/npm/compare.js npmCompareFindings: malware the
// open version is told of, an open version npm says is deprecated, a publisher
// that changed, provenance lost, install scripts added or changed,
// dependencies it takes from elsewhere than npm's registry anew and new ones
// nothing of it imports, the files it adds or changes that call for one, the
// hosts its code names anew, an open version too new to trust yet, and the
// package's tier by downloads where it is orange or red), each a chip, then
// the advisories that affect either,
// Socket's scores either has under its bar (SOCKET_SCORES; maintenance, for
// a deprecated open version, only under DEPRECATED_MAINTENANCE). Each once
// it arrives.
export function npmCompareBadges(base, other) {
  if (!base?.npm || !other?.npm) return nothing
  const sides = [base.npm, other.npm]
  const affecting = advisoriesAffecting(sides)
  const found = new Map((npmRisk(other.npm, base.npm.version)?.findings ?? []).map(finding => [finding.id, finding]))
  const chips = [malwareBadge(found.get('malware')), deprecatedBadge(found.get('deprecated')), publisherBadge(sides, found.get('publisher')), provenanceBadge(sides, found.get('provenance-lost')),
    installScriptsBadge(sides, found.get('install-scripts')), ...dependencyBadges(sides, found), ...fileBadges(found), hostsBadge(found.get('new-hosts')),
    recentBadge(found.get('too-new')), advisoriesBadge(sides, affecting), ...socketBadges(sides, affecting, found.get('malware')), popularityBadge(other.npm.name, found.get('popularity'))]
    .filter(chip => chip !== nothing)
  return chips.length === 0 ? nothing : html`<ul class="npm-extensions npm-compare-badges" aria-label="Versions at a glance">${chips}</ul>`
}

// What calls for a look at a version on its own (`entry`, read as
// `details`), in the Overview, as Compare's chips say of two
// (npmCompareBadges), but for those only a change from one to the other
// tells (a publisher, provenance, files and hosts new): what the server's
// risk finds of it (npm-risk.js npmRisk; risk/npm/held.js: malware it is
// told of, its deprecation, its install scripts, what any of its
// files runs beyond itself, an exfiltration host one names and an
// obfuscator's fingerprint in one, and its age under the minimum release
// age; not its tier by downloads, which its downloads' card over them
// shows), dependencies it takes from elsewhere than npm's registry or
// imports nothing of (npm-package.js npmDependencyChecks), the advisories
// affecting it, and Socket's scores under their bars. Each once it arrives.
export function npmOverviewBadges(entry) {
  const { npm } = entry
  const affecting = advisoriesAffecting([npm])
  const found = new Map((npmRisk(npm)?.findings ?? []).map(finding => [finding.id, finding]))
  const chips = [malwareBadge(found.get('malware')), deprecatedBadge(found.get('deprecated')), heldInstallScriptsBadge(npm, found.get('held-install-scripts')),
    ...npmDependencyChecks(npm).map(chip => html`<li>${chip}</li>`), ...heldFileBadges(found), recentBadge(found.get('too-new')), advisoriesBadge([npm], affecting),
    ...socketBadges([npm], affecting, found.get('malware'))].filter(chip => chip !== nothing)
  return chips.length === 0 ? nothing : html`<ul class="npm-extensions npm-overview-badges" aria-label="Version at a glance">${chips}</ul>`
}

// The scripts npm runs installing a version (risk/npm/held.js), named, their
// commands in its tooltip, in orange as Compare's are where they are added or
// changed.
function heldInstallScriptsBadge(npm, finding) {
  if (!finding) return nothing
  const { scripts } = finding
  return html`<li><span class="npm-extension is-warn npm-compare-install" data-tooltip=${scripts.map(([script, command]) => `${script}: ${command}`).join('; ')}
    .tooltipContent=${compareTip('Install scripts', [npm], [tipLines(scripts.map(([script, command]) => [script, command, false]))])}>
    <span>${scripts.length === 1 ? 'Install script' : 'Install scripts'}</span><span class="npm-extension-count">${scripts.map(([script]) => script).join(', ')}</span></span></li>`
}

// What a version's files hold that calls for a look (risk/npm/held.js), in
// orange as their tags are: what any of them runs beyond itself, the kinds
// named; the services they name, a chip a hosts' tag in its severity's color
// (hostBadges); and an obfuscator's fingerprint. Each lists its files in its
// tooltip, what each holds and where, and nothing more.
function heldFileBadges(found) {
  const rows = id => found.get(id)?.files ?? []
  return [
    listBadge('is-warn npm-held-file npm-overview-runs', 'Runs code', rows('held-runs-code'), row => npmRunsCodeSaid(row.found), npmRunsCodeKinds(rows('held-runs-code').map(row => row.found))),
    ...hostBadges(found, 'held-', 'npm-overview', 'found'),
    listBadge('is-warn npm-held-file npm-overview-obfuscated', 'Obfuscated', rows('held-obfuscated'), row => npmObfuscationFound(row.found)),
  ]
}

// The files become unreadable (`now-unreadable`), as a file chip: red, or
// orange where risk says less of them, each with its longest line before and
// now, and its source map rebuilt with it where it was, or the release major.
function unreadableBadge(finding) {
  const rows = finding?.files ?? []
  const said = row => [`${row.was.toLocaleString('en')} → ${row.now.toLocaleString('en')} characters`,
    ...row.rebuilt ? ['its source map rebuilt with it'] : [], ...finding.major ? ['in a major release'] : []]
  return finding?.severity === 'critical' || !finding ? fileBadge('npm-compare-unreadable', 'Now unreadable', rows, said)
    : listBadge(`${SEVERITY_CHIPS[finding.severity]} npm-held-file npm-compare-unreadable`, 'Now unreadable', rows, said)
}

// A chip for each hosts' tag a finding names services under (risk/npm/held.js
// and compare.js: Exfiltration, Remote, IP lookup), its id `prefix`ed, in its
// severity's color, red, orange or yellow, the services named, each file's
// as its row's `key` holds them; its class `kind`ed by where it shows.
const SEVERITY_CHIPS = { critical: 'is-critical', high: 'is-warn', moderate: 'is-moderate' }
const hostBadges = (found, prefix, kind, key) => [...HOST_TAGS.keys()].map(tag => {
  const finding = found.get(`${prefix}${npmHostFinding(tag)}`), rows = finding?.files ?? []
  return listBadge(`${SEVERITY_CHIPS[finding?.severity]} npm-held-file ${kind}-${npmHostFinding(tag)}`, tag, rows, row => npmExfiltrationSaid(row[key]),
    npmExfiltrationNames(rows.map(row => row[key])))
})

// The advisories affecting each side's version, as the Advisories column
// has them: none where they couldn't be had, and null until they arrive.
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

// The open version, where the server's risk tells of malware in it
// (risk/npm/malware.js): its package taken down by npm, whatever version is
// asked, and the advisories of malware naming it, each a line of its
// tooltip; first, in solid red, in place of Socket's scores (socketBadges).
function malwareBadge(finding) {
  if (!finding) return nothing
  const said = [...finding.takenDown ? ['Taken down by npm'] : [], ...(finding.advisories ?? []).map(({ id, title }) => title ? `${id}: ${title}` : id)]
  return html`<li><span class="npm-extension npm-malware" data-tooltip=${said.join('\n')}>Malware</span></li>`
}

// The open version, where npm says it is deprecated: its message in the
// tooltip, as the Overview lists it (npmDeprecation).
function deprecatedBadge(finding) {
  if (!finding) return nothing
  return html`<li><span class="npm-extension npm-compare-deprecated" data-tooltip=${npmDeprecation(finding.message)}>Deprecated</span></li>`
}

// The npm account that published each version, where npm says for both and
// they differ, as when a package changes hands, or is taken over: linking
// to the open version's publisher's profile. Each account by its standing on
// the package, as risk tells it (risk/npm/release.js npmAccountStanding):
// green where it is known to publish one of npm's most downloaded packages
// (npm-packages.ts npmManifest's `knownAccounts`), yellow where it is one of
// the package's maintainers (on it three months, or first to publish it),
// else orange, an unknown publisher, new to it where risk says so. The chip
// in its severity's tint (risk/npm/compare.js): grey to a known account or
// one of the package's maintainers, orange to another, and red where a known
// one gave way to one that isn't, a level lower in a major release. Its
// tooltip's note a line each: that the account changed, what the open
// version's is, what the one before's was, and a major release.
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

// Provenance the one compared with has and the open version hasn't (npm's
// manifests say; npm-packages.ts npmManifest), as a version published by
// hand, with a token taken from its maintainers, wouldn't.
function provenanceBadge([from, to], finding) {
  if (!finding) return nothing
  return html`<li><span class="npm-extension npm-compare-provenance"
    data-tooltip=${`npm lists provenance for ${from.version}, none for ${to.version}`}
    .tooltipContent=${compareTip('npm provenance', [from, to], ['Listed by npm', html`<span class="compare-tip-none">None</span>`],
      'The open version was published without the provenance the one compared with has')}>Provenance lost</span></li>`
}

// The scripts npm runs installing the open version (install-scripts.js
// npmInstallScripts, node-gyp's for a binding.gyp among them) that the one
// compared with didn't, or ran another command for; one dropped isn't
// flagged. Each version's, with their commands, in its tooltip, those
// added or changed in bold.
function installScriptsBadge(sides, finding) {
  if (!finding) return nothing
  const { was, now, flagged } = finding
  const said = (list, marked) => list.size === 0 ? html`<span class="compare-tip-none">None</span>` : tipLines([...list].map(([script, command]) => [script, command, marked.includes(script)]))
  const summary = flagged.map(script => `${script} ${was.has(script) ? 'changed' : 'added'}`).join(', ')
  return html`<li><span class="npm-extension is-warn npm-compare-install"
    data-tooltip=${sides.map(({ version }, i) => `${version}: ${[...[was, now][i]].map(([script, command]) => `${script}: ${command}`).join('; ') || 'none'}`).join(' · ')}
    .tooltipContent=${compareTip('Install scripts', sides, [said(was, []), said(now, flagged)])}>
    <span>${flagged.length === 1 ? 'Install script' : 'Install scripts'}</span><span class="npm-extension-count">${summary}</span></span></li>`
}

// Files a chip's styled tooltip lists before counting the rest.
const TIP_FILES = 8

// What the open version does to its files that calls for a look, as risk
// finds it (risk/npm/compare.js npmFileFindings), each a red chip, though the
// tags it gives a file (npmFileTags) say little of one alone, or warn of it in
// orange: code that runs beyond itself new to a file, the kinds named; the
// services under a hosts' tag new to a file, a chip a tag, red, or orange for
// an IP lookup (hostBadges), the services named;
// a large code file it adds; a file become unreadable, its longest line before
// and now, in orange where its finding is (a major release, or each file's
// source map rebuilt with it); and a file newly obfuscated. Then in orange, as a file's tags are,
// what any of its files runs beyond itself that the red chip doesn't name,
// kept from the version compared with.
function fileBadges(found) {
  const rows = id => found.get(id)?.files ?? []
  return [
    fileBadge('npm-compare-runs', 'Runs code', rows('runs-code'), row => npmRunsCodeSaid(row.added), npmRunsCodeKinds(rows('runs-code').map(row => row.added))),
    ...hostBadges(found, '', 'npm-compare', 'added'),
    fileBadge('npm-compare-large', 'Large new code', rows('large-code'), row => formatBytes(row.bytes)),
    unreadableBadge(found.get('now-unreadable')),
    fileBadge('npm-compare-obfuscated', 'Obfuscated', rows('obfuscated'), row => npmObfuscationFound(row.obfuscation)),
    listBadge('is-warn npm-compare-kept-runs', 'Runs code', rows('kept-runs-code'), row => npmRunsCodeSaid(row.found), npmRunsCodeKinds(rows('kept-runs-code').map(row => row.found))),
  ]
}

// The hosts the open version's code names in its URLs that the one compared
// with's named in none of its (risk/npm/compare.js npmNewHosts), as a chip in
// orange, as install scripts are: the host, or how many; each in its tooltip
// with every file that names it (TIP_FILES at most) and the line it is first
// named on there. One host named in one place alone, the chip opens it there,
// at its line, in Compare's Code (`compare-open-line`).
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

// A chip on `rows`, files the open version adds or changes, in red.
function fileBadge(kind, ...rest) {
  return listBadge(`npm-compare-file ${kind}`, ...rest)
}

// A chip on `rows`, each with a `path`, counting them where there are
// several, or saying `value` of them all, the rows in its tooltip alone, each
// with what `said` of it (a line, or a list of them), and nothing more; a
// button, where it is to `open` what it says.
function listBadge(classes, label, rows, said, value = null, open = null) {
  if (rows.length === 0) return nothing
  const shown = rows.slice(0, TIP_FILES)
  const more = rows.length > shown.length ? `and ${(rows.length - shown.length).toLocaleString('en')} more` : null
  const lines = row => [said(row)].flat()
  const tooltip = `${label}: ${[...shown.map(row => `${row.path} (${lines(row).join('; ')})`), ...more ? [more] : []].join(', ')}`
  const content = html`<div class="compare-tip">
      <div class="compare-tip-head">${label}</div>
      <div class="compare-tip-rows is-files">${shown.map(row => html`<span class="compare-tip-path">${row.path}</span><span class="compare-tip-said">${lines(row).length > 1
        ? html`<span class="compare-tip-lines">${lines(row).map(line => html`<span>${line}</span>`)}</span>` : said(row)}</span>`)}</div>
      ${more ? html`<div class="compare-tip-note">${more}</div>` : nothing}
    </div>`
  const inner = html`<span>${label}</span>${value !== null || rows.length > 1 ? html`<span class="npm-extension-count">${value ?? rows.length.toLocaleString('en')}</span>` : nothing}`
  return open
    ? html`<li><button type="button" class=${`npm-extension is-open ${classes}`}
      data-tooltip=${tooltip}
      .tooltipContent=${content} @click=${open}>${inner}</button></li>`
    : html`<li><span class=${`npm-extension ${classes}`}
      data-tooltip=${tooltip}
      .tooltipContent=${content}>${inner}</span></li>`
}

// As `Non-registry deps`, the dependencies the open version takes from
// elsewhere than npm's registry, where the one compared with didn't, or by
// another spec; and, as `Unused deps`, those it adds that nothing of it
// imports, which npm installs all the same, its install scripts and all, as
// a dependency added to run them would be (risk/npm/compare.js
// npmDependencyFindings, as Compare's package.json flags each). Their names
// and specs in their tooltips, each version's for those from elsewhere.
function dependencyBadges(sides, found) {
  const fetched = found.get('non-registry-deps')?.dependencies ?? [], unimported = found.get('unused-deps')?.dependencies ?? []
  const chips = []
  if (fetched.length > 0) {
    const said = (key, marked) => tipLines(fetched.map(row => [row.name, row[key], marked]))
    chips.push(html`<li><span class="npm-extension is-warn npm-compare-registry"
      data-tooltip=${sides.map(({ version }, i) => `${version}: ${fetched.map(row => `${row.name} ${row[i === 0 ? 'was' : 'now'] ?? 'none'}`).join('; ')}`).join(' · ')}
      .tooltipContent=${compareTip('From elsewhere than npm\'s registry', sides, [said('was', false), said('now', true)])}>
      Non-registry deps</span></li>`)
  }
  if (unimported.length > 0) {
    const { version } = sides[1]
    const [it, its] = unimported.length === 1 ? ['it', 'its'] : ['them', 'their']
    chips.push(html`<li><span class="npm-extension is-warn npm-compare-unimported"
      data-tooltip=${`New in ${version}, imported by nothing of it: ${unimported.map(({ name, range }) => `${name} ${range}`).join(', ')}`}
      .tooltipContent=${compareTip(`New, and nothing imports ${it}`, [sides[1]], [tipLines(unimported.map(({ name, range, kind }) => [kind ? `${name} (${kind})` : name, range, true]))],
        `No code file of ${version} names ${it} as an import would, nor does an install script; npm installs ${it} all the same, running ${its} install scripts`)}>
      Unused deps</span></li>`)
  }
  return chips
}

// The open version, where it is too new to trust yet (risk/npm/release.js
// npmTooNew): how long ago it was published, the day in its tooltip.
function recentBadge(finding) {
  if (!finding) return nothing
  return html`<li><span class="npm-extension is-warn npm-compare-published" data-tooltip=${npmPublishedOn(finding.published)}>${npmAge(finding.published)}</span></li>`
}

// The advisories affecting each version, tinted by the worst still affecting
// the open one, or green where none does; each version's, by severity, and
// how many the open one brings and fixes, in its tooltip; a click lists them
// (npm-compare-advisories-dialog.js). For one version alone, those affecting
// it, the Overview's Advisories column listing them.
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
  return sides.length > 1 ? html`<li><button type="button" class=${`npm-extension npm-compare-advisories ${tint}`} aria-haspopup="dialog"
    data-tooltip=${text} .tooltipContent=${tooltip} @click=${() => openCompareAdvisories(sides, affecting)}>${content}</button></li>`
    : html`<li><span class=${`npm-extension npm-compare-advisories ${tint}`} data-tooltip=${text} .tooltipContent=${tooltip}>${content}</span></li>`
}

// A tooltip's lines, `[name, value, flagged]` each, `name: value` one to a
// line, its value as code, bold where flagged; `name: none`, muted, where it
// has no value.
const tipLines = lines => html`<span class="compare-tip-lines">${lines.map(([name, value, flagged]) => value == null
  ? html`<span class="compare-tip-none">${name}: none</span>` : html`<span class=${flagged ? 'is-flagged' : nothing}>${name}: <code>${value}</code></span>`)}</span>`

// A badge's styled tooltip: its `head`, a row for each side's version and
// what is said of it, and a `note` under them.
const compareTip = (head, sides, said, note = null) => html`<div class="compare-tip">
  <div class="compare-tip-head">${head}</div>
  <div class="compare-tip-rows">${sides.map(({ version }, i) => html`<span class="compare-tip-version">${version}</span><span class="compare-tip-said">${said[i]}</span>`)}</div>
  ${note ? html`<div class="compare-tip-note">${note}</div>` : nothing}
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
// compared with to the open one (or the one version's alone), its ring, tint
// and link the open one's; none for a private package. Vulnerability only
// where it tells of worse than the advisories found affecting it
// (vulnerabilityBeyond), once they arrive, as the Advisories badge has the
// rest. None where the open version is told of `malware` (malwareBadge),
// which says more of it than any score.
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

// A popularity chip's tint, by its finding's severity, as the other chips'.
const POPULARITY_TINTS = { critical: 'is-critical', high: 'is-warn', moderate: 'is-moderate' }

// A package's tier among npm's by its downloads, as risk tells it (`{ tier,
// level }`, its rank, Infinity past the last, and its tint), its `last`
// complete month's downloads in its tooltip where known, over the month's
// name (npm-downloads-chart.js npmLastMonth); a `chip` as the chips beside
// it are, in its finding's severity's tint, red, orange or yellow, a level
// lower where a known account published the version (`known`), as its
// tooltip says.
function tierTag({ tier, level, severity, known }, last = null, chip = false) {
  const total = last?.total.toLocaleString('en')
  const kind = chip ? `npm-extension npm-popularity ${POPULARITY_TINTS[severity] ?? 'is-warn'}` : `npm-downloads-tier ${level}`
  const note = chip && known ? 'Published by an account that publishes one of npm\'s most downloaded packages' : null
  const tooltip = [last && `${total} downloads/month, ${last.month}`, note].filter(Boolean).join(' · ')
  return html`<span class=${kind} data-tooltip=${tooltip || nothing}
    .tooltipContent=${last || note ? html`${last ? html`<div><strong>${total}</strong> downloads/month</div><div class="compare-tip-note">${last.month}</div>` : nothing}${
      note ? html`<div class="compare-tip-note">${note}</div>` : nothing}` : null}>${npmTierName(tier ?? Infinity)}</span>`
}

// The package's tier where it is orange or red, as the server's risk finds
// it (`popularity`), a chip as its neighbours are (tierTag), its last
// complete month's downloads, as its figures have them, in its tooltip:
// those asked for alongside, so they come with it.
function popularityBadge(name, finding) {
  const stats = npmPackageStats(name)
  if (!finding) return nothing
  return html`<li>${tierTag(finding, stats.status === 'ready' && stats.downloads ? npmLastMonth(stats.downloads) : null, true)}</li>`
}

// A new dependency's tier where npm counts none of its package's downloads:
// none of its days counted yet, as npm counts a package's from the day after
// it was first published (axios 1.14.1, 21 minutes past midnight, named
// plain-crypto-js, first published the morning before). As unpopular as
// one can be, as its tier by its downloads would be once counted: a package
// that new had none before its latest two weeks. Not a private one, whose
// downloads npm's API tells no one, however many it has.
const UNCOUNTED_TAG = html`<span class="npm-downloads-tier is-unpopular"
  data-tooltip="No downloads counted by npm, which counts a package's from the day after it was first published">unpopular</span>`

// How long `ms` is, as npmAge counts: in minutes, then hours, then days,
// months past two months, years past two years (`18 hours`).
const spanIn = unit => new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'long' })
const SPANS = { minute: spanIn('minute'), hour: spanIn('hour'), day: spanIn('day'), month: spanIn('month'), year: spanIn('year') }
function npmSpan(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(minutes / (24 * 60))
  return minutes < 60 ? SPANS.minute.format(minutes) : minutes < 24 * 60 ? SPANS.hour.format(Math.floor(minutes / 60))
    : days < 60 ? SPANS.day.format(days) : days < 730 ? SPANS.month.format(Math.floor(days / 30.44)) : SPANS.year.format(Math.floor(days / 365.25))
}

// A new dependency whose package didn't exist when the version compared
// with was published, as the server's risk tells it (its `created` and
// `gap`, risk/npm/new-dependency.js npmAddedDependency): how old it was
// when the open one was, or that it came after that, as a name someone took
// once a release named it would; in its tooltip, a line each, the day, how
// long before or after the open version, and what npm had.
function newPackageTag({ compared }, { created, gap }) {
  if (!created) return nothing
  const [base, open] = compared, span = npmSpan(Math.abs(gap))
  const lines = [`First published on ${npmPublishedDay(created)}`, `${span} ${gap >= 0 ? 'before' : 'after'} ${open.version} was`]
  const note = `npm had no package by its name when ${gap >= 0 ? base.version : 'either version'} was published`
  return html`<span class="npm-dependency-flag is-new" data-tooltip=${[...lines, note].join(' · ')}
    .tooltipContent=${html`<div class="compare-tip"><div class="compare-tip-head">New package</div>${lines.map(line => html`<div>${line}</div>`)}<div class="compare-tip-note">${note}</div></div>`}
    >${gap >= 0 ? `${span} old` : 'published later'}</span>`
}

// What tags a dependency Compare lists (bundle-compare.js source's
// `dependencyTags`): what calls for a look at it (its `flags`,
// npm-dependency-checks.js), and for a new one what the server's risk tells
// of its package (npm-package.js npmFlaggedDependencyChanges, as
// risk/npm/new-dependency.js npmAddedDependency tells it): its tier by its
// downloads, whatever it is, unpopular where npm counts none of a public
// one's (UNCOUNTED_TAG), and how old it was where it is new since the
// version compared with (newPackageTag). No tier for one changed or removed,
// which the version compared with already had, nor one risk tells none of,
// as one that opens no package (npm-package.js npmDependencies), which npm
// doesn't install from the registry, whose package of its name has
// downloads that aren't its own.
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
// files (npm-entries.js NPM_LICENSE_FILE).
const PACKAGE_FILE = /^(?:package\.json|readme(?:\.md)?)$/iu
const isNpmPackageFile = path => PACKAGE_FILE.test(path) || NPM_LICENSE_FILE.test(path)

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
        ${sourceFileIcon(path, 'binary')}<span class="bundles-source-path" data-tooltip-truncated data-tooltip=${path}>${path}</span>
        ${sizes.has(path) ? html`<span class="bundles-source-size">${formatBytes(sizes.get(path))}</span>` : nothing}
      </div>
    </li>`)}</ul>` })
}
