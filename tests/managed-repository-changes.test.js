import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { CHANGES_ASKED, FILES_PAGE, MAX_FILES, MAX_TREE_FILES, changesAsked, changesWithin, commitChanges, repositoryChanges, repositoryTree }
  from '../server-managed/repository-changes.ts'
import { createSession } from '../server-managed/session.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const [a, b, c] = ['a', 'b', 'c'].map(char => char.repeat(40))

// A commit's files as GitHub's REST API lists them, with their patches.
const FILES = {
  [a]: [{ filename: 'src/allowed/new.js', status: 'added', patch: '+x' }, { filename: 'src/allowed/kept.ts', status: 'modified' },
    { filename: 'src/other/secret.ts', status: 'modified' }, { filename: 'README.md', status: 'removed' }],
  [b]: [{ filename: 'src/allowed/moved.js', status: 'renamed', previous_filename: 'src/allowed/old.js' },
    { filename: 'src/allowed/in.js', status: 'renamed', previous_filename: 'src/other/in.js' },
    { filename: 'src/other/out.js', status: 'renamed', previous_filename: 'src/allowed/out.js' },
    { filename: 'src/allowed/copy.js', status: 'copied', previous_filename: 'src/allowed/kept.ts' }, { filename: 'src/allowed/mode.sh', status: 'unchanged' }],
}

// A commit's tree as GitHub lists it with every tree under it: its
// directories, a submodule, and its files.
const TREE = [{ path: 'README.md', type: 'blob' }, { path: 'src', type: 'tree' }, { path: 'src/allowed', type: 'tree' }, { path: 'src/allowed/a.js', type: 'blob' },
  { path: 'src/allowed/lib/b.ts', type: 'blob' }, { path: 'src/other/secret.ts', type: 'blob' }, { path: 'vendor/sub', type: 'commit' }]

// GitHub, as the reader and the changes read it: `asked` the commits whose
// files were read of it, and the trees.
function github(t) {
  const asked = []
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    const tree = /^\/repos\/org\/repo\/git\/trees\/([a-f\d]{40})$/u.exec(url.pathname)?.[1]
    if (tree) asked.push(`tree:${tree}:${url.searchParams.get('recursive')}`)
    if (tree === a) return Promise.resolve(Response.json({ sha: 't', tree: TREE, truncated: false }))
    if (tree) return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    const sha = /^\/repos\/org\/repo\/commits\/([a-f\d]{40})$/u.exec(url.pathname)?.[1]
    if (sha) asked.push(sha)
    if (sha && FILES[sha]) assert.deepEqual(Object.fromEntries(url.searchParams), { per_page: '100', page: '1' })
    if (sha && FILES[sha]) return Promise.resolve(Response.json({ sha, files: FILES[sha] }))
    if (sha) return Promise.resolve(Response.json({ message: 'No commit found for SHA' }, { status: 422 }))
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

async function fixture(t, { role = 'admin' } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo(repo, Date.now())
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  return async (query, route = 'changes') => {
    const res = { status: 0, body: '', headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
    await handler({ method: 'GET', url: `/api/admin/repositories/${route}?${new URLSearchParams(query)}`, headers: { cookie: session.setCookie.split(';')[0] } }, res)
    return { status: res.status, body: JSON.parse(res.body) }
  }
}

test('a commit\'s files as git names their changes: copies added, renames with the path before, those unchanged none, as many as three hundred', () => {
  assert.deepEqual(commitChanges({ files: FILES[a] }), { more: false, files: [['src/allowed/new.js', 'A'], ['src/allowed/kept.ts', 'M'], ['src/other/secret.ts', 'M'], ['README.md', 'D']] })
  assert.deepEqual(commitChanges({ files: FILES[b] }).files, [['src/allowed/moved.js', 'R', 'src/allowed/old.js'], ['src/allowed/in.js', 'R', 'src/other/in.js'],
    ['src/other/out.js', 'R', 'src/allowed/out.js'], ['src/allowed/copy.js', 'A']])
  assert.deepEqual(commitChanges({ files: [{ filename: 'x', status: 'renamed' }, { filename: '', status: 'added' }, { filename: 'bad\nname', status: 'added' }] }).files, [['x', 'A']],
    'a rename naming no path before is the file added; no path, or one with control characters, none')
  assert.equal(commitChanges({ files: Array.from({ length: MAX_FILES }, (_, at) => ({ filename: `f${at}`, status: 'added' })) }).more, true)
  assert.throws(() => commitChanges({ sha: a }), /github-malformed/u)
})

test('within a directory, a commit changes its files there alone, a rename across its edge added where it comes in, removed where it goes out', () => {
  assert.deepEqual(changesWithin(commitChanges({ files: [...FILES[a], ...FILES[b]] }), 'src/allowed').files, [['src/allowed/new.js', 'A'], ['src/allowed/kept.ts', 'M'],
    ['src/allowed/moved.js', 'R', 'src/allowed/old.js'], ['src/allowed/in.js', 'A'], ['src/allowed/out.js', 'D'], ['src/allowed/copy.js', 'A']])
  assert.deepEqual(changesWithin({ files: [['src/allowedx/a.js', 'A']], more: true }, 'src/allowed'), { files: [], more: true }, 'not a directory sharing its name\'s start')
})

test('the commits a request names: each once, as many as fifty, every one a commit id', () => {
  assert.deepEqual(changesAsked(`${a},${b},${a}`), [a, b])
  assert.equal(changesAsked(Array.from({ length: CHANGES_ASKED + 1 }, (_, at) => at.toString(16).padStart(40, '0')).join(',')), null)
  for (const bad of [null, '', `${a},main`, a.toUpperCase()]) assert.equal(changesAsked(bad), null, String(bad))
})

test('the files commits change are read of GitHub once each, kept by the commit, and answered as asked, one GitHub has no commit of as none', async t => {
  const request = await fixture(t)
  const asked = github(t)
  const { status, body } = await request({ repoId: '1', path: '', shas: `${a},${c}` })
  assert.equal(status, 200)
  assert.deepEqual(body, { path: '', changes: [
    { sha: a, more: false, files: [['src/allowed/new.js', 'A'], ['src/allowed/kept.ts', 'M'], ['src/other/secret.ts', 'M'], ['README.md', 'D']] },
    { sha: c, files: null, more: false },
  ] })
  // a is kept; c, none of it, is asked of GitHub again.
  await request({ repoId: '1', path: '', shas: `${b},${a},${c}` })
  assert.deepEqual(asked, [a, c, b, c])
})

test('a reader whose grants reach a directory is answered its files alone, and none of a directory past them', async t => {
  const request = await fixture(t, { role: 'manage' })
  github(t)
  const { status, body } = await request({ repoId: '1', path: 'src/allowed', shas: a })
  assert.equal(status, 200)
  assert.deepEqual(body.changes, [{ sha: a, more: false, files: [['src/allowed/new.js', 'A'], ['src/allowed/kept.ts', 'M']] }])
  for (const path of ['', 'src', 'src/other']) assert.deepEqual((await request({ repoId: '1', path, shas: a })).body, { error: 'no-directory' }, path)
})

test('a request naming no commits, or what isn\'t one, is refused before GitHub is asked', async t => {
  const request = await fixture(t)
  const asked = github(t)
  for (const shas of [null, '', 'main', `${a},xyz`]) {
    const { status, body } = await request({ repoId: '1', path: '', ...shas === null ? {} : { shas } })
    assert.deepEqual([status, body], [400, { error: 'bad-request' }], String(shas))
  }
  assert.deepEqual(asked, [])
})

test('the files a commit holds, which Replay starts from: its blobs, as GitHub lists its whole tree at once, kept by the commit, within the reader\'s directory', async t => {
  const request = await fixture(t)
  const asked = github(t)
  const { status, body } = await request({ repoId: '1', path: '', commit: a }, 'tree')
  assert.equal(status, 200)
  assert.deepEqual(body, { commit: a, path: '', files: ['README.md', 'src/allowed/a.js', 'src/allowed/lib/b.ts', 'src/other/secret.ts'], cut: false },
    'no directories nor submodules')
  assert.deepEqual((await request({ repoId: '1', path: 'src/allowed', commit: a }, 'tree')).body.files, ['src/allowed/a.js', 'src/allowed/lib/b.ts'])
  assert.deepEqual(asked, [`tree:${a}:1`], 'read of GitHub once')
  assert.deepEqual((await request({ repoId: '1', path: '', commit: b }, 'tree')).body, { commit: b, path: '', files: null, cut: false }, 'a commit GitHub has none of')
  for (const commit of ['', 'main', a.slice(1)]) assert.deepEqual((await request({ repoId: '1', path: '', commit }, 'tree')).status, 400, commit)
  const manager = await fixture(t, { role: 'manage' })
  assert.deepEqual((await manager({ repoId: '1', path: 'src/allowed', commit: a }, 'tree')).body.files, ['src/allowed/a.js', 'src/allowed/lib/b.ts'])
  assert.deepEqual((await manager({ repoId: '1', path: '', commit: a }, 'tree')).body, { error: 'no-directory' })
})

test('a tree of more files than are answered keeps those nearest the root, told cut', async t => {
  const kept = new Map()
  const store = { read: sha => Promise.resolve(kept.get(sha) ?? null), write: (sha, tree) => { kept.set(sha, tree); return Promise.resolve() } }
  const files = [...Array.from({ length: MAX_TREE_FILES - 1 }, (_, at) => ({ path: `f${at}`, type: 'blob' })), { path: 'a/b/c.js', type: 'blob' }, { path: 'a/d.js', type: 'blob' }]
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ tree: files, truncated: false })))
  const many = await repositoryTree('org/repo', null, a, store)
  assert.deepEqual([many.files.length, many.cut, many.files.includes('a/d.js'), many.files.includes('a/b/c.js')], [MAX_TREE_FILES, true, true, false])
  assert.deepEqual(many.files.slice(0, 2), ['a/d.js', 'f0'], 'by path')
  assert.equal(kept.size, 1)
})

test('a tree GitHub lists cut short, as a large repository\'s, is read a tree at a time: each tree\'s own entries, and each tree in it whole', async t => {
  const kept = new Map()
  const store = { read: sha => Promise.resolve(kept.get(sha) ?? null), write: (sha, tree) => { kept.set(sha, tree); return Promise.resolve() } }
  const [src, deps, v8, big] = ['1', '2', '3', '4'].map(digit => digit.repeat(40))
  // The commit's and deps' listings whole cut short; v8's and src's not; big's own entries cut short too.
  const trees = {
    [`${a}:1`]: { tree: [{ path: 'README.md', type: 'blob' }], truncated: true },
    [`${a}:`]: { tree: [{ path: 'README.md', type: 'blob' }, { path: 'deps', type: 'tree', sha: deps }, { path: 'src', type: 'tree', sha: src },
      { path: 'vendor', type: 'commit', sha: v8 }, { path: 'bad', type: 'tree', sha: 'main' }], truncated: false },
    [`${src}:1`]: { tree: [{ path: 'a.js', type: 'blob' }, { path: 'lib', type: 'tree' }, { path: 'lib/b.js', type: 'blob' }], truncated: false },
    [`${deps}:1`]: { tree: [], truncated: true },
    [`${deps}:`]: { tree: [{ path: 'x.c', type: 'blob' }, { path: 'v8', type: 'tree', sha: v8 }], truncated: false },
    [`${v8}:1`]: { tree: [{ path: 'y.cc', type: 'blob' }], truncated: false },
    [`${b}:1`]: { tree: [], truncated: true },
    [`${b}:`]: { tree: [{ path: 'z.js', type: 'blob' }, { path: 'big', type: 'tree', sha: big }], truncated: false },
    [`${big}:1`]: { tree: [], truncated: true },
    [`${big}:`]: { tree: [{ path: 'w.js', type: 'blob' }], truncated: true },
  }
  const asked = []
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const key = `${url.pathname.split('/').at(-1)}:${url.searchParams.get('recursive') ?? ''}`
    asked.push(`${key.slice(0, 1)}${key.slice(40)}`)
    return Promise.resolve(trees[key] ? Response.json(trees[key]) : Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  assert.deepEqual(await repositoryTree('org/repo', null, a, store), { files: ['README.md', 'deps/v8/y.cc', 'deps/x.c', 'src/a.js', 'src/lib/b.js'], cut: false },
    'no directories, submodules nor trees named by no id')
  assert.deepEqual(asked, ['a:1', 'a:', '2:1', '1:1', '2:', '3:1'], 'nearest the root first')
  assert.deepEqual(await repositoryTree('org/repo', null, b, store), { files: ['big/w.js', 'z.js'], cut: true }, 'a tree\'s own entries cut short, cut')
  assert.equal(kept.size, 2)
})

test('a commit\'s files are read a hundred a page while each page is full, as many as three hundred, before what it changes is kept', async t => {
  // Commits of 250 and 420 files, and one of exactly a page.
  const counts = { [a]: 250, [b]: 420, [c]: FILES_PAGE }
  const pages = []
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const sha = url.pathname.split('/').at(-1)
    const [size, page] = [Number(url.searchParams.get('per_page')), Number(url.searchParams.get('page'))]
    pages.push([sha.slice(0, 1), page])
    const files = Array.from({ length: Math.max(0, Math.min(size, counts[sha] - (page - 1) * size)) }, (_, at) => ({ filename: `f${(page - 1) * size + at}.js`, status: 'added' }))
    return Promise.resolve(Response.json({ sha, files }))
  })
  const kept = new Map()
  const store = { read: () => Promise.resolve(new Map()), write: (sha, changes) => { kept.set(sha, changes); return Promise.resolve() } }
  const read = await repositoryChanges('org/repo', null, [a, b, c], store)
  assert.deepEqual([a, b, c].map(sha => [read.get(sha).files.length, read.get(sha).more]), [[250, false], [MAX_FILES, true], [FILES_PAGE, false]])
  assert.deepEqual(read.get(a).files.at(-1), ['f249.js', 'A'], 'the last page\'s files too')
  assert.deepEqual(pages.toSorted(), [['a', 1], ['a', 2], ['a', 3], ['b', 1], ['b', 2], ['b', 3], ['c', 1], ['c', 2]],
    'no page past the three hundredth file, and a full page\'s next asked')
  assert.equal(kept.size, 3)
})
