import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { CHANGES_ASKED, MAX_FILES, MAX_TREE_FILES, changesAsked, changesWithin, commitChanges, repositoryTree } from '../server-managed/repository-changes.ts'
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

test('a commit\'s files as git names their changes: copies added, renames with the path before, those unchanged none, the first page\'s alone', () => {
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

test('a tree of more files than are answered, or one GitHub cuts short, is told cut', async t => {
  const kept = new Map()
  const store = { read: sha => Promise.resolve(kept.get(sha) ?? null), write: (sha, tree) => { kept.set(sha, tree); return Promise.resolve() } }
  const answer = (tree, truncated = false) => { t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ tree, truncated }))) }
  answer(Array.from({ length: MAX_TREE_FILES + 1 }, (_, at) => ({ path: `f${at}`, type: 'blob' })))
  const many = await repositoryTree('org/repo', null, a, store)
  assert.deepEqual([many.files.length, many.cut], [MAX_TREE_FILES, true])
  answer([{ path: 'x', type: 'blob' }], true)
  assert.deepEqual(await repositoryTree('org/repo', null, b, store), { files: ['x'], cut: true })
  assert.equal(kept.size, 2)
})
