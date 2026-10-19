import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { STORAGE_MAGIC } from '../server-common/storage-crypto.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { codeHeadStore } from '../server-managed/npm-kept.ts'
import { createDiskObjectStorage } from '../server-managed/object-storage-disk.ts'
import { createSession } from '../server-managed/session.ts'
import { MAX_NPM_JSON_LENGTH, MAX_NPM_PACKAGE_BYTES, MAX_NPM_PACKAGE_FILES } from '../server-managed/npm-packages.ts'
import { MAX_KEPT_CODE_BYTES, MAX_REPOSITORY_CODE_BYTES, MAX_REPOSITORY_CODE_FILES, loadRepositoryCodeBody, repositoryCodeFits,
  repositoryCodeKept } from '../server-managed/repository-code.ts'
import { tar } from './_managed-npm.js'
import { managedStores } from './_managed-storage.js'
import { storageTestKey } from './_managed-storage-db.js'

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 60_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const commit = 'a'.repeat(40)
// Another commit, of the same tree: another branch's and a tag's, and the
// default branch's once it moves.
const other = 'b'.repeat(40)
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
// the repository answers before it is gone, `archives` the tree whose
// tarball it sends for the one asked, `head` the default branch's commit,
// and `hold` what a tree's tarball waits on before it is sent.
function github(t, { truncate = false, reads = Infinity, archives = tree => tree, head = () => commit, hold = () => null } = {}) {
  const asked = []
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    asked.push(url.pathname + url.search)
    const path = url.pathname
    if (path === '/repos/org/repo' && asked.filter(entry => entry === '/repos/org/repo').length > reads) return Response.json({ message: 'Not Found' }, { status: 404 })
    if (path === '/repos/org/repo') return Response.json(publicMetadata)
    if (path === '/repos/org/repo/commits/heads%2Fmain') return Response.json({ sha: head() })
    if (path === '/repos/org/repo/commits/heads%2Ffeature' || path === '/repos/org/repo/commits/tags%2Fv1') return Response.json({ sha: other })
    const at = /^\/repos\/org\/repo\/git\/commits\/([a-f\d]{40})$/u.exec(path)?.[1]
    if (at === commit || at === other) return Response.json({ sha: at, tree: { sha: treeAt('') } })
    const tree = /^\/repos\/org\/repo\/git\/trees\/([a-f\d]{40})$/u.exec(path)?.[1]
    if (tree && trees.has(tree)) {
      const recursive = url.searchParams.get('recursive') === '1'
      return Response.json({ ...listing(tree, recursive), ...(recursive && truncate ? { truncated: true } : {}) })
    }
    const archived = /^\/repos\/org\/repo\/tarball\/([a-f\d]{40})$/u.exec(path)?.[1]
    if (archived && trees.has(archived)) {
      await hold(archived)
      return new Response(tarball(archives(archived)))
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  })
  return asked
}

// The managed server reading the fixture, as `role`, with byte storage for
// the code it keeps where `storage` asks for it (on disk, encrypted with
// `key` where one is given). Its `elsewhere()` is another instance: the same
// database and byte storage, none of this one's memory. `settle()` waits for
// the work done behind its answers, `kept()` lists what its byte storage
// holds, and `post` sends an admin's mutation.
async function fixture(t, { role = 'manage', storage = false, key = null } = {}) {
  const db = openSqliteManagedDb(':memory:', { storageEncryptionKey: key })
  t.after(() => db.close())
  const session = await createSession(config, db, { githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, role)
  await db.selectRepo(repo, Date.now())
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, 'src/allowed')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  let stores = null
  if (storage) {
    const dir = await mkdtemp(join(tmpdir(), 'triage-repository-code-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    if (key) await db.enableStorageEncryption()
    stores = await managedStores(t, createDiskObjectStorage(dir), { db, key, disk: true })
  }
  const pending = []
  const handlerOf = instance => createManagedRequestHandler({ config, db: instance, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false,
    track: work => { pending.push(work) }, ...stores ? { repositoryCodeStorage: stores.repositoryCodeStorage } : {} })
  const handler = handlerOf(db)
  const cookie = session.setCookie.split(';')[0]
  const requestOf = served => async (query, { method = 'GET', signedIn = true } = {}) => {
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
    await served({ method, url: `/api/admin/repositories/code?${new URLSearchParams(query)}`, headers: { cookie: signedIn ? cookie : undefined } }, res)
    const body = Buffer.concat(chunks)
    // As sent, too (`bytes`), left out of comparisons.
    return Object.defineProperty({ status: res.status, headers: res.headers, body: JSON.parse(res.headers['content-encoding'] === 'br' ? brotliDecompressSync(body).toString() : body.toString()) },
      'bytes', { value: body })
  }
  return Object.assign(requestOf(handler), {
    db, raw: stores?.raw,
    elsewhere: () => requestOf(handlerOf(Object.create(db))),
    settle: async () => { while (pending.length > 0) await Promise.all(pending.splice(0)) },
    // Byte storage's paths, of either generation.
    kept: async () => (await Promise.all(['cache/', 'cache-encrypted-v1/'].map(async prefix => (await stores.raw.list(prefix, null, 100)).objects.map(object => object.key)))).flat(),
    async post(path, body) {
      const res = { status: 0, writeHead(status) { this.status = status }, end() {} }
      await handler(Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path,
        headers: { cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' } }), res)
      return res.status
    },
  })
}
// The commit of each directory a fixture's byte storage keeps.
const keptCommits = async request => (await request.kept()).map(path => /\/repository-code\/1\/([a-f\d]{40})\//u.exec(path)?.[1] ?? path)

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

test('a directory opened again at its commit asks GitHub for neither its tree nor its listing again, its reader\'s access still asked', async t => {
  const request = await fixture(t, { role: 'admin' })
  const asked = github(t, { reads: 4 })
  const commits = () => asked.filter(entry => entry === `/repos/org/repo/git/commits/${commit}`).length
  const listings = () => asked.filter(entry => entry === `/repos/org/repo/git/trees/${treeAt('src/allowed')}?recursive=1`).length
  const access = () => asked.filter(entry => entry === '/repos/org/repo').length
  const first = await request({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(first.status, 200)
  assert.deepEqual([commits(), listings(), access()], [1, 1, 2])
  const again = await request({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(again.status, 200)
  assert.deepEqual(again.body, first.body)
  assert.deepEqual([commits(), listings()], [1, 1], 'the commit\'s tree at the directory, and what it holds, as GitHub answered them')
  assert.equal(access(), 4, 'the reader\'s access asked as ever, before and after')
  // The repository gone from GitHub: its reader is refused before anything kept is read.
  const gone = await request({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.notEqual(gone.status, 200)
})

test('a directory too large to read is told so again without its listing asked again', async t => {
  const request = await fixture(t, { role: 'admin' })
  const asked = github(t, { truncate: true })
  const listings = () => asked.filter(entry => entry.endsWith('?recursive=1')).length
  assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 413)
  assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 413)
  assert.equal((await request.elsewhere()({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 413, 'nor by another instance')
  assert.equal(listings(), 1)
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

test('a directory\'s tarball holding another tree is GitHub\'s answer gone wrong, not one the viewer cannot read', async t => {
  const request = await fixture(t, { role: 'admin' })
  github(t, { archives: tree => tree === treeAt('src/allowed') ? treeAt('src/other') : tree })
  assert.deepEqual(await request({ repoId: '1', ref: commit, path: 'src/allowed' }),
    { status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { error: 'github-malformed' } })
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
  assert.equal(repositoryCodeFits({ files: 80_000, bytes: 256 * 1024 * 1024 }), true)
  assert.equal(repositoryCodeFits({ files: 80_001, bytes: 1 }), false)
  assert.equal(repositoryCodeFits({ files: 1, bytes: 256 * 1024 * 1024 + 1 }), false)
  assert.equal(repositoryCodeFits(null), false)
})

test('a directory unpacks within its own bounds, past a package\'s, and no further', async () => {
  const read = async (count, as) => {
    const tgz = gzipSync(tar(Array.from({ length: count }, (_, i) => ({ name: `org-repo-aaaaaaa/f${i}`, data: 'x' }))))
    const load = loadRepositoryCodeBody({ repoId: 1, repo: 'org/repo', commit, path: '', tree: as, listed: { files: count, bytes: count } }, () => Promise.resolve(tgz))
    try { return JSON.parse(brotliDecompressSync(await load.result).toString()).files.length } finally { load.release() }
  }
  assert.equal(await read(MAX_NPM_PACKAGE_FILES + 1, 'b'.repeat(40)), MAX_NPM_PACKAGE_FILES + 1)
  await assert.rejects(read(MAX_REPOSITORY_CODE_FILES + 1, 'c'.repeat(40)), err => err.status === 413 && err.message === 'directory-too-large')
})

test('a directory past a package\'s bounds takes as many places among the active loads as packages its files would fill', async () => {
  const gate = Promise.withResolvers(), tgz = gzipSync(tar([{ name: 'org-repo-aaaaaaa/a', data: 'a' }]))
  const load = (tree, count, bytes) => loadRepositoryCodeBody({ repoId: 1, repo: 'org/repo', commit, path: '', tree: tree.repeat(40), listed: { files: count, bytes } },
    () => gate.promise.then(() => tgz))
  const busy = /repository-busy/u
  const held = [load('1', 1, 1), load('2', MAX_NPM_PACKAGE_FILES, MAX_NPM_PACKAGE_BYTES)]
  await assert.rejects(load('3', 1, 2 * MAX_NPM_PACKAGE_BYTES + 1).result, busy, 'three packages\' bytes find two places')
  held.push(load('4', MAX_NPM_PACKAGE_FILES + 1, 1))
  await assert.rejects(load('5', 1, 1).result, busy, 'two packages\' files take the other two')
  gate.resolve()
  await Promise.all(held.map(each => each.result))
  for (const each of held) each.release()
  const largest = load('6', MAX_REPOSITORY_CODE_FILES, MAX_REPOSITORY_CODE_BYTES)
  await assert.rejects(load('7', 1, 1).result, busy, 'the largest takes every place')
  await largest.result
  largest.release()
  const after = load('7', 1, 1)
  await after.result
  after.release()
})

test('a directory\'s JSON is held to what its places hold, as its listing cannot tell how far escaping grows it', async () => {
  const size = Math.floor(MAX_NPM_JSON_LENGTH / 6) + 1
  const tgz = gzipSync(tar([{ name: 'org-repo-aaaaaaa/controls', data: Buffer.alloc(size, 1) }]))
  const load = (tree, bytes) => loadRepositoryCodeBody({ repoId: 1, repo: 'org/repo', commit, path: '', tree: tree.repeat(40), listed: { files: 1, bytes } },
    () => Promise.resolve(tgz))
  const one = load('8', size)
  await assert.rejects(one.result, err => err.status === 413 && err.message === 'directory-too-large', 'one place holds a package\'s JSON')
  one.release()
  const two = load('9', MAX_NPM_PACKAGE_BYTES + 1)
  assert.ok((await two.result).byteLength > 0, 'two hold twice that')
  two.release()
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

// Until GitHub has been asked for the tarball of `tree`.
async function tarballAsked(asked, tree) {
  while (!asked.includes(`/repos/org/repo/tarball/${tree}`)) await new Promise(resolve => { setImmediate(resolve) })
}

test('a directory\'s tree and what it holds, as GitHub answered them, are kept in the database for another instance to read', async t => {
  const request = await fixture(t, { role: 'admin' })
  const asked = github(t)
  const commits = () => asked.filter(entry => entry === `/repos/org/repo/git/commits/${commit}`).length
  const listings = () => asked.filter(entry => entry === `/repos/org/repo/git/trees/${treeAt('src/allowed')}?recursive=1`).length
  const first = await request({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(first.status, 200)
  const again = await request.elsewhere()({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.deepEqual(again.body, first.body)
  assert.deepEqual([commits(), listings()], [1, 1], 'neither asked again by an instance that never read them')
  assert.equal(asked.filter(entry => entry.includes('/tarball/')).length, 2, 'its files read again, with no byte storage to keep them')
})

test('a directory of the default branch\'s head is kept in byte storage: opened again, by the branch or its commit, on another instance, nothing of it is asked of GitHub again', async t => {
  const request = await fixture(t, { role: 'admin', storage: true })
  const asked = github(t)
  const access = () => asked.filter(entry => entry === '/repos/org/repo').length
  const first = await request({ repoId: '1', ref: '', path: 'src/allowed' })
  assert.equal(first.status, 200)
  await request.settle()
  const kept = await request.kept()
  assert.equal(kept.length, 1)
  assert.match(kept[0], /^cache\/repository-code\/1\/a{40}\/v1-[a-f\d]{64}\.json\.br$/u, 'by the repository, then the commit')
  const read = asked.length
  const elsewhere = request.elsewhere()
  for (const ref of ['', 'heads/main', commit]) {
    const again = await elsewhere({ repoId: '1', ref, path: 'src/allowed' })
    assert.equal(again.status, 200, ref)
    assert.deepEqual(again.headers, first.headers, ref)
    assert.deepEqual(again.bytes, first.bytes, `${ref}: as it was sent`)
  }
  assert.deepEqual(asked.slice(read).filter(entry => entry !== '/repos/org/repo'), ['/repos/org/repo/commits/heads%2Fmain', '/repos/org/repo/commits/heads%2Fmain'],
    'by the branch, its head alone: no tree, listing or tarball')
  assert.equal(access(), 2 + 3 * 2, 'the reader\'s access asked as ever, before and after')
  // The reader's access gone by the time it is checked again: what is kept is not sent.
  t.mock.restoreAll()
  const later = github(t, { reads: 1 })
  const gone = await elsewhere({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(gone.status, 404)
  assert.equal(gone.body.files, undefined)
  assert.ok(!later.some(entry => entry.includes('/git/') || entry.includes('/tarball/')), 'it was read as kept')
})

test('a kept directory takes a place among the active loads as one read from GitHub does: none left, it is refused as busy, and sent once one is', async t => {
  const request = await fixture(t, { role: 'admin', storage: true })
  github(t)
  assert.equal((await request({ repoId: '1', ref: '', path: 'src/allowed' })).status, 200)
  await request.settle()
  const elsewhere = request.elsewhere()
  // Every place taken by the largest directory there is, read from GitHub, unanswered.
  const gate = Promise.withResolvers()
  const largest = loadRepositoryCodeBody({ repoId: 2, repo: 'org/other', commit: other, path: '', tree: 'e'.repeat(40),
    listed: { files: MAX_REPOSITORY_CODE_FILES, bytes: MAX_REPOSITORY_CODE_BYTES } }, () => gate.promise)
  const busy = await elsewhere({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.deepEqual([busy.status, busy.body.error], [429, 'repository-busy'])
  gate.reject(new Error('gone'))
  await largest.result.catch(() => {})
  largest.release()
  const sent = await elsewhere({ repoId: '1', ref: commit, path: 'src/allowed' })
  assert.equal(sent.status, 200)
})

test('only the default branch\'s head is kept: a read of another branch, a tag, or a commit not known as its head keeps nothing', async t => {
  const request = await fixture(t, { role: 'admin', storage: true })
  const asked = github(t)
  assert.equal((await request({ repoId: '1', ref: commit, path: 'src/allowed' })).status, 200)
  await request.settle()
  assert.deepEqual(await request.kept(), [], 'a commit no read of the default branch has named its head')
  assert.equal((await request({ repoId: '1', ref: '', path: 'src/allowed' })).status, 200)
  for (const ref of ['heads/feature', 'tags/v1', other]) assert.equal((await request({ repoId: '1', ref, path: 'src/allowed' })).body.commit, other, ref)
  assert.equal((await request({ repoId: '1', ref: commit, path: 'src' })).status, 200)
  await request.settle()
  assert.deepEqual(await keptCommits(request), [commit, commit], 'the head\'s directories, by its branch and by its commit')
  assert.equal(asked.filter(entry => entry.includes('/tarball/')).length, 6, 'the others read each time')
})

test('when the default branch moves, a read of it removes what was kept at the head before; one kept for that head meanwhile removes itself', async t => {
  let head = commit
  const slow = Promise.withResolvers()
  const request = await fixture(t, { role: 'admin', storage: true })
  const asked = github(t, { head: () => head, hold: tree => tree === treeAt('src/linked') ? slow.promise : null })
  for (const path of ['src/allowed', 'src']) assert.equal((await request({ repoId: '1', ref: '', path })).status, 200, path)
  await request.settle()
  assert.deepEqual(await keptCommits(request), [commit, commit])
  head = other
  assert.equal((await request({ repoId: '1', ref: 'heads/main', path: 'src/allowed' })).body.commit, other)
  await request.settle()
  assert.deepEqual(await keptCommits(request), [other])
  // The head before, by its commit, as an older route names it: read, not kept.
  assert.equal((await request({ repoId: '1', ref: commit, path: 'src' })).status, 200)
  await request.settle()
  assert.deepEqual(await keptCommits(request), [other])
  // A read of the head as kept, its tarball still coming as another instance
  // finds the branch moved: what it keeps goes again.
  const reading = request.elsewhere()({ repoId: '1', ref: other, path: 'src/linked' })
  await tarballAsked(asked, treeAt('src/linked'))
  head = commit
  assert.equal((await request({ repoId: '1', ref: '', path: 'src/allowed' })).body.commit, commit)
  slow.resolve()
  assert.equal((await reading).body.commit, other)
  await request.settle()
  assert.deepEqual(await keptCommits(request), [commit])
})

test('a repository deactivated or removed has what was kept of its code removed, as is one kept for it meanwhile', async t => {
  for (const [path, body] of [['/api/admin/repositories/select', { repoId: 1, selected: false }],
    ['/api/admin/repositories/remove', { repoId: 1, fullName: 'org/repo', acknowledge: true, deleteTriage: false }]]) {
    const request = await fixture(t, { role: 'admin', storage: true })
    const slow = Promise.withResolvers()
    const asked = github(t, { hold: tree => tree === treeAt('src/linked') ? slow.promise : null })
    for (const ref of ['', commit]) assert.equal((await request({ repoId: '1', ref, path: ref ? 'src' : 'src/allowed' })).status, 200, path)
    await request.settle()
    assert.deepEqual(await keptCommits(request), [commit, commit], path)
    // Another directory of its head, its tarball coming as the repository goes.
    const reading = request({ repoId: '1', ref: commit, path: 'src/linked' })
    await tarballAsked(asked, treeAt('src/linked'))
    assert.equal(await request.post(path, body), 200, path)
    assert.deepEqual(await request.kept(), [], path)
    assert.equal(await codeHeadStore(request.db).read('1'), null, `${path}: nor the commit they were kept at`)
    slow.resolve()
    assert.equal((await reading).status, 404, `${path}: not sent`)
    await request.settle()
    assert.deepEqual(await request.kept(), [], `${path}: what it read kept for none`)
    t.mock.restoreAll()
  }
})

test('a body past MAX_KEPT_CODE_BYTES is not kept, nor one kept past it read', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const put = [], work = []
  const storage = {
    put: (key, bytes) => { put.push(bytes.byteLength); return Promise.resolve() },
    open: () => Promise.resolve({ size: MAX_KEPT_CODE_BYTES + 1, stream: Readable.from([]) }),
    delete: () => Promise.resolve(),
  }
  const kept = repositoryCodeKept(storage, codeHeadStore(db), job => { work.push(job) })
  assert.equal(await kept.at(1, '', commit, 'main'), true)
  const at = { repoId: 1, repo: 'org/repo', commit, path: '' }
  // Bodies by their sizes alone, as neither keeping one nor this storage reads more of it.
  kept.keep(at, { byteLength: MAX_KEPT_CODE_BYTES + 1 })
  kept.keep({ ...at, path: 'src' }, { byteLength: MAX_KEPT_CODE_BYTES })
  await Promise.all(work)
  assert.deepEqual(put, [MAX_KEPT_CODE_BYTES])
  const read = kept.read(at)
  assert.equal(await read.result, null)
  read.release()
})

test('with storage encrypted, a kept directory is ciphertext at rest, bound to its path, and reads back', async t => {
  const request = await fixture(t, { role: 'admin', storage: true, key: storageTestKey })
  const asked = github(t)
  const tarballs = () => asked.filter(entry => entry.includes('/tarball/')).length
  const allowed = await request({ repoId: '1', ref: '', path: 'src/allowed' })
  const src = await request({ repoId: '1', ref: '', path: 'src' })
  await request.settle()
  const kept = await request.kept()
  assert.equal(kept.length, 2)
  assert.ok(kept.every(path => path.startsWith('cache-encrypted-v1/repository-code/1/')), 'apart from the plaintext generation')
  const stored = await Promise.all(kept.map(async path => {
    const parts = []
    for await (const part of (await request.raw.open(path)).stream) parts.push(part)
    return Buffer.concat(parts)
  }))
  for (const bytes of stored) {
    assert.ok(bytes.subarray(0, STORAGE_MAGIC.length).equals(STORAGE_MAGIC))
    for (const sent of [allowed, src]) assert.equal(bytes.indexOf(sent.bytes.subarray(0, 32)), -1, 'none of a body as sent')
  }
  assert.deepEqual((await request.elsewhere()({ repoId: '1', ref: commit, path: 'src/allowed' })).bytes, allowed.bytes)
  assert.equal(tarballs(), 2, 'read back as kept')
  // One path's ciphertext in another's place reads as none kept: that
  // directory is read again, its own files sent.
  for (const [i, path] of kept.entries()) await request.raw.put(path, stored[1 - i])
  const again = await request.elsewhere()({ repoId: '1', ref: commit, path: 'src' })
  assert.deepEqual(again.body, src.body)
  assert.equal(tarballs(), 3)
})
