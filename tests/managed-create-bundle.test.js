import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import './_polyfills.js'
import { ManagedCreateBundle } from '../ui/managed/create-bundle.js'

const commit = 'a'.repeat(40)
const entries = [{ name: 'entry.ts', path: 'src/entry.ts', type: 'file' }]

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}

test('the picker installs the host-provided shared tooltip listener on its own root', () => {
  const page = new ManagedCreateBundle()
  const root = {}
  page.renderRoot = root
  const roots = []
  page.updated(new Map())
  page.installTooltips = target => roots.push(target)
  page.updated(new Map([['installTooltips', undefined]]))
  assert.deepEqual(roots, [root])
  page.updated(new Map([['_selected', new Set()]]))
  assert.deepEqual(roots, [root], 'ordinary selection renders do not reinstall listeners')
})

test('the commit link opens the current directory at the pinned commit on GitHub', () => {
  const page = new ManagedCreateBundle()
  page._repos = [{ repoId: 1, fullName: 'org/repo' }]
  page._repoId = 1
  page._refName = 'main'
  const link = () => templates(page.render()).find(template => template.strings[0].includes('class="commit-link"'))
  assert.equal(link(), undefined, 'do not link before resolving the revision')
  page._commit = commit
  assert.equal(link().values[0], `https://github.com/org/repo/tree/${commit}`)
  assert.match(link().strings.join(''), /target="_blank" rel="noopener noreferrer"/u)
  page._path = 'src/a #?%/nested'
  assert.equal(link().values[0], `https://github.com/org/repo/tree/${commit}/src/a%20%23%3F%25/nested`)
  page.changeRevision('tag', 'v1')
  assert.equal(link(), undefined, 'do not retain a link to the previous commit while loading a revision')
})

test('branch suggestions put the default first, retain filtering, and leave tag order unchanged', () => {
  const page = new ManagedCreateBundle()
  page._refs = { defaultBranch: 'main', branches: ['develop', 'main', 'release'], tags: ['v1', 'v2'] }
  assert.deepEqual(page.revisionSuggestions(), ['main', 'develop', 'release'])
  page._revisionQuery = 're'
  assert.deepEqual(page.revisionSuggestions(), ['release'])
  page._revisionQuery = ''
  page._refs.branches = ['develop']
  assert.deepEqual(page.revisionSuggestions(), ['main', 'develop'], 'default remains available when outside the first page of branch suggestions')
  page._refKind = 'tag'
  assert.deepEqual(page.revisionSuggestions(), ['v1', 'v2'])
})

test('the creation picker loads managed repositories and never selects a filtered-out initial repository', async t => {
  const calls = []
  const allowed = { repoId: 2, fullName: 'org/allowed' }
  t.mock.method(globalThis, 'fetch', url => {
    const path = new URL(url, 'https://test.invalid').pathname
    calls.push(path)
    return Promise.resolve(Response.json(path.endsWith('/browsable') ? { repos: [allowed] }
      : path.endsWith('/refs') ? { defaultBranch: 'main', branches: ['main'], tags: [] } : { commit, entries }))
  })
  const page = new ManagedCreateBundle()
  page.initialRepoId = 1
  assert.deepEqual(page._repos, [])
  await page.loadRepositories()
  assert.deepEqual(page._repos, [allowed])
  assert.equal(page._repoId, null)
  assert.deepEqual(calls, ['/api/admin/repositories/browsable'])
  page.initialRepoId = 2
  await page.loadRepositories()
  await setImmediate()
  assert.equal(page._repoId, 2)
  assert.deepEqual(page._entries, entries)
})

test('failed or cancelled repository listing does not expose stale picker options', async t => {
  const page = new ManagedCreateBundle()
  page._repos = [{ repoId: 1, fullName: 'org/stale' }]
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({}, { status: 502 })))
  await page.loadRepositories()
  assert.deepEqual(page._repos, [])
  assert.match(page._reposError, /load repositories/u)
  let finish
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve }))
  const loading = page.loadRepositories()
  page.disconnectedCallback()
  finish(Response.json({ repos: [{ repoId: 1, fullName: 'org/stale' }] }))
  await loading
  assert.deepEqual(page._repos, [])
})

test('selecting a repository browses its default branch and revision selections browse automatically', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    const request = new URL(url, 'https://test.invalid')
    calls.push(request)
    return Promise.resolve(Response.json(request.pathname.endsWith('/refs')
      ? { defaultBranch: 'release', branches: ['develop', 'main'], tags: ['v1'] }
      : { commit, entries }))
  })
  const page = new ManagedCreateBundle()
  await page.selectRepository(1)
  await setImmediate()
  assert.equal(page._refKind, 'branch')
  assert.equal(page._refName, 'release')
  assert.equal(calls[1].searchParams.get('ref'), 'heads/release')
  assert.deepEqual(page._entries, entries)

  page.toggleFile('src/entry.ts')
  page.editRevision('develop')
  await setImmediate()
  assert.equal(calls[2].searchParams.get('ref'), 'heads/develop')
  assert.equal(page._selected.size, 0)
  page.selectRevisionType('tag')
  assert.equal(page._entries, null)
  page.editRevision('v1')
  await setImmediate()
  assert.equal(calls[3].searchParams.get('ref'), 'tags/v1')
  page.selectRevisionType('branch')
  await setImmediate()
  assert.equal(calls[4].searchParams.get('ref'), 'heads/release')
  page.toggleFile('src/entry.ts')
  page.selectRevisionType('branch')
  assert.equal(calls.length, 5)
  assert.equal(page._selected.size, 1)
})

test('typed revisions browse after a pause and pending browsing is cancelled when context changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    calls.push(new URL(url, 'https://test.invalid').searchParams.get('ref'))
    return Promise.resolve(Response.json({ commit, entries }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.editRevision('feature/o')
  t.mock.timers.tick(300)
  page.editRevision('feature/one')
  t.mock.timers.tick(349)
  assert.equal(calls.length, 0)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.deepEqual(calls, ['heads/feature/one'])

  page.selectRevisionType('commit')
  page.editRevision('abc')
  t.mock.timers.tick(350)
  assert.match(page._error, /commit SHA/u)
  assert.equal(calls.length, 1)
  page.editRevision(commit)
  t.mock.timers.tick(350)
  await setImmediate()
  assert.equal(calls[1], commit)

  page.editRevision('b'.repeat(40))
  await page.selectRepository(null)
  t.mock.timers.tick(350)
  assert.equal(calls.length, 2)
  page._repoId = 1
  page.editRevision('feature/two')
  page.selectRevisionType('tag')
  t.mock.timers.tick(350)
  assert.equal(calls.length, 2)
  page.editRevision('v2')
  page.disconnectedCallback()
  t.mock.timers.tick(350)
  assert.equal(calls.length, 2)
})

test('entry points persist across directories, requests use the pinned commit, and revision changes reset selection', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    const query = new URL(url, 'https://test.invalid').searchParams
    calls.push(query)
    return Promise.resolve(Response.json({ commit, entries }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'feature/one')
  await page.loadDirectory('src')
  page.toggleFile('src/entry.ts')
  await page.loadDirectory('')
  assert.deepEqual([...page._selected], ['src/entry.ts'])
  assert.equal(calls[0].get('ref'), 'heads/feature/one')
  assert.equal(calls[1].get('ref'), commit)
  page.changeRevision('tag', 'v1')
  assert.equal(page._selected.size, 0)
  assert.equal(page._entries, null)
  await page.loadDirectory('')
  assert.equal(calls[2].get('ref'), 'tags/v1')
  page.changeRevision('commit', 'not-a-sha')
  await page.loadDirectory('')
  assert.match(page._error, /commit SHA/u)
  assert.equal(calls.length, 3)
})

test('directory navigation reuses pinned listings with their sorting, limits, and selection', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    const query = new URL(url, 'https://test.invalid').searchParams
    calls.push(query)
    return Promise.resolve(Response.json({ commit, limited: query.get('path') === '', entries: query.get('path') ? entries : [
      { name: 'z.ts', path: 'z.ts', type: 'file' }, { name: 'src', path: 'src', type: 'dir' },
    ] }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'main')
  await page.loadDirectory('')
  const root = page._entries
  assert.deepEqual(root.map(entry => entry.name), ['src', 'z.ts'])
  await page.loadDirectory('src')
  page.toggleFile('src/entry.ts')
  await page.loadDirectory('')
  assert.deepEqual(page._entries, root)
  assert.equal(page._limited, true)
  assert.equal(page._loading, false)
  await page.loadDirectory('src')
  assert.deepEqual(page._entries, entries)
  assert.equal(page._limited, false)
  assert.deepEqual([...page._selected], ['src/entry.ts'])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].get('ref'), 'heads/main')
  assert.equal(calls[1].get('ref'), commit)
})

test('package suggestions are opt-in, additive, deduplicated, and cached with the pinned directory', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', url => {
    calls++
    const path = new URL(url, 'https://test.invalid').searchParams.get('path')
    return Promise.resolve(Response.json({ commit, entries, ...(path === '' ? { packageEntryPoints: ['src/entry.ts', 'cli.js'] } : {}) }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'main')
  await page.loadDirectory('')
  assert.equal(page._selected.size, 0, 'discovery never selects files automatically')
  assert.deepEqual(page._packageEntryPoints, ['src/entry.ts', 'cli.js'])
  page.toggleFile('src/entry.ts')
  page.toggleFile('manual.js')
  const suggestion = () => templates(page.render()).find(template => template.strings[0].includes('class="package-suggestions"'))
  assert.ok(suggestion())
  suggestion().values.find(value => typeof value === 'function')()
  assert.deepEqual([...page._selected], ['src/entry.ts', 'manual.js', 'cli.js'])
  assert.equal(suggestion(), undefined, 'the prompt disappears once all suggested paths are selected')
  page.toggleFile('cli.js')
  assert.ok(suggestion(), 'removed suggestions can be added again')
  await page.loadDirectory('src')
  assert.deepEqual(page._packageEntryPoints, [])
  await page.loadDirectory('')
  assert.deepEqual(page._packageEntryPoints, ['src/entry.ts', 'cli.js'])
  assert.equal(calls, 2, 'returning to the directory does not fetch its package again')
  page.changeRevision('tag', 'v1')
  assert.deepEqual(page._packageEntryPoints, [])
  await page.loadDirectory('')
  assert.equal(calls, 3)
  page.disconnectedCallback()
  assert.deepEqual(page._packageEntryPoints, [])
})

test('Solidity suggestions coexist with package suggestions, preserve selection, and reuse the pinned cache', async t => {
  let reads = 0
  t.mock.method(globalThis, 'fetch', url => {
    reads++
    const path = new URL(url, 'https://test.invalid').searchParams.get('path')
    return Promise.resolve(Response.json({ commit, entries, ...(path === '' ? {
      packageEntryPoints: ['cli.js'], solidityEntryPoints: ['contracts/Token.sol', 'contracts/Vault.sol'], soliditySuggestionsLimited: true,
    } : {}) }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'main')
  await page.loadDirectory('')
  assert.equal(page._selected.size, 0)
  const suggestions = () => templates(page.render()).filter(template => template.strings[0].includes('class="package-suggestions"'))
  assert.equal(suggestions().length, 2)
  page.toggleFile('manual.js')
  page.toggleFile('contracts/Token.sol')
  suggestions()[0].values.find(value => typeof value === 'function')()
  assert.deepEqual([...page._selected], ['manual.js', 'contracts/Token.sol', 'cli.js'])
  const solidity = suggestions()[0]
  assert.ok(solidity.values.includes('Suggested Solidity sources'))
  assert.ok(templates(solidity).some(template => template.strings.join('').includes('Suggestions are limited')))
  solidity.values.find(value => typeof value === 'function')()
  assert.deepEqual([...page._selected], ['manual.js', 'contracts/Token.sol', 'cli.js', 'contracts/Vault.sol'])
  assert.equal(suggestions().length, 0)
  await page.loadDirectory('contracts')
  assert.deepEqual(page._solidityEntryPoints, [])
  assert.equal(page._soliditySuggestionsLimited, false)
  await page.loadDirectory('')
  assert.deepEqual(page._solidityEntryPoints, ['contracts/Token.sol', 'contracts/Vault.sol'])
  assert.equal(page._soliditySuggestionsLimited, true)
  assert.equal(reads, 2)
  page.changeRevision('tag', 'v1')
  assert.deepEqual(page._solidityEntryPoints, [])
  assert.equal(page._soliditySuggestionsLimited, false)
  await page.loadDirectory('')
  assert.equal(reads, 3)
  page.disconnectedCallback()
  assert.deepEqual(page._solidityEntryPoints, [])
})

test('refresh, revision/repository changes, and leaving the view discard directory caches', async t => {
  const calls = []
  let currentCommit = commit
  t.mock.method(globalThis, 'fetch', url => {
    const request = new URL(url, 'https://test.invalid')
    if (request.pathname.endsWith('/refs')) return Promise.resolve(Response.json({ defaultBranch: 'main', branches: [], tags: [] }))
    calls.push(request.searchParams)
    return Promise.resolve(Response.json({ commit: currentCommit, entries }))
  })
  const page = new ManagedCreateBundle()
  await page.selectRepository(1)
  await setImmediate()
  await page.loadDirectory('')
  assert.equal(calls.length, 1)
  currentCommit = 'b'.repeat(40)
  await page.loadDirectory('', true)
  assert.equal(calls[1].get('ref'), 'heads/main', 'refresh resolves the branch again')
  assert.equal(page._commit, currentCommit)
  page.changeRevision('tag', 'v1')
  await page.loadDirectory('')
  assert.equal(calls[2].get('ref'), 'tags/v1')
  await page.selectRepository(2)
  await setImmediate()
  assert.equal(calls[3].get('repoId'), '2', 'same SHA/path in a different repository is not a cache hit')
  page.disconnectedCallback()
  await page.loadDirectory('')
  assert.equal(calls.length, 5, 'a detached view retains no reusable directory data')
  const other = new ManagedCreateBundle()
  await other.selectRepository(2)
  await setImmediate()
  assert.equal(calls.length, 6, 'new views and sessions never inherit directory caches')
})

test('cached navigation cancels in-flight reads, and failures invalidate cached directories', async t => {
  let directoryReads = 0, fail = false, finish
  t.mock.method(globalThis, 'fetch', url => {
    const path = new URL(url, 'https://test.invalid').searchParams.get('path')
    directoryReads++
    if (path === 'src') return new Promise(resolve => { finish = resolve })
    return Promise.resolve(fail ? Response.json({}, { status: 403 }) : Response.json({ commit, entries: [], packageEntryPoints: ['root.js'], solidityEntryPoints: ['Root.sol'] }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'main')
  await page.loadDirectory('')
  const pending = page.loadDirectory('src')
  assert.equal(page._loading, true)
  await page.loadDirectory('')
  assert.equal(page._loading, false)
  finish(Response.json({ commit, entries, packageEntryPoints: ['src/late.js'], solidityEntryPoints: ['src/Late.sol'] }))
  await pending
  assert.deepEqual(page._entries, [])
  assert.deepEqual(page._packageEntryPoints, ['root.js'])
  assert.deepEqual(page._solidityEntryPoints, ['Root.sol'])
  const retry = page.loadDirectory('src')
  assert.equal(directoryReads, 3, 'cancelled reads cannot populate the cache')
  finish(Response.json({ commit, entries }))
  await retry
  fail = true
  await page.loadDirectory('other')
  assert.match(page._error, /access is required/u)
  assert.deepEqual(page._packageEntryPoints, [])
  assert.deepEqual(page._solidityEntryPoints, [])
  await page.loadDirectory('')
  assert.equal(directoryReads, 5, 'known access failure prevents redisplaying an old cached listing')
  assert.equal(page._entries, null)
})

test('the directory cache is bounded and keeps recently visited paths', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    calls.push(new URL(url, 'https://test.invalid').searchParams.get('path'))
    return Promise.resolve(Response.json({ commit, entries: [] }))
  })
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('commit', commit)
  for (let i = 0; i < 100; i++) await page.loadDirectory(`dir-${i}`)
  await page.loadDirectory('dir-0')
  await page.loadDirectory('dir-100')
  await page.loadDirectory('dir-0')
  assert.equal(calls.length, 101)
  await page.loadDirectory('dir-1')
  assert.equal(calls.length, 102)
})

test('late directory results and failures cannot overwrite a newer repository or revision', async t => {
  const pending = []
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((resolve, reject) => { pending.push({ resolve, reject, signal }) }))
  const page = new ManagedCreateBundle()
  page._repoId = 1
  page.changeRevision('branch', 'main')
  const old = page.loadDirectory('src')
  page.changeRevision('tag', 'v1')
  pending[0].resolve(Response.json({ commit, entries }))
  await old
  assert.equal(page._entries, null)
  assert.equal(page._commit, '')
  const newer = page.loadDirectory('')
  const repo = page.selectRepository(2)
  pending[1].reject(new Error('stale failure'))
  await newer
  pending[2].resolve(Response.json({ defaultBranch: 'develop', branches: ['develop'], tags: [] }))
  await repo
  await setImmediate()
  pending[3].resolve(Response.json({ commit: 'b'.repeat(40), entries: [] }))
  await setImmediate()
  assert.equal(page._repoId, 2)
  assert.equal(page._error, '')
  assert.equal(page._commit, 'b'.repeat(40))
  const detached = page.loadDirectory('src')
  page.disconnectedCallback()
  pending[4].resolve(Response.json({ commit, entries }))
  await detached
  assert.equal(page._entries, null)
})

for (const [code, status, message] of [
  ['github-rate-limited', 429, /rate limit.*2 minute/u],
  ['github-status-403', 502, /GitHub denied.*read permissions/u],
  ['github-unauthorized', 502, /authentication.*expired/u],
  ['github-unreachable', 502, /connect to GitHub/u],
]) {
  test(`refs and directory errors explain ${code}`, async t => {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ error: code }, { status, headers: { 'retry-after': '120' } })))
    const page = new ManagedCreateBundle()
    await page.selectRepository(1)
    assert.match(page._refsError, message)
    page.changeRevision('branch', 'main')
    await page.loadDirectory('')
    assert.match(page._error, message)
    assert.equal(page._entries, null)
  })
}
