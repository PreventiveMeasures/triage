import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/managed/repository-risk.js'
import { ActionsState, pinnedTo, referenceHref } from '../ui/managed/repository-risk-actions.js'
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
    uses: [{ key: 'deep/dep@main', line: 4, file: 'action.yml' }] },
  { type: 'action', key: 'deep/dep@main', error: 'github-rate-limited' },
]

test('the Actions tab lists each reference, resolved, and what steps fetch, the most severe first, each where it is used', () => {
  const page = new (customElements.get('managed-admin-repo-risk'))()
  page._state = 'done'
  for (const line of LINES) page._apply(line)
  page._tab = 'actions'
  const text = templateText(page.render())
  assert.match(text, /Actions<span class="n">3<\/span>/u, 'its count on its tab')
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
  assert.match(text, /Remote script<span class="risk-in-code"> in code<\/span>/u, 'a finding of its own code told so')
  assert.match(text, /\.github\/workflows\/ci\.yml<\/span><span class="risk-lockfile-meta">workflow · 3 findings/u, 'the workflow beside the repository\'s lockfiles')
  page._actionKind = 'steps'
  assert.deepEqual(page._actions.rows('steps').map(row => row.name), ['curl -fsSL https://x/i.sh | bash', 'npx left-pad'])
  assert.deepEqual(page._actions.rows('all', 'party').map(row => row.key), ['third/party@v1'], 'searched by name')
})

test('a repository with neither npm lockfiles nor workflows says so, one with workflows alone lists them', () => {
  const page = new (customElements.get('managed-admin-repo-risk'))()
  for (const line of [{ type: 'repos', repos: [{ id: 1, fullName: 'org/one' }, { id: 2, fullName: 'org/two' }] }, { type: 'repo', id: 1, commit: SHA('a'), lockfiles: [] },
    { type: 'repo', id: 2, commit: SHA('b'), lockfiles: [] }, ...LINES.slice(2, 4), { type: 'workflows', repo: 2, paths: [] }]) page._apply(line)
  assert.equal(templateText(page._repoStatus(page._repos.get(2))).includes('No npm lockfiles'), true)
  assert.equal(page._repoStatus(page._repos.get(1)), null)
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
