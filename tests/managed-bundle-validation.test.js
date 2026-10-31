// A Stasis bundle validated (server-managed/bundle-validation.ts): its own
// code as GitHub has it at its commit, by git's blob ids; each dependency's
// files as upstream's package has them, those it leaves out expected, a
// patched npm version's as its patch changes them; those two covering every
// file it holds; and (GET and POST /api/bundles/:id/validation) kept, told
// to whom may see it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { HttpError } from '@preventive/upstream/npm.js'
import { commitBlobs, gitBlobId, validateBundle, validationPlan } from '../server-managed/bundle-validation.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { readTarballFiles } from '../server-managed/npm-loads.ts'
import { parsePatch } from '../server-managed/npm-patch.ts'
import { people } from './_managed-repository-dependency-reviews.js'
import { REGISTRY, packageOf, tar } from './_managed-npm.js'

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
const own = (entries = TREE, more = {}) => ({ entries: new Map(Object.entries(entries)), cut: false, repository: 'org/repo', commit, directory: 'web', ...more })
const PACKAGES = { 'npm:ms@2.1.3': MS, 'npm:left@1.0.0': { 'index.js': 'original\n', 'other.js': 'never bundled\n' } }
const upstream = (packages = PACKAGES) => (ecosystem, name, version) => {
  const files = packages[`${ecosystem}:${name}@${version}`]
  if (!files) return Promise.reject(Object.assign(new HttpError('Not found'), { status: 404 }))
  return Promise.resolve(new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])))
}

test('a bundle\'s files are its own code and each package version\'s; no directory, nor Stasis\'s empty placeholder; the patches it holds', () => {
  const plan = validationPlan(details())
  assert.deepEqual(plan.own.map(file => file.path), ['icon.png', 'patches/ms@2.1.3.patch', 'src/changed.js', 'src/crlf.js', 'src/extra.js', 'src/link.js', 'src/main.js',
    'vendor/sub/x.js'])
  assert.deepEqual(plan.packages.map(pkg => [pkg.ecosystem, pkg.name, pkg.version, pkg.files.map(file => file.rel)]), [['npm', 'gone', '1.0.0', ['index.js']],
    ['npm', 'left', '1.0.0', ['index.js', 'injected.js']], ['npm', 'ms', '2.1.3', ['index.js', 'package.json']], ['composer', 'org/php', '1.0.0', ['a.php']]])
  assert.deepEqual([...plan.patches.keys()], ['patches/ms@2.1.3.patch'])
  assert.equal(plan.files, 14, 'its placeholder left out, allowed')
  const filled = validationPlan(details({ '.': { name: 'app', version: '1.0.0', files: { '.stasis/empty-module.js': 'not empty\n' } } }))
  assert.deepEqual(filled.own.map(file => file.path), ['.stasis/empty-module.js'], 'a file there that isn\'t empty is no placeholder: own code')
  assert.deepEqual([...plan.own.find(file => file.path === 'icon.png').bytes()], [0, 255], 'a resource\'s bytes as its base64 spells them')
  assert.equal(validationPlan({ kind: 'sourcemap' }), null)
})

test('own code is held to GitHub\'s blobs at the commit; each dependency\'s files to its package\'s, a patched one\'s as patched, those it leaves out expected', async () => {
  const validation = await validateBundle(validationPlan(details()), own(), { fetch: upstream(), now: () => 1 })
  assert.equal(validation.status, 'invalid')
  assert.deepEqual(validation.own, { checked: true, repository: 'org/repo', commit, directory: 'web' })
  assert.deepEqual(validation.problems, [
    { path: 'node_modules/left/index.js', kind: 'differs', of: 'npm:left@1.0.0' },
    { path: 'node_modules/left/injected.js', kind: 'unexpected', of: 'npm:left@1.0.0' },
    { path: 'src/changed.js', kind: 'differs', of: 'own' },
    { path: 'src/extra.js', kind: 'unexpected', of: 'own' },
    { path: 'src/link.js', kind: 'differs', of: 'own', reason: 'symlink' },
    { path: 'vendor/sub/x.js', kind: 'unexpected', of: 'own', reason: 'submodule' },
  ])
  assert.deepEqual(validation.packages, [
    { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: 1, status: 'unverified', reason: 'unsupported' },
    { ecosystem: 'npm', name: 'gone', version: '1.0.0', files: 1, status: 'unverified', reason: 'not-published' },
    { ecosystem: 'npm', name: 'left', version: '1.0.0', files: 2, status: 'invalid' },
    { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'valid', patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true } },
  ], 'ms as the patch the bundle holds named for it changes it, no lockfile read; its readme left out; left\'s other.js too')
  assert.deepEqual(validation.counts, { files: 14, own: 8, dependencies: 6, matched: 6, eol: 1, differs: 3, unexpected: 3, unverified: 2, packages: 4, validPackages: 1 },
    'main, crlf (its line endings a checkout\'s), the patch and the icon; ms\'s two')
  assert.equal(validation.validatedAt, 1)
})

test('a version its lockfile patches is held to that patch, of the bundle\'s file of its hash, else read of the repository; one it doesn\'t, as published', async () => {
  const plan = validationPlan(details({ 'node_modules/left': undefined }))
  plan.packages = plan.packages.filter(pkg => pkg.name === 'ms')
  const read = []
  const locked = (lock, text = MS_PATCH) => ({ of: (name, version) => name === 'ms' && version === '2.1.3' ? lock : undefined,
    read: (hash, path) => { read.push([hash, path]); return Promise.resolve(parsePatch(text)) }, git: () => false })
  const told = async (lock, more) => (await validateBundle(plan, own(), { fetch: upstream(), locked: locked(lock, more) })).packages
  assert.deepEqual(await told({ hash: sha256(MS_PATCH), path: 'patches/elsewhere.patch' }), [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'valid',
    patch: { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true } }], 'the bundle\'s file of its hash')
  assert.deepEqual(read, [])
  const hash = sha256('another patch')
  assert.deepEqual((await told({ hash, path: 'web/patches/other.patch' }))[0].patch, { hash, path: 'web/patches/other.patch', from: 'repository', applied: true })
  assert.deepEqual(read, [[hash, 'web/patches/other.patch']], 'none the bundle holds of its hash: the repository\'s')
  assert.deepEqual((await told({ hash }))[0], { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'invalid', patch: { hash, error: 'patch-not-found' } },
    'pnpm 11\'s, named by its hash alone, of no file the bundle holds')
  const unpatched = await validateBundle(plan, own(), { fetch: upstream(), locked: locked(null) })
  assert.deepEqual([unpatched.packages, unpatched.problems.filter(problem => problem.of !== 'own')], [[{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2,
    status: 'invalid' }], [{ path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }]], 'locked unpatched: the bundle\'s patch named for it not taken')
})

test('without its own code checked, a bundle valid otherwise is incomplete; a version past the deadline unverified; its tree cut short, own files not listed unverified', async () => {
  const plan = validationPlan(details())
  plan.own = plan.own.filter(file => file.path === 'src/main.js')
  plan.packages = plan.packages.filter(pkg => pkg.name === 'ms')
  assert.equal((await validateBundle(plan, own(), { fetch: upstream() })).status, 'valid')
  const unchecked = await validateBundle(plan, { reason: 'no-repository' }, { fetch: upstream() })
  assert.deepEqual([unchecked.status, unchecked.own, unchecked.counts.unverified, unchecked.problems], ['incomplete', { checked: false, reason: 'no-repository' }, 1, []])
  const late = await validateBundle(plan, own(), { fetch: upstream(), deadline: 0, now: () => 1 })
  assert.deepEqual([late.status, late.packages[0].reason], ['incomplete', 'timeout'])
  plan.own = validationPlan(details()).own.filter(file => file.path === 'src/extra.js')
  const cut = await validateBundle(plan, own(TREE, { cut: true }), { fetch: upstream() })
  assert.deepEqual([cut.status, cut.own.cut, cut.problems], ['incomplete', true, [{ path: 'src/extra.js', kind: 'unverified', of: 'own', reason: 'tree-cut' }]])
})

test('a commit\'s blobs are its tree\'s listing whole, else, cut short, read a directory at a time into those holding the paths asked alone', async t => {
  const asked = []
  const listings = {
    [`${commit}?recursive=1`]: { truncated: true, tree: [] },
    [commit]: { truncated: false, tree: [{ path: 'web', type: 'tree', sha: 'a'.repeat(40), mode: '040000' }, { path: 'docs', type: 'tree', sha: 'd'.repeat(40), mode: '040000' },
      { path: 'README.md', type: 'blob', sha: 'e'.repeat(40), mode: '100644' }] },
    [`${'a'.repeat(40)}?recursive=1`]: { truncated: false, tree: [{ path: 'src', type: 'tree', sha: 'b'.repeat(40), mode: '040000' },
      { path: 'src/main.js', type: 'blob', sha: 'f'.repeat(40), mode: '100644' }, { path: 'sub', type: 'commit', sha: 'c'.repeat(40), mode: '160000' }] },
  }
  const fetchImpl = t.mock.fn(input => {
    const tree = String(input).split('/git/trees/')[1]
    asked.push(tree)
    return Promise.resolve(listings[tree] ? Response.json(listings[tree]) : Response.json({ message: 'Not Found' }, { status: 404 }))
  })
  const { entries, cut } = await commitBlobs('org/repo', 'token', commit, ['web/src/main.js'], fetchImpl)
  assert.deepEqual([...entries], [['README.md', { sha: 'e'.repeat(40), mode: '100644', type: 'blob' }], ['web/src/main.js', { sha: 'f'.repeat(40), mode: '100644', type: 'blob' }],
    ['web/sub', { sha: 'c'.repeat(40), mode: '160000', type: 'commit' }]])
  assert.equal(cut, false)
  assert.deepEqual(asked, [`${commit}?recursive=1`, commit, `${'a'.repeat(40)}?recursive=1`], 'docs never read')
  await assert.rejects(commitBlobs('org/repo', 'token', '9'.repeat(40), [], fetchImpl), /github-not-found/u)
})

// The app's API as `who` asks it, over a bundle stored at org/repo's `web`,
// GitHub's tree at its commit and npm's registry as `files` and `packages`
// say.
async function fixture(t, { repo = true } = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const users = await people(db)
  const bytes = brotliCompressSync(Buffer.from(details().bundle.serialize()))
  const id = '00000000-0000-4000-8000-000000000002'
  await db.insertBundle({ id, integrity: 'sha512-validated', filename: 'web.stasis.code.br', kind: 'stasis', byteSize: bytes.length, uploadedBy: users.admin.userId,
    uploadedByLogin: 'admin', repoId: repo ? 1 : null, repoDirectory: repo ? 'web' : '' }, Date.now())
  const published = Object.entries(PACKAGES).map(([key, files]) => packageOf(key.slice(4, key.lastIndexOf('@')), key.slice(key.lastIndexOf('@') + 1), files))
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const url = new URL(String(input))
    asked.push(`${url.host}${url.pathname}${url.search}`)
    if (url.host === 'api.github.com') {
      if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json({ id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }))
      if (url.pathname === `/repos/org/repo/git/trees/${commit}` && url.search === '?recursive=1') {
        return Promise.resolve(Response.json({ truncated: false, tree: Object.entries(TREE).map(([path, entry]) => ({ path, ...entry })) }))
      }
      return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    for (const { doc, tgz } of published) {
      if (String(input) === `${REGISTRY}/${doc.name}/${doc.version}`) return Promise.resolve(Response.json(doc))
      if (String(input) === doc.dist.tarball) return Promise.resolve(new Response(tgz))
    }
    void init
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
  assert.ok(asked.includes(`registry.npmjs.org/ms/2.1.3`) && asked.includes(`api.github.com/repos/org/repo/git/trees/${commit}?recursive=1`), 'npm and GitHub asked')
  asked.length = 0
  assert.deepEqual((await send('alice')).body, { validation }, 'kept')
  assert.deepEqual(asked.filter(path => !path.startsWith('api.github.com/repos/org/repo')), [], 'nothing fetched to tell it')

  // A reader of only part of the repository is told none of it, and validates its dependencies alone.
  await db.setTeamRepo('two', 1, 'web')
  assert.deepEqual((await send('manager')).body, { validation: null })
  const theirs = (await send('manager', 'POST')).body.validation
  assert.deepEqual([theirs.own, theirs.counts.unverified], [{ checked: false, reason: 'no-access' }, 10])
  assert.ok(!theirs.problems.some(problem => problem.of === 'own'))
  assert.deepEqual((await send('manager')).body.validation, theirs)
  assert.deepEqual((await send('alice')).body.validation, validation, 'hers still the one checking its own code')
  assert.equal((await send('carol', 'POST')).status, 404, 'one of no bundle')
})

test('a bundle of no repository has its dependencies validated, its own code told unverified', async t => {
  const { send } = await fixture(t, { repo: false })
  const { validation } = (await send('admin', 'POST')).body
  assert.deepEqual([validation.status, validation.own], ['invalid', { checked: false, reason: 'no-repository' }])
  assert.deepEqual(validation.packages.find(pkg => pkg.name === 'ms').patch, { path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true })
})

test('a package\'s tarball unpacked, its top directory left out, as upstream fetches it', async () => {
  // As the registry would serve it: npm's `package/` directory.
  const tgz = gzipSync(tar([{ name: 'package/index.js', data: 'x' }]))
  assert.deepEqual((await readTarballFiles(tgz)).map(file => file.path), ['index.js'])
})

test('each installed copy of a version is held to its files patched or as published apart, the version fetched once', async () => {
  const fetched = []
  const plan = validationPlan(details({ 'node_modules/tool/node_modules/ms': { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } } }))
  plan.own = []
  plan.packages = plan.packages.filter(pkg => pkg.name === 'ms')
  const fetch = (...asked) => { fetched.push(asked.join(':')); return upstream()(...asked) }
  const both = await validateBundle(plan, own(), { fetch })
  assert.deepEqual([both.status, both.problems, both.packages], ['valid', [], [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 3, status: 'valid',
    patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true } }]], 'the direct copy patched, the nested one as published')
  assert.deepEqual(fetched, ['npm:ms:2.1.3'])
  const nested = plan.packages[0].files.find(file => file.dir === 'node_modules/tool/node_modules/ms')
  nested.bytes = () => Buffer.from('neither\n')
  const broken = await validateBundle(plan, own(), { fetch })
  assert.deepEqual([broken.status, broken.problems, broken.packages[0].patch], ['invalid',
    [{ path: 'node_modules/tool/node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }], { path: 'patches/ms@2.1.3.patch', from: 'bundle' }],
  'a copy matching neither told alone; whether it is as patched, told of a valid one alone')
})

test('a vendored crate\'s .cargo-checksum.json, which no crate holds, is held to the crate: its package checksum and each file it lists', async () => {
  const lib = 'pub fn x() {}\n'
  const crate = Object.assign(new Map([['src/lib.rs', Buffer.from(lib)], ['Cargo.toml', Buffer.from('[package]\n')]]), { checksum: 'c'.repeat(64) })
  const json = (files, pkg = 'c'.repeat(64)) => JSON.stringify({ files, package: pkg })
  const run = async text => (await validateBundle(validationPlan({ kind: 'stasis', bundle: Bundle.parse(new Bundle({ modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.rs': 'fn main() {}\n' } }],
    ['vendor/dep', { ecosystem: 'cargo', name: 'dep', version: '1.0.0', files: { 'src/lib.rs': lib, '.cargo-checksum.json': text } }],
  ]) }).serialize()) }), { reason: 'no-repository' }, { fetch: () => Promise.resolve(crate) })).problems
  const listed = { 'src/lib.rs': createHash('sha256').update(lib).digest('hex') }
  const differs = [{ path: 'vendor/dep/.cargo-checksum.json', kind: 'differs', of: 'cargo:dep@1.0.0' }]
  assert.deepEqual(await run(json(listed)), [])
  assert.deepEqual(await run(json({ 'src/lib.rs': 'd'.repeat(64) })), differs, 'a file it lists not the crate\'s')
  assert.deepEqual(await run(json(listed, 'e'.repeat(64))), differs, 'another crate\'s')
  assert.deepEqual(await run('not json'), differs)
})

test('an npm version its lockfiles lock from git alone is left unverified; one recording a commit (a registry package\'s gitHead) held to the registry\'s', async () => {
  const fetched = []
  const gitHead = { github: 'vercel/ms', commit: 'a'.repeat(40) }
  const plan = validationPlan(details({ 'node_modules/ms': { name: 'ms', version: '2.1.3', repo: gitHead, files: { 'index.js': MS['index.js'] } }, 'node_modules/left': undefined }))
  plan.own = []
  plan.packages = plan.packages.filter(pkg => pkg.name !== 'org/php')
  const fetch = (...asked) => { fetched.push(asked.join(':')); return upstream()(...asked) }
  const registry = await validateBundle(plan, own(), { fetch })
  assert.deepEqual(registry.packages.map(pkg => [pkg.name, pkg.status, pkg.reason ?? null]), [['gone', 'unverified', 'not-published'], ['ms', 'valid', null]],
    'ms valid (told for the bundle\'s patch it is not patched with), its gitHead no sign of git')
  assert.deepEqual(fetched.toSorted(), ['npm:gone:1.0.0', 'npm:ms:2.1.3'])

  fetched.length = 0
  const locked = { of: () => undefined, read: () => Promise.resolve([]), git: (name, version) => name === 'ms' && version === '2.1.3' }
  const report = await validateBundle(plan, own(), { fetch, locked })
  assert.deepEqual([report.status, report.problems, report.packages.map(pkg => [pkg.name, pkg.status, pkg.reason ?? null])],
    ['incomplete', [], [['gone', 'unverified', 'not-published'], ['ms', 'unverified', 'git']]], 'locked from git: never held to the registry\'s')
  assert.deepEqual(fetched, ['npm:gone:1.0.0'])
})

test('the root module, and an npm-tagged one outside node_modules (a workspace package), are own code whatever ecosystem they record', () => {
  const plan = validationPlan({ kind: 'stasis', bundle: Bundle.parse(new Bundle({ modules: new Map([
    ['.', { ecosystem: 'composer', name: 'org/app', version: '1.0.0', files: { 'index.php': '<?php\n' } }],
    ['packages/lib', { ecosystem: 'npm', name: 'lib', version: '1.0.0', files: { 'index.js': 'lib\n' } }],
    ['vendor/org/php', { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: { 'a.php': '<?php\n' } }],
  ]) }).serialize()) })
  assert.deepEqual(plan.own.map(file => file.path), ['index.php', 'packages/lib/index.js'])
  assert.deepEqual(plan.packages.map(pkg => `${pkg.ecosystem}:${pkg.name}`), ['composer:org/php'], 'a vendored Composer package a dependency still')
})
