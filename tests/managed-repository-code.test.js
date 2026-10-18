import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { repositoryCodeFits } from '../server-managed/repository-code.ts'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const commit = 'a'.repeat(40)
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }

const files = {
  'README.md': '# repo\n',
  'src/allowed/index.js': 'export const a = 1\n',
  'src/allowed/lib/util.js': 'export const b = 2\n',
  'src/allowed/logo.png': '\0PNG',
  'src/linked/index.js': 'export const d = 4\n',
  'src/other/secret.js': 'export const c = 3\n',
}
// Symlinks by path, to their targets: a package's license linked to the
// workspace root's, as a monorepo links one, and one past the root.
const links = {
  'escape/link': '../../outside',
  'src/linked/LICENSE': '../../README.md',
}
const blobOf = path => Buffer.from(files[path] ?? links[path])
const modeOf = path => Object.hasOwn(links, path) ? '120000' : '100644'

// Git's ids, as GitHub names a commit's trees and blobs.
const objectId = (type, body) => createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest()

// The directory tree of `paths` under `prefix`: names to file paths or subtrees.
function treeOf(prefix) {
  const root = new Map()
  for (const path of [...Object.keys(files), ...Object.keys(links)].filter(candidate => candidate.startsWith(prefix))) {
    const parts = path.slice(prefix.length).split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      if (!dir.has(part)) dir.set(part, new Map())
      dir = dir.get(part)
    }
    dir.set(parts.at(-1), path)
  }
  return root
}

function treeId(dir) {
  const entries = [...dir].map(([name, entry]) => entry instanceof Map ? [`${name}/`, '40000', name, treeId(entry)] : [name, modeOf(entry), name, objectId('blob', blobOf(entry))])
  entries.sort(([a], [b]) => a < b ? -1 : Number(a > b))
  return objectId('tree', Buffer.concat(entries.flatMap(([, mode, name, id]) => [Buffer.from(`${mode} ${name}\0`), id])))
}

// Every tree of the fixture by its id: its directory, `''` the root.
const trees = new Map()
for (const prefix of ['', 'escape/', 'src/', 'src/allowed/', 'src/allowed/lib/', 'src/linked/', 'src/other/']) trees.set(treeId(treeOf(prefix)).toString('hex'), prefix.replace(/\/$/u, ''))
const treeAt = path => [...trees].find(([, dir]) => dir === path)[0]

// GitHub's listing of a tree, as git/trees answers it: its own entries, or
// with `recursive` every entry under it by its path in it.
function listing(tree, recursive) {
  const prefix = trees.get(tree) ? `${trees.get(tree)}/` : ''
  const walk = (dir, at) => [...dir].flatMap(([name, entry]) => entry instanceof Map
    ? [{ path: at + name, mode: '040000', type: 'tree', sha: treeId(entry).toString('hex') }, ...recursive ? walk(entry, `${at}${name}/`) : []]
    : [{ path: at + name, mode: modeOf(entry), type: 'blob', sha: objectId('blob', blobOf(entry)).toString('hex'), size: blobOf(entry).length }])
  return { sha: tree, tree: walk(treeOf(prefix), ''), truncated: false }
}

// GitHub's tarball of a tree, as git archive writes it: its files under one
// top directory, owned by root.
function tarball(tree) {
  const prefix = trees.get(tree) ? `${trees.get(tree)}/` : ''
  const blocks = []
  const entry = (path, type, body = Buffer.alloc(0), linkname = '') => {
    const header = Buffer.alloc(512)
    header.write(path, 0, 100)
    header.write(type === '5' ? '0000755\0' : type === '2' ? '0000777\0' : '0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write(type, 156)
    header.write(linkname, 157, 100)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write('root', 265)
    header.write('root', 297)
    header.write(`${[...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  entry('org-repo-aaaaaaa/', '5')
  for (const [file, text] of Object.entries(files).filter(([candidate]) => candidate.startsWith(prefix))) entry(`org-repo-aaaaaaa/${file.slice(prefix.length)}`, '0', Buffer.from(text))
  for (const [link, target] of Object.entries(links).filter(([candidate]) => candidate.startsWith(prefix))) entry(`org-repo-aaaaaaa/${link.slice(prefix.length)}`, '2', undefined, target)
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

// GitHub, as the reader and upstream's client ask it; `asked` the paths asked
// for, `truncate` cutting recursive listings short, `reads` how many times
// the repository answers before it is gone.
function github(t, { truncate = false, reads = Infinity } = {}) {
  const asked = []
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    asked.push(url.pathname + url.search)
    const path = url.pathname
    if (path === '/repos/org/repo' && asked.filter(entry => entry === '/repos/org/repo').length > reads) return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    if (path === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    if (path === '/repos/org/repo/commits/heads%2Fmain') return Promise.resolve(Response.json({ sha: commit }))
    if (path === `/repos/org/repo/git/commits/${commit}`) return Promise.resolve(Response.json({ sha: commit, tree: { sha: treeAt('') } }))
    const tree = /^\/repos\/org\/repo\/git\/trees\/([a-f\d]{40})$/u.exec(path)?.[1]
    if (tree && trees.has(tree)) {
      const recursive = url.searchParams.get('recursive') === '1'
      return Promise.resolve(Response.json({ ...listing(tree, recursive), ...(recursive && truncate ? { truncated: true } : {}) }))
    }
    const archived = /^\/repos\/org\/repo\/tarball\/([a-f\d]{40})$/u.exec(path)?.[1]
    if (archived && trees.has(archived)) return Promise.resolve(new Response(tarball(archived)))
    return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  return asked
}

async function fixture(t, { role = 'manage' } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo(repo, Date.now())
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const handler = createManagedRequestHandler({ config, db, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  return async (query, { method = 'GET', signedIn = true } = {}) => {
    const chunks = []
    let closed = () => {}
    const res = {
      status: 0, headers: {}, headersSent: false, destroyed: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
      write(chunk) { chunks.push(Buffer.from(chunk)) },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); closed() },
      once(event, listener) { if (event === 'close') closed = listener },
      off() {}, setTimeout() {},
    }
    await handler({ method, url: `/api/admin/repositories/code?${new URLSearchParams(query)}`, headers: { cookie: signedIn ? session.setCookie.split(';')[0] : undefined } }, res)
    const body = Buffer.concat(chunks)
    return { status: res.status, headers: res.headers, body: JSON.parse(res.headers['content-encoding'] === 'br' ? brotliDecompressSync(body).toString() : body.toString()) }
  }
}

test('a directory reads at its revision\'s commit, its files as the npm viewer reads a package\'s, by their paths in it', async t => {
  const request = await fixture(t, { role: 'admin' })
  const asked = github(t)
  const { status, headers, body } = await request({ repoId: '1', ref: 'heads/main', path: 'src/allowed' })
  assert.equal(status, 200)
  assert.equal(headers['cache-control'], 'private, no-store')
  assert.deepEqual(body, {
    repoId: 1, repo: 'org/repo', commit, path: 'src/allowed', tree: treeAt('src/allowed'),
    files: [['index.js', 19, 'export const a = 1\n'], ['lib/util.js', 19, 'export const b = 2\n'],
      ['logo.png', 4, null, `sha256-${createHash('sha256').update('\0PNG').digest('base64')}`]],
  })
  assert.ok(asked.includes(`/repos/org/repo/git/trees/${treeAt('src/allowed')}?recursive=1`), 'its size is asked before its tarball')
  assert.ok(asked.indexOf(`/repos/org/repo/git/trees/${treeAt('src/allowed')}?recursive=1`) < asked.indexOf(`/repos/org/repo/tarball/${treeAt('src/allowed')}`))
})

test('an admin reads the whole repository; a manager, or any team member, only the directories their teams reach whole', async t => {
  const admin = await fixture(t, { role: 'admin' })
  github(t)
  const root = await admin({ repoId: '1', ref: 'heads/main' })
  assert.equal(root.status, 200)
  assert.deepEqual(root.body.files.map(([path]) => path), Object.keys(files))

  const manager = await fixture(t)
  assert.deepEqual((await manager({ repoId: '1', ref: commit, path: 'src/allowed/lib' })).body.files.map(([path]) => path), ['util.js'])
  for (const path of ['', 'src', 'src/other']) {
    assert.deepEqual(await manager({ repoId: '1', ref: commit, path }), { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { error: 'no-directory' } }, path)
  }
  assert.equal((await manager({ repoId: '2', ref: commit, path: 'src/allowed' })).body.error, 'no-repository')

  // A member at the view or triage role reads as a manager does; none, nothing.
  for (const role of ['view', 'triage']) {
    const member = await fixture(t, { role })
    assert.deepEqual((await member({ repoId: '1', ref: commit, path: 'src/allowed/lib' })).body.files.map(([path]) => path), ['util.js'], role)
    assert.equal((await member({ repoId: '1', ref: commit, path: '' })).body.error, 'no-directory', role)
  }
  assert.equal((await (await fixture(t, { role: 'none' }))({ repoId: '1', ref: commit, path: 'src/allowed/lib' })).status, 403)
})

test('a directory\'s symlinks may reach the repository\'s root, as a monorepo package\'s LICENSE does, and no further', async t => {
  const request = await fixture(t, { role: 'admin' })
  github(t)
  for (const path of ['src/linked', 'src', '']) {
    const { status, body } = await request({ repoId: '1', ref: commit, path })
    assert.equal(status, 200, path)
    assert.ok(!body.files.some(([file]) => file.endsWith('LICENSE')), `${path}: a link is no file to read`)
  }
  assert.deepEqual((await request({ repoId: '1', ref: commit, path: 'src/linked' })).body.files.map(([path]) => path), ['index.js'])
  assert.deepEqual(await request({ repoId: '1', ref: commit, path: 'escape' }),
    { status: 422, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { error: 'directory-unreadable' } },
    'a link past the root, as @preventive/archive refuses its tarball')
})

test('a directory too large to hold, or listed short, is refused before its tarball is asked for', async t => {
  const request = await fixture(t, { role: 'admin' })
  const asked = github(t, { truncate: true })
  assert.deepEqual((await request({ repoId: '1', ref: commit })).body, { error: 'directory-too-large', commit })
  assert.ok(!asked.some(path => path.includes('/tarball/')))
  assert.equal(asked.filter(path => path === '/repos/org/repo').length, 2, 'access is checked again before the commit is named')
  t.mock.restoreAll()
  // Access gone meanwhile names nothing.
  github(t, { truncate: true, reads: 1 })
  const gone = await request({ repoId: '1', ref: commit })
  assert.equal(gone.status, 404)
  assert.equal(gone.body.commit, undefined)
  assert.equal(repositoryCodeFits({ files: 20_000, bytes: 64 * 1024 * 1024 }), true)
  assert.equal(repositoryCodeFits({ files: 20_001, bytes: 1 }), false)
  assert.equal(repositoryCodeFits({ files: 1, bytes: 64 * 1024 * 1024 + 1 }), false)
  assert.equal(repositoryCodeFits(null), false)
})

test('a directory the commit has none at is none to read; bad queries, other methods and signed-out readers are refused', async t => {
  const request = await fixture(t, { role: 'admin' })
  github(t)
  assert.deepEqual((await request({ repoId: '1', ref: commit, path: 'missing' })).body, { error: 'no-directory' })
  assert.equal((await request({ repoId: '1', ref: commit, path: 'missing' })).status, 404)
  assert.equal((await request({ repoId: 'x' })).status, 400)
  assert.equal((await request({ repoId: '1', path: '../src' })).status, 400)
  assert.equal((await request({ repoId: '1' }, { method: 'POST' })).status, 405)
  assert.equal((await request({ repoId: '1' }, { signedIn: false })).status, 401)
})
