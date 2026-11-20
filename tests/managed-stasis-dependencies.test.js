// What a repository's stasis.config.json files have Stasis reach, as its
// dependency review holds to them (server-managed/stasis-dependencies.ts):
// kept by the repository, the commit and the file's path, the versions alone;
// built behind the answers asking for them, none waited for; and each version
// as the lockfiles laying it out lock it, a patched one as it was installed.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { BundleBuildError } from '../server-managed/bundle-build.ts'
import { bundleDependencies, lockedVersions } from '../server-managed/bundle-dependency-reviews.ts'
import { reviewedDependencies } from '../server-managed/pull-dependency-reviews.ts'
import { STASIS_DEPENDENCIES_READ, stasisDependencyReader, stasisDirectory, withReach } from '../server-managed/stasis-dependencies.ts'
import { sri } from './_managed-repository-dependency-reviews.js'

const [head, base] = ['b', 'c'].map(char => char.repeat(40))
const repo = { repoId: 1, fullName: 'org/repo' }
const config = 'app/stasis.config.json'
const PATCH = 'ab'.repeat(32)
const dep = (name, version, more = {}) => ({ name, version, integrity: sri(`${name}@${version}`), ...more })
const locked = (name, version, more = {}) => ({ name, version, source: 'registry', integrity: sri(`${name}@${version}`), lockfile: 'pnpm', ...more })

// A store as the database's is, by key: what is kept, and when.
function memory() {
  const kept = new Map()
  return { kept, read: key => Promise.resolve(kept.get(key) ?? null), write: (key, value, at) => { kept.set(key, { at, value }); return Promise.resolve() } }
}
// A reader whose builds are handed over as asked for and settled as the test
// tells it (`builds`), what goes on behind its answers awaited by `settled`.
function reader({ store = memory(), stopping = () => false } = {}) {
  const behind = [], builds = []
  const read = stasisDependencyReader({ store, stopping, behind: work => { behind.push(work) },
    build: (input, github, token, signal) => new Promise((resolve, reject) => { builds.push({ input, github, token, signal, resolve, reject }) }) })
  return { ...read, store, builds, settled: () => Promise.all(behind) }
}
const key = (commit, path = config) => `1\0${STASIS_DEPENDENCIES_READ}\0${commit}\0${path}`
const pending = { status: 'pending' }

test('what a stasis.config.json reaches at a commit is built behind the answer asking for it, none waited for, and kept by the repository, the commit and its path: the versions alone', async () => {
  const one = reader()
  assert.deepEqual(await one.read(repo, 'token', head, config, 'release'), pending, 'not kept: built, and told so at once')
  assert.deepEqual(one.builds.map(({ input, github, token }) => [input, github, token]), [[{ repoId: 1, commit: head, config, branch: 'release' }, 'org/repo', 'token']],
    'told the branch its commit is said to be of')
  // While it is built, neither it nor another is, one at a time: the one asked for last meanwhile follows it at once, the rest when asked for again.
  for (const commit of [head, '2'.repeat(40), base, head]) assert.deepEqual(await one.read(repo, 'token', commit, config), pending)
  assert.equal(one.builds.length, 1)
  const dependencies = [dep('ms', '2.1.3'), dep('tool', '1.0.0', { patch: PATCH })]
  one.builds.shift().resolve(dependencies)
  await new Promise(resolve => { setImmediate(resolve) })
  assert.deepEqual(one.builds.map(({ input }) => input), [{ repoId: 1, commit: base, config }], 'the one asked for last, not waiting to be asked again; of no branch where none is said')
  one.builds.shift().resolve([])
  await one.settled()
  assert.deepEqual(await one.read(repo, 'token', head, config), { status: 'ready', dependencies })
  assert.deepEqual([...one.store.kept].map(([at, { value }]) => [at, value]), [[key(head), dependencies], [key(base), []]], 'its versions, nothing else of the lockfile built')
  assert.equal(one.builds.length, 0, 'the other asked for meanwhile, not till it is asked for again')
  // Another instance, cold: kept beyond the one that built it; what is kept that isn't one, built again.
  const other = reader({ store: one.store })
  assert.deepEqual(await other.read(repo, 'another', head, config), { status: 'ready', dependencies })
  assert.equal(other.builds.length, 0, 'built by none again')
  one.store.kept.set(key('1'.repeat(40)), { at: Date.now(), value: [{ name: 'x', version: '1.0.0', patch: 1 }] })
  assert.deepEqual(await other.read(repo, 'token', '1'.repeat(40), config), pending)
})

test('a failed build is held in this instance, GitHub\'s for less; one whose slot is busy, or that gave it up, or that a long build came before, is built when asked for again; one under way stops with the server', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 })
  const warn = mock.method(console, 'warn', () => {})
  t.after(() => warn.mock.restore())
  let stopped = false
  const one = reader({ stopping: () => stopped })
  const fails = async (commit, error) => {
    assert.deepEqual(await one.read(repo, 'token', commit, config), pending)
    one.builds.shift().reject(error)
    await one.settled()
    return one.read(repo, 'token', commit, config)
  }
  assert.deepEqual(await fails('1'.repeat(40), new BundleBuildError(422, 'config-invalid')), { status: 'failed', error: 'config-invalid', transient: false })
  assert.deepEqual(await fails('2'.repeat(40), new BundleBuildError(422, 'github-build-failed')), { status: 'failed', error: 'github-build-failed', transient: true })
  assert.deepEqual(await fails('3'.repeat(40), new Error('unexpected')), { status: 'failed', error: 'build-failed', transient: true }, 'one failing otherwise, as GitHub\'s')
  assert.equal(one.store.kept.size, 0, 'none kept beyond the instance')
  // A minute on, GitHub's failure is built again as asked; an hour on, the commit's own.
  t.mock.timers.tick(60_000)
  assert.deepEqual([(await one.read(repo, 'token', '1'.repeat(40), config)).status, await one.read(repo, 'token', '2'.repeat(40), config)], ['failed', pending])
  one.builds.shift().resolve([])
  await one.settled()
  t.mock.timers.tick(60 * 60_000)
  // One begun a minute ago or longer is followed by none, lest builds on end outlast what they run behind: the next is built when asked for again.
  assert.deepEqual(await one.read(repo, 'token', '4'.repeat(40), config), pending)
  t.mock.timers.tick(60_000)
  assert.deepEqual(await one.read(repo, 'token', '5'.repeat(40), config), pending)
  one.builds.shift().resolve([])
  await one.settled()
  assert.equal(one.builds.length, 0)
  // Busy, or yielding to a build asked for: none tried for ten seconds, then built as asked.
  for (const code of ['build-busy', 'build-yielded']) {
    assert.deepEqual(await fails('1'.repeat(40), new BundleBuildError(429, code)), pending, code)
    assert.equal(one.builds.length, 0, 'not tried at once')
    t.mock.timers.tick(10_000)
  }
  assert.deepEqual(await one.read(repo, 'token', '1'.repeat(40), config), pending)
  const [build] = one.builds.splice(0)
  build.signal.addEventListener('abort', () => build.reject(build.signal.reason))
  stopped = true
  t.mock.timers.tick(1000)
  await one.settled()
  assert.equal(build.signal.aborted, true, 'stopped with the server')
  assert.deepEqual(await one.read(repo, 'token', '1'.repeat(40), config), pending)
  assert.equal(one.builds.length, 0, 'none started while it stops')
})

// The lockfiles of a commit as read (commit-lockfiles.ts CommitLockfiles).
const lockfiles = (...files) => ({ unread: [], lockfiles: files.map(([path, packages]) => ({ path, packages })) })

test('a Stasis build\'s versions are locked as the nearest lockfile locking each as it was installed locks it: a patched one by its patch, one none locks told so', () => {
  const read = lockfiles(['pnpm-lock.yaml', [locked('tool', '1.0.0'), locked('ms', '2.1.3'), locked('deep', '1.0.0')]],
    ['app/pnpm-lock.yaml', [locked('tool', '1.0.0', { patchHash: PATCH, patchPath: 'patches/tool.patch' }), locked('ms', '2.1.3', { integrity: sri('another ms') })]])
  const found = lockedVersions([dep('tool', '1.0.0', { patch: PATCH }), dep('tool', '1.0.0'), dep('ms', '2.1.3'), dep('deep', '1.0.0'), dep('gone', '1.0.0'), dep('gone', '1.0.0', { patch: PATCH }),
    { name: 'unattested', version: '1.0.0' }], read)
  assert.deepEqual(found.locked, [locked('tool', '1.0.0', { patchHash: PATCH, patchDir: 'app', patchPath: 'app/patches/tool.patch' }), locked('tool', '1.0.0'), locked('ms', '2.1.3'), locked('deep', '1.0.0')],
    'the build\'s patched one as the nearest locking it patched locks it, its patch\'s file from the root; unpatched, as the one above does; ms by the integrity installed, not the nearer one\'s')
  assert.deepEqual(found.unlocked, [{ name: 'gone', version: '1.0.0' }, { name: 'unattested', version: '1.0.0' }], 'each once')
  assert.deepEqual([found.versions, found.paths], [5, ['app/pnpm-lock.yaml', 'pnpm-lock.yaml']])
  // One telling nothing of how it was installed, and one installed as no lockfile locks it: as the nearest locking it at all does, every one of its.
  const loose = lockedVersions([{ name: 'tool', version: '1.0.0' }, dep('ms', '2.1.3', { patch: 'cd'.repeat(32) })], read)
  assert.deepEqual(loose.locked, [locked('tool', '1.0.0', { patchHash: PATCH, patchDir: 'app', patchPath: 'app/patches/tool.patch' }), locked('ms', '2.1.3', { integrity: sri('another ms') })])
  assert.deepEqual(bundleDependencies([{ name: 'tool', version: '1.0.0' }, { name: 'gone', version: '1.0.0' }], read, head).told.lockfiles[0].locked, [loose.locked[0]], 'as a bundle\'s are')
})

test('a stasis.config.json is told as a directory of a pull request\'s dependencies: what its entries reach at the head that they didn\'t at its merge base, or that it is still built, or why it couldn\'t be', async () => {
  const reads = { [head]: { status: 'ready', dependencies: [dep('ms', '2.1.3'), dep('kept', '1.0.0'), dep('tool', '1.0.0', { patch: PATCH }), dep('gone', '1.0.0')] },
    [base]: { status: 'ready', dependencies: [dep('ms', '2.1.2'), dep('kept', '1.0.0'), dep('tool', '1.0.0')] } }
  const asked = []
  const read = commit => { asked.push(commit); return Promise.resolve(reads[commit]) }
  const at = { [head]: lockfiles(['app/pnpm-lock.yaml', [locked('ms', '2.1.3'), locked('kept', '1.0.0'), locked('tool', '1.0.0', { patchHash: PATCH }), locked('unreached', '9.0.0')]],
    ['other/pnpm-lock.yaml', [locked('gone', '1.0.0')]]),
  [base]: lockfiles(['pnpm-lock.yaml', [locked('ms', '2.1.2'), locked('kept', '1.0.0'), locked('tool', '1.0.0')]], ['app/sub/yarn.lock', [locked('ms', '2.1.3')]]) }
  const held = []
  const lockedAt = (commit, holds) => {
    held.push([commit, at[commit].lockfiles.map(({ path }) => path).filter(holds)])
    return Promise.resolve({ unread: [], lockfiles: at[commit].lockfiles.filter(({ path }) => holds(path)) })
  }
  const dir = await stasisDirectory(config, base, head, read, lockedAt)
  assert.deepEqual(asked.toSorted(), [head, base].toSorted(), 'both asked for at once')
  assert.deepEqual(held, [[head, ['app/pnpm-lock.yaml']], [base, ['pnpm-lock.yaml']]], 'each commit\'s versions as the lockfiles in its directory or above lock them there')
  const gone = { name: 'gone', version: '1.0.0', source: 'registry', unlocked: true }
  assert.deepEqual(dir, { paths: [config], more: 0, moreLocked: 0,
    added: [gone, { ...locked('ms', '2.1.3'), was: ['2.1.2'] }, { ...locked('tool', '1.0.0', { patchHash: PATCH, patchDir: 'app' }), was: ['1.0.0'] }],
    locked: [locked('ms', '2.1.3'), locked('kept', '1.0.0'), locked('tool', '1.0.0', { patchHash: PATCH, patchDir: 'app' }), gone] },
  'a version newly patched is new; one the lockfile locks that nothing reaches, not told; one no lockfile laying it out locks, told so')
  const branch = await stasisDirectory(config, null, head, read, lockedAt)
  assert.deepEqual([branch.added, branch.locked], [[], dir.locked], 'a default branch\'s, of no base, adds none')

  // Reviewed as a lockfile's directory is: by its patch, one unlocked failing it.
  const state = { required: 1, since: null, canReview: true, lockfiles: { mode: 'include', paths: [config] }, reviews: [] }
  const told = { base, head, cut: false, lockfiles: [{ paths: ['package-lock.json'], more: 0, moreLocked: 0, added: [locked('elsewhere', '1.0.0')], locked: [locked('elsewhere', '1.0.0')] }, dir] }
  const answer = await reviewedDependencies(told, state)
  assert.deepEqual(answer.lockfiles.map(one => one.paths), [[config]], 'the lockfiles it holds to none of left out, its own directory told')
  assert.deepEqual(answer.lockfiles[0].added.map(pkg => [pkg.name, pkg.patch?.hash ?? null, pkg.unsupported ?? pkg.reviews]), [['gone', null, 'unlocked'], ['ms', null, 0], ['tool', PATCH, 0]])
  assert.deepEqual(answer.lockfiles[0].unsupported, [{ name: 'gone', version: '1.0.0', source: 'registry', unsupported: 'unlocked' }])
  assert.deepEqual([answer.review.toReview, answer.review.unreviewed, answer.review.unsupported], [2, 1, 1])

  // Still to be built, either of them: told so, the other asked for all the same.
  for (const unbuilt of [head, base]) {
    asked.length = 0
    const waiting = await stasisDirectory(config, base, head, commit => read(commit).then(known => commit === unbuilt ? pending : known), lockedAt)
    assert.deepEqual([waiting, asked.length], [{ paths: [config], error: 'stasis-pending' }, 2], unbuilt)
  }
  const failing = (commit, failure) => stasisDirectory(config, base, head, one => read(one).then(known => one === commit ? { status: 'failed', ...failure } : known), lockedAt)
  assert.deepEqual(await failing(head, { error: 'config-invalid', transient: false }), { paths: [config], error: 'stasis-failed', detail: 'config-invalid' })
  assert.deepEqual(await failing(base, { error: 'github-rate-limited', transient: true }), { paths: [config], error: 'stasis-failed', detail: 'github-rate-limited' }, 'GitHub failing its merge base\'s')
  const baseless = await failing(base, { error: 'config-invalid', transient: false })
  assert.deepEqual(baseless.added.map(pkg => [pkg.name, pkg.was]), [['gone', undefined], ['kept', undefined], ['ms', undefined], ['tool', undefined]],
    'a merge base that couldn\'t be built of its own reaches nothing: every version at the head is new')
})

test('a version a lockfile locks that the stasis.config.json beside it reaches not is marked as its package manager\'s alone to ask for; none till Stasis has built it, nor one asked for otherwise', () => {
  const directory = (paths, lockedThere, added = []) => ({ paths, added, more: 0, locked: lockedThere, moreLocked: 0 })
  const [ms, kept, dev, tool, shared, far] = ['ms', 'kept', 'dev', 'tool', 'shared', 'far'].map(name => locked(name, '1.0.0'))
  const patched = locked('tool', '1.0.0', { patchHash: PATCH })
  const told = (...dirs) => ({ base, head, cut: false, lockfiles: dirs })
  const marks = answer => answer.lockfiles.map(one => 'error' in one ? one.error
    : Object.fromEntries(['added', 'locked'].map(list => [list, one[list].filter(pkg => pkg.unreached).map(pkg => `${pkg.name}${pkg.patchHash ? '+patch' : ''}`)])))
  const none = { added: [], locked: [] }
  // app: its lockfile and its stasis.config.json, held to together; web: a stasis.config.json alone; tools: a lockfile alone.
  const app = directory(['app/pnpm-lock.yaml'], [ms, kept, dev, tool, shared, far], [{ ...ms, was: ['0.9.0'] }, dev])
  const reach = directory([config], [ms, kept, patched], [ms])
  const web = directory(['web/stasis.config.json'], [far])
  const tools = directory(['tools/package-lock.json'], [shared, locked('lint', '1.0.0')], [shared])
  const answer = withReach(told(app, reach, web, tools))
  assert.deepEqual(marks(answer), [{ added: ['dev'], locked: ['dev', 'tool'] }, none, none, none],
    'dev, which nothing reaches, and tool, reached patched alone; not ms and kept, asked for by both, far, another\'s to reach, nor shared, a lockfile\'s with none beside it')
  assert.deepEqual([answer.lockfiles[0].added[0], answer.lockfiles[0].locked[0], app.locked[2]], [{ ...ms, was: ['0.9.0'] }, ms, dev], 'the rest as they were, those told untouched')
  assert.deepEqual(marks(withReach(told(tools, web))), [none, none], 'a lockfile with none beside it; a stasis.config.json alone')
  assert.deepEqual(marks(withReach(told(directory(['pnpm-lock.yaml'], [dev]), reach))), [none, none], 'one above it is not beside it')
  // Still built, or failed, or reaching more than are told: its lockfile's told as they are, till it is built.
  for (const unknown of [{ paths: [config], error: 'stasis-pending' }, { paths: [config], error: 'stasis-failed', detail: 'config-invalid' }, { ...reach, moreLocked: 1 }]) {
    const lazy = withReach(told(app, unknown))
    assert.deepEqual(lazy.lockfiles[0], app, JSON.stringify(unknown.error ?? 'cut'))
  }
  assert.deepEqual(marks(withReach(told(app, { paths: ['app/package-lock.json'], error: 'lockfile-unreadable' }, reach)))[0], { added: ['dev'], locked: ['dev', 'tool', 'shared', 'far'] })
  // A default branch's, its lockfiles' versions told as one: by what each lockfile locks.
  const branch = told(directory(['app/pnpm-lock.yaml', 'tools/package-lock.json'], [ms, kept, dev, shared]), reach)
  assert.deepEqual(marks(withReach(branch, [{ path: 'app/pnpm-lock.yaml', packages: [ms, kept, dev, shared] }, { path: 'tools/package-lock.json', packages: [shared] }]))[0], { added: [], locked: ['dev'] })
})
