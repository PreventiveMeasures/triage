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
import { MAX_NPM_JSON_LENGTH, MAX_NPM_PACKAGE_BYTES, NpmPackageError, canReadPrivateNpm, npmFileText, npmManifest, npmTarballFilename, readNpmPackument, readNpmTar, readNpmVersion, readNpmVersions,
  setNpmDocumentCache } from '../server-managed/npm-packages.ts'
import { npmVersionFields } from '../server-managed/npm-manifest.ts'
import { npmVersionStore, riskLineStore } from '../server-managed/npm-kept.ts'
import { MAX_TAR_BYTES, loadNpmPackageBody, loadNpmTarball, setNpmTarballCache } from '../server-managed/npm-loads.ts'
import { npmCommitTags, npmGithubStats } from '../server-managed/npm-insights.ts'
import { npmReadyScanDownload, npmReadyScanDownloads, npmRisk, npmRiskCache, npmRiskRemoved } from '../server-managed/npm-risk.ts'
import { NpmRiskError } from '../risk/index.js'
import { isNpmPackageName, isNpmPackageSpec, normalizeNpmScope, npmPackageScope } from '../common/managed/npm-packages.js'
import { checkTeamNpmScopes } from './_managed-team-npm-scopes.js'
import { ADVISORIES, OSV, REGISTRY, osvNone, packageOf, registry, tar, withToken } from './_managed-npm.js'

const config = {
  port: 0, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'cid', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'sid', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}
// A pax record, its length counting its bytes, the length's own digits among them.
const paxRecord = (key, value) => { const record = ` ${key}=${value}\n`; let length = Buffer.byteLength(record); length += String(length + String(length).length).length; return `${length}${record}` }
const pax = path => paxRecord('path', path)


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

test('the viewer reads an exact public version\'s document from the database once npm answered it; a dist-tag from npm each time', async t => {
  const h = await setup(t)
  const pkg = packageOf('kept-viewed', '1.0.0', { 'index.js': '' })
  const calls = registry(t, [pkg])
  const asked = () => calls.filter(call => call.url === `${REGISTRY}/kept-viewed/1.0.0`).length
  for (const path of [packagePath('kept-viewed', '1.0.0'), '/api/npm/tags?name=kept-viewed&version=1.0.0', packagePath('kept-viewed', '1.0.0')]) {
    assert.equal((await h.send(path)).status, 200)
  }
  assert.equal(asked(), 1, 'its document asked of npm once')
  const tagged = () => calls.filter(call => call.url === `${REGISTRY}/kept-viewed/latest`).length
  await h.send(packagePath('kept-viewed', 'latest'))
  const once = tagged()
  await h.send(packagePath('kept-viewed', 'latest'))
  assert.ok(once > 0 && tagged() > once, 'asked of npm on every view')
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
  assert.deepEqual(versions.json(), { name: '@pub/pkg', private: false, distTags: { latest: '1.2.3' }, versions: ['1.2.3'], times: { '1.2.3': '2025-01-01T00:00:00.000Z' },
    created: '2020-01-01T00:00:00.000Z', teamScoped: false }, 'tags of unlisted versions are left out; when each was published, and its first was, from the whole document')
  assert.equal((await h.send(packagePath('@pub/pkg', '1.2.3'))).json().published, '2025-01-01T00:00:00.000Z', 'kept, once a whole document said it, for the version to carry')
  const download = await h.send('/api/npm/download?name=%40pub%2Fpkg&version=1.2.3')
  assert.equal(download.status, 200)
  assert.equal(download.headers['content-type'], 'application/gzip')
  assert.match(download.headers['content-disposition'], /filename="pub-pkg-1\.2\.3\.tgz"/u)
  assert.deepEqual(download.bytes, pkg.tgz)
})

test('a version\'s risk is told on the server, as risk tells it, for whoever can read the version', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = packageOf('@pub/pkg', '1.2.3', { 'lib/index.js': 'require("child_process")\n', 'package.json': '{"name":"@pub/pkg"}' })
  registry(t, [pkg])
  const riskPath = params => `/api/npm/risk?${new URLSearchParams({ name: '@pub/pkg', ...params })}`
  const res = await h.send(riskPath({ version: '1.2.3' }))
  assert.equal(res.status, 200)
  const body = res.json()
  assert.deepEqual([body.name, body.version, body.oldVersion, body.published], ['@pub/pkg', '1.2.3', null, '2025-01-01T00:00:00.000Z'])
  assert.deepEqual(body.findings.map(({ id }) => id), ['held-install-scripts', 'held-runs-code', 'held-unused-deps'], 'what it holds: its postinstall, child_process, and a dependency nothing imports')
  assert.deepEqual(body.files['lib/index.js'].stamps, [{ name: 'child_process', severity: 'high' }])
  const fromEmpty = await h.send(riskPath({ version: '1.2.3', otherVersion: '(empty)' }))
  assert.equal(fromEmpty.status, 200)
  assert.ok(fromEmpty.json().findings.some(finding => finding.id === 'held-runs-code' && finding.severity === 'critical' && finding.files.every(row => row.added)),
    'blank-base reviews assess all files as added: what runs code red, each file new')
  assert.deepEqual((await h.send(riskPath({ version: '1.2.3' }))).json().findings, body.findings, 'the empty comparison has its own cache entry')
  assert.deepEqual(body.dependencies.added.map(({ name, flags }) => [name, flags.map(({ check }) => check)]), [['dep', ['unimported']]])
  assert.equal((await h.send(riskPath({ version: '1.2.3' }), 'nobody')).status, 401)
  assert.equal((await h.send(riskPath({ version: '1.2.3', otherVersion: 'not a version' }))).status, 400)
  assert.equal((await h.send(riskPath({ version: '9.9.9' }))).status, 404)
  const huge = packageOf('@pub/huge', '1.0.0', { 'package.json': '{}' })
  huge.doc.dist.unpackedSize = 65 * 1024 * 1024
  const calls = registry(t, [huge])
  const refused = await h.send(`/api/npm/risk?${new URLSearchParams({ name: '@pub/huge', version: '1.0.0' })}`)
  assert.deepEqual([refused.status, refused.json()], [413, { error: 'package-too-large' }], 'its tarball read as the viewer loads one, refused as it would be')
  assert.ok(!calls.some(call => call.url === huge.doc.dist.tarball))
})

test('a version\'s risk asked alone is told against the version risk picks, its document read for its tarball; Compare\'s against the one it names', async t => {
  const h = await setup(t)
  const old = packageOf('picked', '1.0.0', { 'package.json': '{}', 'index.js': 'module.exports = 1\n' }, { scripts: {}, dependencies: {} })
  const open = packageOf('picked', '1.1.0', { 'package.json': '{}', 'index.js': 'require("child_process").exec(x)\n' }, { scripts: {}, dependencies: {} })
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const url = String(input)
    asked.push(url)
    if (url === ADVISORIES) return Promise.resolve(Response.json({}))
    if (url === OSV) return Promise.resolve(osvNone(init))
    for (const { doc, tgz } of [old, open]) {
      if (url === `${REGISTRY}/picked/${doc.version}`) return Promise.resolve(Response.json(doc))
      if (url === doc.dist.tarball) return Promise.resolve(new Response(tgz))
    }
    if (url === `${REGISTRY}/picked`) {
      return Promise.resolve(Response.json({ name: 'picked', 'dist-tags': { latest: '1.1.0' }, versions: { '1.0.0': old.doc, '1.1.0': open.doc },
        time: { created: '2025-01-01T00:00:00.000Z', '1.0.0': '2025-01-01T00:00:00.000Z', '1.1.0': '2025-06-01T00:00:00.000Z' } }))
    }
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  })
  const alone = (await h.send('/api/npm/risk?name=picked&version=1.1.0')).json()
  assert.equal(alone.oldVersion, '1.0.0', 'the version risk picks, said')
  assert.deepEqual(alone.findings.filter(({ id }) => id === 'held-runs-code').map(({ severity, files }) => [severity, files.map(({ path, added }) => [path, Object.keys(added)])]),
    [['critical', [['index.js', ['child-process']]]]], 'what it holds, red where it is new since')
  assert.ok(asked.includes(`${REGISTRY}/picked/1.0.0`) && asked.includes(old.doc.dist.tarball), 'its document read, then its tarball')
  const named = (await h.send('/api/npm/risk?name=picked&version=1.1.0&otherVersion=1.0.0')).json()
  assert.deepEqual([named.oldVersion, named.findings], ['1.0.0', alone.findings], 'Compare\'s, against the one it names')
})

test('a team\'s own package isn\'t flagged as few download it, as it isn\'t as just published', async t => {
  const pkg = packageOf('quiet-own', '1.0.0', { 'package.json': '{}' })
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = String(input)
    if (url === ADVISORIES) return Promise.resolve(Response.json({}))
    if (url === OSV) return Promise.resolve(osvNone(init))
    if (url === pkg.doc.dist.tarball) return Promise.resolve(new Response(pkg.tgz))
    if (url.startsWith('https://api.npmjs.org/downloads/range/')) return Promise.resolve(Response.json({ start: '2026-08-01', end: '2026-10-11', package: 'quiet-own', downloads: [] }))
    return Promise.resolve(Response.json({ name: 'quiet-own', versions: { '1.0.0': pkg.doc }, time: { '1.0.0': '2025-01-01T00:00:00.000Z' } }))
  })
  const db = { getUpstreamCacheEntry: () => Promise.resolve(null), setUpstreamCacheEntry: () => Promise.resolve() }
  const doc = { ...pkg.doc, private: false, dist: { ...pkg.doc.dist, unpackedSize: null, fileCount: null }, manifest: {} }
  const unpopular = async teamScoped => (await npmRisk(doc, null, { db, teamScoped, privileged: false, signal: new AbortController().signal })).findings.some(({ id }) => id === 'popularity')
  assert.equal(await unpopular(false), true, 'anyone else\'s is')
  assert.equal(await unpopular(true), false)
})

test('a new dependency on a package of a scope a team lists is told no tier nor age, as the team\'s own package isn\'t', async t => {
  const before = packageOf('own-app', '1.0.0', { 'package.json': '{}', 'index.js': '' }, { dependencies: {} })
  const after = packageOf('own-app', '1.1.0', { 'package.json': '{}', 'index.js': 'require("@own/helper")\nrequire("stranger")\n' },
    { dependencies: { '@own/helper': '^1.0.0', stranger: '^1.0.0' } })
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = String(input)
    asked.push(url)
    if (url === ADVISORIES) return Promise.resolve(Response.json({}))
    if (url === OSV) return Promise.resolve(osvNone(init))
    for (const pkg of [before, after]) if (url === pkg.doc.dist.tarball) return Promise.resolve(new Response(pkg.tgz))
    if (url.startsWith('https://api.npmjs.org/downloads/range/')) return Promise.resolve(Response.json({ start: '2026-08-01', end: '2026-10-11', package: 'x', downloads: [] }))
    if (url.endsWith('/stranger')) return Promise.resolve(Response.json({ name: 'stranger', versions: {}, time: { created: '2025-01-01T00:00:00.000Z' } }))
    return Promise.resolve(Response.json({ name: 'own-app', versions: { '1.0.0': before.doc, '1.1.0': after.doc },
      time: { '1.0.0': '2025-01-01T00:00:00.000Z', '1.1.0': '2025-02-01T00:00:00.000Z' } }))
  })
  const db = { getUpstreamCacheEntry: () => Promise.resolve(null), setUpstreamCacheEntry: () => Promise.resolve() }
  const docOf = pkg => ({ ...pkg.doc, private: false, dist: { ...pkg.doc.dist, unpackedSize: null, fileCount: null }, manifest: {} })
  const scopes = []
  const ownScope = scope => { scopes.push(scope); return Promise.resolve(scope === '@own') }
  const { added } = (await npmRisk(docOf(after), docOf(before), { db, teamScoped: false, ownScope, privileged: false, signal: new AbortController().signal })).dependencies
  const byName = Object.fromEntries(added.map(row => [row.name, row]))
  assert.equal(byName.stranger.level, 'is-unpopular', 'anyone else\'s is told its tier')
  assert.equal(byName['@own/helper'].level, undefined)
  assert.deepEqual(scopes, ['@own'], 'a scope asked of the teams once, an unscoped package none')
  assert.ok(!asked.some(url => url.includes('@own')), 'nor npm asked of its package')
})

test('a risk assessment whose reader is gone stops waiting on its tarball, which loads on for others', async t => {
  const pkg = packageOf('slow-risk', '1.0.0', { 'package.json': '{}' })
  let answer = () => {}
  const arrived = new Promise(resolve => {
    t.mock.method(globalThis, 'fetch', (input, init) => {
      if (String(input) === ADVISORIES) return Promise.resolve(Response.json({}))
      if (String(input) === OSV) return Promise.resolve(osvNone(init))
      if (String(input) !== pkg.doc.dist.tarball) return Promise.resolve(Response.json({ name: 'slow-risk', versions: { '1.0.0': pkg.doc }, time: { '1.0.0': '2025-01-01T00:00:00.000Z' } }))
      resolve()
      return new Promise(resolveFetch => { answer = () => resolveFetch(new Response(pkg.tgz)) })
    })
  })
  const db = { getUpstreamCacheEntry: () => Promise.resolve(null), setUpstreamCacheEntry: () => Promise.resolve() }
  const controller = new AbortController()
  const assessed = npmRisk({ ...pkg.doc, private: false, dist: { ...pkg.doc.dist, unpackedSize: null, fileCount: null }, manifest: {} }, null,
    { db, teamScoped: false, privileged: false, signal: controller.signal })
  await arrived
  controller.abort(new Error('reader gone'))
  await assert.rejects(assessed, /reader gone/u, 'given up on while its tarball is still on its way')
  const load = loadNpmTarball({ ...pkg.doc, private: false, dist: { ...pkg.doc.dist, unpackedSize: null, fileCount: null }, manifest: {} })
  answer()
  assert.equal((await load.result).byteLength, pkg.tgz.byteLength, 'the load went on for whoever else reads it')
  load.release()
})

test('a version npm removed is assessed as a scan\'s others are, within the spare assessments the server makes at once', async t => {
  const pkgs = ['spare-one', 'spare-two'].map(name => packageOf(name, '1.0.0', { 'package.json': '{}' }))
  const placeholder = packageOf('spare-gone', '0.0.1-security', { 'package.json': '{}' },
    { description: 'security holding package', _npmUser: { name: 'npm', email: 'npm@npmjs.com' } })
  const answers = []
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = String(input)
    const pkg = pkgs.find(({ doc }) => url === doc.dist.tarball)
    if (pkg) return new Promise(resolve => { answers.push(() => resolve(new Response(pkg.tgz))) })
    if (url.startsWith('https://api.npmjs.org/downloads/range/')) return Promise.resolve(Response.json({ start: '2026-08-01', end: '2026-10-11', package: 'x', downloads: [] }))
    if (url === ADVISORIES) return Promise.resolve(Response.json({}))
    if (url === OSV) return Promise.resolve(osvNone(init))
    const gone = { name: 'spare-gone', 'dist-tags': { latest: '0.0.1-security' }, versions: { '0.0.1-security': placeholder.doc },
      time: { '0.0.1-security': '2025-02-01T00:00:00.000Z', '1.0.0': '2025-01-01T00:00:00.000Z' } }
    if (url === `${REGISTRY}/spare-gone`) return Promise.resolve(Response.json(gone))
    const named = pkgs.find(({ doc }) => url === `${REGISTRY}/${doc.name}`)
    return Promise.resolve(Response.json({ name: named.doc.name, versions: { '1.0.0': named.doc }, time: { '1.0.0': '2025-01-01T00:00:00.000Z' } }))
  })
  const db = { getUpstreamCacheEntry: () => Promise.resolve(null), setUpstreamCacheEntry: () => Promise.resolve() }
  const options = { db, teamScoped: false, privileged: false, signal: new AbortController().signal }
  const busy = pkgs.map(({ doc }) => npmRisk({ ...doc, private: false, dist: { ...doc.dist, unpackedSize: null, fileCount: null }, manifest: {} }, null, { ...options, spare: true }))
  while (answers.length < pkgs.length) await new Promise(resolve => { setImmediate(resolve) })
  await assert.rejects(npmRiskRemoved('spare-gone', '1.0.0', options), /npm-busy/u, 'two spare in flight: none more')
  for (const answer of answers) answer()
  await Promise.all(busy)
  assert.deepEqual((await npmRiskRemoved('spare-gone', '1.0.0', options)).findings, [{ id: 'malware', severity: 'critical', takenDown: true }], 'once they are done')
})

test('a version npm removed is told of by OSV\'s malware where anyone can read its package, as nx\'s are, a private one\'s name never sent it', async t => {
  withToken(t)
  const removed = { time: { '1.0.1': '2025-02-01T00:00:00.000Z' } }
  const calls = registry(t, [{ ...packageOf('gone-open', '1.0.0', { 'package.json': '{}' }), ...removed }, { ...packageOf('@acme/gone', '1.0.0', { 'package.json': '{}' }), ...removed, private: true }])
  const fetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (String(url) === OSV && JSON.parse(init.body).queries.every(({ package: { name } }) => name === 'gone-open')) return Promise.resolve(Response.json({ results: [{ vulns: [{ id: 'MAL-2025-41443' }] }] }))
    if (String(url) === 'https://api.osv.dev/v1/vulns/MAL-2025-41443') return Promise.resolve(Response.json({ id: 'MAL-2025-41443', summary: 'Malicious code in gone-open (npm)', aliases: [] }))
    return fetch(url, init)
  })
  const db = { getUpstreamCacheEntry: () => Promise.resolve(null), setUpstreamCacheEntry: () => Promise.resolve() }
  const options = { db, teamScoped: false, privileged: true, signal: new AbortController().signal }
  assert.deepEqual((await npmRiskRemoved('gone-open', '1.0.1', options)).findings, [{ id: 'malware', severity: 'critical',
    advisories: [{ id: 'MAL-2025-41443', url: 'https://osv.dev/vulnerability/MAL-2025-41443', title: 'Malicious code in gone-open (npm)' }] }])
  await assert.rejects(npmRiskRemoved('@acme/gone', '1.0.1', options), error => error instanceof NpmRiskError && error.code === 'version-not-found', 'a private one\'s told of by npm alone')
  assert.ok(!calls.some(({ url }) => url === OSV), 'its name never left for OSV')
})

test('a removed version\'s package npm has none of anonymously is asked of npm again only where its token reads more', async t => {
  withToken(t)
  const calls = registry(t, [])
  const db = { getUpstreamCacheEntry: () => Promise.resolve(null), setUpstreamCacheEntry: () => Promise.resolve() }
  const removed = (name, privileged) => npmRiskRemoved(name, '1.0.0', { db, teamScoped: false, privileged, signal: new AbortController().signal })
  const missing = error => error instanceof NpmRiskError && error.code === 'package-not-found'
  const asked = name => calls.filter(({ url }) => url === `${REGISTRY}/${name}`).map(({ auth }) => auth)
  await assert.rejects(removed('nowhere', true), missing)
  assert.deepEqual(asked('nowhere'), [null], 'an unscoped one: anonymously, once')
  await assert.rejects(removed('@acme/nowhere', false), missing)
  assert.deepEqual(asked('@acme/nowhere'), [null], 'a scoped one, for a reader without private access: anonymously, once')
  await assert.rejects(removed('@acme/hidden', true), missing)
  assert.deepEqual(asked('@acme/hidden'), [null, 'Bearer server-token'], 'for one with it: then with the token')
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
  // Its releases are the team's own, whoever reads them.
  for (const who of ['view', 'admin']) assert.equal((await h.send('/api/npm/versions?name=%40acme%2Fsecret', who)).json().teamScoped, true, who)
  await h.db.setTeamHidden('team', true, Date.now())
  assert.equal((await h.send(packagePath('@acme/secret', '2.0.0'))).status, 404, 'a hidden team grants nothing')
  assert.equal((await h.send('/api/npm/versions?name=%40acme%2Fsecret', 'admin')).json().teamScoped, false, 'nor lists its scope')
  await h.db.setTeamHidden('team', false, Date.now())
  assert.equal((await set([])).status, 200)
  assert.equal((await h.send(packagePath('@acme/secret', '2.0.0'))).status, 404)
})

test('a reader\'s team scopes are read only where they count: a scoped package read below manager, and again only for a private answer', async t => {
  const h = await setup(t)
  withToken(t)
  registry(t, [packageOf('open-lib', '1.0.0', { 'index.js': '' }), packageOf('@acme/open', '1.0.0', { 'index.js': '' }),
    { ...packageOf('@acme/secret', '1.0.0', { 'index.js': 'secret' }), private: true }])
  assert.equal((await h.send('/api/admin/teams/set-npm-scopes', 'admin', { method: 'POST', body: { teamId: 'team', scopes: ['@acme'] } })).status, 200)
  const listScopes = h.db.listUserNpmScopes.bind(h.db)
  let reads = 0
  t.mock.method(h.db, 'listUserNpmScopes', user => { reads++; return listScopes(user) })
  const readsOf = async (name, who) => {
    reads = 0
    assert.equal((await h.send(packagePath(name, '1.0.0'), who)).status, 200, `${name}, read by ${who}`)
    return reads
  }
  assert.equal(await readsOf('open-lib', 'triage'), 0, 'an unscoped package')
  assert.equal(await readsOf('@acme/secret', 'manage'), 0, 'a manager')
  assert.equal(await readsOf('@acme/open', 'triage'), 1, 'a public scoped one: as it is asked of npm, its public answer not')
  assert.equal(await readsOf('@acme/secret', 'triage'), 2, 'a private one: again before it is answered')
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

test('risk\'s records kept in memory are held to a length, the first kept going first', async () => {
  const cache = npmRiskCache({ db: { getUpstreamCacheEntry: () => Promise.resolve(null), setUpstreamCacheEntry: () => Promise.resolve() } }, false)
  const MiB = 1024 * 1024, part = 'p'.repeat(7 * MiB)
  await cache.write('risk/npm/assessments', 'too-large', 'x'.repeat(9 * MiB))
  assert.equal(await cache.read('risk/npm/assessments', 'too-large'), null, 'past an eighth of what memory holds: not kept')
  for (let i = 0; i < 10; i++) await cache.write('risk/npm/assessments', `part-${i}`, part)
  assert.deepEqual(await Promise.all([0, 1, 9].map(async i => (await cache.read('risk/npm/assessments', `part-${i}`))?.length ?? null)), [null, 7 * MiB, 7 * MiB],
    'ten of 7 MiB: the first gone for the 64 MiB memory holds')
})

test('risk\'s downloads of a public package are kept in the database, for another instance, a private one\'s not, and removed eight days on', async t => {
  const db = openSqliteManagedDb(':memory:')
  const DAY = 24 * 60 * 60_000, now = Date.now()
  const counted = { start: '2026-08-01', end: '2026-10-11', days: [1, 2] }
  await npmRiskCache({ db }, true).write('risk/npm/downloads', 'left-pad@2026-08-01:2026-10-11', counted)
  await npmRiskCache({ db }, false).write('risk/npm/downloads', '@acme/secret@2026-08-01:2026-10-11', counted)
  assert.deepEqual(await npmRiskCache({ db }, true).read('risk/npm/downloads', 'left-pad@2026-08-01:2026-10-11'), counted, 'read by another instance')
  const kept = () => db.getUpstreamCacheEntries(['risk/npm/downloads/left-pad@2026-08-01:2026-10-11', 'risk/npm/downloads/@acme/secret@2026-08-01:2026-10-11',
    'risk/npm/downloads/is-number@2026-08-01:2026-10-13']).then(rows => [...rows.keys()])
  assert.deepEqual(await kept(), ['risk/npm/downloads/left-pad@2026-08-01:2026-10-11'], 'a private package\'s kept in memory alone')
  t.mock.timers.enable({ apis: ['Date'], now: now + 9 * DAY })
  await npmRiskCache({ db }, true).write('risk/npm/downloads', 'is-number@2026-08-01:2026-10-13', counted)
  assert.deepEqual(await kept(), ['risk/npm/downloads/is-number@2026-08-01:2026-10-13'], 'nine days on, the first removed as another is written')
})

test('a scan reads the database once and writes it once a lookup of npm\'s downloads, as a request\'s queries take turns', async t => {
  const db = openSqliteManagedDb(':memory:')
  const queries = []
  const counted = Object.assign(Object.create(db), {
    getUpstreamCacheEntries: keys => { queries.push(`read ${keys.length}`); return db.getUpstreamCacheEntries(keys) },
    getUpstreamCacheEntry: key => { queries.push('read 1'); return db.getUpstreamCacheEntry(key) },
    setUpstreamCacheEntries: (entries, at) => { queries.push(`write ${entries.length}`); return db.setUpstreamCacheEntries(entries, at) },
    setUpstreamCacheEntry: (key, value, at) => { queries.push('write 1'); return db.setUpstreamCacheEntry(key, value, at) },
  })
  t.mock.method(globalThis, 'fetch', input => Promise.resolve(Response.json(Object.fromEntries(String(input).split('/').at(-1).split(',')
    .map(name => [name, { package: name, start: '2026-08-01', end: '2026-08-01', downloads: [{ day: '2026-08-01', downloads: 5 }] }])))))
  const names = Array.from({ length: 130 }, (_, i) => `pkg-${i}`)
  const ready = []
  await npmReadyScanDownloads(names, name => { ready.push(name) }, { db: counted }, new AbortController().signal)
  assert.deepEqual(queries, ['read 128', 'write 128', 'read 2', 'write 2'])
  assert.equal(ready.length, 130)
  queries.length = 0
  await npmReadyScanDownloads(names, () => {}, { db: counted }, new AbortController().signal)
  assert.deepEqual(queries, ['read 128', 'read 2'], 'again, all kept: read alone')
})

test('a scan keeps a scoped package\'s downloads where public ones are only where npm counts some, never a private one\'s none', async t => {
  const db = openSqliteManagedDb(':memory:')
  const asked = []
  t.mock.method(globalThis, 'fetch', input => {
    asked.push(String(input))
    return Promise.resolve(String(input).endsWith('/@acme%2fsecret') ? Response.json({ error: 'package @acme/secret not found' }, { status: 404 })
      : Response.json({ package: '@scope/open', start: '2026-08-01', end: '2026-08-01', downloads: [{ day: '2026-08-01', downloads: 5 }] }))
  })
  for (const name of ['@acme/secret', '@scope/open']) await npmReadyScanDownload(name, { db }, new AbortController().signal)
  // Kept by name, as risk keys them.
  const keyOf = name => `risk/npm/downloads/${name}`
  assert.deepEqual([...(await db.getUpstreamCacheEntries(['@acme/secret', '@scope/open'].map(keyOf))).keys()], [keyOf('@scope/open')])
})

test('risk lines kept in the database are read many at once, by key, however old, and removed once older than they are kept', async t => {
  const db = openSqliteManagedDb(':memory:')
  const DAY = 24 * 60 * 60_000, now = Date.now()
  const lines = riskLineStore(db, 30 * DAY)
  await lines.write('left-pad@1.3.0', { score: 7 }, now - 10 * DAY)
  await lines.write('is-number@7.0.0', { score: 0 }, now)
  assert.deepEqual(await lines.readMany(['left-pad@1.3.0', 'is-number@7.0.0', 'gone@1.0.0']),
    new Map([['left-pad@1.3.0', { at: now - 10 * DAY, value: { score: 7 } }], ['is-number@7.0.0', { at: now, value: { score: 0 } }]]))
  t.mock.timers.enable({ apis: ['Date'], now: now + 31 * DAY })
  await lines.write('ms@2.1.3', { score: 0 }, now + 31 * DAY)
  assert.deepEqual([...(await lines.readMany(['left-pad@1.3.0', 'is-number@7.0.0', 'ms@2.1.3'])).keys()], ['ms@2.1.3'], 'a month on, the older removed')
})

test('risk lines kept for good are never removed, however old', async t => {
  const db = openSqliteManagedDb(':memory:')
  const DAY = 24 * 60 * 60_000, now = Date.now()
  const lines = riskLineStore(db, Infinity)
  await lines.write('left-pad@1.3.0', { score: 7 }, now)
  t.mock.timers.enable({ apis: ['Date'], now: now + 400 * DAY })
  await lines.write('ms@2.1.3', { score: 0 }, now + 400 * DAY)
  assert.deepEqual([...(await lines.readMany(['left-pad@1.3.0', 'ms@2.1.3'])).keys()], ['left-pad@1.3.0', 'ms@2.1.3'])
})

test('risk against a private version is checked again for it once told', async t => {
  const h = await setup(t)
  withToken(t)
  const open = { ...packageOf('@acme/mixed', '2.0.0', { 'index.js': 'open' }), versions: ['1.0.0', '2.0.0'] }
  const secret = { ...packageOf('@acme/mixed', '1.0.0', { 'index.js': 'secret' }), private: true }
  registry(t, [open, secret])
  const fetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // Demoted while the private version's tarball downloads.
    if (String(url) === secret.doc.dist.tarball) await h.db.setUserRole(h.users.manage.userId, 'view')
    return fetch(url, init)
  })
  const res = await h.send(`/api/npm/risk?${new URLSearchParams({ name: '@acme/mixed', version: '2.0.0', otherVersion: '1.0.0' })}`, 'manage')
  assert.deepEqual([res.status, res.json()], [404, { error: 'package-not-found' }])
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
    tarballSize: pkgs[0].tgz.length, published: null, manifest: { description: 'shared-a for tests' }, files: [['index.js', 21, "module.exports = 'a'\n"]], known: {} })
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
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const store = npmVersionStore(db)
  await store.write('listed-e', '1.0.0', npmVersionFields(pkgs[4].doc))
  await assert.rejects(readNpmVersion('listed-e', '1.0.0', false, signal, store), /npm-busy/u, 'kept ones too')
  gate.resolve()
  assert.deepEqual((await Promise.all(lists)).map(list => list.versions), [['1.0.0'], ['1.0.0'], ['1.0.0'], ['1.0.0']])
  assert.equal((await readNpmVersion('listed-e', '1.0.0', false, signal)).version, '1.0.0', 'a read frees its bytes once done')
})

// A disk cache for whole documents, set as the server sets it off Vercel.
async function documentCache(t) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-npm-documents-'))
  setNpmDocumentCache(dir)
  t.after(async () => { setNpmDocumentCache(null); await rm(dir, { recursive: true, force: true }) })
  return dir
}

// npm's whole document of `name`, as `answer()` has it now ({ etag, doc } or
// null for none), answered 304 to its own ETag; each request noted with the
// ETag it gave and what was answered.
function wholeDocuments(t, name, answer) {
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const headers = new Headers(init.headers)
    const given = headers.get('if-none-match'), now = answer(headers.get('authorization'))
    const status = String(input) !== `${REGISTRY}/${name}` || !now ? 404 : given === now.etag ? 304 : 200
    asked.push([given, status])
    return Promise.resolve(status === 200 ? Response.json(now.doc, { headers: { etag: now.etag } }) : new Response(null, { status }))
  })
  return asked
}

test('off Vercel, a public package\'s whole document is kept on disk and asked for again with its ETag, read from npm only once changed', async t => {
  const dir = await documentCache(t)
  const signal = new AbortController().signal
  const docOf = versions => ({ name: 'kept-doc', versions: Object.fromEntries(versions.map(v => [v, { name: 'kept-doc', version: v }])), time: { [versions[0]]: '2025-01-01T00:00:00.000Z' } })
  let now = { etag: 'W/"one"', doc: docOf(['1.0.0']) }
  const asked = wholeDocuments(t, 'kept-doc', () => now)
  assert.deepEqual(await readNpmPackument('kept-doc', false, signal), now.doc)
  assert.deepEqual(await readNpmPackument('kept-doc', false, signal), now.doc, 'the kept one, npm answering 304')
  assert.deepEqual((await readNpmVersions('kept-doc', false, signal, { times: true })).versions, ['1.0.0'], 'the viewer\'s read of it kept alike')
  now = { etag: 'W/"two"', doc: docOf(['1.0.0', '1.1.0']) }
  assert.deepEqual(await readNpmPackument('kept-doc', false, signal), now.doc, 'changed, read again')
  assert.deepEqual(await readNpmPackument('kept-doc', false, signal), now.doc)
  assert.deepEqual(asked, [[null, 200], ['W/"one"', 304], ['W/"one"', 304], ['W/"one"', 200], ['W/"two"', 304]])
  await readFile(join(dir, 'npm/packuments', 'kept-doc.json.gz'))
  now = null
  assert.equal(await readNpmPackument('kept-doc', false, signal), null)
  await assert.rejects(readFile(join(dir, 'npm/packuments', 'kept-doc.json.gz')), { code: 'ENOENT' }, 'one npm has none of no longer kept')
  setNpmDocumentCache(null)
  now = { etag: 'W/"three"', doc: docOf(['2.0.0']) }
  await readNpmPackument('kept-doc', false, signal)
  await readNpmPackument('kept-doc', false, signal)
  assert.deepEqual(asked.slice(-2), [[null, 200], [null, 200]], 'on Vercel none kept, none asked conditionally')
})

// A version's document as npm answers it: what readNpmVersion and the viewer
// read of it, and what neither does.
const fullVersion = packageOf('kept-version', '1.2.3', { 'index.js': '' }, {
  author: { name: 'Ada', email: 'ada@example.com' }, maintainers: [{ name: 'publisher-1', email: 'p@example.com' }], keywords: ['k'], bin: 'cli.js',
  homepage: 'https://github.com/org/repo/tree/main/packages/pkg#readme', bugs: { url: 'https://github.com/org/repo/issues' }, engines: { node: '>=20' },
  peerDependencies: { peer: '^2.0.0' }, optionalDependencies: { opt: '^3.0.0' }, hasInstallScript: true, types: 'index.d.ts', module: 'index.mjs', type: 'module',
  readme: 'x'.repeat(10_000), _id: 'kept-version@1.2.3', _nodeVersion: '22.0.0', devDependencies: { big: '^1.0.0' },
}).doc
fullVersion.dist = { ...fullVersion.dist, shasum: 'f'.repeat(40), signatures: [{ keyid: 'k', sig: 's' }], attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x', provenance: { predicateType: 'p' } } }

test('a version\'s document is kept of only the fields read of it, read alike', () => {
  const kept = npmVersionFields(fullVersion)
  assert.deepEqual(npmManifest(kept), npmManifest(fullVersion))
  for (const key of ['readme', '_id', '_nodeVersion', 'devDependencies']) assert.equal(key in kept, false, key)
  assert.deepEqual(kept.scripts, { postinstall: 'node setup.js' }, 'only the scripts npm runs installing it')
  assert.deepEqual(kept.dist, { tarball: fullVersion.dist.tarball, integrity: fullVersion.dist.integrity, unpackedSize: 100, fileCount: 2, attestations: { provenance: {} } })
  assert.ok(JSON.stringify(kept).length < JSON.stringify(fullVersion).length / 5)
})

test('with a store, a public version\'s document is kept and read from it, never asked of npm again; a private one, and a dist-tag, asked each time', async t => {
  withToken(t)
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const store = npmVersionStore(db)
  const secret = packageOf('@team/secret', '1.0.0', { 'index.js': '' })
  const calls = registry(t, [{ doc: fullVersion }, { ...secret, private: true }])
  const signal = new AbortController().signal
  const fresh = await readNpmVersion('kept-version', '1.2.3', false, signal, store)
  assert.deepEqual(await readNpmVersion('kept-version', '1.2.3', false, signal), fresh, 'as read without a store')
  const asked = calls.length
  assert.deepEqual(await readNpmVersion('kept-version', '1.2.3', false, signal, store), fresh)
  assert.equal(calls.length, asked, 'read from the store')
  assert.equal((await store.read('kept-version', '1.2.3')).readme, undefined)
  await readNpmVersion('kept-version', 'latest', false, signal, store)
  assert.equal(calls.length, asked + 1, 'a dist-tag asked of npm')
  assert.equal((await readNpmVersion('@team/secret', '1.0.0', true, signal, store)).private, true)
  assert.equal(await store.read('@team/secret', '1.0.0'), null, 'one only the token reads not kept')
})

test('a kept version is asked of npm again a day on, as npm lets a scoped package be made private, or a version deprecated', async t => {
  withToken(t)
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const store = npmVersionStore(db)
  const scoped = packageOf('@org/turned', '1.0.0', { 'index.js': '' })
  let secret = false
  const calls = registry(t, [{ ...scoped, get private() { return secret } }])
  const signal = new AbortController().signal
  assert.equal((await readNpmVersion('@org/turned', '1.0.0', true, signal, store)).private, false)
  const asked = calls.length
  await readNpmVersion('@org/turned', '1.0.0', true, signal, store)
  assert.equal(calls.length, asked, 'kept within the day')
  secret = true
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 25 * 60 * 60_000 })
  assert.equal((await readNpmVersion('@org/turned', '1.0.0', true, signal, store)).private, true, 'asked again, and private now')
  assert.ok(calls.length > asked)
})

test('an unscoped version deprecated after it was kept shows its deprecation a day on', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const store = npmVersionStore(db)
  const pkg = packageOf('deprecated-later', '1.0.0', { 'index.js': '' })
  registry(t, [pkg])
  const signal = new AbortController().signal
  assert.equal((await readNpmVersion('deprecated-later', '1.0.0', false, signal, store)).manifest.deprecated, undefined)
  pkg.doc.deprecated = 'use deprecated-now'
  assert.equal((await readNpmVersion('deprecated-later', '1.0.0', false, signal, store)).manifest.deprecated, undefined, 'kept within the day')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 25 * 60 * 60_000 })
  assert.equal((await readNpmVersion('deprecated-later', '1.0.0', false, signal, store)).manifest.deprecated, 'use deprecated-now')
})

test('a store removes its rows kept longer than they count as it writes, at most once an hour', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const store = npmVersionStore(db)
  const day = 24 * 60 * 60_000, now = Date.now()
  await db.setUpstreamCacheEntry('npm/version-documents/stale', '{}', now - day - 1)
  await db.setUpstreamCacheEntry('npm/version-documents/fresh', '{}', now - 1)
  await db.setUpstreamCacheEntry('repository-risk/lines/other', '{}', now - day - 1)
  const left = () => db.getUpstreamCacheEntries(['npm/version-documents/stale', 'npm/version-documents/fresh', 'repository-risk/lines/other']).then(rows => [...rows.keys()].toSorted())
  await store.write('pruning', '1.0.0', { name: 'pruning', version: '1.0.0' })
  assert.deepEqual(await left(), ['npm/version-documents/fresh', 'repository-risk/lines/other'], 'its own kind\'s, older than a day')
  await db.setUpstreamCacheEntry('npm/version-documents/stale', '{}', now - day - 1)
  await store.write('pruning', '1.0.1', { name: 'pruning', version: '1.0.1' })
  assert.ok((await left()).includes('npm/version-documents/stale'), 'not again within the hour')
  t.mock.timers.enable({ apis: ['Date'], now: now + 61 * 60_000 })
  await npmVersionStore(db).write('pruning', '1.0.2', { name: 'pruning', version: '1.0.2' })
  assert.ok(!(await left()).includes('npm/version-documents/stale'), 'again an hour on, whatever store of the database writes')
})

test('a private package\'s whole document, read with the server\'s token, is never kept', async t => {
  withToken(t)
  const dir = await documentCache(t)
  const signal = new AbortController().signal
  const doc = { name: '@team/secret', versions: { '1.0.0': {} } }
  const asked = wholeDocuments(t, '@team/secret', auth => auth === 'Bearer server-token' ? { etag: 'W/"private"', doc } : null)
  assert.deepEqual(await readNpmPackument('@team/secret', true, signal), doc)
  assert.deepEqual(await readNpmPackument('@team/secret', true, signal), doc)
  assert.deepEqual(asked, [[null, 404], [null, 200], [null, 404], [null, 200]], 'asked anonymously, then with the token, never with an ETag')
  await assert.rejects(readFile(join(dir, 'npm/packuments', '@team+secret.json.gz')), { code: 'ENOENT' })
})

test('a package\'s first version was published when the earliest time its whole document lists says, one since unpublished among them', async t => {
  // As plain-crypto-js's, once npm took it down: its placeholder listed,
  // npm's `created` the placeholder's, the versions it replaced timed still.
  registry(t, [{ ...packageOf('taken-down', '0.0.1-security', { 'index.js': '' }), time: { created: '2026-03-31T04:26:32.907Z', modified: '2026-03-31T04:26:33.055Z',
    '4.2.0': '2026-03-30T05:57:32.867Z', '4.2.1': '2026-03-30T23:59:12.278Z', '0.0.1-security': '2026-03-31T03:25:11.636Z', unpublished: { time: '2026-03-31T03:25:11.636Z' } } }])
  const list = await readNpmVersions('taken-down', false, new AbortController().signal, { times: true })
  assert.equal(list.created, '2026-03-30T05:57:32.867Z')
  assert.deepEqual(list.times, { '0.0.1-security': '2026-03-31T03:25:11.636Z' }, 'times only for the versions it lists')
  assert.equal((await readNpmVersions('taken-down', false, new AbortController().signal)).created, undefined, 'none from the abbreviated document')
})

test('a read no reader waits on leaves room for two version lists of readers\' own', async t => {
  const pkgs = ['a', 'b', 'c'].map(name => packageOf(`spare-${name}`, '1.0.0', { 'index.js': '' }))
  registry(t, pkgs)
  const answer = globalThis.fetch, gate = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', (input, init) => gate.promise.then(() => answer(input, init)))
  const { signal } = new AbortController()
  const lists = [readNpmVersions('spare-a', false, signal), readNpmVersions('spare-b', false, signal, { spare: true })]
  await assert.rejects(readNpmVersions('spare-c', false, signal, { spare: true }), /npm-busy/u, 'two in flight leave room for two more, not three')
  lists.push(readNpmVersions('spare-c', false, signal))
  gate.resolve()
  assert.deepEqual((await Promise.all(lists)).map(list => list.name), ['spare-a', 'spare-b', 'spare-c'])
})

// npm's downloads API, GitHub and npm's bulk advisories, beside the registry
// `registry` mocks; what each was asked, with its credentials.
function insights(t, { downloads = {}, ranges = {}, repos = {}, advisories = {}, repoAdvisories = {}, osv = {}, socket = {}, badges = {}, provenance = {} }) {
  const asked = [], registryFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const auth = new Headers(init.headers).get('authorization'), url = String(input)
    const record = url.match(/^https:\/\/api\.osv\.dev\/v1\/vulns\/(.+)$/u)
    if (record) {
      asked.push(['osv', record[1], auth])
      return Promise.resolve(osv[record[1]] ? Response.json({ id: record[1], details: osv[record[1]] }) : Response.json({ message: 'Not Found' }, { status: 404 }))
    }
    const attested = url.match(/^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\/(.+)$/u)
    if (attested) {
      const id = decodeURIComponent(attested[1])
      asked.push(['provenance', id, auth])
      return Promise.resolve(provenance[id] ? Response.json(provenance[id]) : Response.json({ error: 'Not found' }, { status: 404 }))
    }
    const badge = url.match(/^https:\/\/badge\.socket\.dev\/npm\/package\/(.+)$/u)
    if (badge) {
      const id = decodeURIComponent(badge[1])
      asked.push(['badge', id, auth])
      const shown = badges[id]
      if (shown instanceof Response) return Promise.resolve(shown)
      return Promise.resolve(new Response(`<svg role="img" aria-label="Socket: ${shown ?? 'not found'}"><title>Socket: ${shown ?? 'not found'}</title></svg>`,
        { status: shown === undefined ? 404 : 200, headers: { 'content-type': 'image/svg+xml' } }))
    }
    const purl = url.match(/^https:\/\/firewall-api\.socket\.dev\/purl\/(.+)$/u)
    if (purl) {
      const id = decodeURIComponent(purl[1])
      asked.push(['socket', id, auth])
      const answer = socket[id]
      return Promise.resolve(answer instanceof Response ? answer : new Response(answer === undefined ? ''
        : `${JSON.stringify(answer)}\n`, { status: answer === undefined ? 500 : 200, headers: { 'content-type': 'application/x-ndjson' } }))
    }
    const listing = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/security-advisories\?/u)
    if (listing) {
      asked.push(['repository', listing[1], auth])
      const answer = repoAdvisories[listing[1]] ?? []
      return Promise.resolve(answer instanceof Response ? answer : Response.json(answer))
    }
    const day = url.match(/^https:\/\/api\.npmjs\.org\/downloads\/range\/([^/]+)\/(.+)$/u)
    if (day) {
      const [, range, encoded] = day, name = decodeURIComponent(encoded)
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
    // A repository by its name, or by its id, where GitHub redirects one
    // renamed or transferred (`location`, with a 301 or its `status`).
    const repo = url.match(/^https:\/\/api\.github\.com\/(?:repos\/([^/]+\/[^/?]+)|repositories\/(\d+))$/u)
    if (repo) {
      const [, name, id] = repo
      asked.push(['github', name ?? `repositories/${id}`, auth])
      const answer = name === undefined ? Object.values(repos).find(found => found.id === Number(id)) : repos[name]
      if (answer?.location) return Promise.resolve(Response.json({ message: 'Moved', url: answer.location }, { status: answer.status ?? 301, headers: { location: answer.location } }))
      return Promise.resolve(answer ? Response.json(answer) : Response.json({ message: 'Not Found' }, { status: 404 }))
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
  assert.deepEqual(asked.filter(([what]) => what !== 'pulls'), [['github', 'org/repo', null], ['advisories', ['advised'], null],
    ['osv', 'GHSA-aaaa-bbbb-cccc', null], ['osv', 'GHSA-dddd-eeee-ffff', null], ['repository', 'org/repo', null]],
    'its repository found public first; every version asked at once, then each advisory\'s text, without credentials')
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

test('advisories carry their text where their source has one: OSV\'s record of npm\'s, the repository\'s own', async t => {
  const h = await setup(t)
  const pkg = packageOf('texted', '1.1.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/texted.git' } })
  registry(t, [{ ...pkg, versions: ['1.0.0', '1.1.0'] }])
  const asked = insights(t, {
    repos: { 'org/texted': { full_name: 'org/texted', private: false, visibility: 'public' } },
    advisories: { texted: [
      { id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Described', severity: 'high', vulnerable_versions: '<1.1.0', cwe: [] },
      { id: 2, url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', title: 'Undescribed', severity: 'low', vulnerable_versions: '<1.1.0', cwe: [] },
    ] },
    osv: { 'GHSA-aaaa-bbbb-cccc': '## Impact\n\nPrototype pollution.' },
    repoAdvisories: { 'org/texted': [{ ghsa_id: 'GHSA-gggg-hhhh-jjjj', state: 'published', summary: 'Unreviewed', description: 'Found in `parse`.', severity: 'low', cwe_ids: [],
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'texted' }, vulnerable_version_range: '< 1.2.0' }] }] },
  })
  const { advisories } = (await h.send('/api/npm/advisories?name=texted')).json()
  assert.deepEqual(advisories.map(({ id, details }) => [id, details]), [
    ['GHSA-aaaa-bbbb-cccc', '## Impact\n\nPrototype pollution.'], ['GHSA-dddd-eeee-ffff', undefined], ['GHSA-gggg-hhhh-jjjj', 'Found in `parse`.'],
  ], 'none where OSV has no record')
  assert.ok(asked.filter(([what]) => what === 'osv').every(([, , auth]) => auth === null), 'OSV asked without credentials')
})

test('Socket\'s scores and alerts for a public version, the file each names as the package has it', async t => {
  const h = await setup(t)
  withToken(t)
  const pkg = packageOf('scored', '1.0.0', { 'index.js': '' })
  const scope = packageOf('@pub/scored', '2.0.0', { 'index.js': '' })
  const unseen = packageOf('unseen', '1.0.0', { 'index.js': '' })
  const capped = packageOf('capped', '1.0.0', { 'index.js': '' })
  registry(t, [pkg, scope, unseen, capped])
  const score = { overall: 0.5, supplyChain: 0.25, vulnerability: 1, quality: 0.86, maintenance: 0.8, license: 1 }
  const asked = insights(t, { badges: { 'scored/1.0.0': 26, '@pub/scored/2.0.0': 10, 'capped/1.0.0': 40 }, socket: {
    'pkg:npm/scored@1.0.0': { id: '1', type: 'npm', name: 'scored', version: '1.0.0', score, alerts: [
      { type: 'installScripts', severity: 'middle', category: 'supplyChainRisk' },
      { type: 'malware', severity: 'critical', category: 'supplyChainRisk', file: 'package/lib/index.js', props: { note: 'Steals tokens.' } },
      { type: 'unknownSeverity', severity: 'bogus' },
    ] },
    'pkg:npm/@pub/scored@2.0.0': { id: '2', type: 'npm', namespace: '@pub', name: 'scored', version: '2.0.0', score, alerts: [] },
    'pkg:npm/unseen@1.0.0': { id: 'synthetic:notFound:1', type: 'npm', name: 'unseen', version: '1.0.0', alerts: [] },
    'pkg:npm/capped@1.0.0': { id: '3', type: 'npm', name: 'capped', version: '1.0.0', score, alerts: [] },
  } })
  assert.deepEqual((await h.send('/api/npm/socket?name=scored&version=1.0.0')).json(), { name: 'scored', version: '1.0.0', socket: { scores: { ...score, supplyChain: 0.26 }, alerts: [
    { type: 'malware', severity: 'critical', category: 'supplyChainRisk', file: 'lib/index.js', note: 'Steals tokens.' },
    { type: 'installScripts', severity: 'middle', category: 'supplyChainRisk', file: null, note: null },
  ] } }, 'most severe first; one of a severity Socket doesn\'t name left out; supply chain as the badge rounds it')
  assert.deepEqual((await h.send('/api/npm/socket?name=%40pub%2Fscored&version=2.0.0')).json().socket, { scores: { ...score, supplyChain: 0.1 }, alerts: [] },
    'a badge lower than the score wins')
  assert.deepEqual((await h.send('/api/npm/socket?name=capped&version=1.0.0')).json().socket.scores.supplyChain, 0.26, 'one higher at most')
  assert.equal((await h.send('/api/npm/socket?name=unseen&version=1.0.0')).json().socket, null, 'a version Socket hasn\'t seen')
  await h.send('/api/npm/socket?name=scored&version=1.0.0')
  assert.deepEqual(asked.filter(([what]) => what === 'socket').map(([, id, auth]) => [id, auth]),
    [['pkg:npm/scored@1.0.0', null], ['pkg:npm/@pub/scored@2.0.0', null], ['pkg:npm/capped@1.0.0', null], ['pkg:npm/unseen@1.0.0', null]], 'asked without credentials, and kept')
  assert.deepEqual(asked.filter(([what]) => what === 'badge').map(([, id, auth]) => [id, auth]),
    [['scored/1.0.0', null], ['@pub/scored/2.0.0', null], ['capped/1.0.0', null], ['unseen/1.0.0', null]], 'its badge too, kept with it')
})

test('a report whose badge couldn\'t be had is answered with Socket\'s own score, and asked again next time', async t => {
  const h = await setup(t)
  registry(t, [packageOf('flaky', '1.0.0', { 'index.js': '' })])
  const score = { overall: 0.79, supplyChain: 0.79, vulnerability: 1, quality: 0.99, maintenance: 0.82, license: 1 }
  const badges = { 'flaky/1.0.0': new Response('', { status: 429 }) }
  const asked = insights(t, { badges, socket: { 'pkg:npm/flaky@1.0.0': { id: '1', type: 'npm', name: 'flaky', version: '1.0.0', score, alerts: [] } } })
  const supplyChain = async () => (await h.send('/api/npm/socket?name=flaky&version=1.0.0')).json().socket.scores.supplyChain
  assert.equal(await supplyChain(), 0.79, 'Socket\'s own, a point low at most')
  badges['flaky/1.0.0'] = 80
  assert.equal(await supplyChain(), 0.8, 'as the badge rounds it, once it answers')
  assert.equal(await supplyChain(), 0.8)
  assert.equal(asked.filter(([what]) => what === 'socket').length, 2, 'kept from then on')
})

test('a version carries what is kept about its package, each part as its own route answers it, and asks for the rest as it loads', async t => {
  const h = await setup(t)
  withToken(t)
  const repository = { type: 'git', url: 'git+https://github.com/org/known.git' }
  const pkg = packageOf('known-pkg', '1.1.0', { 'index.js': '' }, { repository })
  const bare = packageOf('known-bare', '1.0.0', { 'index.js': '' }, { repository: undefined })
  const secret = { ...packageOf('@acme/known', '1.0.0', { 'index.js': '' }), private: true }
  registry(t, [{ ...pkg, versions: ['1.0.0', '1.1.0'] }, packageOf('known-pkg', '1.0.0', { 'index.js': '' }, { repository }), bare, secret])
  const asked = insights(t, {
    downloads: { 'known-pkg': { start: '2026-01-01', end: '2026-01-01', package: 'known-pkg', downloads: [{ day: '2026-01-01', downloads: 5 }] } },
    repos: { 'org/known': { full_name: 'org/known', private: false, visibility: 'public', stargazers_count: 1, forks_count: 0, open_issues_count: 0, archived: false, pushed_at: '2026-09-01T00:00:00Z', pulls: 0 } },
    advisories: { 'known-pkg': [] },
    socket: { 'pkg:npm/known-pkg@1.1.0': { id: '1', type: 'npm', name: 'known-pkg', version: '1.1.0', alerts: [{ type: 'malware', severity: 'critical', category: 'supplyChainRisk' }] } },
  })
  // The registry answers at once; npm's downloads and advisories, GitHub and
  // Socket once the gate opens. Each URL is noted as it is asked.
  const answer = globalThis.fetch, requested = []
  let gate = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    requested.push(url)
    if (!url.startsWith(`${REGISTRY}/`) || url.includes('/-/npm/v1/security/')) await gate.promise
    return answer(input, init)
  })
  const knownOf = async (name, version, who) => (await h.send(packagePath(name, version), who)).json().known
  assert.deepEqual(await knownOf('known-pkg', '1.1.0'), {}, 'nothing kept yet, nor answered before its files are')
  assert.ok(requested.some(url => url.includes('/downloads/range/last-year/known-pkg')) && requested.some(url => url.includes('pkg%3Anpm%2Fknown-pkg%401.1.0')),
    'its downloads and Socket\'s report asked for as it loaded')
  gate.resolve()
  const stats = (await h.send('/api/npm/stats?name=known-pkg')).json()
  const advisories = (await h.send('/api/npm/advisories?name=known-pkg')).json()
  const socket = (await h.send('/api/npm/socket?name=known-pkg&version=1.1.0')).json()
  assert.deepEqual(asked.map(([what]) => what).filter(what => ['downloads', 'advisories', 'socket'].includes(what)).toSorted(), ['advisories', 'downloads', 'socket'],
    'the viewer\'s own requests share what the version asked for')
  const answered = asked.length
  assert.deepEqual(await knownOf('known-pkg', '1.1.0'), { stats, advisories, socket }, 'the tags of its commit need the reader\'s token, so none are kept')
  assert.equal(asked.length, answered, 'nothing kept is asked for again')
  assert.deepEqual(await knownOf('known-pkg', '1.0.0'), { stats, advisories }, 'Socket\'s report is on the version')
  gate = Promise.withResolvers()
  assert.deepEqual(await knownOf('known-bare', '1.0.0'), { tags: { name: 'known-bare', version: '1.0.0', tags: [] } }, 'a version naming no repository has no tags to ask for')
  assert.deepEqual(await knownOf('@acme/known', '1.0.0', 'admin'), { socket: { name: '@acme/known', version: '1.0.0', socket: null },
    provenance: { name: '@acme/known', version: '1.0.0', provenance: null } }, 'nor a private package a report, nor provenance')
  assert.ok(!requested.some(url => url.includes('socket.dev') && url.includes('acme')), 'Socket is never asked about it')
  gate.resolve()
})

test('npm\'s provenance for a public version: where it was built, read only from a statement naming its tarball, never asked for a private one', async t => {
  const h = await setup(t)
  withToken(t)
  const attested = extra => ({ dist: { ...extra.dist, attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } })
  const version = (name, files, extra = {}) => { const pkg = packageOf(name, '1.0.0', files, extra); Object.assign(pkg.doc, attested(pkg.doc)); return pkg }
  const forged = version('forged', { 'index.js': '3' }), lab = version('attested-gitlab', { 'index.js': '6' }), old = version('attested-v02', { 'index.js': '2' })
  const pkg = version('attested', { 'index.js': '1' })
  const bare = packageOf('unattested', '1.0.0', { 'index.js': '4' })
  const secret = { ...version('@acme/attested', { 'index.js': '5' }), private: true }
  registry(t, [pkg, old, lab, forged, bare, secret])
  const hex = doc => Buffer.from(doc.dist.integrity.slice('sha512-'.length), 'base64').toString('hex')
  // A signing certificate's DER, around Fulcio's Runner Environment extension.
  const certificate = runner => Buffer.concat([Buffer.from('3082ffff', 'hex'), Buffer.from('060a2b0601040183bf30010b', 'hex'),
    Buffer.from([0x04, runner.length + 2, 0x0c, runner.length]), Buffer.from(runner), Buffer.from('3000', 'hex')]).toString('base64')
  const envelope = (doc, predicateType, predicate, digest = hex(doc), material = {}) => ({ attestations: [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
    { predicateType, bundle: { verificationMaterial: { tlogEntries: [{ logIndex: '42' }], ...material }, dsseEnvelope: { payload: Buffer.from(JSON.stringify({
      subject: [{ name: `pkg:npm/${doc.name.replace(/^@/u, '%40')}@${doc.version}`, digest: { sha512: digest } }], predicate })).toString('base64') } } },
  ] })
  // Its build's parameters long enough that the statement passes 2,048 characters, as one may.
  const v1 = { buildDefinition: { externalParameters: { workflow: { repository: 'https://github.com/org/repo', path: '.github/workflows/release.yml', ref: 'refs/tags/v1.0.0' } },
    internalParameters: { github: { event_name: 'push', repository_id: '1'.repeat(2000) } },
    resolvedDependencies: [{ uri: 'git+https://github.com/org/repo@refs/tags/v1.0.0', digest: { gitCommit: 'b'.repeat(40) } }] },
    runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' }, metadata: { invocationId: 'https://github.com/org/repo/actions/runs/7/attempts/1' } } }
  const v02 = { builder: { id: 'https://github.com/actions/runner' }, invocation: { configSource: { uri: 'git+https://github.com/org/repo@refs/heads/main', digest: { sha1: 'c'.repeat(40) },
    entryPoint: '.github/workflows/publish.yml' } }, metadata: { buildInvocationId: '9-2' } }
  // As npm writes GitLab's: its project with no ref, its job's URL as its run.
  const v02GitLab = { builder: { id: 'https://gitlab.com/group/project/-/runners/12345' },
    invocation: { configSource: { uri: 'git+https://gitlab.com/group/project', digest: { sha1: 'd'.repeat(40) }, entryPoint: 'publish' } },
    metadata: { buildInvocationId: 'https://gitlab.com/group/project/-/jobs/678' } }
  const asked = insights(t, { provenance: {
    'attested@1.0.0': envelope(pkg.doc, 'https://slsa.dev/provenance/v1', v1, undefined, { certificate: { rawBytes: certificate('github-hosted') } }),
    'attested-v02@1.0.0': envelope(old.doc, 'https://slsa.dev/provenance/v0.2', v02),
    'attested-gitlab@1.0.0': envelope(lab.doc, 'https://slsa.dev/provenance/v0.2', v02GitLab, undefined,
      { x509CertificateChain: { certificates: [{ rawBytes: certificate('self-hosted') }] } }),
    'forged@1.0.0': envelope(forged.doc, 'https://slsa.dev/provenance/v1', v1, '00'.repeat(64)),
    '@acme/attested@1.0.0': envelope(secret.doc, 'https://slsa.dev/provenance/v1', v1),
  } })
  const provenanceOf = async (name, who) => (await h.send(`/api/npm/provenance?name=${encodeURIComponent(name)}&version=1.0.0`, who)).json()
  assert.equal((await h.send(packagePath('attested', '1.0.0'))).json().manifest.provenance, true, 'its manifest says npm keeps provenance for it')
  assert.equal((await h.send(packagePath('unattested', '1.0.0'))).json().manifest.provenance, undefined)
  assert.ok(envelope(pkg.doc, 'https://slsa.dev/provenance/v1', v1).attestations[1].bundle.dsseEnvelope.payload.length > 2048)
  assert.deepEqual(await provenanceOf('attested'), { name: 'attested', version: '1.0.0', provenance: {
    repository: 'https://github.com/org/repo', commit: 'b'.repeat(40), workflow: '.github/workflows/release.yml', ref: 'refs/tags/v1.0.0',
    builder: 'https://github.com/actions/runner/github-hosted', run: 'https://github.com/org/repo/actions/runs/7/attempts/1', logIndex: 42, runner: 'github-hosted' } },
  'whose runner built it, as its certificate says')
  assert.deepEqual((await provenanceOf('attested-v02')).provenance, { repository: 'https://github.com/org/repo', commit: 'c'.repeat(40),
    workflow: '.github/workflows/publish.yml', ref: 'refs/heads/main', builder: 'https://github.com/actions/runner',
    run: 'https://github.com/org/repo/actions/runs/9/attempts/2', logIndex: 42, runner: null }, 'as SLSA v0.2 says it, its run GitHub\'s; no certificate, no runner')
  assert.deepEqual((await provenanceOf('attested-gitlab')).provenance, { repository: 'https://gitlab.com/group/project', commit: 'd'.repeat(40),
    workflow: 'publish', ref: null, builder: 'https://gitlab.com/group/project/-/runners/12345', run: 'https://gitlab.com/group/project/-/jobs/678', logIndex: 42,
    runner: 'self-hosted' }, 'as npm writes GitLab\'s: no ref, its job\'s URL its run; its runner from a certificate chain')
  assert.equal((await provenanceOf('forged')).provenance, null, 'a statement naming another tarball is not read')
  assert.equal((await provenanceOf('unattested')).provenance, null)
  assert.equal((await provenanceOf('@acme/attested', 'admin')).provenance, null, 'none for a private package')
  await provenanceOf('attested')
  const provenanceAsked = asked.filter(([what]) => what === 'provenance')
  assert.deepEqual(provenanceAsked.map(([, id]) => id).toSorted(), ['attested-gitlab@1.0.0', 'attested-v02@1.0.0', 'attested@1.0.0', 'forged@1.0.0'],
    'asked once each, kept; not about a version npm keeps none for, nor a private one')
  assert.ok(provenanceAsked.every(([, , auth]) => auth === null), 'asked without credentials')
})

test('Socket is never asked about a private package, whoever reads it', async t => {
  const h = await setup(t)
  withToken(t)
  registry(t, [{ ...packageOf('@acme/secret', '1.0.0', { 'index.js': '' }), private: true }])
  const asked = insights(t, {})
  assert.deepEqual((await h.send('/api/npm/socket?name=%40acme%2Fsecret&version=1.0.0', 'view')).json(), { error: 'package-not-found' })
  assert.deepEqual((await h.send('/api/npm/socket?name=%40acme%2Fsecret&version=1.0.0', 'admin')).json(), { name: '@acme/secret', version: '1.0.0', socket: null })
  assert.deepEqual(asked, [], 'its name never leaves for Socket')
})

test('OSV is never asked about a private package\'s risk, whoever reads it, as a public one\'s is', async t => {
  const h = await setup(t)
  withToken(t)
  const calls = registry(t, [{ ...packageOf('@acme/secret', '1.0.0', { 'package.json': '{}' }), private: true }, packageOf('@pub/open', '1.0.0', { 'package.json': '{}' })])
  for (const name of ['@acme/secret', '@pub/open']) assert.equal((await h.send(`/api/npm/risk?${new URLSearchParams({ name, version: '1.0.0' })}`, 'admin')).status, 200, name)
  assert.deepEqual(calls.filter(({ url }) => url === OSV).length, 1, 'its name never leaves for OSV, the public one\'s does')
})

test('a repository advisory\'s range with no upper bound ends below the version GitHub names as patched', async t => {
  const h = await setup(t)
  const pkg = packageOf('patched', '5.0.3', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/patched.git' } })
  registry(t, [{ ...pkg, versions: ['4.1.10', '4.1.11', '5.0.0-beta.1', '5.0.0-rc.2', '5.0.3'] }])
  insights(t, {
    repos: { 'org/patched': { full_name: 'org/patched', private: false, visibility: 'public' } },
    repoAdvisories: { 'org/patched': [{ ghsa_id: 'GHSA-82fw-gwwq-j7x9', state: 'published', summary: 'Path traversal', severity: 'medium', cwe_ids: [],
      vulnerabilities: [
        { package: { ecosystem: 'npm', name: 'patched' }, vulnerable_version_range: '>= 2.1.0, < 4.1.11', patched_versions: '4.1.11' },
        { package: { ecosystem: 'npm', name: 'patched' }, vulnerable_version_range: '>= 5.0.0-beta.1', patched_versions: '5.0.0-rc.2' },
      ] }] },
  })
  const body = (await h.send('/api/npm/advisories?name=patched')).json()
  assert.deepEqual(body.versions, ['5.0.3', '5.0.0-rc.2', '5.0.0-beta.1', '4.1.11', '4.1.10'])
  assert.deepEqual(body.advisories.map(({ range, affected }) => [range, affected.map(at => body.versions[at])]),
    [['>= 2.1.0, < 4.1.11 || >= 5.0.0-beta.1, < 5.0.0-rc.2', ['5.0.0-beta.1', '4.1.10']]], '5.0.3 and the patched versions are not affected')
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

test('where GitHub refuses the listing, or can\'t say whether the repository is public, its listing as last kept is shown, however old', async t => {
  const h = await setup(t)
  const names = ['kept-a', 'kept-b', 'kept-c', 'kept-d']
  registry(t, names.map(name => packageOf(name, '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/org/kept.git' } })))
  const repos = { 'org/kept': { full_name: 'org/kept', private: false, visibility: 'public' } }
  const repoAdvisories = { 'org/kept': [{ ghsa_id: 'GHSA-gggg-hhhh-jjjj', state: 'published', summary: 'Unreviewed', severity: 'high', cwe_ids: [],
    vulnerabilities: names.map(name => ({ package: { ecosystem: 'npm', name }, vulnerable_version_range: '< 2.0.0' })) }] }
  const asked = insights(t, { repos, repoAdvisories })
  const listings = () => asked.filter(([what]) => what === 'repository').length
  const ids = body => body.advisories.map(row => `${row.source} ${row.id}`)
  const fresh = (await h.send('/api/npm/advisories?name=kept-a')).json()
  assert.deepEqual([fresh.repository, fresh.keptAt, ids(fresh)], [true, undefined, ['repository GHSA-gggg-hhhh-jjjj']])
  // Three hours on, past the 90 minutes upstream takes a listing for, GitHub refuses it.
  const at = Date.now() - 3 * 60 * 60_000, key = 'github/advisories/org/kept'
  await h.db.setUpstreamCacheEntry(key, JSON.stringify({ ...JSON.parse(await h.db.getUpstreamCacheEntry(key)), at }), Date.now())
  const refuse = () => { repoAdvisories['org/kept'] = Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) }
  refuse()
  const refused = (await h.send('/api/npm/advisories?name=kept-b')).json()
  assert.deepEqual([refused.repository, refused.keptAt, ids(refused)], [true, new Date(at).toISOString(), ['repository GHSA-gggg-hhhh-jjjj']])
  assert.equal(listings(), 2, 'GitHub refusing it once, the kept listing is taken without asking again')
  assert.equal(JSON.parse(await h.db.getUpstreamCacheEntry(key)).at, at, 'and left as it was kept')
  refuse()
  assert.equal((await h.send('/api/npm/advisories?name=kept-b')).json().keptAt, new Date(at).toISOString())
  assert.equal(listings(), 3, 'such a list isn\'t kept: GitHub is asked again next time')
  // GitHub's answer for the repository fails: it can't be told public.
  t.mock.method(globalThis, 'fetch', ((fetch) => (input, init) => String(input) === 'https://api.github.com/repos/org/kept' && repos['org/kept'].visibility === 'public'
    ? Promise.resolve(Response.json({ message: 'Server Error' }, { status: 500 })) : fetch(input, init))(globalThis.fetch))
  const untold = (await h.send('/api/npm/advisories?name=kept-c')).json()
  assert.deepEqual([untold.repository, untold.keptAt, ids(untold)], [true, new Date(at).toISOString(), ['repository GHSA-gggg-hhhh-jjjj']])
  assert.equal(listings(), 3)
  // GitHub says it isn't public: its kept listing is never taken.
  Object.assign(repos['org/kept'], { private: true, visibility: 'private' })
  const hidden = (await h.send('/api/npm/advisories?name=kept-d')).json()
  assert.deepEqual([hidden.repository, hidden.keptAt, ids(hidden)], [true, undefined, []])
  assert.equal(listings(), 3)
})

test('where npm\'s audit fails, advisories and risk answer 502 with its code alone, and log why', async t => {
  const h = await setup(t)
  registry(t, [packageOf('unlogged', '1.0.0', { 'package.json': '{}', 'index.js': '' }, { dependencies: {} })])
  insights(t, {})
  t.mock.method(globalThis, 'fetch', ((fetch) => (input, init) => String(input) === `${REGISTRY}/-/npm/v1/security/advisories/bulk`
    ? Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })) : fetch(input, init))(globalThis.fetch))
  const logged = t.mock.method(console, 'error', () => {}), warned = t.mock.method(console, 'warn', () => {})
  const advisories = await h.send('/api/npm/advisories?name=unlogged')
  assert.deepEqual([advisories.status, advisories.json()], [502, { error: 'upstream-unavailable' }])
  const [label, cause] = warned.mock.calls.at(-1).arguments
  assert.equal(label, 'managed: advisories failed:')
  assert.match(cause, /503/u, 'upstream\'s message, npm\'s answer in it')
  const risk = await h.send('/api/npm/risk?name=unlogged&version=1.0.0')
  assert.deepEqual([risk.status, risk.json()], [502, { error: 'upstream-unavailable' }], 'what the reader is told is the code')
  assert.equal(logged.mock.calls.at(-1).arguments[0], 'managed: npm risk failed (upstream-unavailable):')
  assert.match(logged.mock.calls.at(-1).arguments[1], /^advisories of unlogged@1\.0\.0 couldn't be had: /u, 'the logs say why')
  logged.mock.resetCalls()
  assert.equal((await h.send('/api/npm/risk?name=unlogged&version=9.9.9')).status, 404)
  assert.equal(logged.mock.callCount(), 0, 'nor one the reader asked for wrong')
})

test('a kept listing asks GitHub nothing: where npm\'s audit fails, it isn\'t asked a third time, and where upstream won\'t take the listing, npm\'s are alone', async t => {
  const h = await setup(t)
  const names = { unaudited: 'org/unaudited', outdated: 'org/outdated' }
  registry(t, Object.entries(names).map(([name, repo]) => packageOf(name, '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: `git+https://github.com/${repo}.git` } })))
  const at = Date.now() - 3 * 60 * 60_000
  // Kept as upstream keeps a listing, but for `outdated` one kept differently, which upstream won't take.
  for (const [name, repo] of Object.entries(names)) {
    await h.db.setUpstreamCacheEntry(`github/advisories/${repo}`, JSON.stringify({ at, name: repo, v: name === 'outdated' ? 1 : 2, advisories: [] }), at)
  }
  const refused = () => Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
  const repoAdvisories = {}
  const asked = insights(t, { repos: Object.fromEntries(Object.values(names).map(repo => [repo, { full_name: repo, private: false, visibility: 'public' }])), repoAdvisories,
    advisories: { outdated: [{ id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Reviewed', severity: 'low', vulnerable_versions: '*', cwe: [] }] } })
  const audits = []
  t.mock.method(globalThis, 'fetch', ((fetch) => (input, init) => {
    if (String(input) !== `${REGISTRY}/-/npm/v1/security/advisories/bulk`) return fetch(input, init)
    const [name] = Object.keys(JSON.parse(init.body))
    audits.push(name)
    return name === 'unaudited' ? Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })) : fetch(input, init)
  })(globalThis.fetch))
  repoAdvisories['org/unaudited'] = refused()
  assert.equal((await h.send('/api/npm/advisories?name=unaudited')).status, 502)
  assert.deepEqual(audits, ['unaudited', 'unaudited'], 'with its repository\'s, then with the kept listing, and no more')
  repoAdvisories['org/outdated'] = refused()
  const alone = (await h.send('/api/npm/advisories?name=outdated')).json()
  assert.deepEqual([alone.repository, alone.keptAt, alone.advisories.map(row => row.id)], [false, undefined, ['GHSA-aaaa-bbbb-cccc']])
  assert.deepEqual(audits.slice(2), ['outdated', 'outdated', 'outdated'], 'its kept listing not taken, npm\'s are asked for alone')
  assert.deepEqual(asked.filter(([what]) => what === 'repository').map(([, repo]) => repo), ['org/outdated'], 'GitHub asked for a listing only once npm answered, and only by the reader\'s audit')
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

test('a repository renamed or transferred is followed once, by its id, to its name now: its figures, and its listing asked under that name', async t => {
  const h = await setup(t)
  const pkg = packageOf('moved', '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: 'git+https://github.com/old/name.git' } })
  registry(t, [pkg])
  const asked = insights(t, {
    repos: {
      'old/name': { location: 'https://api.github.com/repositories/1' },
      'new/name': { id: 1, full_name: 'new/name', private: false, visibility: 'public', stargazers_count: 40, forks_count: 2, open_issues_count: 3, archived: false, pushed_at: '2026-09-01T00:00:00Z', pulls: 1 },
    },
    repoAdvisories: { 'new/name': [{ ghsa_id: 'GHSA-gggg-hhhh-jjjj', state: 'published', summary: 'Unreviewed', severity: 'high', cwe_ids: [],
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'moved' }, vulnerable_version_range: '< 2.0.0' }] }] },
  })
  assert.deepEqual((await h.send('/api/npm/stats?name=moved')).json().github,
    { repo: 'new/name', stars: 40, forks: 2, openIssues: 3, openPulls: 1, archived: false, pushedAt: '2026-09-01T00:00:00Z' })
  assert.deepEqual(asked.filter(([what]) => what === 'github' || what === 'pulls'),
    [['github', 'old/name', null], ['github', 'repositories/1', null], ['pulls', 'new/name', null]], 'then by its id, and by its name now')
  const body = (await h.send('/api/npm/advisories?name=moved')).json()
  assert.equal(body.repository, true)
  assert.deepEqual(body.advisories.map(row => [row.source, row.url]), [['repository', 'https://github.com/new/name/security/advisories/GHSA-gggg-hhhh-jjjj']])
  assert.deepEqual(asked.filter(([what]) => what === 'repository'), [['repository', 'new/name', null]], 'its listing asked under its name now')
  assert.ok(await h.db.getUpstreamCacheEntry('github/advisories/new/name'), 'and kept so')
})

test('a redirect to a repository that isn\'t public, anywhere but a repository by its id on GitHub\'s API, or on again, leaves no figures, and npm\'s advisories alone', async t => {
  const h = await setup(t)
  const names = { 'moved-private': 'old/private', 'moved-elsewhere': 'old/elsewhere', 'moved-twice': 'old/twice' }
  const calls = registry(t, Object.entries(names).map(([name, repo]) => packageOf(name, '1.0.0', { 'index.js': '' }, { repository: { type: 'git', url: `git+https://github.com/${repo}.git` } })))
  const reviewed = [{ id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Reviewed', severity: 'low', vulnerable_versions: '*', cwe: [] }]
  const listing = name => [{ ghsa_id: 'GHSA-xxxx-yyyy-zzzz', state: 'published', summary: 'Moved', severity: 'high', cwe_ids: [],
    vulnerabilities: [{ package: { ecosystem: 'npm', name }, vulnerable_version_range: '< 2.0.0' }] }]
  const asked = insights(t, {
    repos: {
      'old/private': { location: 'https://api.github.com/repositories/1' },
      'new/private': { id: 1, full_name: 'new/private', private: true, visibility: 'private', stargazers_count: 9 },
      'old/elsewhere': { location: 'https://example.com/repositories/2', status: 307 },
      'old/twice': { location: 'https://api.github.com/repositories/3' },
      'new/twice': { id: 3, location: 'https://api.github.com/repositories/4' },
      'newer/twice': { id: 4, full_name: 'newer/twice', private: false, visibility: 'public', stargazers_count: 9 },
    },
    advisories: Object.fromEntries(Object.keys(names).map(name => [name, reviewed])),
    repoAdvisories: { 'new/private': listing('moved-private'), 'newer/twice': listing('moved-twice') },
  })
  for (const name of Object.keys(names)) {
    assert.equal((await h.send(`/api/npm/stats?name=${name}`)).json().github, null, name)
    const body = (await h.send(`/api/npm/advisories?name=${name}`)).json()
    assert.deepEqual([body.repository, body.advisories.map(row => row.id)], [true, ['GHSA-aaaa-bbbb-cccc']], `${name}: there is no public repository to ask`)
  }
  assert.deepEqual(asked.filter(([what]) => what === 'github').map(([, repo]) => repo), [
    'old/private', 'repositories/1', 'old/private', 'repositories/1', 'old/elsewhere', 'old/elsewhere', 'old/twice', 'repositories/3', 'old/twice', 'repositories/3',
  ], 'for its figures, then afresh for its advisories, a second redirect never followed')
  assert.ok(!calls.some(call => call.url.startsWith('https://example.com/')), 'nor one off GitHub\'s API')
  assert.equal(asked.filter(([what]) => what === 'repository').length, 0, 'no listing asked for')
})

test('a redirect is followed with the reader\'s token where GitHub takes it, and without where it refuses it', async t => {
  registry(t, [])
  const repos = { 'new/tokened': { id: 5, full_name: 'new/tokened', private: false, visibility: 'public', stargazers_count: 5 } }
  for (const repo of ['old/tokened', 'old/revoked']) repos[repo] = { location: 'https://api.github.com/repositories/5' }
  const asked = insights(t, { repos })
  t.mock.method(globalThis, 'fetch', ((fetch) => (input, init = {}) => new Headers(init.headers).get('authorization') === 'Bearer revoked'
    ? Promise.resolve(Response.json({ message: 'Bad credentials' }, { status: 401 })) : fetch(input, init))(globalThis.fetch))
  assert.equal((await npmGithubStats('old/tokened', () => Promise.resolve('user-token')))?.repo, 'new/tokened')
  assert.equal((await npmGithubStats('old/revoked', () => Promise.resolve('revoked')))?.repo, 'new/tokened')
  assert.deepEqual(asked.filter(([what]) => what === 'github'), [
    ['github', 'old/tokened', 'Bearer user-token'], ['github', 'repositories/5', 'Bearer user-token'],
    ['github', 'old/revoked', null], ['github', 'repositories/5', null],
  ])
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

test('a GitLab project a package names as its repository is kept, in any form npm takes, for its provenance to be matched with', () => {
  const gitlab = repository => npmManifest({ repository }).gitlab ?? null
  for (const [repository, project] of [
    ['gitlab:group/project', 'group/project'], ['git@gitlab.com:group/sub/project.git', 'group/sub/project'],
    ['git+https://gitlab.com/group/project.git', 'group/project'], [{ type: 'git', url: 'git+ssh://git@gitlab.com/Group/Project.git' }, 'Group/Project'],
    ['https://gitlab.com/group/project/-/tree/main/packages/x', 'group/project'],
    ['https://github.com/org/repo', null], ['https://gitlab.com/group', null], ['https://gitlab.com/../x', null], ['https://gitlab.example.com/a/b', null], [3, null],
  ]) assert.equal(gitlab(repository), project, JSON.stringify(repository))
})

test('a CI npm trusts to publish is named as npm names it, never as an account', () => {
  const manifest = npmManifest({ _npmUser: { name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com', trustedPublisher: { id: 'github', oidcConfigId: 'oidc:1' } } })
  assert.equal(manifest.trustedPublisher, 'GitHub Actions')
  assert.equal(manifest.publisher, undefined)
  assert.equal(npmManifest({ _npmUser: { name: 'Not An Account', email: 'x@example.com' } }).trustedPublisher, undefined, 'only where npm says it trusted it')
  assert.equal(npmManifest({ _npmUser: { name: 'alice', email: 'a@example.com', trustedPublisher: { id: 'github' } } }).trustedPublisher, undefined, 'an account is named as one')
})

test('the accounts known to publish one of npm\'s most downloaded packages are named so, whatever their case', () => {
  const known = json => npmManifest(json).knownAccounts ?? []
  assert.deepEqual(known({ author: 'Sindre <s@example.com>', _npmUser: { name: 'sindresorhus', email: 's@example.com' } }), ['sindresorhus'], 'once, both author and publisher')
  assert.deepEqual(known({ _npmUser: { name: 'LJHarb', email: 'l@example.com' } }), ['LJHarb'])
  assert.deepEqual(known({ _npmUser: { name: 'someone-new-0000', email: 'n@example.com' } }), [])
  assert.deepEqual(known({ author: 'Sindre <s@example.com>', _npmUser: { name: 'someone-new-0000', email: 'n@example.com' },
    maintainers: [{ name: 'sindresorhus', email: 's@example.com' }] }), ['sindresorhus'], 'its author\'s account alone, published by another')
})

test('an author is named, with their npm account where the publisher or a maintainer is them, and no email kept', () => {
  const people = json => { const { author, authorAccount, publisher } = npmManifest(json); return { author, authorAccount, publisher } }
  const maintainers = [{ name: 'substack', email: 'mail@substack.net' }, { name: 'maxogden', email: 'max@example.com' }]
  assert.deepEqual(people({ author: 'James Halliday <mail@substack.net> (http://substack.net)', _npmUser: { name: 'maxogden', email: 'max@example.com' }, maintainers }),
    { author: 'James Halliday', authorAccount: 'substack', publisher: 'maxogden' }, 'a maintainer by their email, published by another')
  assert.deepEqual(people({ author: 'substack', _npmUser: { name: 'maxogden', email: 'max@example.com' }, maintainers }),
    { author: 'substack', authorAccount: 'substack', publisher: 'maxogden' }, 'a maintainer by their account\'s name')
  assert.deepEqual(people({ author: { name: 'Max', email: 'MAX@example.com' }, _npmUser: { name: 'maxogden', email: 'max@example.com' } }),
    { author: 'Max', authorAccount: 'maxogden', publisher: 'maxogden' }, 'the publisher, emails told apart regardless of case')
  assert.deepEqual(people({ author: 'Someone Else', _npmUser: { name: 'maxogden', email: 'max@example.com' }, maintainers }),
    { author: 'Someone Else', authorAccount: undefined, publisher: 'maxogden' }, 'no account where none is theirs')
  assert.ok(!JSON.stringify(npmManifest({ author: 'A <a@example.com>', _npmUser: { name: 'a', email: 'a@example.com' }, maintainers })).includes('@example.com'))
})
