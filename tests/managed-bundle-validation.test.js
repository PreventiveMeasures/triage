// A Stasis bundle validated as the app reads its repository
// (server-managed/bundle-validation.ts), and kept and told (GET and POST
// /api/bundles/:id/validation). Stasis's rules themselves are its own tests'.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { gitBlobId } from '@exodus/stasis/validate'
import { commitBlobs } from '../server-managed/bundle-validation.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { people } from './_managed-repository-dependency-reviews.js'
import { REGISTRY, packageOf } from './_managed-npm.js'

const commit = '7'.repeat(40)
const sha256 = text => createHash('sha256').update(text).digest('hex')
const blob = text => gitBlobId(Buffer.from(text))
// ms@2.1.3 as published, and as its patch changes it.
const MS = { 'index.js': 'one\ntwo\nthree\n', 'package.json': '{"name":"ms","version":"2.1.3"}\n', 'readme.md': 'left out of the bundle\n' }
const MS_PATCH = `diff --git a/index.js b/index.js
index 1111111..2222222 100644
--- a/index.js
+++ b/index.js
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`
// The bundle, built in `web`: its own code; ms patched; left with a file
// changed and one its package hasn't; gone, published nowhere; a Composer
// package; and Stasis's empty placeholder, which is allowed.
function details(modules = {}) {
  const bundle = new Bundle({
    repo: { github: 'org/repo', directory: 'web', commit },
    modules: new Map(Object.entries({
      '.': { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n', 'src/changed.js': 'edited here\n', 'src/extra.js': 'not on GitHub\n',
        'src/link.js': 'linked\n', 'src/crlf.js': 'a\r\nb\r\n', 'vendor/sub/x.js': 'in a submodule\n', 'patches/ms@2.1.3.patch': MS_PATCH,
        '.stasis/empty-module.js': '', 'icon.png': 'AP8=' } },
      'node_modules/ms': { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\nTWO\nthree\n', 'package.json': MS['package.json'] } },
      'node_modules/left': { name: 'left', version: '1.0.0', files: { 'index.js': 'tampered\n', 'injected.js': 'x\n' } },
      'node_modules/gone': { name: 'gone', version: '1.0.0', files: { 'index.js': '\n' } },
      'vendor/org/php': { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: { 'a.php': '<?php\n' } },
      ...modules,
    }).filter(([, info]) => info !== undefined)),
    formats: new Map([['patches/ms@2.1.3.patch', 'patch'], ['icon.png', 'resource:base64'], ['src', 'directory']]),
  })
  return { kind: 'stasis', bundle: Bundle.parse(bundle.serialize()) }
}
// The commit's tree under `web`, as GitHub lists it.
const TREE = {
  'web/src/main.js': { sha: blob('main\n'), mode: '100644', type: 'blob' },
  'web/src/changed.js': { sha: blob('as committed\n'), mode: '100644', type: 'blob' },
  'web/src/link.js': { sha: blob('../linked.js'), mode: '120000', type: 'blob' },
  'web/src/crlf.js': { sha: blob('a\nb\n'), mode: '100644', type: 'blob' },
  'web/vendor/sub': { sha: 'c'.repeat(40), mode: '160000', type: 'commit' },
  'web/patches/ms@2.1.3.patch': { sha: blob(MS_PATCH), mode: '100644', type: 'blob' },
  'web/icon.png': { sha: gitBlobId(Buffer.from('AP8=', 'base64')), mode: '100644', type: 'blob' },
}
const PACKAGES = { 'npm:ms@2.1.3': MS, 'npm:left@1.0.0': { 'index.js': 'original\n', 'other.js': 'never bundled\n' } }

test('a commit\'s entries are its tree\'s listing whole, else, cut short, read a directory at a time into those holding the paths asked alone', async t => {
  const asked = []
  const listings = {
    [`${commit}?recursive=1`]: { truncated: true, tree: [] },
    [commit]: { truncated: false, tree: [{ path: 'web', type: 'tree', sha: 'a'.repeat(40), mode: '040000' }, { path: 'docs', type: 'tree', sha: 'd'.repeat(40), mode: '040000' },
      { path: 'README.md', type: 'blob', sha: 'e'.repeat(40), mode: '100644' }] },
    [`${'a'.repeat(40)}?recursive=1`]: { truncated: false, tree: [{ path: 'src', type: 'tree', sha: 'b'.repeat(40), mode: '040000' },
      { path: 'src/main.js', type: 'blob', sha: 'f'.repeat(40), mode: '100644' }, { path: 'src/link.js', type: 'blob', sha: '1'.repeat(40), mode: '120000' },
      { path: 'sub', type: 'commit', sha: 'c'.repeat(40), mode: '160000' }] },
  }
  const fetchImpl = t.mock.fn(input => {
    const tree = String(input).split('/git/trees/')[1]
    asked.push(tree)
    return Promise.resolve(listings[tree] ? Response.json(listings[tree]) : Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  const { entries, cut } = await commitBlobs('org/repo', 'token', commit, ['web/src/main.js'], fetchImpl)
  assert.deepEqual([...entries], [['README.md', { sha: 'e'.repeat(40) }], ['web/src/main.js', { sha: 'f'.repeat(40) }], ['web/src/link.js', { symlink: '' }],
    ['web/sub', { submodule: true }]], 'as Stasis\'s validation takes them: a file by its blob id, a symlink, a submodule')
  assert.equal(cut, false)
  assert.deepEqual(asked, [`${commit}?recursive=1`, commit, `${'a'.repeat(40)}?recursive=1`], 'docs never read')
  await assert.rejects(commitBlobs('org/repo', 'token', '9'.repeat(40), [], fetchImpl), /github-not-found/u)
})

// The app's API as `who` asks it, over a bundle stored at org/repo's `web`,
// GitHub's tree at its commit (with `repoFiles` beside TREE, their contents
// read there too), its main branch's head at `head` (whose history holds the
// commit where it is the commit itself), and npm's registry as PACKAGES says,
// the registry answering once `gate` settles.
async function fixture(t, { repo = true, gate = Promise.resolve(), repoFiles = {}, head = commit, tree: listed = true } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const users = await people(db)
  const bytes = brotliCompressSync(Buffer.from(details().bundle.serialize()))
  const id = '00000000-0000-4000-8000-000000000002'
  await db.insertBundle({ id, integrity: 'sha512-validated', filename: 'web.stasis.code.br', kind: 'stasis', byteSize: bytes.length, uploadedBy: users.admin.userId,
    uploadedByLogin: 'admin', repoId: repo ? 1 : null, repoDirectory: repo ? 'web' : '' }, Date.now())
  const published = Object.entries(PACKAGES).map(([key, files]) => packageOf(key.slice(4, key.lastIndexOf('@')), key.slice(key.lastIndexOf('@') + 1), files))
  const asked = []
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(String(input))
    asked.push(`${url.host}${url.pathname}${url.search}`)
    if (url.host === 'api.github.com') {
      if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json({ id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }))
      if (url.pathname === '/repos/org/repo/git/ref/heads/main') return Promise.resolve(Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: head } }))
      if (url.pathname === '/repos/org/repo/tags') return Promise.resolve(Response.json([]))
      if (url.pathname === '/repos/org/repo/branches') return Promise.resolve(Response.json([{ name: 'main', commit: { sha: head } }]))
      if (listed && url.pathname === `/repos/org/repo/git/trees/${commit}` && url.search === '?recursive=1') {
        const tree = { ...TREE, ...Object.fromEntries(Object.entries(repoFiles).map(([path, text]) => [path, { sha: blob(text), mode: '100644', type: 'blob' }])) }
        return Promise.resolve(Response.json({ truncated: false, tree: Object.entries(tree).map(([path, entry]) => ({ path, ...entry })) }))
      }
      const path = decodeURIComponent(url.pathname.slice('/repos/org/repo/contents/'.length))
      if (url.pathname.startsWith('/repos/org/repo/contents/') && url.searchParams.get('ref') === commit && typeof repoFiles[path] === 'string') {
        const text = Buffer.from(repoFiles[path])
        return Promise.resolve(Response.json({ type: 'file', path, size: text.length, sha: gitBlobId(text), encoding: 'base64', content: text.toString('base64') }))
      }
      // A commit of none of its history (a fork's), GitHub's compare finding none in common with a ref.
      return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    for (const { doc, tgz } of published) {
      if (String(input) === `${REGISTRY}/${doc.name}/${doc.version}`) return gate.then(() => Response.json(doc))
      if (String(input) === doc.dist.tarball) return Promise.resolve(new Response(tgz))
    }
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  })
  const handler = createManagedRequestHandler({ config: { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3_600_000 }, db, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track() {}, bundleStore: { get: () => Promise.resolve(bytes) } })
  const send = async (who, method = 'GET', csrf = true) => {
    const session = users[who]
    const req = Object.assign(Readable.from([]), { url: `/api/bundles/${id}/validation`, method,
      headers: { cookie: session.setCookie.split(';')[0], ...csrf ? { 'x-csrf-token': session.csrfToken } : {} } })
    // eslint-disable-next-line unicorn/prefer-event-target
    const res = Object.assign(new EventEmitter(), { status: 0, body: null, writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value); this.writableEnded = true } })
    await handler(req, res)
    return res
  }
  return { db, users, send, asked }
}

test('a bundle validated on request: its own code too for a reader of all of its repository, kept and told again without fetching anything', async t => {
  const { db, send, asked } = await fixture(t)
  assert.deepEqual((await send('alice')).body, { validation: null }, 'none yet')
  assert.equal((await send('alice', 'POST', false)).status, 403, 'a validation needs the CSRF token')
  const run = await send('alice', 'POST')
  assert.equal(run.status, 200)
  const { validation } = run.body
  assert.deepEqual([validation.status, validation.own.checked, validation.counts.matched, validation.counts.differs, validation.counts.unexpected, validation.counts.unverified],
    ['invalid', true, 6, 3, 3, 2])
  assert.deepEqual([validation.own.ref, validation.lockfiles, validation.lockfileError], [{ branch: 'main' }, null, 'no-lockfile'],
    'the commit main\'s; no lockfile at it, its dependencies held to their registry alone')
  assert.deepEqual(validation.packages.find(pkg => pkg.name === 'ms').patch, { path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: true },
    'the bundle\'s patch as the repository has it')
  assert.ok(asked.includes(`registry.npmjs.org/ms/2.1.3`) && asked.includes(`api.github.com/repos/org/repo/git/trees/${commit}?recursive=1`), 'npm and GitHub asked')
  asked.length = 0
  assert.deepEqual((await send('alice')).body, { validation }, 'kept')
  assert.deepEqual(asked.filter(path => !path.startsWith('api.github.com/repos/org/repo')), [], 'nothing fetched to tell it')

  // A reader of only part of the repository is told none of it, and validates its dependencies alone.
  await db.setTeamRepo('two', 1, 'web')
  assert.deepEqual((await send('manager')).body, { validation: null })
  const theirs = (await send('manager', 'POST')).body.validation
  // Own code's 8, Composer's, gone's, and ms's 2, which only the bundle's patch, unverified with no repository read, makes as they should be.
  assert.deepEqual([theirs.own, theirs.counts.unverified, theirs.lockfiles], [{ checked: false, reason: 'no-access' }, 12, null])
  assert.ok(!theirs.problems.some(problem => problem.of === 'own'))
  assert.deepEqual((await send('manager')).body.validation, theirs)
  assert.deepEqual((await send('alice')).body.validation, validation, 'hers still the one checking its own code')
  assert.equal((await send('carol', 'POST')).status, 404, 'one of no bundle')

  // Her team narrowed to the bundle's directory as the kept one is read: told the one that didn't check own code.
  const read = db.getFirstUpstreamCacheEntries.bind(db)
  t.mock.method(db, 'getFirstUpstreamCacheEntries', async (...keys) => {
    const found = await read(...keys)
    await db.removeTeamRepo('one', 1)
    await db.setTeamRepo('one', 1, 'web')
    return found
  }, { times: 1 })
  assert.deepEqual((await send('alice')).body.validation, theirs, 'none of own code told her')

  // Her team narrowed as her new one is kept, after her run checked her access: refused it.
  await db.setTeamRepo('one', 1, null)
  const write = db.setUpstreamCacheEntry.bind(db)
  let narrowed = false
  t.mock.method(db, 'setUpstreamCacheEntry', async (key, ...rest) => {
    await write(key, ...rest)
    if (narrowed || !key.startsWith('bundles/validations')) return
    narrowed = true
    await db.removeTeamRepo('one', 1)
    await db.setTeamRepo('one', 1, 'web')
  })
  const refused = await send('alice', 'POST')
  assert.deepEqual([narrowed, refused.status, refused.body], [true, 404, { error: 'no-directory' }])
})

test('a validation of own code is shared by its reader\'s requests alone, each reader\'s access checked again after their own run', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { db, send, asked } = await fixture(t, { gate })
  await db.setTeamRepo('two', 1, null) // his team reads all of the repository, as hers does
  const runs = () => asked.filter(path => path === 'registry.npmjs.org/ms/2.1.3').length
  const until = async (done, what) => {
    for (const started = Date.now(); !done(); await new Promise(resolve => { setTimeout(resolve, 5) })) {
      if (Date.now() - started > 10_000) throw new Error(`never ${what}`)
    }
  }
  const hers = send('alice', 'POST')
  await until(() => runs() === 1, 'started')
  const his = send('manager', 'POST')
  await until(() => runs() === 2, 'ran apart: his request shared hers')
  // His access narrowed to the bundle's directory while his run reads the repository.
  await db.removeTeamRepo('two', 1)
  await db.setTeamRepo('two', 1, 'web')
  release()
  const [her, him] = await Promise.all([hers, his])
  assert.deepEqual([her.status, her.body.validation.own.checked], [200, true])
  assert.deepEqual([him.status, him.body], [404, { error: 'no-directory' }], 'none of own code told him')
})

test('a bundle of no repository has its dependencies validated, its own code told unverified, and the files only its own patch makes', async t => {
  const { send } = await fixture(t, { repo: false })
  const { validation } = (await send('admin', 'POST')).body
  assert.deepEqual([validation.status, validation.own, validation.lockfiles], ['invalid', { checked: false, reason: 'no-repository' }, null])
  const ms = validation.packages.find(pkg => pkg.name === 'ms')
  assert.deepEqual([ms.status, ms.reason, ms.patch], ['unverified', 'patch-unverified', { path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: false }])
})

// org/repo's pnpm-lock.yaml at the commit: ms patched by the bundle's patch, left as published, each
// with its tarball's integrity; gone, which it locks none of.
const PNPM_LOCK = () => {
  const integrity = name => packageOf(name, name === 'ms' ? '2.1.3' : '1.0.0', name === 'ms' ? MS : PACKAGES['npm:left@1.0.0']).doc.dist.integrity
  return `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\npatchedDependencies:\n  ms@2.1.3:\n    hash: ${sha256(MS_PATCH)}\n`
    + `    path: web/patches/ms@2.1.3.patch\n\nimporters:\n\n  web:\n    dependencies:\n      left:\n        specifier: 1.0.0\n        version: 1.0.0\n      ms:\n        specifier: 2.1.3\n`
    + `        version: 2.1.3(patch_hash=${sha256(MS_PATCH)})\n\npackages:\n\n  left@1.0.0:\n    resolution: {integrity: ${integrity('left')}}\n\n  ms@2.1.3:\n`
    + `    resolution: {integrity: ${integrity('ms')}}\n\nsnapshots:\n\n  left@1.0.0: {}\n\n  ms@2.1.3(patch_hash=${sha256(MS_PATCH)}): {}\n`
}

test('a bundle\'s dependencies held to the lockfile installing it at its commit: each fetched with the integrity it locks, one it locks none of failing', async t => {
  const { send, asked } = await fixture(t, { repoFiles: { 'pnpm-lock.yaml': PNPM_LOCK(), 'pnpm-workspace.yaml': 'packages:\n  - web\n' } })
  const { validation } = (await send('alice', 'POST')).body
  assert.deepEqual([validation.status, validation.lockfiles, validation.lockfileError, validation.counts.lockFailures], ['invalid', ['pnpm-lock.yaml'], undefined, 1])
  assert.deepEqual(validation.packages.map(pkg => [pkg.name, pkg.status, pkg.reason ?? null]), [['gone', 'invalid', 'not-locked'], ['left', 'invalid', null],
    ['org/php', 'unverified', 'unsupported'], ['ms', 'valid', null]])
  assert.deepEqual(validation.packages.find(pkg => pkg.name === 'ms').patch, { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: true })
  assert.ok(asked.includes('registry.npmjs.org/ms/-/ms-2.1.3.tgz') && !asked.includes('registry.npmjs.org/ms/2.1.3'), 'its tarball fetched with the integrity locked')
  assert.ok(!asked.some(path => path.startsWith('registry.npmjs.org/gone')), 'gone, locked by none, never fetched')
})

test('a commit of no branch or tag of the repository (a fork\'s, which GitHub serves through its name too) leaves own code unverified, its lockfile not held to', async t => {
  const { send, asked } = await fixture(t, { head: 'e'.repeat(40), repoFiles: { 'pnpm-lock.yaml': PNPM_LOCK() } })
  const { validation } = (await send('alice', 'POST')).body
  assert.deepEqual([validation.status, validation.own, validation.lockfiles], ['invalid', { checked: false, reason: 'commit-not-in-history' }, null])
  assert.ok(asked.includes(`api.github.com/repos/org/repo/compare/${commit}...main?per_page=1`), 'held to main\'s history')
})

test('a commit GitHub has none of leaves own code unverified, no history of the repository\'s compared', async t => {
  const { send, asked } = await fixture(t, { tree: false })
  const { validation } = (await send('alice', 'POST')).body
  assert.deepEqual([validation.own, validation.lockfiles], [{ checked: false, reason: 'commit-not-found' }, null])
  assert.ok(!asked.some(path => path.includes('/compare/') || path.includes('/branches')))
})

