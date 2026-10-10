import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { getTarball, setCacheDir } from '@preventive/upstream/npm.js'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { MAX_NPM_JSON_LENGTH, MAX_NPM_PACKAGE_BYTES, NpmPackageError, canReadPrivateNpm, npmFileText, npmManifest, npmTarballFilename, readNpmTar, readNpmVersion, readNpmVersions } from '../server-managed/npm-packages.ts'
import { MAX_TAR_BYTES, loadNpmPackageBody, loadNpmTarball, setNpmTarballCache } from '../server-managed/npm-loads.ts'
import { npmCommitTags } from '../server-managed/npm-insights.ts'
import { isNpmPackageName, isNpmPackageSpec, normalizeNpmScope, npmPackageScope } from '../common/managed/npm-packages.js'
import { checkTeamNpmScopes } from './_managed-team-npm-scopes.js'

const config = {
  port: 0, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'sid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}
const REGISTRY = 'https://registry.npmjs.org'

// A ustar archive of `entries`, each `{ name, data, type, prefix }`, as npm pack writes one.
function tar(entries) {
  const blocks = []
  for (const { name, data = '', type = '0', prefix = '' } of entries) {
    const body = Buffer.from(data)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write('0000644\0', 100)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write(type, 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(prefix, 345, 155)
    header.write('        ', 148)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

// A pax record, its length counting its bytes, the length's own digits among them.
const paxRecord = (key, value) => { const record = ` ${key}=${value}\n`; let length = Buffer.byteLength(record); length += String(length + String(length).length).length; return `${length}${record}` }
const pax = path => paxRecord('path', path)

function packageOf(name, version, files, extra = {}) {
  const tgz = gzipSync(tar(Object.entries(files).map(([path, data]) => ({ name: `package/${path}`, data }))))
  const base = name.split('/').at(-1)
  const doc = { name, version, description: `${name} for tests`, license: 'MIT', main: 'lib/index.js',
    repository: { type: 'git', url: 'git+https://github.com/org/repo.git', directory: 'packages/pkg' }, gitHead: 'a'.repeat(40),
    dependencies: { dep: '^1.0.0' }, scripts: { postinstall: 'node setup.js', test: 'node --test' }, _npmUser: { name: 'publisher-1', email: 'p@example.com' },
    dist: { tarball: `${REGISTRY}/${name}/-/${base}-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`, unpackedSize: 100, fileCount: 2 }, ...extra }
  return { doc, tgz }
}

// The registry: public packages answer anyone; private ones only the token.
function registry(t, packages) {
  const calls = []
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    const auth = headers.get('authorization')
    calls.push({ url, auth })
    for (const { doc, tgz, private: secret, versions } of packages) {
      if (secret && auth !== `Bearer ${process.env['NPM_TOKEN']}`) continue
      if (url === `${REGISTRY}/${doc.name}/${encodeURIComponent(doc.version)}` || url === `${REGISTRY}/${doc.name}/latest`) return Promise.resolve(Response.json(doc))
      if (url === `${REGISTRY}/${doc.name}`) {
        return Promise.resolve(Response.json({ name: doc.name, 'dist-tags': { latest: doc.version, next: '9.9.9' }, versions: Object.fromEntries((versions ?? [doc.version]).map(v => [v, {}])) }))
      }
      if (url === doc.dist.tarball) return Promise.resolve(new Response(tgz))
    }
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  })
  return calls
}

async function setup(t) {
  const db = openSqliteManagedDb(':memory:')
  const server = createServer(createManagedRequestHandler({
    config, db, avatarStore: { get: () => Promise.resolve(null) }, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track: () => {},
  }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    const stopping = new Promise(resolve => { server.close(resolve) })
    server.closeAllConnections()
    await stopping
    await db.close()
  })
  const users = {}
  for (const [i, role] of ['admin', 'manage', 'triage', 'view', 'none'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    users[role] = { ...session, cookie: session.setCookie.split(';')[0] }
  }
  await db.createTeam('team', 'Team', Date.now())
  for (const role of ['triage', 'view']) await db.setTeamMember('team', users[role].userId, { dependencies: false, security: false })
  function send(path, who = 'view', { method = 'GET', body, csrf = true } = {}) {
    const user = users[who]
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        ...(user ? { cookie: user.cookie, ...(csrf ? { 'x-csrf-token': user.csrfToken } : {}) } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: res.statusCode, headers: res.headers, bytes,
            json: () => JSON.parse((res.headers['content-encoding'] === 'br' ? brotliDecompressSync(bytes) : bytes).toString()) })
        })
      })
      req.on('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  return { db, users, send }
}

function withToken(t, token = 'server-token') {
  const previous = process.env['NPM_TOKEN']
  process.env['NPM_TOKEN'] = token
  t.after(() => { if (previous === undefined) delete process.env['NPM_TOKEN']; else process.env['NPM_TOKEN'] = previous })
}

const packagePath = (name, version) => `/api/npm/package?${new URLSearchParams({ name, ...(version ? { version } : {}) })}`

test('names, specs and scopes follow npm', () => {
  for (const name of ['lodash', '@babel/core', 'JSONStream', 'a.b-c_d', '@scope/name.js']) assert.equal(isNpmPackageName(name), true, name)
  for (const name of ['', '.hidden', '_under', '-dash', '@scope', '@scope/', '../etc', 'a/b', 'a b', 'x'.repeat(215), 3]) assert.equal(isNpmPackageName(name), false, String(name))
  for (const spec of ['1.2.3', '1.0.0-beta.1+build.5', 'latest', 'next']) assert.equal(isNpmPackageSpec(spec), true, spec)
  for (const spec of ['', '^1.0.0', '1.x || 2', '../1', '.1']) assert.equal(isNpmPackageSpec(spec), false, spec)
  assert.equal(npmPackageScope('@Acme/pkg'), '@acme')
  assert.equal(npmPackageScope('pkg'), null)
  assert.equal(normalizeNpmScope(' Acme '), '@acme')
  assert.equal(normalizeNpmScope('@my-org'), '@my-org')
  for (const bad of ['', '@', '@a/b', '@.x', 'a b', null]) assert.equal(normalizeNpmScope(bad), null, String(bad))
  assert.equal(npmTarballFilename('@babel/core', '7.24.0'), 'babel-core-7.24.0.tgz')
})

test('private access: admins and managers, or a member of a team listing the scope', () => {
  const none = new Set()
  assert.equal(canReadPrivateNpm({ role: 'admin', scopes: none }, '@x/y'), true)
  assert.equal(canReadPrivateNpm({ role: 'manage', scopes: none }, 'y'), true)
  assert.equal(canReadPrivateNpm({ role: 'view', scopes: none }, '@x/y'), false)
  assert.equal(canReadPrivateNpm({ role: 'triage', scopes: new Set(['@x']) }, '@X/y'), true)
  assert.equal(canReadPrivateNpm({ role: 'triage', scopes: new Set(['@x']) }, 'x'), false, 'scopes cover scoped names alone')
})

test('tarballs unpack to package paths, as extraction leaves them', () => {
  const files = readNpmTar(tar([
    { name: 'package/', type: '5' },
    { name: 'package/index.js', data: 'module.exports = 1\n' },
    { name: 'package/link', type: '2' },
    { name: 'package/../escape.js', data: 'nope' },
    { name: 'package/./a/./b.js', data: 'b' },
    { name: 'deep/name.js', prefix: 'package/very/long', data: 'prefixed' },
    { name: 'PaxHeader', type: 'x', data: pax('package/from-pax.js') },
    { name: 'package/short', data: 'pax' },
    { name: 'PaxHeader', type: 'x', data: pax('package/文档/说明.md') + paxRecord('mtime', '1700000000') },
    { name: 'package/short-utf8', data: 'utf8' },
    { name: '././@LongLink', type: 'L', data: 'package/from-gnu.js\0' },
    { name: 'package/trunc', data: 'gnu' },
    { name: 'package/index.js', data: 'replaced' },
    { name: 'other-root/bin.dat', data: Buffer.from([0, 1, 2]) },
  ]))
  assert.deepEqual(files.map(file => [file.path, Buffer.from(file.bytes).toString()]), [
    ['a/b.js', 'b'], ['bin.dat', '\0\u0001\u0002'], ['from-gnu.js', 'gnu'], ['from-pax.js', 'pax'], ['index.js', 'replaced'], ['very/long/deep/name.js', 'prefixed'],
    ['文档/说明.md', 'utf8'],
  ], 'pax lengths count bytes, not characters')
  assert.equal(npmFileText(files[1].bytes), null, 'binary has no text')
  assert.equal(npmFileText(Buffer.from([0xff, 0xfe])), null)
  assert.equal(npmFileText(Buffer.from('﻿text')), '﻿text', 'a BOM is kept, as the bytes have it')
  assert.throws(() => readNpmTar(tar([{ name: 'package/a', data: 'abc' }]).subarray(0, 514)), (err) => err instanceof NpmPackageError && err.message === 'bad-tarball')
  assert.throws(() => readNpmTar(tar([{ name: 'package/a', data: Buffer.alloc(MAX_NPM_PACKAGE_BYTES + 1) }])), /package-too-large/u)
})

test('anyone with workspace access opens a public version, asked of the registry without credentials', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = packageOf('@pub/pkg', '1.2.3', { 'lib/index.js': 'export default 1\n', 'package.json': '{"name":"@pub/pkg"}', 'logo.png': Buffer.from([137, 80, 78, 71, 0]) })
  const calls = registry(t, [pkg])
  for (const who of ['view', 'triage']) {
    calls.length = 0
    const res = await h.send(packagePath('@pub/pkg', 'latest'), who)
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'br')
    assert.equal(res.headers['cache-control'], 'private, no-store')
    const body = res.json()
    assert.equal(body.version, '1.2.3')
    assert.equal(body.private, false)
    assert.equal(body.integrity, pkg.doc.dist.integrity)
    assert.equal(body.tarballSize, pkg.tgz.length)
    const png = `sha256-${createHash('sha256').update(Buffer.from([137, 80, 78, 71, 0])).digest('base64')}`
    assert.deepEqual(body.files, [['lib/index.js', 17, 'export default 1\n'], ['logo.png', 5, null, png], ['package.json', 19, '{"name":"@pub/pkg"}']],
      'a file that is not text carries its digest instead')
    assert.deepEqual(body.manifest, { description: '@pub/pkg for tests', license: 'MIT', main: 'lib/index.js', gitHead: 'a'.repeat(40), publisher: 'publisher-1',
      dependencies: { dep: '^1.0.0' }, installScripts: { postinstall: 'node setup.js' }, github: { github: 'org/repo', directory: 'packages/pkg' } }, 'the publisher\'s account, never their email')
    assert.equal(calls[0].url, `${REGISTRY}/@pub/pkg/latest`)
    assert.equal(calls[0].auth, null, 'the version document is asked for anonymously')
  }
  const versions = await h.send('/api/npm/versions?name=%40pub%2Fpkg')
  assert.deepEqual(versions.json(), { name: '@pub/pkg', private: false, distTags: { latest: '1.2.3' }, versions: ['1.2.3'] }, 'tags of unlisted versions are left out')
  const download = await h.send('/api/npm/download?name=%40pub%2Fpkg&version=1.2.3')
  assert.equal(download.status, 200)
  assert.equal(download.headers['content-type'], 'application/gzip')
  assert.match(download.headers['content-disposition'], /filename="pub-pkg-1\.2\.3\.tgz"/u)
  assert.deepEqual(download.bytes, pkg.tgz)
})

test('a private version is read with the token for admins and managers only, even with its tarball cached', async t => {
  const h = await setup(t)
  withToken(t)
  const cache = await mkdtemp(join(tmpdir(), 'triage-npm-cache-'))
  setCacheDir(cache)
  setNpmTarballCache(cache)
  t.after(async () => { setCacheDir(false); setNpmTarballCache(null); await rm(cache, { recursive: true, force: true }) })
  const pkg = { ...packageOf('@acme/secret', '2.0.0', { 'index.js': 'secret source' }), private: true }
  const calls = registry(t, [pkg])
  for (const who of ['admin', 'manage']) {
    const res = await h.send(packagePath('@acme/secret', '2.0.0'), who)
    assert.equal(res.status, 200, who)
    assert.equal(res.json().private, true)
    assert.deepEqual(res.json().files, [['index.js', 13, 'secret source']])
  }
  assert.ok(calls.some(call => call.url === pkg.doc.dist.tarball), 'the tarball was fetched with the token')
  // The viewer kept the tarball, and a bundle build fills upstream's cache
  // using the token too, which leaves it readable without one. A reader
  // without private access is answered by the anonymous registry all the same.
  await getTarball('@acme/secret', '2.0.0', { tarball: pkg.doc.dist.tarball, integrity: pkg.doc.dist.integrity })
  for (const who of ['view', 'triage']) {
    calls.length = 0
    for (const path of [packagePath('@acme/secret', '2.0.0'), packagePath('@acme/secret'), '/api/npm/download?name=%40acme%2Fsecret&version=2.0.0', '/api/npm/versions?name=%40acme%2Fsecret']) {
      const res = await h.send(path, who)
      assert.equal(res.status, 404, `${who} ${path}`)
      assert.deepEqual(res.json(), { error: 'package-not-found' })
    }
    assert.ok(calls.length > 0 && calls.every(call => call.auth === null && call.url !== pkg.doc.dist.tarball), 'never with the token, nor the tarball')
  }
  // Admins do see it as private in the version list.
  assert.equal((await h.send('/api/npm/versions?name=%40acme%2Fsecret', 'admin')).json().private, true)
  const unauthenticated = await h.send(packagePath('@acme/secret', '2.0.0'), 'nobody')
  assert.equal(unauthenticated.status, 401)
  assert.equal((await h.send(packagePath('@acme/secret', '2.0.0'), 'none')).status, 403)
})

test('a team listing the scope lets its members read it, while the team is visible', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = { ...packageOf('@acme/secret', '2.0.0', { 'index.js': 'secret' }), private: true }
  const other = { ...packageOf('@other/secret', '1.0.0', { 'index.js': 'other' }), private: true }
  registry(t, [pkg, other])
  const set = scopes => h.send('/api/admin/teams/set-npm-scopes', 'admin', { method: 'POST', body: { teamId: 'team', scopes } })
  assert.equal((await set(['ACME'])).status, 200)
  for (const who of ['view', 'triage']) {
    const res = await h.send(packagePath('@acme/secret', '2.0.0'), who)
    assert.equal(res.status, 200, who)
    assert.equal(res.json().private, true)
    assert.equal((await h.send(packagePath('@other/secret', '1.0.0'), who)).status, 404, 'another scope stays closed')
  }
  await h.db.setTeamHidden('team', true, Date.now())
  assert.equal((await h.send(packagePath('@acme/secret', '2.0.0'))).status, 404, 'a hidden team grants nothing')
  await h.db.setTeamHidden('team', false, Date.now())
  assert.equal((await set([])).status, 200)
  assert.equal((await h.send(packagePath('@acme/secret', '2.0.0'))).status, 404)
})

test('without a token, private packages stay closed to every role', async t => {
  const h = await setup(t)
  delete process.env['NPM_TOKEN']
  const pkg = { ...packageOf('@acme/secret', '2.0.0', { 'index.js': 'secret' }), private: true }
  const calls = registry(t, [pkg])
  assert.equal((await h.send(packagePath('@acme/secret', '2.0.0'), 'admin')).status, 404)
  assert.ok(calls.every(call => call.auth === null))
})

test('access is checked again once the registry answers', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = { ...packageOf('@acme/secret', '2.0.0', { 'index.js': 'secret' }), private: true }
  registry(t, [pkg])
  const fetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // Demoted while the tarball downloads.
    if (String(url) === pkg.doc.dist.tarball) await h.db.setUserRole(h.users.manage.userId, 'view')
    return fetch(url, init)
  })
  const res = await h.send(packagePath('@acme/secret', '2.0.0'), 'manage')
  assert.equal(res.status, 404)
  assert.deepEqual(res.json(), { error: 'package-not-found' })
})

test('oversized, malformed and unreachable packages are refused without their files', async t => {
  const h = await setup(t)
  const big = packageOf('big', '1.0.0', { 'a.js': 'a' }, {})
  big.doc.dist.unpackedSize = MAX_NPM_PACKAGE_BYTES + 1
  const wrong = packageOf('wrong', '1.0.0', { 'a.js': 'a' })
  wrong.doc = { ...wrong.doc, name: 'other' }
  // Within the unpacked limit, but six times larger once escaped as JSON.
  const controls = packageOf('controls', '1.0.0', { 'a.txt': Buffer.alloc(Math.floor(MAX_NPM_JSON_LENGTH / 6) + 1, 1) })
  const plain = packageOf('plain', '1.0.0', { 'a.txt': Buffer.alloc(Math.floor(MAX_NPM_JSON_LENGTH / 6) + 1, 'a') })
  const calls = registry(t, [big, wrong, controls, plain])
  assert.deepEqual((await h.send(packagePath('big', '1.0.0'))).json(), { error: 'package-too-large' })
  assert.ok(!calls.some(call => call.url === big.doc.dist.tarball), 'a declared size refuses before download')
  assert.deepEqual((await h.send(packagePath('controls', '1.0.0'))).json(), { error: 'package-too-large' })
  assert.equal((await h.send(packagePath('plain', '1.0.0'))).status, 200, 'the same bytes as plain text fit')
  assert.equal((await h.send(packagePath('wrong', '1.0.0'))).status, 404, 'the registry answering for another name')
  for (const path of [packagePath('../x', '1.0.0'), packagePath('ok', '^1.0.0'), '/api/npm/package', '/api/npm/versions?name=.x']) {
    assert.deepEqual((await h.send(path)).json(), { error: 'bad-package' }, path)
  }
  assert.equal((await h.send(packagePath('ok', '1.0.0'), 'view', { method: 'POST' })).status, 405)
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('oops', { status: 503 })))
  assert.deepEqual((await h.send(packagePath('down', '1.0.0'))).json(), { error: 'upstream-unavailable' })
})

test('reads of a version share its load and its encoded body; four load at once, each held until its readers are done', async t => {
  const pkgs = ['a', 'b', 'c', 'd', 'e'].map(name => packageOf(`shared-${name}`, '1.0.0', { 'index.js': `module.exports = '${name}'\n` }))
  registry(t, pkgs)
  // Tarballs answer once released, holding their loads in flight meanwhile.
  const answer = globalThis.fetch, downloads = [], gate = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', (input, init) => {
    downloads.push(String(input))
    return gate.promise.then(() => answer(input, init))
  })
  const version = ({ doc }) => ({ name: doc.name, version: doc.version, private: false, dist: doc.dist, manifest: { description: doc.description } })
  const downloadsOf = pkg => downloads.filter(url => url === pkg.doc.dist.tarball).length
  const reads = Array.from({ length: 6 }, () => loadNpmPackageBody(version(pkgs[0])))
  const others = pkgs.slice(1, 4).map(pkg => loadNpmPackageBody(version(pkg)))
  await assert.rejects(loadNpmPackageBody(version(pkgs[4])).result, /npm-busy/u)
  await assert.rejects(loadNpmTarball(version(pkgs[4])).result, /npm-busy/u, 'downloads count among them')
  gate.resolve()
  const bodies = await Promise.all(reads.map(read => read.result))
  assert.ok(bodies.every(body => body === bodies[0]), 'one encoded body for every reader')
  assert.equal(downloadsOf(pkgs[0]), 1)
  assert.deepEqual(JSON.parse(brotliDecompressSync(bodies[0])), { name: 'shared-a', version: '1.0.0', private: false, integrity: pkgs[0].doc.dist.integrity,
    tarballSize: pkgs[0].tgz.length, manifest: { description: 'shared-a for tests' }, files: [['index.js', 21, "module.exports = 'a'\n"]] })
  await Promise.all(others.map(other => other.result))
  // Done, but their readers are still writing them out.
  await assert.rejects(loadNpmTarball(version(pkgs[4])).result, /npm-busy/u, 'a body still being written keeps its place')
  const late = loadNpmPackageBody(version(pkgs[0]))
  assert.equal(await late.result, bodies[0], 'a reader meanwhile shares it')
  reads[0].release()
  reads[0].release()
  for (const read of reads.slice(1)) read.release()
  const again = loadNpmPackageBody(version(pkgs[0]))
  await again.result
  assert.equal(downloadsOf(pkgs[0]), 1, 'held while one reader remains, however often another releases')
  late.release()
  again.release()
  for (const other of others) other.release()
  const fifth = loadNpmTarball(version(pkgs[4]))
  assert.deepEqual(Buffer.from(await fifth.result), pkgs[4].tgz, 'a place frees once its readers are done')
  fifth.release()
  const fresh = loadNpmPackageBody(version(pkgs[0]))
  await fresh.result
  fresh.release()
  assert.equal(downloadsOf(pkgs[0]), 2, 'and nothing is kept after')
})

test('a load its readers abandon keeps its place until its work is done', async t => {
  const pkgs = ['a', 'b', 'c', 'd', 'e'].map(name => packageOf(`abandoned-${name}`, '1.0.0', { 'index.js': '' }))
  registry(t, pkgs)
  const answer = globalThis.fetch, gate = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', (input, init) => gate.promise.then(() => answer(input, init)))
  const version = ({ doc }) => ({ name: doc.name, version: doc.version, private: false, dist: doc.dist, manifest: {} })
  const loads = pkgs.slice(0, 4).map(pkg => loadNpmTarball(version(pkg)))
  for (const load of loads) load.release()
  await assert.rejects(loadNpmTarball(version(pkgs[4])).result, /npm-busy/u)
  gate.resolve()
  await Promise.all(loads.map(load => load.result))
  const fifth = loadNpmTarball(version(pkgs[4]))
  assert.deepEqual(Buffer.from(await fifth.result), pkgs[4].tgz)
  fifth.release()
})

test('a tarball is read from the package\'s own path on the registry, bounded as it arrives and held to its sha512', async t => {
  const pkg = packageOf('bounded', '1.0.0', { 'index.js': 'x' })
  const version = (dist = {}) => ({ name: 'bounded', version: '1.0.0', private: false, dist: { ...pkg.doc.dist, unpackedSize: null, fileCount: null, ...dist }, manifest: {} })
  const tarballOf = async doc => {
    const load = loadNpmTarball(doc)
    try { return await load.result } finally { load.release() }
  }
  let answer = () => new Response(pkg.tgz), pulled = 0
  const calls = []
  t.mock.method(globalThis, 'fetch', (input, init) => { calls.push([String(input), new Headers(init.headers).get('authorization')]); return Promise.resolve(answer()) })
  assert.deepEqual(Buffer.from(await tarballOf(version())), pkg.tgz)
  assert.deepEqual(calls, [[pkg.doc.dist.tarball, null]], 'a public tarball is asked for without credentials')
  // Sizes the document leaves out, or understates, bound nothing: the bytes do.
  answer = () => new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024)) } }))
  await assert.rejects(tarballOf(version()), /package-too-large/u)
  assert.ok(pulled > MAX_TAR_BYTES / (1024 * 1024) && pulled < MAX_TAR_BYTES / (1024 * 1024) + 8, `stopped at the limit, after ${pulled} MiB`)
  answer = () => new Response('', { headers: { 'content-length': String(MAX_TAR_BYTES + 1) } })
  await assert.rejects(tarballOf(version()), /package-too-large/u, 'a declared length past it is refused unread')
  answer = () => new Response(gzipSync('other'))
  await assert.rejects(tarballOf(version()), /upstream-invalid/u, 'bytes the integrity does not name')
  calls.length = 0
  for (const dist of [{ tarball: 'https://example.com/bounded/-/bounded-1.0.0.tgz' }, { tarball: `${REGISTRY}/other/-/other-1.0.0.tgz` },
    { tarball: `${REGISTRY}/bounded/-/../../other.tgz` }, { integrity: 'sha1-abc=' }]) {
    await assert.rejects(tarballOf(version(dist)), /upstream-invalid/u, JSON.stringify(dist))
  }
  assert.deepEqual(calls, [], 'nothing off the package\'s path is asked for')
})

test('tarballs are kept where bundle builds keep theirs, and served from there or npm\'s cache only when they match the sha512', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'triage-npm-kept-')), npmCache = await mkdtemp(join(tmpdir(), 'triage-npm-cacache-'))
  const configured = process.env['npm_config_cache']
  process.env['npm_config_cache'] = npmCache
  t.after(async () => {
    setCacheDir(false)
    setNpmTarballCache(null)
    if (configured === undefined) delete process.env['npm_config_cache']
    else process.env['npm_config_cache'] = configured
    await rm(cache, { recursive: true, force: true })
    await rm(npmCache, { recursive: true, force: true })
  })
  const [kept, built, npm] = [packageOf('@kept/pkg', '1.0.0', { 'index.js': 'kept' }), packageOf('@built/pkg', '2.0.0', { 'index.js': 'built' }),
    packageOf('from-npm', '3.0.0', { 'index.js': 'npm' })]
  const calls = registry(t, [kept, built, npm])
  const downloads = () => calls.filter(call => call.url.includes('/-/')).length
  const tarballOf = async ({ doc }) => {
    const load = loadNpmTarball({ name: doc.name, version: doc.version, private: false, dist: { ...doc.dist, unpackedSize: null, fileCount: null }, manifest: {} })
    try { return Buffer.from(await load.result) } finally { load.release() }
  }
  assert.deepEqual(await tarballOf(kept), kept.tgz)
  assert.equal(downloads(), 1, 'no cache set, nothing kept')
  setNpmTarballCache(cache)
  const file = join(cache, 'npm', 'tarballs', '@kept+pkg@1.0.0.tgz')
  assert.deepEqual(await tarballOf(kept), kept.tgz)
  assert.deepEqual(await readFile(file), kept.tgz, 'kept under upstream\'s name for it')
  assert.deepEqual(await tarballOf(kept), kept.tgz)
  assert.equal(downloads(), 2, 'then read from the cache')
  await writeFile(file, gzipSync('other'))
  assert.deepEqual(await tarballOf(kept), kept.tgz, 'bytes the integrity does not name are passed over')
  assert.equal(downloads(), 3)
  assert.deepEqual(await readFile(file), kept.tgz, 'and replaced')
  await truncate(file, MAX_TAR_BYTES + 1)
  assert.deepEqual(await tarballOf(kept), kept.tgz, 'as is a file past the tar stream\'s bound, unread')
  assert.equal(downloads(), 4)
  // What a bundle build fetched is read as it left it.
  setCacheDir(cache)
  await getTarball('@built/pkg', '2.0.0', { tarball: built.doc.dist.tarball, integrity: built.doc.dist.integrity })
  calls.length = 0
  assert.deepEqual(await tarballOf(built), built.tgz)
  // npm files a tarball by its sha512.
  const hex = Buffer.from(npm.doc.dist.integrity.slice('sha512-'.length), 'base64').toString('hex')
  const content = join(npmCache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4))
  await mkdir(content, { recursive: true })
  await writeFile(join(content, hex.slice(4)), npm.tgz)
  assert.deepEqual(await tarballOf(npm), npm.tgz)
  assert.equal(downloads(), 0, 'neither was downloaded')
})

test('registry documents read at once are held to a budget: four version lists, or their bytes in versions', async t => {
  const pkgs = ['a', 'b', 'c', 'd', 'e'].map(name => packageOf(`listed-${name}`, '1.0.0', { 'index.js': '' }))
  registry(t, pkgs)
  // The registry answers once released, holding the reads in flight meanwhile.
  const answer = globalThis.fetch, gate = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', (input, init) => gate.promise.then(() => answer(input, init)))
  const { signal } = new AbortController()
  const lists = pkgs.slice(0, 4).map(pkg => readNpmVersions(pkg.doc.name, false, signal))
  await assert.rejects(readNpmVersions('listed-e', false, signal), /npm-busy/u)
  await assert.rejects(readNpmVersion('listed-e', '1.0.0', false, signal), /npm-busy/u, 'version documents count among them')
  gate.resolve()
  assert.deepEqual((await Promise.all(lists)).map(list => list.versions), [['1.0.0'], ['1.0.0'], ['1.0.0'], ['1.0.0']])
  assert.equal((await readNpmVersion('listed-e', '1.0.0', false, signal)).version, '1.0.0', 'a read frees its bytes once done')
})

// npm's downloads API, GitHub and npm's bulk advisories, beside the registry
// `registry` mocks; what each was asked, with its credentials.
function insights(t, { downloads = {}, ranges = {}, repos = {}, advisories = {}, repoAdvisories = {} }) {
  const asked = [], registryFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const auth = new Headers(init.headers).get('authorization'), url = String(input)
    const listing = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/security-advisories\?/u)
    if (listing) {
      asked.push(['repository', listing[1], auth])
      const answer = repoAdvisories[listing[1]] ?? []
      return Promise.resolve(answer instanceof Response ? answer : Response.json(answer))
    }
    const day = url.match(/^https:\/\/api\.npmjs\.org\/downloads\/range\/([^/]+)\/(.+)$/u)
    if (day) {
      const [, range, name] = day
      asked.push(['downloads', range === 'last-year' ? name : `${name} ${range}`, auth])
      const answer = range === 'last-year' ? downloads[name] : ranges[`${name} ${range}`]
      return Promise.resolve(answer ? Response.json(answer) : Response.json({ error: 'not found' }, { status: 404 }))
    }
    const pulls = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)\/pulls\?state=open&per_page=1$/u)
    if (pulls) {
      asked.push(['pulls', pulls[1], auth])
      const answer = repos[pulls[1]]?.pulls
      return Promise.resolve(answer === undefined ? Response.json({ message: 'Not Found' }, { status: 404 })
        : Response.json(answer > 0 ? [{}] : [], { headers: answer > 1 ? { link: `<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=${answer}>; rel="last"` } : {} }))
    }
    const repo = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)$/u)
    if (repo) {
      asked.push(['github', repo[1], auth])
      return Promise.resolve(repos[repo[1]] ? Response.json(repos[repo[1]]) : Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    if (url === `${REGISTRY}/-/npm/v1/security/advisories/bulk`) {
      const body = JSON.parse(init.body)
      asked.push(['advisories', Object.keys(body), auth])
      return Promise.resolve(Response.json(Object.fromEntries(Object.keys(body).map(name => [name, advisories[name] ?? []]))))
    }
    return registryFetch(input, init)
  })
  return asked
}

test('a package\'s figures: its downloads, and its public repository\'s, asked without credentials', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = packageOf('@pub/figures', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/figures.git' } })
  const calls = registry(t, [pkg])
  const asked = insights(t, {
    downloads: { '@pub/figures': { start: '2026-01-01', end: '2026-01-04', package: '@pub/figures', downloads: [{ day: '2026-01-01', downloads: 5 }, { day: '2026-01-03', downloads: 7 }, { day: '2026-01-04', downloads: 9 }] } },
    repos: { 'org/figures': { full_name: 'org/figures', private: false, visibility: 'public', stargazers_count: 1200, forks_count: 30, open_issues_count: 4, archived: false, pushed_at: '2026-09-01T00:00:00Z', pulls: 3 } },
  })
  const res = await h.send('/api/npm/stats?name=%40pub%2Ffigures')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), {
    name: '@pub/figures',
    downloads: { start: '2026-01-01', end: '2026-01-04', days: [5, 0, 7, 9] },
    github: { repo: 'org/figures', stars: 1200, forks: 30, openIssues: 4, openPulls: 3, archived: false, pushedAt: '2026-09-01T00:00:00Z' },
  }, 'a day npm leaves out counts none')
  assert.deepEqual(asked, [['downloads', '@pub/figures', null], ['github', 'org/figures', null], ['pulls', 'org/figures', null]])
  // Kept an hour; the access check is not.
  calls.length = 0
  assert.equal((await h.send('/api/npm/stats?name=%40pub%2Ffigures')).status, 200)
  assert.equal(asked.length, 3, 'figures are kept')
  assert.deepEqual(calls.map(call => [call.url, call.auth]), [[`${REGISTRY}/@pub/figures/latest`, null]], 'the registry is asked again, anonymously')
})

test('a year of downloads reaches back to the first of the month it starts in, so that month is whole', async t => {
  const h = await setup(t)
  registry(t, [packageOf('monthly', '1.0.0', { 'index.js': '' }), packageOf('half-month', '1.0.0', { 'index.js': '' })])
  const year = name => ({ start: '2026-01-03', end: '2026-01-05', package: name, downloads: [{ day: '2026-01-03', downloads: 3 }, { day: '2026-01-04', downloads: 4 }, { day: '2026-01-05', downloads: 5 }] })
  const asked = insights(t, {
    downloads: { monthly: year('monthly'), 'half-month': year('half-month') },
    ranges: { 'monthly 2026-01-01:2026-01-02': { start: '2026-01-01', end: '2026-01-02', package: 'monthly', downloads: [{ day: '2026-01-01', downloads: 1 }, { day: '2026-01-02', downloads: 2 }] } },
  })
  assert.deepEqual((await h.send('/api/npm/stats?name=monthly')).json().downloads, { start: '2026-01-01', end: '2026-01-05', days: [1, 2, 3, 4, 5] })
  assert.deepEqual((await h.send('/api/npm/stats?name=half-month')).json().downloads, { start: '2026-01-03', end: '2026-01-05', days: [3, 4, 5] },
    'without the days before it, the year as npm has it')
  assert.deepEqual(asked.filter(([what]) => what === 'downloads').map(([, name]) => name),
    ['monthly', 'monthly 2026-01-01:2026-01-02', 'half-month', 'half-month 2026-01-01:2026-01-02'])
})

test('a private repository, or a package npm has no downloads for, has no figures', async t => {
  const h = await setup(t)
  const pkg = packageOf('quiet-figures', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/hidden.git' } })
  const internal = packageOf('internal-figures', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/internal.git' } })
  registry(t, [pkg, internal])
  insights(t, { repos: {
    'org/hidden': { full_name: 'org/hidden', private: true, visibility: 'private', stargazers_count: 9 },
    'org/internal': { full_name: 'org/internal', private: false, visibility: 'internal', stargazers_count: 9 },
  } })
  assert.deepEqual((await h.send('/api/npm/stats?name=quiet-figures')).json(), { name: 'quiet-figures', downloads: null, github: null })
  assert.equal((await h.send('/api/npm/stats?name=internal-figures')).json().github, null, 'an internal repository answers private: false, and is no more public')
})

test('advisories cover every published version, each naming the versions it affects', async t => {
  const h = await setup(t)
  const pkg = packageOf('advised', '1.2.0', { 'index.js': '' })
  registry(t, [{ ...pkg, versions: ['1.0.0', '1.1.0', '1.2.0'] }])
  const asked = insights(t, { repos: { 'org/repo': { full_name: 'org/repo', private: false, visibility: 'public' } }, advisories: { advised: [
    { id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Prototype pollution', severity: 'high', vulnerable_versions: '<1.1.0', cwe: ['CWE-1321'], cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N' } },
    { id: 2, url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', title: 'ReDoS', severity: 'moderate', vulnerable_versions: '>=1.1.0 <1.3.0', cwe: [], cvss: { score: 0 } },
  ] } })
  const res = await h.send('/api/npm/advisories?name=advised')
  assert.equal(res.status, 200)
  const body = res.json()
  assert.deepEqual(body.versions, ['1.2.0', '1.1.0', '1.0.0'], 'newest first, as the version list has them')
  assert.deepEqual(body.advisories, [
    { id: 'GHSA-aaaa-bbbb-cccc', source: 'registry', ghsa: 'GHSA-aaaa-bbbb-cccc', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Prototype pollution', severity: 'high', cvss: 7.5, cwe: ['CWE-1321'], range: '<1.1.0', affected: [2] },
    { id: 'GHSA-dddd-eeee-ffff', source: 'registry', ghsa: 'GHSA-dddd-eeee-ffff', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', title: 'ReDoS', severity: 'moderate', cwe: [], range: '>=1.1.0 <1.3.0', affected: [0, 1] },
  ])
  assert.equal(body.repository, true)
  assert.deepEqual(asked.filter(([what]) => what !== 'pulls'), [['github', 'org/repo', null], ['advisories', ['advised'], null], ['repository', 'org/repo', null]],
    'its repository found public first; every version asked at once, without credentials')
})

test('an advisory npm answers once a range it covers is one row, its ranges, versions and CWEs together', async t => {
  const h = await setup(t)
  const pkg = packageOf('ranged', '4.5.0', { 'index.js': '' })
  registry(t, [{ ...pkg, versions: ['3.10.0', '4.0.0', '4.4.0', '4.5.0'] }])
  insights(t, { advisories: { ranged: [
    { id: 1, url: 'https://github.com/advisories/GHSA-gpvr-g6gh-9mc2', title: 'No charset', severity: 'moderate', vulnerable_versions: '>=4.0.0 <4.5.0', cwe: ['CWE-79'], cvss: { score: 6.1 } },
    { id: 2, url: 'https://github.com/advisories/GHSA-gpvr-g6gh-9mc2', title: 'No charset', severity: 'moderate', vulnerable_versions: '<3.11.0', cwe: ['CWE-79', 'CWE-20'], cvss: { score: 0 } },
  ] } })
  const body = (await h.send('/api/npm/advisories?name=ranged')).json()
  assert.deepEqual(body.advisories, [{ id: 'GHSA-gpvr-g6gh-9mc2', source: 'registry', ghsa: 'GHSA-gpvr-g6gh-9mc2', url: 'https://github.com/advisories/GHSA-gpvr-g6gh-9mc2',
    title: 'No charset', severity: 'moderate', cvss: 6.1, cwe: ['CWE-79', 'CWE-20'], range: '>=4.0.0 <4.5.0 || <3.11.0', affected: [1, 2, 3] }])
})

test('advisories its repository publishes on GitHub join npm\'s, its listing kept as bundle advisories keep it', async t => {
  const h = await setup(t)
  const pkg = packageOf('repo-advised', '1.2.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/advised.git' } })
  registry(t, [{ ...pkg, versions: ['1.0.0', '1.1.0', '1.2.0'] }])
  const repoAdvisory = (ghsa, name, range) => ({ ghsa_id: ghsa, state: 'published', summary: `Unreviewed ${ghsa}`, severity: 'medium', cwe_ids: ['CWE-79'],
    vulnerabilities: [{ package: { ecosystem: 'npm', name }, vulnerable_version_range: range }] })
  const asked = insights(t, {
    repos: { 'org/advised': { full_name: 'org/advised', private: false, visibility: 'public' } },
    advisories: { 'repo-advised': [{ id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Reviewed', severity: 'high', vulnerable_versions: '<1.1.0', cwe: [] }] },
    repoAdvisories: { 'org/advised': [
      repoAdvisory('GHSA-gggg-hhhh-jjjj', 'repo-advised', '< 1.2.0'), repoAdvisory('GHSA-kkkk-mmmm-pppp', 'other-package', '< 9.0.0'),
      // Already reviewed into npm's for the versions npm reports it on.
      repoAdvisory('GHSA-aaaa-bbbb-cccc', 'repo-advised', '< 1.1.0'),
    ] },
  })
  const body = (await h.send('/api/npm/advisories?name=repo-advised')).json()
  assert.deepEqual(body.advisories, [
    { id: 'GHSA-aaaa-bbbb-cccc', source: 'registry', ghsa: 'GHSA-aaaa-bbbb-cccc', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Reviewed', severity: 'high', cwe: [], range: '<1.1.0', affected: [2] },
    { id: 'GHSA-gggg-hhhh-jjjj', source: 'repository', ghsa: 'GHSA-gggg-hhhh-jjjj', url: 'https://github.com/org/advised/security/advisories/GHSA-gggg-hhhh-jjjj', title: 'Unreviewed GHSA-gggg-hhhh-jjjj', severity: 'moderate', cwe: ['CWE-79'], range: '< 1.2.0', affected: [1, 2] },
  ], 'only those naming the package, and only versions npm does not report under the same GHSA')
  assert.equal(body.repository, true)
  assert.deepEqual(asked.filter(([what]) => what === 'repository'), [['repository', 'org/advised', null]])
  assert.ok(await h.db.getUpstreamCacheEntry('github/advisories/org/advised'), 'the listing is kept where bundle advisories keep it')
})

test('npm\'s advisories are answered while GitHub refuses, and its repository asked again next time', async t => {
  const h = await setup(t)
  const pkg = packageOf('rate-limited', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/limited.git' } })
  registry(t, [pkg])
  const repoAdvisories = { 'org/limited': Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) }
  const asked = insights(t, { repos: { 'org/limited': { full_name: 'org/limited', private: false, visibility: 'public' } },
    advisories: { 'rate-limited': [{ id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Reviewed', severity: 'low', vulnerable_versions: '*', cwe: [] }] }, repoAdvisories })
  const refused = (await h.send('/api/npm/advisories?name=rate-limited')).json()
  assert.equal(refused.repository, false)
  assert.deepEqual(refused.advisories.map(row => row.id), ['GHSA-aaaa-bbbb-cccc'])
  repoAdvisories['org/limited'] = []
  const answered = (await h.send('/api/npm/advisories?name=rate-limited')).json()
  assert.equal(answered.repository, true)
  assert.equal(asked.filter(([what]) => what === 'repository').length, 2)
})

test('advisories of a repository that isn\'t public, an internal one included, are not asked for, nor where GitHub can\'t say', async t => {
  const h = await setup(t)
  const reviewed = [{ id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Reviewed', severity: 'low', vulnerable_versions: '*', cwe: [] }]
  const hidden = packageOf('hidden-advised', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/hidden.git' } })
  const untold = packageOf('untold-advised', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/untold.git' } })
  registry(t, [hidden, untold])
  const asked = insights(t, {
    repos: { 'org/hidden': { full_name: 'org/hidden', private: false, visibility: 'internal' } },
    advisories: { 'hidden-advised': reviewed, 'untold-advised': reviewed },
    repoAdvisories: { 'org/hidden': [{ ghsa_id: 'GHSA-xxxx-yyyy-zzzz', state: 'published', summary: 'Private', severity: 'high', cwe_ids: [],
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'hidden-advised' }, vulnerable_version_range: '< 2.0.0' }] }] },
  })
  const hiddenBody = (await h.send('/api/npm/advisories?name=hidden-advised')).json()
  assert.deepEqual(hiddenBody.advisories.map(row => row.id), ['GHSA-aaaa-bbbb-cccc'], 'npm\'s alone')
  assert.equal(hiddenBody.repository, true, 'there is no public repository to ask')
  assert.equal(asked.filter(([what]) => what === 'repository').length, 0, 'the internal repository\'s listing is never asked for, though it answers private: false')
  // GitHub's answer for the repository fails: it can't be told public.
  t.mock.method(globalThis, 'fetch', ((fetch) => (input, init) => String(input) === 'https://api.github.com/repos/org/untold'
    ? Promise.resolve(Response.json({ message: 'Server Error' }, { status: 500 })) : fetch(input, init))(globalThis.fetch))
  const untoldBody = (await h.send('/api/npm/advisories?name=untold-advised')).json()
  assert.deepEqual(untoldBody.advisories.map(row => row.id), ['GHSA-aaaa-bbbb-cccc'])
  assert.equal(untoldBody.repository, false, 'not kept, so asked again next time')
  assert.equal(asked.filter(([what]) => what === 'repository').length, 0)
})

test('a repository\'s visibility is asked afresh for its advisories, not taken from its kept figures', async t => {
  const h = await setup(t)
  const pkg = packageOf('turned-private', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/turned.git' } })
  registry(t, [pkg])
  const repos = { 'org/turned': { full_name: 'org/turned', private: false, visibility: 'public' } }
  const asked = insights(t, { repos, repoAdvisories: { 'org/turned': [] } })
  assert.equal((await h.send('/api/npm/stats?name=turned-private')).json().github.repo, 'org/turned', 'kept as public')
  Object.assign(repos['org/turned'], { private: true, visibility: 'private' })
  const body = (await h.send('/api/npm/advisories?name=turned-private')).json()
  assert.equal(body.repository, true)
  assert.equal(asked.filter(([what, repo]) => what === 'github' && repo === 'org/turned').length, 2, 'GitHub asked again')
  assert.equal(asked.filter(([what]) => what === 'repository').length, 0, 'and the now private repository\'s listing never asked for')
})

test('a version\'s publish commit\'s tags, from a public repository, asked with a token', async t => {
  const other = 'd'.repeat(40), sha = 'c'.repeat(40)
  const asked = []
  let repository = null
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    asked.push({ url: String(input), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) })
    return Promise.resolve(Response.json({ data: { repository } }))
  })
  const token = value => () => Promise.resolve(value)
  const commit = oid => ({ __typename: 'Commit', oid })
  const annotated = target => ({ __typename: 'Tag', oid: 'e'.repeat(40), target })
  repository = { visibility: 'PUBLIC', refs: { nodes: [
    { name: 'v1.2.3', target: commit(sha) },
    { name: 'pkg@1.2.3', target: annotated(commit(sha)) },
    { name: 'nested@1.2.3', target: annotated(annotated(commit(sha))) },
    { name: 'v1.2.3-rc.1', target: commit(other) },
  ] } }
  assert.deepEqual(await npmCommitTags('Org/Tagged', sha, '1.2.3', token('user-token')), ['nested@1.2.3', 'pkg@1.2.3', 'v1.2.3'], 'annotated tags followed to their commit, others left out')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].url, 'https://api.github.com/graphql')
  assert.equal(asked[0].auth, 'Bearer user-token')
  assert.deepEqual(asked[0].body.variables, { owner: 'Org', name: 'Tagged', query: '1.2.3' })
  assert.deepEqual(await npmCommitTags('org/tagged', sha, '1.2.3', token('another-token')), ['nested@1.2.3', 'pkg@1.2.3', 'v1.2.3'])
  assert.equal(asked.length, 1, 'kept for the repository and commit, whoever asks')
  repository = { visibility: 'PRIVATE', refs: { nodes: [{ name: 'v2.0.0', target: commit(sha) }] } }
  assert.deepEqual(await npmCommitTags('org/private', sha, '2.0.0', token('user-token')), [], 'a private repository\'s tags are no one\'s to see here')
  repository = { visibility: 'INTERNAL', refs: { nodes: [{ name: 'v2.0.0', target: commit(sha) }] } }
  assert.deepEqual(await npmCommitTags('org/internal', sha, '2.0.0', token('user-token')), [], 'nor an internal one\'s')
  repository = null
  assert.deepEqual(await npmCommitTags('org/gone', sha, '2.0.0', token('user-token')), [])
  asked.length = 0
  assert.deepEqual(await npmCommitTags('org/untold', sha, '3.0.0', token(null)), [])
  assert.equal(asked.length, 0, 'GraphQL needs a token: without one, nothing is asked')
  repository = { visibility: 'PUBLIC', refs: { nodes: [{ name: 'v3.0.0', target: commit(sha) }] } }
  assert.deepEqual(await npmCommitTags('org/untold', sha, '3.0.0', token('user-token')), ['v3.0.0'], 'nor kept for a reader with one')
  let tokensAsked = 0
  await npmCommitTags('org/untold', sha, '3.0.0', () => { tokensAsked++; return Promise.resolve('user-token') })
  assert.equal(tokensAsked, 0, 'a token is asked for only where the tags are not kept')
})

test('the tags route reads the version as the reader may, and asks GitHub only with their token', async t => {
  const h = await setup(t)
  const pkg = packageOf('tagged-route', '1.0.0', { 'index.js': '' })
  const calls = registry(t, [pkg])
  const res = await h.send('/api/npm/tags?name=tagged-route&version=1.0.0')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { name: 'tagged-route', version: '1.0.0', tags: [] })
  assert.ok(!calls.some(call => call.url.includes('api.github.com')), 'a reader without a GitHub token asks GitHub nothing')
  assert.deepEqual((await h.send('/api/npm/tags?name=missing-package&version=1.0.0')).json(), { error: 'package-not-found' })
})

test('figures and advisories of a private package stay closed to readers without private access', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = { ...packageOf('@acme/insight', '1.0.0', { 'index.js': '' }), private: true }
  registry(t, [pkg])
  const asked = insights(t, { downloads: { '@acme/insight': { start: '2026-01-01', end: '2026-01-01', downloads: [] } } })
  for (const path of ['/api/npm/stats?name=%40acme%2Finsight', '/api/npm/advisories?name=%40acme%2Finsight', '/api/npm/tags?name=%40acme%2Finsight&version=1.0.0']) {
    assert.deepEqual((await h.send(path, 'view')).json(), { error: 'package-not-found' }, path)
    assert.equal((await h.send(path, 'admin')).status, 200, path)
  }
  assert.ok(asked.every(([, , auth]) => auth === null), 'never with the server\'s token')
  assert.deepEqual((await h.send('/api/npm/stats?name=..%2Fx')).json(), { error: 'bad-package' })
})

test('team npm scopes are admin-only, normalized, listed with teams and recorded', async t => {
  const h = await setup(t)
  const path = '/api/admin/teams/set-npm-scopes'
  assert.equal((await h.send(path, 'manage', { method: 'POST', body: { teamId: 'team', scopes: ['@a'] } })).status, 403)
  assert.equal((await h.send(path, 'admin', { method: 'POST', body: { teamId: 'team', scopes: ['@a'] }, csrf: false })).status, 403)
  assert.equal((await h.send(path, 'admin', { method: 'GET' })).status, 405)
  assert.deepEqual((await h.send(path, 'admin', { method: 'POST', body: { teamId: 'team', scopes: ['@bad scope'] } })).json(), { error: 'bad-scope' })
  assert.deepEqual((await h.send(path, 'admin', { method: 'POST', body: { teamId: 'missing', scopes: [] } })).json(), { error: 'no-team' })
  const res = await h.send(path, 'admin', { method: 'POST', body: { teamId: 'team', scopes: ['Tools', '@acme'] } })
  assert.deepEqual(res.json(), { ok: true, scopes: ['@acme', '@tools'] })
  const teams = (await h.send('/api/admin/teams', 'admin')).json().teams
  assert.deepEqual(teams.map(team => [team.id, team.npmScopes]), [['team', ['@acme', '@tools']]])
  await h.send(path, 'admin', { method: 'POST', body: { teamId: 'team', scopes: ['@acme', '@new'] } })
  const history = await h.db.listActivity({ page: 1, limit: 10, kind: 'all', query: '', contexts: null })
  assert.deepEqual(history.history.map(row => row.action).filter(action => action.includes('npm')), [
    "changed team Team's npm scopes: added @new; removed @tools",
    "changed team Team's npm scopes: added @acme, @tools",
  ])
})

test('SQLite team npm scopes normalize, follow membership and hidden teams, and need an admin', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkTeamNpmScopes(db)
})

test('a homepage that leads only where the repository does is left out of the manifest', () => {
  const repository = (url, directory) => ({ repository: { type: 'git', url, ...directory ? { directory } : {} } })
  const homepage = json => npmManifest(json).homepage ?? null
  const axios = repository('git+https://github.com/axios/axios.git')
  assert.equal(homepage({ ...axios, homepage: 'https://github.com/axios/axios#readme' }), null, 'npm\'s default homepage')
  assert.equal(homepage({ ...axios, homepage: 'https://github.com/Axios/axios' }), null)
  assert.equal(homepage({ ...axios, homepage: 'https://axios-http.com' }), 'https://axios-http.com')
  assert.equal(homepage({ ...axios, homepage: 'https://github.com/axios/axios/wiki' }), 'https://github.com/axios/axios/wiki')
  const core = repository('git+https://github.com/babel/babel.git', 'packages/babel-core')
  assert.equal(homepage({ ...core, homepage: 'https://github.com/babel/babel/tree/main/packages/babel-core#readme' }), null, 'its directory')
  assert.equal(homepage({ ...core, homepage: 'https://github.com/babel/babel/tree/main/packages/babel-parser' }),
    'https://github.com/babel/babel/tree/main/packages/babel-parser', 'another package\'s directory')
  assert.equal(homepage({ homepage: 'https://example.com/' }), 'https://example.com/', 'no repository')
})
