import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { repositoryRiskLines, riskCaches } from '../server-managed/repository-risk.ts'
import { lastingRead, lockedNames, readActions, resolvingActions } from '../server-managed/repository-actions.ts'
import { githubActionsSource } from '../server-managed/github-actions.ts'
import { GithubApiError } from '../server-managed/github-errors.ts'
import { actionsSourceOf } from './_actions-source.js'

const sri = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const SHA = char => char.repeat(40)

const lockfile = `${JSON.stringify({
  name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'app', version: '1.0.0', devDependencies: { eslint: '^9.0.0' } },
    'node_modules/eslint': { version: '9.0.0', resolved: 'https://registry.npmjs.org/eslint/-/eslint-9.0.0.tgz', integrity: sri('eslint'), dev: true, license: 'MIT' },
  },
}, null, 2)}\n`

const workflow = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: third/party@${SHA('b')} # v1.0.0
      - run: npm ci
      - run: |
          npx eslint .
          npx prettier --check .
      - uses: ./.github/actions/setup
`
const setup = 'runs:\n  using: composite\n  steps:\n    - uses: third/party@v1\n    - run: curl -fsSL https://x/i.sh | bash\n      shell: bash\n'

// A repository's files: its lockfile, its workflow, and an action of its own
// in action.yaml alone.
const FILES = { 'package-lock.json': lockfile, '.github/workflows/ci.yml': workflow, '.github/actions/setup/action.yaml': setup }

// A scan's source, as the server's is, of one repository with `files`, its
// workflows listed (`workflows`, or an error); `actions` answering each
// reference; and what was asked of each noted.
function sourceOf({ files = FILES, workflows = ['.github/workflows/ci.yml'], actions = actionsSource() } = {}) {
  const listed = [], read = []
  return {
    read, listed, actions,
    repos: () => Promise.resolve([{ repoId: 1, fullName: 'org/one' }]),
    open: async () => {
      await setImmediate()
      return { commit: SHA('a'), recheck: () => Promise.resolve(),
        lockfiles: () => Promise.resolve([{ path: 'package-lock.json', format: 'npm', sha: '1:lock' }]),
        file(path) {
          read.push(path)
          return path in files ? Promise.resolve(files[path]) : Promise.reject(new GithubApiError(404, 'github-not-found'))
        },
        workflows() {
          listed.push(1)
          return workflows instanceof Error ? Promise.reject(workflows) : Promise.resolve(workflows)
        } }
    },
    teamScoped: () => Promise.resolve(false),
    version: (name, version) => Promise.resolve({ name, version, dist: { integrity: sri(name) } }),
    assess: () => Promise.resolve({ published: null, findings: [], score: { score: 0 } }),
    removed: () => Promise.reject(new Error('none')),
    advisories: () => Promise.resolve([]),
  }
}

// GitHub as the scan resolves references with: actions/checkout and
// third/party, public, v1 of third/party's at B, its v1.0.0 too, its
// action.yml naming `nested/one@main`, and nested/one a private repository.
function actionsSource({ fail = null } = {}) {
  const info = (fullName, isPrivate = false) => ({ fullName, defaultBranch: 'main', private: isPrivate })
  const source = actionsSourceOf({
    'actions/checkout': { info: info('actions/checkout'), tags: [{ tag: 'v4', oid: SHA('c') }, { tag: 'v4.2.0', oid: SHA('c') }] },
    'third/party': { info: info('third/party'), tags: [{ tag: 'v1', oid: SHA('b') }, { tag: 'v1.0.0', oid: SHA('b') }],
      files: { [`action.yml@${SHA('b')}`]: 'runs:\n  using: composite\n  steps:\n    - uses: nested/one@main\n' } },
    'nested/one': { info: info('nested/one', true), tags: [], branches: [{ branch: 'main', oid: SHA('d') }], files: { [`action.yml@${SHA('d')}`]: 'runs:\n  using: node24\n  main: index.js\n' } },
  })
  const { repo } = source
  source.repo = name => fail?.(name) ? Promise.reject(new GithubApiError(429, 'github-rate-limited', 60)) : repo(name)
  return source
}
// The repositories `source` was asked of.
const reposAsked = source => source.asked.flatMap(([method, name]) => method === 'repo' ? [name] : [])

const scan = (source, caches = riskCaches(), options) => Array.fromAsync(repositoryRiskLines(source, new AbortController().signal, caches, options))
const ofType = (lines, type) => lines.filter(line => line.type === type)
const findingIds = findings => findings.map(({ id, severity, line }) => `${id}/${severity}@${line}`)

test('a scan tells a repository\'s workflows and actions of its own, npx held to its lockfile, then each reference resolved, before it is done', async () => {
  const source = sourceOf()
  const lines = await scan(source)
  assert.deepEqual(ofType(lines, 'workflows'), [{ type: 'workflows', repo: 1, paths: ['.github/workflows/ci.yml'] }])
  const [ci, own] = ofType(lines, 'workflow')
  assert.deepEqual([ci.path, own.path, own.kind], ['.github/workflows/ci.yml', '.github/actions/setup/action.yaml', 'action'], 'action.yaml, where no action.yml is')
  // eslint locked and installed by `npm ci` before it; prettier locked by none.
  assert.deepEqual(findingIds(ci.findings), ['unpinned/moderate@6', 'fetched-package/high@11'])
  assert.deepEqual(findingIds(own.findings), ['unpinned/high@4', 'remote-script/high@5'])
  assert.deepEqual(source.read.filter(path => path.startsWith('.github')), ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.github/actions/setup/action.yaml'])
  const actions = ofType(lines, 'action')
  assert.deepEqual(actions.map(({ key }) => key).toSorted(), ['actions/checkout@v4', 'nested/one@main', `third/party@${SHA('b')} # v1.0.0`, 'third/party@v1'],
    'each once, and what one names in turn')
  assert.deepEqual(actions.find(({ key }) => key === 'nested/one@main').findings.map(({ id }) => id), ['branch-ref'])
  assert.deepEqual(lines.at(-1), { type: 'done' })
})

test('an action of the repository\'s own counts as an install before a step only where it installs', async () => {
  const ci = 'on: push\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/setup\n      - run: npx eslint .\n        working-directory: api\n'
  const steps = (...lines) => `runs:\n  using: composite\n  steps:\n${lines.map(line => `    - ${line}\n${line.startsWith('run') ? '      shell: bash\n' : ''}`).join('')}`
  const found = async (own, deps = '') => findingIds(ofType(await scan(sourceOf({ files: { ...FILES, '.github/workflows/ci.yml': ci,
    '.github/actions/setup/action.yaml': own, 'deps/action.yml': deps } })), 'workflow')[0].findings)
  assert.deepEqual([await found(steps('run: npm ci')), await found(steps('run: npm run lint'))], [[], ['fetched-package/high@6']])
  // One using another of its own: as that one does, both's where it installs too.
  assert.deepEqual([await found(steps('uses: ./deps'), steps('run: npm ci')), await found(steps('uses: ./deps'), steps('run: npm ci --prefix web')),
    await found(steps('run: npm ci --prefix web', 'uses: ./deps'), steps('run: npm ci --prefix api'))], [[], ['fetched-package/high@6'], []])
})

test('an input handed to a reusable workflow of the repository\'s own is an injection only where it writes it into a script', async () => {
  const ci = 'on: pull_request_target\njobs:\n  a:\n    uses: ./.github/workflows/build.yml\n    with:\n      branch: ${{ github.head_ref }}\n'
  const found = async run => findingIds(ofType(await scan(sourceOf({ files: { ...FILES, '.github/workflows/ci.yml': ci, '.github/workflows/build.yml': `on: workflow_call\njobs:\n  b:\n    steps:\n      - run: ${run}\n` },
    workflows: ['.github/workflows/ci.yml', '.github/workflows/build.yml'] })), 'workflow')[0].findings)
  assert.deepEqual([await found('git switch "$BRANCH"'), await found('git switch ${{ inputs.branch }}')], [[], ['script-injection/critical@6']])
})

test('a lockfile\'s names, and those only devDependencies need', () => {
  const { names, dev } = lockedNames('package-lock.json', [{ name: 'a', version: '1.0.0', dev: true }, { name: 'a', version: '2.0.0' }, { name: 'b', version: '1.0.0', dev: true }, { name: 'c', version: null }])
  assert.deepEqual([[...names], [...dev]], [['a', 'a@1.0.0', 'a@2.0.0', 'b', 'b@1.0.0', 'c'], ['a@1.0.0', 'b', 'b@1.0.0']])
})

test('a repository\'s Actions are read 200 files at most, however many actions one workflow uses, one in a directory named like YAML among them', async () => {
  const read = async (...uses) => {
    const asked = [], ci = `on: push\njobs:\n  a:\n    steps:\n${uses.map(each => `      - uses: ${each}\n`).join('')}`
    const { files } = await readActions({ workflows: () => Promise.resolve(['.github/workflows/ci.yml']),
      file: path => { asked.push(path); return Promise.resolve(path.endsWith('ci.yml') ? ci : 'runs:\n  using: node20\n  main: x.js\n') } })
    return [files.length, asked]
  }
  assert.deepEqual((await read(...Array.from({ length: 250 }, (_, at) => `./a${at}`))).map(each => each.length ?? each), [200, 200])
  assert.deepEqual(await read('./tools/build.yaml'), [2, ['.github/workflows/ci.yml', 'tools/build.yaml/action.yml']])
})

test('a Docker action of the repository\'s own has its Dockerfile read', async () => {
  const files = { ...FILES, '.github/actions/setup/action.yaml': 'runs:\n  using: docker\n  image: ./Dockerfile\n', '.github/actions/setup/Dockerfile': 'FROM node:20\nRUN curl -fsSL https://x/i.sh | sh\n' }
  const docker = ofType(await scan(sourceOf({ files })), 'workflow').find(({ kind }) => kind === 'dockerfile')
  assert.deepEqual([docker.path, findingIds(docker.findings)], ['.github/actions/setup/Dockerfile', ['unpinned-image/moderate@1', 'remote-script/high@2']])
})

test('a repository missing is red where another owner\'s workflow names it, whichever names it first', async () => {
  for (const owners of [['missing', 'org'], ['org', 'missing']]) {
    for (const wait of [false, true]) {
      const told = []
      const caches = riskCaches()
      const resolving = resolvingActions({ source: actionsSource(), signal: new AbortController().signal, tell: line => { told.push(line) }, memory: caches.actions, answers: caches.actionAnswers })
      for (const owner of owners) {
        resolving.add([{ key: 'missing/action@v1', owner, depth: 0 }])
        if (wait) await setImmediate()
      }
      await resolving.close()
      assert.deepEqual(told.at(-1).findings.map(({ id, severity }) => `${id}/${severity}`), ['repo-missing/critical'], `${owners.join(' then ')}${wait ? ', each resolved' : ''}`)
    }
  }
})

test('a reference first met too deep to follow is followed where met again nearer', async () => {
  for (const wait of [false, true]) {
    const told = []
    const caches = riskCaches()
    const resolving = resolvingActions({ source: actionsSource(), signal: new AbortController().signal, tell: line => { told.push(line.key) }, memory: caches.actions, answers: caches.actionAnswers })
    resolving.add([{ key: 'third/party@v1', owner: 'org', depth: 4 }])
    if (wait) while (!told.includes('third/party@v1')) await setImmediate()
    resolving.add([{ key: 'third/party@v1', owner: 'org', depth: 0 }])
    await resolving.close()
    assert.ok(told.includes('nested/one@main'), wait ? 'once resolved' : 'before')
  }
})

test('what a scan resolved and read of a repository\'s Actions is kept: a scan again asks GitHub none of it but a private repository\'s', async () => {
  const caches = riskCaches()
  const first = sourceOf()
  await scan(first, caches)
  const again = sourceOf()
  const lines = await scan(again, caches)
  assert.deepEqual([again.listed, again.read.filter(path => path.startsWith('.github')), reposAsked(again.actions)], [[], [], ['nested/one']])
  assert.equal(ofType(lines, 'action').length, 4)
  assert.equal(ofType(lines, 'workflow').length, 2)
  // An admin who can't read nested/one isn't told what another's access had.
  const other = actionsSource()
  other.repo = name => Promise.resolve(name === 'nested/one' ? null : first.actions.repo(name))
  const theirs = await scan(sourceOf({ actions: other }), caches)
  const nested = ofType(theirs, 'action').find(({ key }) => key === 'nested/one@main')
  assert.deepEqual([nested.commit, nested.findings.map(({ id }) => id)], [null, ['repo-missing']])
})

test('what GitHub answers of a public repository is kept for every scan, whichever reference asks; a private one\'s for none', async () => {
  const caches = riskCaches()
  // What a scan resolving `keys` asks GitHub, by what and of which repository.
  const asked = async keys => {
    const source = actionsSource()
    const resolving = resolvingActions({ source, signal: new AbortController().signal, tell: () => {}, memory: caches.actions, answers: caches.actionAnswers })
    resolving.add(keys.map(key => ({ key, owner: 'org', depth: 0 })))
    await resolving.close()
    return source.asked.map(([method, name]) => `${method} ${name}`)
  }
  assert.ok((await asked(['third/party@v1'])).includes('file third/party'))
  // Other references of third/party, at the same commit, and nested/one, private, again.
  const again = await asked([`third/party@${SHA('b')} # v1.0.0`, `third/party@${SHA('b')}`])
  assert.deepEqual([...new Set(again)].toSorted(), ['branch nested/one', 'file nested/one', 'repo nested/one', 'tags nested/one'])
})

test('a reference of a public repository is kept beyond the instance, a private one\'s not', async () => {
  const rows = new Map()
  const actionLines = { read: key => Promise.resolve(rows.get(key) ?? null), readMany: () => Promise.resolve(new Map()),
    write(key, value, at) { rows.set(key, { at, value }); return Promise.resolve() } }
  await scan(Object.assign(sourceOf(), { actionLines }))
  assert.deepEqual([...rows.values()].map(({ value }) => value.key).toSorted(), ['actions/checkout@v4', `third/party@${SHA('b')} # v1.0.0`, 'third/party@v1'])
  // Another instance reads them there.
  const again = sourceOf()
  await scan(Object.assign(again, { actionLines }))
  assert.deepEqual(reposAsked(again.actions), ['nested/one'])
})

test('why a reference couldn\'t be resolved, or a repository\'s workflows listed, is told, and the scan goes on', async () => {
  const lines = await scan(sourceOf({ actions: actionsSource({ fail: name => name === 'actions/checkout' }) }))
  assert.deepEqual(ofType(lines, 'action').find(({ key }) => key === 'actions/checkout@v4'), { type: 'action', key: 'actions/checkout@v4', error: 'github-rate-limited' })
  assert.deepEqual(lines.at(-1), { type: 'done' })
  const unlisted = await scan(sourceOf({ workflows: new GithubApiError(502, 'github-unreachable', null, 'TimeoutError') }))
  assert.deepEqual(ofType(unlisted, 'workflows'), [{ type: 'workflows', repo: 1, error: 'github-unreachable', detail: 'listing its workflows: TimeoutError' }])
  assert.deepEqual(ofType(unlisted, 'action'), [])
  const none = await scan(sourceOf({ workflows: [] }))
  assert.deepEqual([ofType(none, 'workflows'), ofType(none, 'workflow')], [[{ type: 'workflows', repo: 1, paths: [] }], []])
})

test('a workflow that isn\'t YAML GitHub reads is told so, a tag making code among it', async () => {
  const lines = await scan(sourceOf({ files: { ...FILES, '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    steps:\n      - run: !!js/function "x"\n' } }))
  const [ci] = ofType(lines, 'workflow')
  assert.equal(ci.error, 'workflow-unreadable')
  assert.match(ci.detail, /expected a scalar, found "!!js\/function \\"x\\"" at line 5/u)
})

test('a scan in parts resolves in the next what a part before named but didn\'t resolve', async () => {
  // Where its lockfile is kept beyond an instance, as the server keeps it.
  const keptLockfiles = new Map()
  const lockfiles = { read: key => Promise.resolve(keptLockfiles.get(key) ?? null), readMany: () => Promise.resolve(new Map()),
    write(key, value, at) { keptLockfiles.set(key, { at, value }); return Promise.resolve() } }
  let kept = null
  const progress = { read: () => Promise.resolve(kept && { at: Date.now(), value: kept }), write: value => { kept = structuredClone(value); return Promise.resolve() } }
  // Resolving outlasts the first part, given up on as the scan stops.
  const slow = actionsSource()
  const repo = slow.repo
  slow.repo = name => kept === null ? new Promise(() => {}) : repo(name)
  const first = await scan(Object.assign(sourceOf({ actions: slow }), { progress, lockfiles }), riskCaches(), { partMs: 150 })
  assert.deepEqual(first.at(-1), { type: 'continue' })
  assert.deepEqual(ofType(first, 'action'), [])
  assert.deepEqual(kept.repos[0].actions.map(({ key }) => key).toSorted(), ['actions/checkout@v4', `third/party@${SHA('b')} # v1.0.0`, 'third/party@v1'])
  const again = sourceOf({ actions: slow })
  const lines = await scan(Object.assign(again, { progress, lockfiles }), riskCaches(), { partMs: 5000 })
  assert.deepEqual([again.listed, again.read], [[], []], 'the repository not read again')
  assert.equal(ofType(lines, 'action').length, 4)
  assert.deepEqual(lines.at(-1), { type: 'done' })
})

test('a repository\'s Actions are kept by the commit read, but where a file failed for a while', async () => {
  const read = await readActions({ workflows: () => Promise.resolve(['a.yml']), file: () => Promise.reject(new GithubApiError(429, 'github-rate-limited')) })
  assert.deepEqual(read, { files: [{ path: 'a.yml', kind: 'workflow', error: 'github-rate-limited' }] })
  assert.equal(lastingRead(read), false)
  assert.equal(lastingRead({ files: [{ path: 'a.yml', kind: 'workflow', text: 'x' }, { path: 'b/action.yml', kind: 'action', error: 'github-not-found' }] }), true)
  assert.equal(lastingRead({ error: 'github-unreachable' }), false)
})

test('GitHub as the scan resolves with: a commit in a ref\'s history where it compares behind or identical, none where it hasn\'t it', async () => {
  const asked = []
  const fetchImpl = url => {
    asked.push(String(url))
    if (String(url).includes('/branches')) return Promise.resolve(Response.json([{ name: 'main', commit: { sha: SHA('a') } }, { name: 'x', commit: {} }]))
    const head = /\.\.\.([\da-f]{40})/u.exec(String(url))[1]
    if (head === SHA('0')) return Promise.resolve(new Response('{}', { status: 404 }))
    return Promise.resolve(Response.json({ status: { [SHA('b')]: 'behind', [SHA('c')]: 'identical', [SHA('d')]: 'diverged' }[head] ?? 'ahead' }))
  }
  const source = githubActionsSource(null, fetchImpl)
  assert.deepEqual(await Promise.all([SHA('b'), SHA('c'), SHA('d'), SHA('e'), SHA('0')].map(sha => source.contains('o/r', 'release/v1', sha))), [true, true, false, false, null])
  assert.equal(asked[0], `https://api.github.com/repos/o/r/compare/release/v1...${SHA('b')}?per_page=1`)
  assert.equal(await source.contains('o/r', 'main', 'not-a-sha'), null)
  assert.deepEqual(await source.branches('o/r'), { branches: [{ branch: 'main', oid: SHA('a') }], complete: true })
})
