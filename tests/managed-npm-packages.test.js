import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gzipSync } from 'node:zlib'
import { setCacheDir } from '@preventive/upstream/npm.js'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { MAX_NPM_PACKAGE_BYTES, NpmPackageError, canReadPrivateNpm, npmFileText, npmTarballFilename, readNpmTar } from '../server-managed/npm-packages.ts'
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

const pax = path => { const record = ` path=${path}\n`; let length = record.length; length += String(length + String(length).length).length; return `${length}${record}` }

function packageOf(name, version, files, extra = {}) {
  const tgz = gzipSync(tar(Object.entries(files).map(([path, data]) => ({ name: `package/${path}`, data }))))
  const base = name.split('/').at(-1)
  const doc = { name, version, description: `${name} for tests`, license: 'MIT', main: 'lib/index.js',
    repository: { type: 'git', url: 'git+https://github.com/org/repo.git', directory: 'packages/pkg' }, gitHead: 'a'.repeat(40),
    dependencies: { dep: '^1.0.0' }, scripts: { postinstall: 'node setup.js', test: 'node --test' },
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
    { name: '././@LongLink', type: 'L', data: 'package/from-gnu.js\0' },
    { name: 'package/trunc', data: 'gnu' },
    { name: 'package/index.js', data: 'replaced' },
    { name: 'other-root/bin.dat', data: Buffer.from([0, 1, 2]) },
  ]))
  assert.deepEqual(files.map(file => [file.path, Buffer.from(file.bytes).toString()]), [
    ['a/b.js', 'b'], ['bin.dat', '\0\u0001\u0002'], ['from-gnu.js', 'gnu'], ['from-pax.js', 'pax'], ['index.js', 'replaced'], ['very/long/deep/name.js', 'prefixed'],
  ])
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
    assert.deepEqual(body.files, [['lib/index.js', 17, 'export default 1\n'], ['logo.png', 5, null], ['package.json', 19, '{"name":"@pub/pkg"}']])
    assert.deepEqual(body.manifest, { description: '@pub/pkg for tests', license: 'MIT', main: 'lib/index.js', gitHead: 'a'.repeat(40),
      dependencies: { dep: '^1.0.0' }, installScripts: { postinstall: 'node setup.js' }, github: { github: 'org/repo', directory: 'packages/pkg' } })
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
  t.after(async () => { setCacheDir(false); await rm(cache, { recursive: true, force: true }) })
  const pkg = { ...packageOf('@acme/secret', '2.0.0', { 'index.js': 'secret source' }), private: true }
  const calls = registry(t, [pkg])
  for (const who of ['admin', 'manage']) {
    const res = await h.send(packagePath('@acme/secret', '2.0.0'), who)
    assert.equal(res.status, 200, who)
    assert.equal(res.json().private, true)
    assert.deepEqual(res.json().files, [['index.js', 13, 'secret source']])
  }
  assert.ok(calls.some(call => call.url === pkg.doc.dist.tarball), 'the tarball was fetched, and cached by upstream')
  // The tarball is now in upstream's cache, readable without any token. A
  // reader without private access is answered by the anonymous registry.
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
  const calls = registry(t, [big, wrong])
  assert.deepEqual((await h.send(packagePath('big', '1.0.0'))).json(), { error: 'package-too-large' })
  assert.ok(!calls.some(call => call.url === big.doc.dist.tarball), 'a declared size refuses before download')
  assert.equal((await h.send(packagePath('wrong', '1.0.0'))).status, 404, 'the registry answering for another name')
  for (const path of [packagePath('../x', '1.0.0'), packagePath('ok', '^1.0.0'), '/api/npm/package', '/api/npm/versions?name=.x']) {
    assert.deepEqual((await h.send(path)).json(), { error: 'bad-package' }, path)
  }
  assert.equal((await h.send(packagePath('ok', '1.0.0'), 'view', { method: 'POST' })).status, 405)
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('oops', { status: 503 })))
  assert.deepEqual((await h.send(packagePath('down', '1.0.0'))).json(), { error: 'upstream-unavailable' })
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
