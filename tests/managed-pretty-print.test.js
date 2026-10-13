import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { format } from '@preventive/compare/pretty.js'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { createBundleCache } from '../server-managed/bundle-cache.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createDiskObjectStorage } from '../server-managed/object-storage-disk.ts'
import { createPrettyCache, prettyBody } from '../server-managed/pretty-print.ts'
import { renameDiffOf } from '../server-managed/rename-diff.ts'
import { createSession } from '../server-managed/session.ts'
import { MAX_PRETTY_BYTES, prettyExtension } from '../common/pretty-print.js'
import { changeBlocks } from '../common/line-diff.js'
import { storageTestKey as key } from './_managed-storage-db.js'
import { managedStores } from './_managed-storage.js'
import { packageOf, registry, withToken } from './_managed-npm.js'

const config = {
  port: 0, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'sid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600, allowShare: true,
}
const minified = 'function add(a,b){return a+b}const s=css`a{color:red}`;export const x=add(1,2),y=[1,2,3].map(n=>n*2);\n'
const fileHash = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const formatted = async text => (await format(text, 'js')).code

// A package's tarball downloads among the registry's calls.
const downloads = (calls, { doc }) => calls.filter(call => call.url === doc.dist.tarball).length

// A managed server on disk storage, encrypted as a deployment with a key is.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-pretty-'))
  const db = openSqliteManagedDb(':memory:', { storageEncryptionKey: key })
  await db.enableStorageEncryption()
  const stores = await managedStores(t, createDiskObjectStorage(dir), { db, key, disk: true })
  const bundleCache = createBundleCache(stores.cacheStorage, db, stores.bundleStore)
  const prettyCache = createPrettyCache(stores.cacheStorage, stores.npmCacheStorage, db, stores.bundleStore)
  const server = createServer(createManagedRequestHandler({
    config, db, bundleStore: stores.bundleStore, reportStore: stores.reportStore, bundleCache, prettyCache,
    avatarStore: { get: () => Promise.resolve(null) }, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: () => {},
  }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    const stopping = new Promise(resolve => { server.close(resolve) })
    server.closeAllConnections()
    await stopping
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })
  const users = {}
  for (const [i, role] of ['admin', 'view', 'view'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: `user${i}`, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    users[['admin', 'viewer', 'outsider'][i]] = { ...session, cookie: session.setCookie.split(';')[0] }
  }
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: users.admin.userId }, Date.now())
  const team = randomUUID()
  await db.createTeam(team, 'Team', Date.now())
  await db.setTeamRepo(team, 1, null)
  await db.setTeamMember(team, users.viewer.userId, { dependencies: true, security: true })
  function send(path, who = 'viewer', { method = 'GET', headers = {}, body } = {}) {
    const user = users[who]
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrfToken } : {}), ...headers,
      } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          const decoded = () => (res.headers['content-encoding'] === 'br' ? brotliDecompressSync(bytes) : bytes).toString()
          resolve({ status: res.statusCode, headers: res.headers, bytes, text: decoded, json: () => JSON.parse(decoded()) })
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  async function seed(sources) {
    const bytes = Buffer.from(JSON.stringify({ version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources), names: [], mappings: 'AAAA' }))
    const id = randomUUID()
    const dataKey = await stores.bundleStore.put(id, bytes, 'sourcemap')
    await db.insertBundle({ id, integrity: bundleIntegrity(bytes), filename: 'app.map', kind: 'sourcemap', byteSize: bytes.length, dataKey,
      uploadedBy: users.admin.userId, uploadedByLogin: 'admin', repoId: 1, repoDirectory: '' }, Date.now())
    return id
  }
  return { dir, db, raw: stores.raw, stores, users, send, seed, team }
}

const npmPretty = (name, version) => `/api/npm/pretty?${new URLSearchParams({ name, version })}`
// A response's lines, each a file's.
const linesOf = res => res.text().split('\n').filter(Boolean).map(line => JSON.parse(line))
// Minified enough to be pretty-printed (needsPrettyPrint), as `minified` alone
// is not; and as long, but not code.
const long = `var a=[${Array.from({ length: 400 }, (_, i) => i).join(',')}];function f(b){return a.map(c=>c*b)}export{f};\n`
const broken = long.replace('function f(b)', 'function (')
const bundlePretty = (id, path, hash) => `/api/bundles/${id}/pretty?${new URLSearchParams({ path, hash })}`
const bundleRenameDiff = (id, other, params) => `/api/bundles/${id}/rename-diff?${new URLSearchParams({ other, ...params })}`
const npmRenameDiff = (name, version, otherVersion, params) => `/api/npm/rename-diff?${new URLSearchParams({ name, version, otherVersion, ...params })}`

// What a rename diff of the two builds below answers: the old one with the
// new one's names, formatted, diffed with the new one, the two files' hashes
// and those of the two copies diffed.
async function renamedBuilds(ignoreWhitespace = false) {
  const before = (await formatted(built)).replace('add(a, b)', 'add(c, d)').replace('a + b', 'c + d')
  const after = await formatted(rebuilt)
  // No name read; the function's first two lines differ in its renamed names alone.
  const marks = [{ a0: 0, a1: 2, b0: 0, b1: 2 }]
  return { before, blocks: changeBlocks(before, after, ignoreWhitespace), reason: null, reads: [], marks, hash: fileHash(built), otherHash: fileHash(rebuilt),
    prettyHash: fileHash(await formatted(built)), otherPrettyHash: fileHash(after) }
}
// A minifier's two builds of a module: a function's names renamed, a number changed.
const built = 'function add(a,b){return a+b}export const x=add(1,2),y=[1,2,3].map(n=>n*2);\n'
const rebuilt = 'function add(c,d){return c+d}export const x=add(1,2),y=[1,2,3].map(n=>n*3);\n'
const builds = (path = 'dist/app.min.js', otherPath = path) => ({ path, hash: fileHash(built), otherPath, otherHash: fileHash(rebuilt) })

test('pretty-printing takes code by extension, up to a size, and leaves template literals as they are', async () => {
  assert.deepEqual(['a.min.js', 'b.MJS', 'c.d.ts', 'd.tsx', 'e.css', 'f.json', 'g.md', 'h', 'i.js.map'].map(prettyExtension),
    ['js', 'mjs', 'ts', 'tsx', 'css', 'json', null, null, null])
  const text = brotliDecompressSync(await prettyBody(minified, 'js')).toString()
  assert.equal(text, await formatted(minified))
  assert.ok(text.split('\n').length > 5)
  assert.match(text, /css`a\{color:red\}`/u, 'an embedded stylesheet is not reformatted')
  await assert.rejects(prettyBody('function (', 'js'), { status: 422, message: 'unformattable' })
  await assert.rejects(prettyBody('x'.repeat(MAX_PRETTY_BYTES + 1), 'js'), { status: 413, message: 'file-too-large' })
})

test('published minified code and styles pretty-print, checked by @preventive/compare to change their layout alone', async () => {
  const require = createRequire(import.meta.url)
  for (const file of ['prismjs/components/prism-core.min.js', 'prismjs/components/prism-javascript.min.js', 'prismjs/themes/prism.min.css']) {
    const text = await readFile(require.resolve(file), 'utf8')
    const pretty = brotliDecompressSync(await prettyBody(text, prettyExtension(file))).toString()
    assert.ok(pretty.split('\n').length > text.split('\n').length, file)
  }
})

test('formats past those running wait their turn, and past those waiting are refused', async () => {
  const results = await Promise.allSettled(Array.from({ length: 19 }, () => prettyBody(minified, 'js')))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 18)
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(({ reason }) => [reason.status, reason.message]), [[429, 'pretty-busy']])
})

test('a public npm version\'s files that need it are pretty-printed in one request, each kept unencrypted by its hash', async t => {
  const h = await setup(t)
  const pkg = packageOf('lib', '1.0.0', { 'dist/lib.min.js': long, 'README.md': '# lib\n', 'dist/other.min.js': long, 'src/index.js': 'export const a = 1\n', 'dist/bad.min.js': broken })
  registry(t, [pkg])
  const hash = fileHash(long), pretty = await formatted(long)
  const first = await h.send(npmPretty('lib', '1.0.0'))
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-encoding'], 'br')
  assert.equal(first.headers['content-type'], 'application/x-ndjson')
  assert.equal(first.headers['cache-control'], 'private, no-store')
  assert.deepEqual(linesOf(first), [
    { path: 'dist/bad.min.js', source: fileHash(broken), error: 'unformattable', status: 422 },
    { path: 'dist/lib.min.js', source: hash, text: pretty },
    { path: 'dist/other.min.js', source: hash, text: pretty },
  ], 'its minified files alone, in path order, each naming the file it was formatted from')
  // Kept in the public namespace, the same text once.
  assert.deepEqual(await readdir(join(h.dir, 'cache', 'npm', 'pretty-v3')), [`${Buffer.from(hash.slice(7), 'base64').toString('hex')}.js.br`])
  assert.deepEqual(linesOf(await h.send(npmPretty('lib', '1.0.0'))), linesOf(first), 'and read from there')
})

test('npm pretty-print refuses what it cannot answer', async t => {
  const h = await setup(t)
  registry(t, [packageOf('lib', '1.0.0', { 'lib.min.js': long }), packageOf('plain', '1.0.0', { 'index.js': 'export const a = 1\n' })])
  const missing = await h.send(npmPretty('lib', '2.0.0'))
  assert.equal(missing.status, 404)
  assert.equal(missing.json().error, 'package-not-found')
  assert.equal((await h.send(npmPretty('lib', '1.0.0'), null)).status, 401)
  assert.equal((await h.send(npmPretty('lib', '1.0.0'), 'viewer', { method: 'POST' })).status, 405)
  const plain = await h.send(npmPretty('plain', '1.0.0'))
  assert.equal(plain.status, 200)
  assert.deepEqual(linesOf(plain), [], 'a version with nothing minified has no lines')
  await assert.rejects(readdir(join(h.dir, 'cache', 'npm')), { code: 'ENOENT' }, 'refusals keep nothing')
})

test('a private npm version is formatted for each reader who may read it and never kept', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = { ...packageOf('@corp/lib', '1.0.0', { 'lib.min.js': long }), private: true }
  const calls = registry(t, [pkg])
  assert.equal((await h.send(npmPretty('@corp/lib', '1.0.0'))).status, 404, 'a reader without private access gets nothing')
  for (let i = 0; i < 2; i++) {
    const res = await h.send(npmPretty('@corp/lib', '1.0.0'), 'admin')
    assert.equal(res.status, 200)
    assert.deepEqual(linesOf(res), [{ path: 'lib.min.js', source: fileHash(long), text: await formatted(long) }])
  }
  assert.equal(downloads(calls, pkg), 2)
  await assert.rejects(readdir(join(h.dir, 'cache', 'npm')), { code: 'ENOENT' })
})

test('a bundle file is formatted once, kept encrypted in its cache, and removed with the bundle', async t => {
  const h = await setup(t)
  const id = await h.seed({ 'dist/app.min.js': minified, 'src/b.js': 'export const b = 1\n' })
  const hash = fileHash(minified)
  const reads = t.mock.method(h.stores.bundleStore, 'get')
  // Readers asking at once share one copy.
  const [first, twin] = await Promise.all([h.send(bundlePretty(id, 'dist/app.min.js', hash)), h.send(bundlePretty(id, 'dist/app.min.js', hash), 'admin')])
  assert.equal(first.status, 200)
  assert.deepEqual(twin.bytes, first.bytes)
  assert.equal(first.headers['content-encoding'], 'br')
  assert.equal(first.headers['x-source-hash'], hash, 'naming the file it was formatted from')
  assert.equal(first.text(), await formatted(minified))
  const copy = `${Buffer.from(hash.slice(7), 'base64').toString('hex')}.js.br`
  const kept = await readdir(join(h.dir, 'cache-encrypted-v1', 'bundles', id, 'pretty-v3'))
  assert.deepEqual(kept, [copy])
  const stored = await h.raw.open(`cache-encrypted-v1/bundles/${id}/pretty-v3/${copy}`)
  const chunks = []
  for await (const chunk of stored.stream) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).subarray(0, 16).toString(), 'DeepView.storage')
  const again = await h.send(bundlePretty(id, 'dist/app.min.js', hash))
  assert.deepEqual(again.bytes, first.bytes)
  assert.equal(again.headers['x-source-hash'], hash, 'from the kept copy too')
  const head = await h.send(bundlePretty(id, 'dist/app.min.js', hash), 'viewer', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], String(first.bytes.length))
  assert.equal(head.bytes.length, 0)
  assert.equal(reads.mock.callCount(), 1, 'the bundle is decoded only for the first')
  assert.equal((await h.send(`/api/admin/bundles/${id}`, 'admin', { method: 'DELETE' })).status, 200)
  await assert.rejects(readdir(join(h.dir, 'cache-encrypted-v1', 'bundles', id)), { code: 'ENOENT' })
})

test('bundle pretty-print checks access and refuses what it cannot answer', async t => {
  const h = await setup(t)
  const id = await h.seed({ 'dist/app.min.js': minified, 'bad.js': 'function (' })
  const hash = fileHash(minified)
  assert.equal((await h.send(bundlePretty(id, 'dist/app.min.js', hash), 'outsider')).status, 404, 'no team grants the outsider the repository')
  const cases = [
    [bundlePretty(id, 'dist/app.min.js', 'sha512-nope'), 400, 'bad-file'],
    [bundlePretty(id, 'dist/missing.js', hash), 404, 'no-file'],
    [bundlePretty(id, 'dist/app.min.js', fileHash('else')), 409, 'hash-mismatch'],
    [bundlePretty(id, 'bad.js', fileHash('function (')), 422, 'unformattable'],
    [bundlePretty(randomUUID(), 'dist/app.min.js', hash), 404, 'no-bundle'],
  ]
  for (const [path, status, error] of cases) {
    const res = await h.send(path)
    assert.equal(res.status, status, path)
    assert.equal(res.json().error, error, path)
  }
  assert.equal((await h.send(bundlePretty(id, 'dist/app.min.js', hash), 'viewer', { method: 'POST' })).status, 405)
})

test('a public link reads its bundles\' files pretty-printed', async t => {
  const h = await setup(t)
  const id = await h.seed({ 'dist/app.min.js': minified })
  const share = (await h.send(`/api/teams/${h.team}/share`, 'admin', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()
  const headers = { 'x-deepview-share': share.path.split('.').at(-1) }
  const res = await h.send(bundlePretty(id, 'dist/app.min.js', fileHash(minified)), null, { headers })
  assert.equal(res.status, 200)
  assert.equal(res.text(), await formatted(minified))
  const refused = await h.send(bundlePretty(id, 'dist/app.min.js', 'sha512-nope'), null, { headers })
  assert.equal(refused.status, 400)
})

const bundleChanges = (id, other) => `/api/bundles/${id}/pretty?${new URLSearchParams({ other })}`
const npmChanges = (name, version, otherVersion) => `/api/npm/pretty?${new URLSearchParams({ name, version, otherVersion })}`
// Two builds' files: one minified and changed, its old text kept again at a
// new path; one plain and changed; one changed into what can't be formatted;
// one renamed unchanged, its text at another path on each side; and, left
// out, one the same at its path, one changed but not formattable.
const longer = long.replace('c*b', 'c*b*2')
const comparedBuilds = [
  { 'dist/app.min.js': long, 'bad.js': 'export const c = 1\n', 'src/edit.js': 'export const b = 1\n', 'src/same.js': 'export const s = 1\n', 'src/old.js': 'export const o = 1\n', 'README.md': '# a\n' },
  { 'dist/app.min.js': longer, 'dist/backup.min.js': long, 'bad.js': 'function (', 'src/edit.js': 'export const b = 2\n', 'src/same.js': 'export const s = 1\n', 'src/new.js': 'export const o = 1\n', 'README.md': '# b\n' },
]
// The lines for those files, by side and path, as the first request has them:
// the minified first, then the rest in path order, the base's before the other's.
async function comparedLines() {
  const line = async (side, path, text) => ({ side, path, source: fileHash(text), text: await formatted(text) })
  return [await line('base', 'dist/app.min.js', long), await line('other', 'dist/app.min.js', longer), await line('other', 'dist/backup.min.js', long),
    await line('base', 'bad.js', 'export const c = 1\n'), { side: 'other', path: 'bad.js', source: fileHash('function ('), error: 'unformattable', status: 422 },
    await line('base', 'src/edit.js', 'export const b = 1\n'), await line('other', 'src/edit.js', 'export const b = 2\n'),
    await line('other', 'src/new.js', 'export const o = 1\n'), await line('base', 'src/old.js', 'export const o = 1\n')]
}
// Those lines as kept copies are read: in path order, the base's first where
// both have one, then any formatted again, as one that failed is.
const keptOrder = lines => [...lines.filter(line => !line.error).toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), ...lines.filter(line => line.error)]

test('the files that changed between two bundles are pretty-printed in one request, kept ones first, the minified before the rest', async t => {
  const h = await setup(t)
  const [base, other] = [await h.seed(comparedBuilds[0]), await h.seed(comparedBuilds[1])]
  const first = await h.send(bundleChanges(base, other))
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'application/x-ndjson')
  assert.equal(first.headers['content-encoding'], 'br')
  assert.equal(first.headers['cache-control'], 'private, no-store')
  const lines = await comparedLines()
  assert.deepEqual(linesOf(first), lines, 'each side\'s changed files that can be formatted, each naming the file it was formatted from: one whose old text the other keeps elsewhere too among them')
  // Kept in each bundle's cache, as one file's are, and read from there.
  assert.equal((await readdir(join(h.dir, 'cache-encrypted-v1', 'bundles', base, 'pretty-v3'))).length, 4)
  assert.equal((await readdir(join(h.dir, 'cache-encrypted-v1', 'bundles', other, 'pretty-v3'))).length, 4)
  const reads = t.mock.method(h.stores.bundleStore, 'get')
  const one = await h.send(bundlePretty(other, 'src/edit.js', fileHash('export const b = 2\n')))
  assert.equal(one.text(), await formatted('export const b = 2\n'))
  assert.equal(reads.mock.callCount(), 0, 'a copy the comparison made, read alone without decoding the bundle')
  assert.deepEqual(linesOf(await h.send(bundleChanges(base, other))), keptOrder(lines), 'the kept first, the one that failed formatted again after')
})

test('a comparison sends every file whose path has another text on the other side, however many share its text', async t => {
  const h = await setup(t)
  // Two copies of one file, one of them moved: which pairs with which, if
  // any, is the viewer's to say.
  const [base, other] = [await h.seed({ 'a.min.js': long, 'b.min.js': long }), await h.seed({ 'c.min.js': long })]
  const lines = linesOf(await h.send(bundleChanges(base, other)))
  assert.deepEqual(lines.map(({ side, path }) => `${side} ${path}`), ['base a.min.js', 'base b.min.js', 'other c.min.js'])
  assert.ok(lines.every(line => line.text === lines[0].text && line.source === fileHash(long)))
})

test('a comparison\'s pretty-printed files check access to both bundles and refuse what they cannot answer', async t => {
  const h = await setup(t)
  const [base, other] = [await h.seed(comparedBuilds[0]), await h.seed(comparedBuilds[1])]
  const cases = [
    [bundleChanges(base, 'nope'), 'viewer', 400, 'bad-bundle'],
    [bundleChanges(base, randomUUID()), 'viewer', 404, 'no-bundle'],
    [bundleChanges(randomUUID(), other), 'viewer', 404, 'no-bundle'],
    [bundleChanges(base, other), 'outsider', 404, 'no-bundle'],
  ]
  for (const [path, who, status, error] of cases) {
    const res = await h.send(path, who)
    assert.equal(res.status, status, `${who} ${path}`)
    assert.equal(res.json().error, error, `${who} ${path}`)
  }
  assert.equal((await h.send(bundleChanges(base, other), null)).status, 401)
  assert.equal((await h.send(bundleChanges(base, other), 'viewer', { method: 'HEAD' })).status, 405)
})

test('the files that changed between two npm versions are pretty-printed in one request, as two bundles\' are', async t => {
  const h = await setup(t)
  registry(t, [packageOf('lib', '1.0.0', comparedBuilds[0]), packageOf('lib', '1.1.0', comparedBuilds[1])])
  const first = await h.send(npmChanges('lib', '1.0.0', '1.1.0'))
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'application/x-ndjson')
  const lines = await comparedLines()
  assert.deepEqual(linesOf(first), lines)
  assert.equal((await readdir(join(h.dir, 'cache', 'npm', 'pretty-v3'))).length, 6, 'a public version\'s kept by their hashes')
  assert.deepEqual(linesOf(await h.send(npmChanges('lib', '1.0.0', '1.1.0'))), keptOrder(lines))
  const missing = await h.send(npmChanges('lib', '1.0.0', '2.0.0'))
  assert.equal(missing.status, 404)
  assert.equal(missing.json().error, 'package-not-found')
  assert.equal((await h.send(npmChanges('lib', '1.0.0', '>=<'))).status, 400)
  assert.equal((await h.send(npmChanges('lib', '1.0.0', '1.1.0'), null)).status, 401)
})

test('a public link pretty-prints the files that changed between its own bundles alone', async t => {
  const h = await setup(t)
  const [base, other] = [await h.seed(comparedBuilds[0]), await h.seed(comparedBuilds[1])]
  const share = (await h.send(`/api/teams/${h.team}/share`, 'admin', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()
  const headers = { 'x-deepview-share': share.path.split('.').at(-1) }
  const res = await h.send(bundleChanges(base, other), null, { headers })
  assert.equal(res.status, 200)
  assert.deepEqual(linesOf(res), await comparedLines())
  assert.equal((await h.send(bundleChanges(base, randomUUID()), null, { headers })).status, 404)
})

test('a bundle file is diffed with another bundle\'s, both pretty-printed, renamed names hidden', async t => {
  const h = await setup(t)
  const [base, other] = [await h.seed({ 'dist/app.min.js': built }), await h.seed({ 'dist/app.min.js': rebuilt })]
  const res = await h.send(bundleRenameDiff(base, other, builds()))
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json')
  assert.equal(res.headers['content-encoding'], 'br')
  const expected = await renamedBuilds()
  assert.deepEqual(res.json(), expected)
  assert.equal(expected.blocks.length, 1, 'the renamed lines alike, the changed one shown')
  assert.deepEqual((await h.send(bundleRenameDiff(base, other, { ...builds(), ignoreWhitespace: 'true' }))).json(), await renamedBuilds(true))
  // Both copies were kept, as the pretty-print toggle's are.
  for (const id of [base, other]) assert.equal((await readdir(join(h.dir, 'cache-encrypted-v1', 'bundles', id, 'pretty-v3'))).length, 1)
  assert.deepEqual((await h.send(bundleRenameDiff(base, other, builds()), 'admin')).json(), expected, 'kept, for any reader of both')
})

test('a rename diff is kept by both files\' types as well as their texts: a script\'s top level is not a module\'s', async t => {
  const h = await setup(t)
  const [before, after] = ['let a=1;f(a);\n', 'let b=1;f(b);\n']
  const [base, other] = [await h.seed({ 'a.js': before, 'a.mjs': before }), await h.seed({ 'a.js': after, 'a.mjs': after })]
  const params = path => ({ path, hash: fileHash(before), otherPath: path, otherHash: fileHash(after) })
  const script = (await h.send(bundleRenameDiff(base, other, params('a.js')))).json()
  assert.equal(script.blocks.length, 1, 'a script\'s top-level names are globals, kept')
  const module = (await h.send(bundleRenameDiff(base, other, params('a.mjs')))).json()
  assert.deepEqual(module.blocks, [], 'a module\'s are its own, renamed')
})

// A Diff view's four files, built (0) and rebuilt (1), and each one's diff's parameters.
const files = n => Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`dist/${i}.min.js`, n === 0 ? built.replace('n*2', `n*${i + 2}`) : rebuilt.replace('n*3', `n*${i + 9}`)]))
const fileDiffs = () => Object.keys(files(0)).map(path => ({ path, hash: fileHash(files(0)[path]), otherPath: path, otherHash: fileHash(files(1)[path]) }))

test('rename diffs asked for at once past the workers running wait their turn', async t => {
  const h = await setup(t)
  const [base, other] = [await h.seed(files(0)), await h.seed(files(1))]
  // Each copy pretty-printed first, as the view has them by then.
  for (const [id, texts] of [[base, files(0)], [other, files(1)]]) for (const [path, text] of Object.entries(texts)) assert.equal((await h.send(bundlePretty(id, path, fileHash(text)))).status, 200)
  const asked = await Promise.all(fileDiffs().map(params => h.send(bundleRenameDiff(base, other, params))))
  assert.deepEqual(asked.map(res => res.status), [200, 200, 200, 200], 'a Diff view\'s four files')
})

test('a private npm version\'s files diffed at once are formatted in their turns, none refused, and nothing kept', async t => {
  const h = await setup(t)
  withToken(t)
  registry(t, [{ ...packageOf('@corp/lib', '1.0.0', files(0)), private: true }, { ...packageOf('@corp/lib', '1.1.0', files(1)), private: true }])
  const diff = params => npmRenameDiff('@corp/lib', '1.0.0', '1.1.0', params)
  assert.equal((await h.send(diff(fileDiffs()[0]))).status, 404, 'a reader without private access gets nothing')
  // Each side is formatted again for its diff, two formats at most at once.
  const asked = await Promise.all(fileDiffs().map(params => h.send(diff(params), 'admin')))
  assert.deepEqual(asked.map(res => res.status), [200, 200, 200, 200], 'a Diff view\'s four files')
  await assert.rejects(readdir(join(h.dir, 'cache', 'npm')), { code: 'ENOENT' })
})

// A rename diff's answer, read.
async function renameDiffRead(job) {
  const chunks = []
  for await (const chunk of (await job).stream) chunks.push(chunk)
  return JSON.parse(brotliDecompressSync(Buffer.concat(chunks)).toString())
}
const diffSide = text => ({ path: 'a.js', hash: fileHash(text), extension: 'js' })
const diffed = { base: diffSide(built), other: diffSide(rebuilt), ignoreWhitespace: false }
const readBuilds = () => Promise.resolve([built, rebuilt])

test('a rename diff with whitespace changes hidden hides how much whitespace a line has alone, as diff -b', async () => {
  // A blank put into a string, which diff -w would read as no change.
  const rerun = 'function f(b){return exec("rm -rf / tmp/x",b)}export{f};\n', run = 'function f(a){return exec("rm -rf /tmp/x",a)}export{f};\n'
  const asked = { base: diffSide(run), other: diffSide(rerun), ignoreWhitespace: true }
  const copies = await Promise.all([run, rerun].map(text => formatted(text)))
  const answer = await renameDiffRead(renameDiffOf(asked, () => Promise.resolve(copies), false))
  assert.equal(answer.reason, null, 'its names given')
  assert.equal(answer.blocks.length, 1, 'the string\'s change shown')
  assert.match(answer.before.split('\n')[answer.blocks[0].a0], /"rm -rf \/tmp\/x"/u)
})

test('a rename diff waiting its turn has its minute run out there, and leaves the queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 30_000 })
  let release
  const held = new Promise(resolve => { release = resolve })
  // Both workers' turns taken by diffs whose sides (a private version's, so
  // read in their turn) are still being read, their minutes running past
  // those of the diffs then queued behind them: the clock set back once they
  // have their turns.
  const running = [0, 1].map(() => renameDiffOf(diffed, () => held, false))
  await new Promise(resolve => { setImmediate(resolve) })
  t.mock.timers.setTime(0)
  const queued = Array.from({ length: 16 }, () => renameDiffOf(diffed, readBuilds, false))
  await assert.rejects(renameDiffOf(diffed, readBuilds, false), { status: 429, message: 'diff-busy' })
  t.mock.timers.tick(60_000)
  for (const job of queued) await assert.rejects(job, { status: 504, message: 'diff-timeout' })
  // Gone from the queue: the next one waits its turn, and gets it.
  const next = renameDiffOf(diffed, readBuilds, false)
  release([built, rebuilt])
  const answers = await Promise.all([...running, next].map(renameDiffRead))
  for (const answer of answers) assert.deepEqual(answer, answers[0])
  assert.equal(answers[0].reason, null, 'each one diffed, its names given')
})

test('a private rename diff still reading its sides when its minute runs out answers 504 and gives up its turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  // Its version's files still downloading, say.
  const running = [0, 1].map(() => renameDiffOf(diffed, () => new Promise(() => {}), false))
  await new Promise(resolve => { setImmediate(resolve) })
  t.mock.timers.tick(60_000)
  for (const job of running) await assert.rejects(job, { status: 504, message: 'diff-timeout' })
  assert.equal((await renameDiffRead(renameDiffOf(diffed, readBuilds, false))).reason, null, 'the next one has a turn at once')
})

test('a bundle rename diff checks access to both bundles and refuses what it cannot answer', async t => {
  const h = await setup(t)
  const [base, other] = [await h.seed({ 'dist/app.min.js': built, 'app.css': 'a{b:c}' }), await h.seed({ 'dist/app.min.js': rebuilt })]
  // Diffed once, so that a refusal below is no kept diff's.
  assert.equal((await h.send(bundleRenameDiff(base, other, builds()))).status, 200)
  assert.equal((await h.send(bundleRenameDiff(base, other, builds()), 'outsider')).status, 404, 'no team grants the outsider the repository')
  assert.equal((await h.send(bundleRenameDiff(base, other, builds()), null)).status, 401)
  const cases = [
    [bundleRenameDiff(base, other, { ...builds(), hash: 'sha512-nope' }), 400, 'bad-file'],
    [bundleRenameDiff(base, other, { ...builds(), path: 'app.css', hash: fileHash('a{b:c}') }), 400, 'bad-file'],
    [bundleRenameDiff(base, 'nope', builds()), 400, 'bad-file'],
    [bundleRenameDiff(base, randomUUID(), builds()), 404, 'no-bundle'],
    // A copy is its text's, at any path (as above): a file no copy is kept of.
    [bundleRenameDiff(base, other, { ...builds('dist/missing.js', 'dist/app.min.js'), hash: fileHash('missing') }), 404, 'no-file'],
    [bundleRenameDiff(base, other, { ...builds(), otherHash: fileHash('else') }), 409, 'hash-mismatch'],
    // Each side is its own bundle's: the other's file named on this one is none of its.
    [bundleRenameDiff(other, base, builds()), 409, 'hash-mismatch'],
  ]
  for (const [path, status, error] of cases) {
    const res = await h.send(path)
    assert.equal(res.status, status, path)
    assert.equal(res.json().error, error, path)
  }
  assert.equal((await h.send(bundleRenameDiff(base, other, builds()), 'viewer', { method: 'HEAD' })).status, 405)
})

test('an npm file is diffed with another version\'s, both pretty-printed, renamed names hidden', async t => {
  const h = await setup(t)
  registry(t, [packageOf('lib', '1.0.0', { 'dist/lib.min.js': built }), packageOf('lib', '1.1.0', { 'dist/lib.min.js': rebuilt })])
  const res = await h.send(npmRenameDiff('lib', '1.0.0', '1.1.0', builds('dist/lib.min.js')))
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), await renamedBuilds())
  const cases = [
    [npmRenameDiff('lib', '1.0.0', '', builds('dist/lib.min.js')), 400, 'bad-package'],
    [npmRenameDiff('lib', '1.0.0', '1.1.0', { ...builds('dist/lib.min.js'), otherHash: 'sha512-nope' }), 400, 'bad-file'],
    [npmRenameDiff('lib', '1.0.0', '2.0.0', builds('dist/lib.min.js')), 404, 'package-not-found'],
    [npmRenameDiff('lib', '1.0.0', '1.1.0', { ...builds('dist/lib.min.js', 'dist/missing.js'), otherHash: fileHash('missing') }), 404, 'no-file'],
    [npmRenameDiff('lib', '1.0.0', '1.1.0', { ...builds('dist/lib.min.js'), otherHash: fileHash('else') }), 409, 'hash-mismatch'],
  ]
  for (const [path, status, error] of cases) {
    const reply = await h.send(path)
    assert.equal(reply.status, status, path)
    assert.equal(reply.json().error, error, path)
  }
  assert.equal((await h.send(npmRenameDiff('lib', '1.0.0', '1.1.0', builds('dist/lib.min.js')), null)).status, 401)
})

test('a public link diffs its bundles\' files with renamed names hidden, between its own bundles alone', async t => {
  const h = await setup(t)
  const [base, other] = [await h.seed({ 'dist/app.min.js': built }), await h.seed({ 'dist/app.min.js': rebuilt })]
  const share = (await h.send(`/api/teams/${h.team}/share`, 'admin', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()
  const headers = { 'x-deepview-share': share.path.split('.').at(-1) }
  const res = await h.send(bundleRenameDiff(base, other, builds()), null, { headers })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), await renamedBuilds())
  assert.equal((await h.send(bundleRenameDiff(base, randomUUID(), builds()), null, { headers })).status, 404)
  assert.equal((await h.send(bundleRenameDiff(base, other, { ...builds(), hash: 'nope' }), null, { headers })).status, 400)
})
