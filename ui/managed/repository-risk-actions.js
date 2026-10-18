// The Actions tab of Manage → Repositories → Risk (repository-risk.js): what
// each repository's workflows pull in, as the scan tells it
// (server-managed/repository-actions.ts): each action and reusable workflow
// of another repository, by its key, resolved on GitHub, what it is pinned
// to and what it calls for, its own code's findings among them; and each
// thing a workflow's steps fetch or run past a pin, by what it is, wherever
// it is. Each row is used in the workflows that name it, each linked to its
// line on GitHub at the commit read, or in the actions that name it in turn.
import { html, nothing } from 'lit'
import { SEVERITIES } from '../../risk/files/stamps.js'
import { encodePath } from '../view/bundle-origin-links.js'

// What each finding is called, and what it says, beside what it found.
const ACTION_FINDINGS = {
  'unpinned': ['Unpinned', 'By a tag or a branch, which its repository’s owner can point anywhere, not a full commit sha.'],
  'short-sha': ['Short sha', 'A short sha, which GitHub reads as a branch or tag named so too.'],
  'unpinned-image': ['Image by tag', 'An image by a tag, which its publisher can move, not a digest.'],
  'fetched-package': ['Fetched package', 'A package fetched and run as it resolves now, past what a lockfile locks.'],
  'unlocked-install': ['Unlocked install', 'An install that resolves anew where package.json and the lockfile disagree; npm ci holds to the lockfile.'],
  'remote-script': ['Remote script', 'A script fetched and run as it is fetched.'],
  'clone': ['Clone', 'A repository cloned at whatever its branch has.'],
  'hosts': ['Host', 'A service malicious code sends what it takes to, or fetches what it runs from.'],
  'script-injection': ['Script injection', 'An expression anyone can write, in a script: what it holds runs as the script’s own code.'],
  'pwn-request': ['Runs a fork’s code', 'Checks out a pull request’s own code where the workflow runs with the base repository’s secrets.'],
  'untrusted-artifact': ['Untrusted artifact', 'Takes another run’s artifacts, which a fork’s pull request writes, where the workflow runs with secrets.'],
  'secrets-inherited': ['Inherits secrets', 'Another owner’s reusable workflow handed every secret.'],
  'invalid-uses': ['Invalid', 'A uses: GitHub can’t read.'],
  'deprecated-runtime': ['Old Node.js', 'A Node.js GitHub no longer runs actions on.'],
  'repo-missing': ['Repository missing', 'No such repository on GitHub: anyone who takes its owner’s name can publish one.'],
  'repo-moved': ['Repository moved', 'Renamed or transferred: GitHub redirects the old name until someone takes it.'],
  'repo-fork': ['Fork', 'A fork of another repository.'],
  'repo-archived': ['Archived', 'Archived by its owner.'],
  'branch-ref': ['Branch', 'A branch, which moves with every push.'],
  'ambiguous-ref': ['Tag and branch', 'A tag and a branch of the same name.'],
  'ref-missing': ['Ref missing', 'Neither a tag nor a branch: GitHub runs whichever is pushed first.'],
  'not-version': ['Not a version', 'A tag that is no version.'],
  'tag-off-release': ['Tag off release', 'A major or minor tag on a commit no release of its line is on, as a tag moved by whoever took the repository is.'],
  'tag-off-branch': ['Tag off branch', 'The tag’s commit is on none of its branches, as a release’s built files may be.'],
  'outdated': ['Outdated', 'An older major version than the latest release.'],
  'imposter-commit': ['Imposter commit', 'In the history of none of the repository’s branches and releases: GitHub serves a fork’s commit under the name of the repository it forked.'],
  'unverified-commit': ['Unverified commit', 'In the history of none of the branches and releases looked at; it has more.'],
  'commit-missing': ['Commit missing', 'GitHub has no such commit.'],
  'untagged-commit': ['Untagged commit', 'A commit no tag names: no release.'],
  'comment-mismatch': ['Comment mismatch', 'The version the comment beside it names isn’t this commit’s.'],
  'action-missing': ['No action.yml', 'No action.yml where it names, at the commit.'],
  'unreadable': ['Unreadable', 'Its file couldn’t be read as GitHub reads it.'],
}
const HOST_LABELS = { 'Exfiltration': 'Exfiltration host', 'Remote': 'Remote host', 'IP lookup': 'IP lookup' }

export const ACTION_KINDS = {
  all: ['All'],
  actions: ['Actions', 'Actions and reusable workflows of other repositories, resolved on GitHub.'],
  steps: ['Steps', 'What workflows’ steps fetch or run past a pin, and what else they call for.'],
}

export const severityRank = severity => SEVERITIES.includes(severity) ? SEVERITIES.indexOf(severity) : SEVERITIES.length
const worst = findings => findings.reduce((best, { severity }) => severityRank(severity) < severityRank(best) ? severity : best, null)
const findingLabel = finding => finding.id === 'hosts' ? HOST_LABELS[finding.tag] ?? 'Host' : ACTION_FINDINGS[finding.id]?.[0] ?? finding.id

// What a finding found, as its tooltip tells it beside what it says.
function findingDetail(finding) {
  const parts = []
  if (finding.id === 'fetched-package') parts.push(stepName(finding), ...finding.localFirst ? [finding.locked ? (finding.installed ? '' : 'locked, but run before any install') : 'no lockfile here locks it'] : [])
  if (finding.services) parts.push(finding.services.join(', '))
  if (finding.expression) parts.push(`\${{ ${finding.expression} }}`)
  if (finding.to) parts.push(`now ${finding.to}`)
  if (finding.parent) parts.push(`of ${finding.parent}`)
  if (finding.latest) parts.push(`latest ${finding.latest}`)
  if (finding.release) parts.push(`its line’s latest release is ${finding.release}`)
  if (finding.comment) parts.push(`# ${finding.comment}, ${finding.tags?.length ? `tags here: ${finding.tags.join(', ')}` : 'no tag is on it'}`)
  if (finding.image) parts.push(finding.image)
  if (finding.file) parts.push(`in ${finding.file}${finding.line ? `, line ${finding.line}` : ''}`)
  if (finding.detail) parts.push(finding.detail)
  return [ACTION_FINDINGS[finding.id]?.[1], ...parts.filter(Boolean)].filter(Boolean).join('\n')
}

// What a step's finding is about, as its row is named: its package, its
// image, its expression, or what it is.
function stepName(finding) {
  if (finding.id === 'fetched-package') return `${finding.tool} ${finding.name}${finding.spec ? `@${finding.spec}` : ''}`
  if (finding.id === 'unlocked-install') return finding.tool
  if (finding.id === 'unpinned-image') return finding.image
  if (finding.id === 'clone') return `git clone ${finding.url ?? ''}`.trim()
  if (finding.id === 'hosts') return finding.services.join(', ')
  if (finding.id === 'script-injection') return `\${{ ${finding.expression} }}`
  if (finding.id === 'secrets-inherited' || finding.id === 'invalid-uses') return finding.uses
  if (finding.id === 'deprecated-runtime') return `runs.using: ${finding.using}`
  if (finding.id === 'remote-script' && finding.command) return finding.command
  if (finding.id === 'pwn-request' && finding.ref) return finding.ref === 'gh pr checkout' ? finding.ref : `actions/checkout ref: ${finding.ref}`
  return findingLabel(finding)
}

// The workflows, actions and repositories' Actions a scan told, by its
// lines: each repository's workflows listed, or why not, and its files by
// path; each reference resolved, by key; and the rows of them all (rows),
// built once for what is told.
export class ActionsState {
  constructor() {
    this.listed = new Map()
    this.files = new Map()
    this.actions = new Map()
    this.built = null
  }

  apply(line) {
    this.built = null
    if (line.type === 'workflows') { this.forget(line.repo); this.listed.set(line.repo, line) }
    else if (line.type === 'workflow') (this.files.get(line.repo) ?? this.files.set(line.repo, new Map()).get(line.repo)).set(line.path, line)
    else if (line.type === 'action' && (!line.error || !this.actions.has(line.key))) this.actions.set(line.key, line)
  }

  // What a repository no longer listed, or read again, told: forgotten.
  forget(repo) {
    this.listed.delete(repo)
    this.files.delete(repo)
    this.built = null
  }

  filesOf(repo) {
    return [...this.files.get(repo)?.values() ?? []]
  }

  // How much is told, for a scan's parts to tell whether one went further.
  told() {
    return this.listed.size + this.actions.size + [...this.files.values()].reduce((sum, files) => sum + files.size, 0)
  }

  // Workflows listed and read, and references named and resolved.
  counts() {
    const named = this.rows('actions')
    return { workflows: [...this.listed.values()].reduce((sum, line) => sum + (line.paths?.length ?? 0), 0),
      workflowsRead: [...this.files.values()].reduce((sum, files) => sum + [...files.values()].filter(file => file.kind === 'workflow').length, 0),
      actions: named.length, resolved: named.filter(row => row.line).length }
  }

  // A row of each reference, resolved or not yet, and of each thing steps
  // fetch or run past a pin, or else call for, by what it is: where it is
  // used (`usedIn`, a file's line or a reference naming it), its findings and
  // the worst. The most severe first, then, of none, those that couldn't be
  // resolved, those still to be, and those found nothing of; then those of
  // more findings, then by name.
  #build() {
    const refs = new Map(), steps = new Map()
    const ref = key => refs.get(key) ?? refs.set(key, { key, kind: 'action', usedIn: [], local: [] }).get(key)
    for (const [repo, files] of this.files) {
      for (const file of files.values()) {
        for (const uses of file.uses ?? []) if (uses.key) Object.assign(ref(uses.key), { uses }).usedIn.push({ repo, path: file.path, line: uses.line })
        for (const finding of file.findings ?? []) {
          if (finding.key) { ref(finding.key).local.push(finding); continue }
          const name = stepName(finding)
          const key = `${finding.id}\0${finding.tag ?? ''}\0${name}`
          const at = steps.get(key) ?? steps.set(key, { key, kind: 'step', name, findings: [finding], severity: finding.severity, usedIn: [] }).get(key)
          if (severityRank(finding.severity) < severityRank(at.severity)) Object.assign(at, { severity: finding.severity, findings: [finding] })
          at.usedIn.push({ repo, path: file.path, line: finding.line })
        }
      }
    }
    for (const line of this.actions.values()) for (const { key } of line.uses ?? []) ref(key).usedIn.push({ via: line.key })
    for (const at of refs.values()) {
      const seen = new Set()
      at.line = this.actions.get(at.key) ?? null
      at.findings = [...at.local, ...at.line?.findings ?? []].filter(finding => { const key = `${finding.id}\0${finding.file ?? ''}\0${finding.file ? finding.line : ''}`; return !seen.has(key) && seen.add(key) })
      at.severity = worst(at.findings)
    }
    const standing = row => row.findings.length > 0 ? 0 : row.line?.error ? 1 : row.line || row.kind === 'step' ? 3 : 2
    return [...refs.values(), ...steps.values()].toSorted((a, b) => severityRank(a.severity) - severityRank(b.severity) || standing(a) - standing(b)
      || b.findings.length - a.findings.length || (a.name ?? a.key).localeCompare(b.name ?? b.key))
  }

  // The rows of `kind` (ACTION_KINDS) searched for.
  rows(kind, query = '') {
    this.built ??= this.#build()
    const text = query.trim().toLowerCase()
    return this.built.filter(row => (kind === 'all' || (kind === 'actions') === (row.kind === 'action')) && (!text || (row.name ?? row.key).toLowerCase().includes(text)))
  }
}

// What a reference is pinned to, as GitHub resolved it: its commit, and
// the tags on it; null where it isn't resolved.
export function pinnedTo(line) {
  if (!line || line.error || !line.commit) return null
  const short = line.commit.slice(0, 7)
  const tags = line.tags?.length ? ` (${line.tags.join(', ')})` : ''
  if (line.at === 'sha') return `${short}${tags}`
  return `${line.at === 'branch' ? 'branch' : 'tag'} → ${short}${tags}`
}

// The findings' cell of a row: each by its severity, its tooltip saying what
// it found, and where in a resolved reference's own code.
export function findingsCell(findings) {
  return html`<ul class="risk-findings">${findings.map(finding => html`<li class=${`risk-${finding.severity}`}
    data-tooltip=${findingDetail(finding) || nothing}>${findingLabel(finding)}${finding.file ? html`<span class="risk-in-code"> in code</span>` : nothing}</li>`)}</ul>`
}

// A reference's link on GitHub at the ref it names, its path in it.
export function referenceHref({ uses, line }) {
  const repo = line?.repository?.fullName ?? uses?.repo ?? line?.repo
  const ref = line?.commit ?? uses?.ref ?? line?.ref
  if (!repo || !ref) return null
  const path = uses?.path ?? line?.path ?? ''
  return `https://github.com/${repo}/${line?.kind === 'workflow' || uses?.kind === 'workflow' ? 'blob' : 'tree'}/${encodeURIComponent(ref)}${path ? `/${encodePath(path)}` : ''}`
}
