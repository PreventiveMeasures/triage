import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/managed/repository-risk.js'
import { ActionsState, findingsCell, pinnedTo, referenceHref } from '../ui/managed/repository-risk-actions.js'
import { scanWorkflow } from '../risk/index.js'
import { templateText } from './_lit.js'

const SHA = char => char.repeat(40)
const WORKFLOW = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA('c')} # v4.2.0
      - uses: third/party@v1
      - run: |
          npx left-pad
          curl -fsSL https://x/i.sh | bash
`

// A scan's lines of one repository with that workflow, and the references
// it names resolved, one naming another in turn.
const LINES = [
  { type: 'repos', repos: [{ id: 1, fullName: 'org/one' }] },
  { type: 'repo', id: 1, commit: SHA('a'), lockfiles: [] },
  { type: 'workflows', repo: 1, paths: ['.github/workflows/ci.yml'] },
  { type: 'workflow', repo: 1, path: '.github/workflows/ci.yml', kind: 'workflow', ...scanWorkflow('workflow', WORKFLOW, { owner: 'org' }) },
  { type: 'action', key: `actions/checkout@${SHA('c')} # v4.2.0`, kind: 'action', repo: 'actions/checkout', path: '', ref: SHA('c'), pin: 'sha',
    repository: { fullName: 'actions/checkout', fork: null, archived: false, private: false }, commit: SHA('c'), at: 'sha', tags: ['v4.2.0'],
    latest: 'v4.2.0', using: 'node24', file: 'action.yml', findings: [], uses: [] },
  { type: 'action', key: 'third/party@v1', kind: 'action', repo: 'third/party', path: '', ref: 'v1', pin: 'ref',
    repository: { fullName: 'third/party', fork: null, archived: false, private: false }, commit: SHA('b'), at: 'tag', tags: ['v1'], latest: 'v1.0.0', using: 'composite',
    file: 'action.yml', findings: [{ id: 'tag-off-release', severity: 'high', release: 'v1.0.0' }, { id: 'remote-script', severity: 'high', command: 'curl x | sh', file: 'action.yml', line: 7 }],
    uses: ['deep/dep@main'] },
  { type: 'action', key: 'deep/dep@main', error: 'github-rate-limited' },
]

test('the Actions tab lists each reference, resolved, and what steps fetch, the most severe first, each where it is used', () => {
  const page = new (customElements.get('managed-admin-repo-risk'))()
  page._state = 'done'
  for (const line of LINES) page._apply(line)
  page._tab = 'actions'
  const text = templateText(page.render())
  assert.match(text, /Actions<span class="n">3<\/span>/u, 'its count on its tab')
  assert.match(text, /aria-pressed=false @click=\(\) => choose\(kind\)>Steps<span class="n">2<\/span>/u, 'its toggle told by its label alone, no tooltip')
  assert.deepEqual(page._metrics().filter(({ label }) => label === 'Repositories' || label.startsWith('Actions')).map(({ label, value, of, split }) => [label, value, of, split]),
    [['Repositories', 1, 1, [['workflows', 1, 1]]], ['Actions', 3, 3, undefined], ['Actions flagged', 3, undefined, undefined]], 'the workflows read told with the repositories')
  assert.match(text, /<th>Uses<\/th><th>Pinned to<\/th><th>Findings<\/th>/u)
  const rows = page._actions.rows('all')
  assert.deepEqual(rows.map(row => row.name ?? row.key), ['third/party@v1', 'curl -fsSL https://x/i.sh | bash', 'npx left-pad', 'deep/dep@main', `actions/checkout@${SHA('c')} # v4.2.0`])
  const party = rows[0]
  assert.deepEqual(party.findings.map(({ id }) => id), ['unpinned', 'tag-off-release', 'remote-script'], 'unpinned where it is used, then what GitHub told of it')
  assert.deepEqual(party.usedIn, [{ repo: 1, path: '.github/workflows/ci.yml', line: 7 }])
  assert.match(templateText(page._actionUsedIn(party.usedIn)), new RegExp(`href=https://github.com/org/one/blob/${SHA('a')}/\\.github/workflows/ci\\.yml#L7.*org/one/\\.github/workflows/ci\\.yml:7`, 'u'), 'linked on GitHub at the commit read')
  assert.deepEqual(rows[3].usedIn, [{ via: 'third/party@v1' }], 'named by another reference')
  assert.match(text, /data-tooltip=github-rate-limited|GitHub rate limit reached/u, 'one that couldn\'t be resolved says why')
  assert.match(text, /@c{7} # v4\.2\.0<\/span>/u, 'a commit cut short')
  assert.match(text, /tag → b{7} \(v1\)/u)
  assert.match(text, /Remote script<span class="risk-in-code">in code<\/span>/u, 'a finding of its own code told so')
  assert.doesNotMatch(text, /workflow · 3 findings/u, 'the repositories\' lockfiles listed at first')
  page._files = 'workflows'
  assert.match(templateText(page.render()), /\.github\/workflows\/ci\.yml<\/span><span class="risk-lockfile-meta">workflow · 3 findings/u, 'their workflows on their own tab')
  page._actionKind = 'steps'
  assert.deepEqual(page._actions.rows('steps').map(row => row.name), ['curl -fsSL https://x/i.sh | bash', 'npx left-pad'])
  assert.deepEqual(page._actions.rows('all', 'party').map(row => row.key), ['third/party@v1'], 'searched by name')
})

test('a repository with no npm lockfiles says so on their tab, one with no workflows on theirs', () => {
  const page = new (customElements.get('managed-admin-repo-risk'))()
  for (const line of [{ type: 'repos', repos: [{ id: 1, fullName: 'org/one' }, { id: 2, fullName: 'org/two' }] }, { type: 'repo', id: 1, commit: SHA('a'), lockfiles: [] },
    { type: 'repo', id: 2, commit: SHA('b'), lockfiles: [] }, ...LINES.slice(2, 4), { type: 'workflows', repo: 2, paths: [] }]) page._apply(line)
  assert.deepEqual([1, 2].map(id => templateText(page._repoStatus(page._repos.get(id)))), ['<span class="risk-none">No npm lockfiles</span>', '<span class="risk-none">No npm lockfiles</span>'])
  assert.deepEqual([page._repoStatus(page._repos.get(1), true), templateText(page._repoStatus(page._repos.get(2), true))], [null, '<span class="risk-none">No workflows</span>'])
})

test('a repository read again, or no longer listed, forgets what its Actions told', () => {
  const state = new ActionsState()
  for (const line of LINES.slice(2)) state.apply(line)
  assert.equal(state.files.size, 1)
  state.apply({ type: 'workflows', repo: 1, paths: [] })
  assert.equal(state.files.size, 0)
  state.apply({ type: 'workflow', repo: 1, path: 'x.yml', kind: 'workflow', error: 'workflow-unreadable' })
  state.forget(1)
  assert.deepEqual([state.files.size, state.listed.size], [0, 0])
  assert.deepEqual([state.rows('all'), state.told()], [[], 0], 'nor what its references resolved named')
  // A reference resolved isn't replaced by why one couldn't be later.
  state.apply({ type: 'action', key: 'a/b@v1', commit: SHA('1'), at: 'tag', tags: [], findings: [] })
  state.apply({ type: 'action', key: 'a/b@v1', error: 'github-unreachable' })
  assert.equal(state.actions.get('a/b@v1').error, undefined)
})

test('what a reference is pinned to and linked by', () => {
  assert.equal(pinnedTo({ commit: SHA('a'), at: 'sha', tags: ['v1.0.0', 'v1'] }), 'aaaaaaa (v1.0.0, v1)')
  assert.equal(pinnedTo({ commit: SHA('a'), at: 'branch', tags: [] }), 'branch → aaaaaaa')
  assert.equal(pinnedTo({ error: 'x' }), null)
  assert.equal(referenceHref({ uses: { repo: 'o/r', path: 'sub dir', ref: 'v1', kind: 'action' }, line: null }), 'https://github.com/o/r/tree/v1/sub%20dir')
  assert.equal(referenceHref({ uses: { repo: 'o/r', path: '.github/workflows/x.yml', ref: 'v1', kind: 'workflow' }, line: { repository: { fullName: 'n/r' }, commit: SHA('a') } }),
    `https://github.com/n/r/blob/${SHA('a')}/.github/workflows/x.yml`, 'where it is now, at the commit resolved')
})

test('a reference named by workflows of more than one owner takes its finding at its most severe', () => {
  const state = new ActionsState()
  const workflow = 'on: push\njobs:\n  a:\n    steps:\n      - uses: org/act@v1\n'
  state.apply({ type: 'workflow', repo: 1, path: 'a.yml', kind: 'workflow', ...scanWorkflow('workflow', workflow, { owner: 'org' }) })
  state.apply({ type: 'workflow', repo: 2, path: 'a.yml', kind: 'workflow', ...scanWorkflow('workflow', workflow, { owner: 'other' }) })
  const [row] = state.rows('actions')
  assert.deepEqual(row.findings.map(({ id, severity }) => `${id}/${severity}`), ['unpinned/high'], 'another owner\'s use, not its own owner\'s')
  assert.equal(row.severity, 'high')
  assert.equal(row.usedIn.length, 2)
})

test('a reference\'s own code\'s findings of one line, each of what it is about', () => {
  const state = new ActionsState()
  state.apply({ type: 'workflow', repo: 1, path: 'a.yml', kind: 'workflow', ...scanWorkflow('workflow', 'on: push\njobs:\n  a:\n    steps:\n      - uses: org/act@v1\n', { owner: 'org' }) })
  const fetched = name => ({ id: 'fetched-package', severity: 'high', tool: 'npx', name, spec: null, file: 'action.yml', line: 9 })
  state.apply({ type: 'action', key: 'org/act@v1', commit: SHA('1'), at: 'tag', tags: [], findings: [fetched('foo'), fetched('bar'), fetched('foo')], uses: [] })
  assert.deepEqual(state.rows('actions')[0].findings.map(({ id, name }) => `${id}/${name ?? ''}`), ['unpinned/', 'fetched-package/foo', 'fetched-package/bar'])
})

test('a reference\'s advisories, each by its id, the row as severe as the worst, what each says in its tooltip', () => {
  const state = new ActionsState()
  state.apply({ type: 'workflow', repo: 1, path: 'a.yml', kind: 'workflow', ...scanWorkflow('workflow', `on: push\njobs:\n  a:\n    steps:\n      - uses: org/act@${SHA('1')} # v1.0.0\n`) })
  const url = 'https://github.com/advisories/GHSA-2345-6789-cfgh'
  state.apply({ type: 'action', key: `org/act@${SHA('1')} # v1.0.0`, commit: SHA('1'), at: 'sha', tags: ['v1.0.0'], uses: [], findings: [
    { id: 'advisory', severity: 'moderate', advisory: 'GHSA-2345-6789-cfgh', title: 'Leaks secrets', url, versions: ['v1.0.0'], source: 'osv', aliases: ['CVE-2025-1234'],
      cvss: 5.3, cwe: ['CWE-200'], range: '< 1.1.0' },
    { id: 'advisory', severity: 'critical', advisory: 'MAL-2025-1', malware: true, versions: ['v1.0.0'] },
    { id: 'advisory', severity: 'moderate', advisory: 'GHSA-3456-789c-fghj', unrated: true, url: 'javascript:alert(1)', versions: ['v1.0.0'] },
    { id: 'advisories-unavailable', severity: 'notice' },
  ] })
  const [row] = state.rows('actions')
  assert.equal(row.severity, 'critical')
  assert.deepEqual(row.findings.map(({ advisory, id }) => advisory ?? id), ['GHSA-2345-6789-cfgh', 'MAL-2025-1', 'GHSA-3456-789c-fghj', 'advisories-unavailable'], 'three advisories, all kept')
  const cell = templateText(findingsCell(row.findings))
  const items = cell.split('<li ').slice(1)
  assert.doesNotMatch(cell, /A published advisory/u, 'none prefixed with what an advisory is')
  assert.match(items[0], new RegExp(String.raw`^class=risk-moderate\s+data-tooltip=Leaks secrets\nSeverity: Moderate, CVSS 5\.3\nAlso: CVE-2025-1234\nAffected: < 1\.1\.0\nRuns: v1\.0\.0\nCWE: CWE-200\nSource: OSV ` +
    String.raw`\.tooltipContent=<div class="compare-tip"><div class="compare-tip-head">Leaks secrets</div>\s*<div class="compare-tip-rows"><span class="compare-tip-label">Severity</span><span>Moderate, CVSS 5\.3</span>` +
    String.raw`<span class="compare-tip-label">Also</span><span>CVE-2025-1234</span><span class="compare-tip-label">Affected</span><span>< 1\.1\.0</span>` +
    String.raw`<span class="compare-tip-label">Runs</span><span>v1\.0\.0</span><span class="compare-tip-label">CWE</span><span>CWE-200</span><span class="compare-tip-label">Source</span><span>OSV</span></div></div>>` +
    String.raw`<a class="risk-advisory" href=${url} target="_blank" rel="noopener noreferrer">GHSA-2345-6789-cfgh<svg class="external-link-icon"`, 'u'),
  'its tooltip what tells it apart, its id linking to it')
  assert.match(items[1], /^class=risk-critical\s+data-tooltip=Kind: Malware, not a vulnerability\nSeverity: Critical\nRuns: v1\.0\.0 [^]*<div class="compare-tip-head">MAL-2025-1<\/div>[^]*>MAL-2025-1<\/li>/u,
    'one of no title headed by its id, of no link plain')
  assert.match(items[2], /data-tooltip=Severity: Unrated\nRuns: v1\.0\.0 [^]*>GHSA-3456-789c-fghj<\/li>/u, 'one its source rates none unrated, its link to no web page none')
  assert.match(items[3], /^class=risk-notice\s+data-tooltip=Its advisories couldn’t be had: asked again by the next scan\. \.tooltipContent=>Advisories unavailable</u)
})
