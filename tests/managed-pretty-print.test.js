import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { format } from 'oxfmt'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { createBundleCache } from '../server-managed/bundle-cache.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createDiskObjectStorage } from '../server-managed/object-storage-disk.ts'
import { PRETTY_OPTIONS, createPrettyCache, prettyBody, sameCode } from '../server-managed/pretty-print.ts'
import { createSession } from '../server-managed/session.ts'
import { createEncryptedObjectStorage } from '../server-managed/storage-encryption.ts'
import { createManagedStores } from '../server-managed/storage-stores.ts'
import { MAX_PRETTY_BYTES, prettyExtension } from '../common/pretty-print.js'
import { storageTestKey as key } from './_managed-storage-db.js'

const config = {
  port: 0, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'sid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600, allowShare: true,
}
const REGISTRY = 'https://registry.npmjs.org'
const minified = 'function add(a,b){return a+b}const s=css`a{color:red}`;export const x=add(1,2),y=[1,2,3].map(n=>n*2);\n'
const fileHash = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const formatted = async text => (await format('pretty.js', text, PRETTY_OPTIONS)).code

// A ustar archive of `files` under `package/`, as npm pack writes one.
function tar(files) {
  const blocks = []
  for (const [path, data] of Object.entries(files)) {
    const body = Buffer.from(data), header = Buffer.alloc(512)
    header.write(`package/${path}`, 0, 100)
    header.write('0000644\0', 100)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write('        ', 148)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

function packageOf(name, version, files) {
  const tgz = gzipSync(tar(files))
  const doc = { name, version, license: 'MIT',
    dist: { tarball: `${REGISTRY}/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`, unpackedSize: 100, fileCount: 2 } }
  return { doc, tgz }
}

// The registry: public packages answer anyone, private ones only the token;
// `tarballs` counts each package's tarball downloads.
function registry(t, packages) {
  const tarballs = new Map()
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const auth = new Headers(init.headers).get('authorization'), url = String(input)
    for (const { doc, tgz, private: secret } of packages) {
      if (secret && auth !== `Bearer ${process.env['NPM_TOKEN']}`) continue
      if (url === `${REGISTRY}/${doc.name}/${encodeURIComponent(doc.version)}`) return Promise.resolve(Response.json(doc))
      if (url === doc.dist.tarball) { tarballs.set(doc.name, (tarballs.get(doc.name) ?? 0) + 1); return Promise.resolve(new Response(tgz)) }
    }
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  })
  return tarballs
}

// A managed server on disk storage, encrypted as a deployment with a key is.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-pretty-'))
  const db = openSqliteManagedDb(':memory:', { storageEncryptionKey: key })
  await db.enableStorageEncryption()
  const raw = createDiskObjectStorage(dir)
  const stores = createManagedStores(await createEncryptedObjectStorage(raw, db, key), true)
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
  return { dir, db, raw, stores, users, send, seed, team }
}

const npmPretty = (name, version, path, hash) => `/api/npm/pretty?${new URLSearchParams({ name, version, path, hash })}`
const bundlePretty = (id, path, hash) => `/api/bundles/${id}/pretty?${new URLSearchParams({ path, hash })}`

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

test('a formatted copy is checked, apart from the formatter, to differ from its file only in layout', async () => {
  // What formatting may respell: whitespace, quotes, parentheses, semicolons, numbers.
  assert.equal(sameCode(
    "var a='x',b='it\\'s';f(x=>x);a=1,b=2;x={'a':1};var n=.5,m=1E+3,k=1.50;!(a||b)||(c||d);new Foo",
    'var a = "x",\n  b = "it\'s";\nf((x) => x);\n((a = 1), (b = 2));\nx = { "a": 1 };\nvar n = 0.5,\n  m = 1e3,\n  k = 1.5;\n!(a || b) || c || d;\nnew Foo();\n'), true)
  for (const [output, what] of [['a = b + c;', 'an operator'], ['a = b;', 'a name'], ['a = c - b;', 'the order'], ['a = b - c; d;', 'an addition'],
    ['a = b - 2;', 'a name for a number'], ['a = "b" - c;', 'a name for a string']]) {
    assert.equal(sameCode('a=b-c', output), false, what)
  }
  assert.equal(sameCode('a=/x/img.test(s)', 'a = /x/gim.test(s);\n'), true, 'flags in order')
  assert.equal(sameCode('a=/x/im', 'a = /x/gim;\n'), false, 'a flag')
  assert.equal(sameCode('a=1.5', 'a = 1.25;\n'), false, 'a number')
  assert.equal(sameCode('a()/* keep me */', 'a();\n'), false, 'a comment')
  assert.equal(sameCode('A[class*=x]{COLOR:RED}', 'a[class*="x"] {\n  color: red;\n}\n'), false)
  assert.equal(sameCode('A[class*=x]{COLOR:RED}', 'a[class*="x"] {\n  color: red;\n}\n', true), true, 'CSS compares without quotes or case')
  // Published minified code and styles pass it as formatted.
  const require = createRequire(import.meta.url)
  for (const file of ['prismjs/components/prism-core.min.js', 'prismjs/components/prism-javascript.min.js', 'prismjs/themes/prism.min.css']) {
    const text = await readFile(require.resolve(file), 'utf8')
    const pretty = brotliDecompressSync(await prettyBody(text, prettyExtension(file))).toString()
    assert.ok(pretty.split('\n').length > text.split('\n').length, file)
  }
})

test('a public npm file is formatted once, kept unencrypted by its hash, and served from that copy', async t => {
  const h = await setup(t)
  const pkg = packageOf('lib', '1.0.0', { 'dist/lib.min.js': minified, 'README.md': '# lib\n', 'dist/other.min.js': minified })
  const tarballs = registry(t, [pkg])
  const hash = fileHash(minified)
  const first = await h.send(npmPretty('lib', '1.0.0', 'dist/lib.min.js', hash))
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-encoding'], 'br')
  assert.equal(first.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(first.headers['cache-control'], 'private, no-store')
  assert.equal(first.text(), await formatted(minified))
  // Kept as the response's bytes, in the public namespace, as they are.
  const kept = await readdir(join(h.dir, 'cache', 'npm', 'pretty-v1'))
  assert.deepEqual(kept, [`${Buffer.from(hash.slice(7), 'base64').toString('hex')}.js.br`])
  const again = await h.send(npmPretty('lib', '1.0.0', 'dist/lib.min.js', hash))
  assert.deepEqual(again.bytes, first.bytes)
  // The same text at another path is the same copy.
  assert.deepEqual((await h.send(npmPretty('lib', '1.0.0', 'dist/other.min.js', hash))).bytes, first.bytes)
  assert.equal(tarballs.get('lib'), 1, 'later reads need no tarball')
})

test('npm pretty-print refuses what it cannot answer', async t => {
  const h = await setup(t)
  registry(t, [packageOf('lib', '1.0.0', { 'lib.min.js': minified, 'bad.js': 'function (' })])
  const hash = fileHash(minified)
  const cases = [
    [npmPretty('lib', '1.0.0', 'lib.min.js', 'sha512-nope'), 400, 'bad-file'],
    [npmPretty('lib', '1.0.0', 'README.md', hash), 400, 'bad-file'],
    [`/api/npm/pretty?${new URLSearchParams({ name: 'lib', version: '1.0.0', path: 'lib.min.js' })}`, 400, 'bad-file'],
    [npmPretty('lib', '1.0.0', 'missing.js', hash), 404, 'no-file'],
    [npmPretty('lib', '1.0.0', 'lib.min.js', fileHash('something else')), 409, 'hash-mismatch'],
    [npmPretty('lib', '1.0.0', 'bad.js', fileHash('function (')), 422, 'unformattable'],
    [npmPretty('lib', '2.0.0', 'lib.min.js', hash), 404, 'package-not-found'],
  ]
  for (const [path, status, error] of cases) {
    const res = await h.send(path)
    assert.equal(res.status, status, path)
    assert.equal(res.json().error, error, path)
  }
  assert.equal((await h.send(npmPretty('lib', '1.0.0', 'lib.min.js', hash), null)).status, 401)
  assert.equal((await h.send(npmPretty('lib', '1.0.0', 'lib.min.js', hash), 'viewer', { method: 'POST' })).status, 405)
  await assert.rejects(readdir(join(h.dir, 'cache', 'npm')), { code: 'ENOENT' }, 'refusals keep nothing')
})

test('a private npm version is formatted for each reader who may read it and never kept', async t => {
  const h = await setup(t)
  const previous = process.env['NPM_TOKEN']
  process.env['NPM_TOKEN'] = 'server-token'
  t.after(() => { if (previous === undefined) delete process.env['NPM_TOKEN']; else process.env['NPM_TOKEN'] = previous })
  const tarballs = registry(t, [{ ...packageOf('@corp/lib', '1.0.0', { 'lib.min.js': minified }), private: true }])
  const path = npmPretty('@corp/lib', '1.0.0', 'lib.min.js', fileHash(minified))
  assert.equal((await h.send(path)).status, 404, 'a reader without private access gets nothing')
  for (let i = 0; i < 2; i++) {
    const res = await h.send(path, 'admin')
    assert.equal(res.status, 200)
    assert.equal(res.text(), await formatted(minified))
  }
  assert.equal(tarballs.get('@corp/lib'), 2)
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
  assert.equal(first.text(), await formatted(minified))
  const copy = `${Buffer.from(hash.slice(7), 'base64').toString('hex')}.js.br`
  const kept = await readdir(join(h.dir, 'cache-encrypted-v1', 'bundles', id, 'pretty-v1'))
  assert.deepEqual(kept, [copy])
  const stored = await h.raw.open(`cache-encrypted-v1/bundles/${id}/pretty-v1/${copy}`)
  const chunks = []
  for await (const chunk of stored.stream) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).subarray(0, 16).toString(), 'DeepView.storage')
  const again = await h.send(bundlePretty(id, 'dist/app.min.js', hash))
  assert.deepEqual(again.bytes, first.bytes)
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
    [bundlePretty(id, 'dist/app.min.js.map', hash), 400, 'bad-file'],
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
