// The lines a version changes against another, or against none, a whole
// package's (GET /api/npm/delta, server-managed/npm-delta.ts): added and
// removed, of its text files, as git's --numstat counts them, and, where
// some declaration files changed in types alone, those of the rest; whether
// a binary file changed; kept by both sides' integrities, each version's
// access checked as it is asked.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { packageOf, registry, withToken } from './_managed-npm.js'
import { readLines } from './_managed-lines.js'

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const config = { sessionCookieName: 'sid', sessionTtlMs: 3600000 }
  const sessions = {}
  for (const [i, role] of ['admin', 'triage'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    sessions[role] = session
  }
  const handler = createManagedRequestHandler({ db, config, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  // A streamed answer's lines, off a real listener.
  const lines = (path, who = 'triage') => readLines(t, handler, path, sessions[who]?.setCookie.split(';')[0])
  return Object.assign(async (path, who = 'triage') => {
    const session = sessions[who]
    const req = Object.assign(Readable.from([]), { url: path, method: 'GET', headers: session ? { cookie: session.setCookie.split(';')[0] } : {} })
    // ServerResponse exposes Node's EventEmitter contract.
    // eslint-disable-next-line unicorn/prefer-event-target
    const res = Object.assign(new EventEmitter(), { status: 0, headers: {}, body: '', setTimeout() {},
      writeHead(status, headers) { this.status = status; this.headers = headers }, end(value) { this.body = JSON.parse(value); this.writableEnded = true } })
    await handler(req, res)
    return res
  }, { lines })
}
const delta = (name, version, otherVersion) => `/api/npm/delta?${new URLSearchParams({ name, version, otherVersion })}`

// Two versions: a script changed, a declaration file changed in types alone,
// one the same, and a binary changed.
const versions = [
  { 'index.js': 'a\nb\n', 'types/index.d.ts': 'export interface A { a: string }\n', 'README.md': 'x\n', 'logo.bin': Buffer.from([0, 1]) },
  { 'index.js': 'a\nc\nd\n', 'types/index.d.ts': 'export interface A { a: number }\n', 'README.md': 'x\n', 'logo.bin': Buffer.from([0, 2]) },
]

test('a version\'s lines against another, and those but for declaration files changed in types alone; against none, its whole package\'s; kept, a private one\'s to its readers', async t => {
  const send = await fixture(t)
  withToken(t)
  const calls = registry(t, [packageOf('lib', '1.0.0', versions[0]), packageOf('lib', '1.1.0', versions[1]), packageOf('plain', '1.0.0', { 'a.js': 'a\n' }),
    packageOf('plain', '2.0.0', { 'a.js': 'b\n' }), { ...packageOf('@corp/lib', '1.1.0', versions[1]), private: true }])
  const res = await send(delta('lib', '1.1.0', '1.0.0'))
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { name: 'lib', version: '1.1.0', otherVersion: '1.0.0', additions: 3, deletions: 2, typeless: { additions: 2, deletions: 1 },
    binary: true }, 'the script\'s two and one, the declaration file\'s apart, the binary\'s none, told it changed')
  assert.deepEqual((await send(delta('lib', '1.1.0', '(empty)'))).body, { name: 'lib', version: '1.1.0', otherVersion: null, additions: 5, deletions: 0,
    typeless: { additions: 4, deletions: 0 }, binary: true }, 'its whole package\'s, an added declaration file holding types alone apart')
  const plain = (await send(delta('plain', '2.0.0', '1.0.0'))).body
  assert.deepEqual([plain.typeless, plain.binary], [null, false], 'none apart where no declaration file changed so, nor binary where none is')

  const tarballs = () => calls.filter(call => call.url.endsWith('.tgz')).length
  const read = tarballs()
  assert.equal((await send(delta('lib', '1.1.0', '1.0.0'))).body.additions, 3)
  assert.equal(tarballs(), read, 'kept: neither tarball read again')

  assert.equal((await send(delta('@corp/lib', '1.1.0', '(empty)'))).status, 404, 'a reader without private access gets nothing')
  assert.equal((await send(delta('@corp/lib', '1.1.0', '(empty)'), 'admin')).body.additions, 5)
  assert.equal((await send(delta('lib', '1.1.0', ''))).status, 400)
  assert.equal((await send(delta('lib', '1.1.0', '1.0.0'), null)).status, 401)
})

// Several versions' lines in one request (GET /api/npm/deltas), as a list's
// rows near the viewport ask for them together.
const deltas = asked => `/api/npm/deltas?${new URLSearchParams({ versions: JSON.stringify(asked) })}`
const byAsked = lines => Object.fromEntries(lines.map(line => [`${line.name}@${line.version} ${line.otherVersion}`, line]))

test('several versions\' lines in one request, each as GET delta answers it, as lines as each is counted; a private one\'s to its readers alone; fifty at most', async t => {
  const send = await fixture(t)
  withToken(t)
  registry(t, [packageOf('lib', '1.0.0', versions[0]), packageOf('lib', '1.1.0', versions[1]), { ...packageOf('@corp/lib', '1.1.0', versions[1]), private: true }])
  const asked = [['lib', '1.1.0', '1.0.0'], ['lib', '1.1.0', '(empty)'], ['@corp/lib', '1.1.0', '(empty)'], ['lib', '9.9.9', '1.0.0']]
  // Each as GET delta answers it, of the version asked against.
  const alone = async ([name, version, otherVersion], who) => {
    const res = await send(delta(name, version, otherVersion), who)
    return res.status === 200 ? { ...res.body, otherVersion } : { name, version, otherVersion, error: res.body.error, status: res.status }
  }
  const answer = await send.lines(deltas(asked))
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'application/x-ndjson')
  assert.ok(answer.ended)
  assert.deepEqual(byAsked(answer.lines), byAsked(await Promise.all(asked.map(one => alone(one)))), 'each as one asked alone, one of no such version refused')
  assert.deepEqual(byAsked(answer.lines)['@corp/lib@1.1.0 (empty)'], { name: '@corp/lib', version: '1.1.0', otherVersion: '(empty)', error: 'package-not-found', status: 404 },
    'a private one refused a reader without access to it')
  const admin = byAsked((await send.lines(deltas(asked), 'admin')).lines)
  assert.deepEqual(admin['@corp/lib@1.1.0 (empty)'], await alone(asked[2], 'admin'), 'counted for one with it')
  assert.equal(admin['@corp/lib@1.1.0 (empty)'].additions, 5)

  assert.equal((await send.lines(deltas(Array.from({ length: 50 }, (_, at) => ['lib', '1.1.0', at % 2 ? '1.0.0' : '(empty)'])))).lines.length, 50, 'fifty at once')
  assert.equal((await send.lines(deltas(Array.from({ length: 51 }, () => asked[0])))).status, 400, 'no more')
  for (const bad of ['/api/npm/deltas', '/api/npm/deltas?versions=x', deltas([]), deltas([['lib', '1.1.0']]), deltas([['lib', '1.1.0', '']]), deltas([['Not A Name', '1.0.0', '(empty)']])]) {
    assert.deepEqual([(await send.lines(bad)).status, (await send(bad)).body], [400, { error: 'bad-package' }], bad)
  }
  assert.equal((await send.lines(deltas(asked), null)).status, 401)
})

test('a binary file added, removed or changed is told of, one moved as it was not; one kept before binary files were told of worked out again', async () => {
  const { npmDelta } = await import('../server-managed/npm-delta.ts')
  const side = (integrity, files) => ({ integrity, files: () => Promise.resolve(Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) }))) })
  const icon = [0, 3], logo = [0, 1, 2]
  const base = side('sha512-bin-base', { 'a.js': 'a\n', 'logo.png': logo, 'icon.png': icon })
  const binary = async (integrity, files) => (await npmDelta(base, side(integrity, files))).binary
  assert.equal(await binary('sha512-bin-moved', { 'a.js': 'b\n', 'img/logo.png': logo, 'img/icon.png': icon }), false, 'moved as they were')
  assert.equal(await binary('sha512-bin-swapped', { 'a.js': 'a\n', 'logo.png': icon, 'icon.png': logo }), false, 'each where the other was')
  assert.equal(await binary('sha512-bin-changed', { 'a.js': 'a\n', 'logo.png': [0, 1, 3], 'icon.png': icon }), true)
  assert.equal(await binary('sha512-bin-removed', { 'a.js': 'a\n', 'logo.png': logo }), true)
  assert.equal(await binary('sha512-bin-added', { 'a.js': 'a\n', 'logo.png': logo, 'icon.png': icon, 'font.woff': [0, 4] }), true)
  assert.equal(await binary('sha512-bin-copied', { 'a.js': 'a\n', 'logo.png': logo, 'copy.png': logo }), true, 'one in place of another the same as a third')
  // Many moved, each to where another was, matched by their digests.
  const many = Array.from({ length: 5000 }, (_, at) => [0, at >> 8, at & 255])
  const manyBase = side('sha512-bin-many', Object.fromEntries(many.map((bytes, at) => [`a/${at}.bin`, bytes])))
  const reversed = side('sha512-bin-reversed', Object.fromEntries(many.map((bytes, at) => [`b/${many.length - 1 - at}.bin`, bytes])))
  assert.equal((await npmDelta(manyBase, reversed)).binary, false)
  const written = []
  const kept = { read: () => Promise.resolve({ value: { additions: 1, deletions: 0, typeless: null } }), write: (key, value) => { written.push(value); return Promise.resolve() } }
  const told = await npmDelta(null, side('sha512-bin-old', { 'a.js': 'a\n', 'logo.png': logo }), kept)
  assert.deepEqual([told.binary, written.map(value => value.binary)], [true, [true]], 'one kept before worked out again, and kept so')
})

test('a delta\'s files are read only once its turn comes, two at a time, and one asked again meanwhile shares the first\'s', async () => {
  const { npmDelta } = await import('../server-managed/npm-delta.ts')
  const read = []
  const held = []
  const side = (integrity, text, hold = false) => ({ integrity, files: () => {
    read.push(integrity)
    const files = [{ path: 'index.js', bytes: Buffer.from(text) }]
    return hold ? new Promise(resolve => { held.push(() => resolve(files)) }) : Promise.resolve(files)
  } })
  const first = npmDelta(null, side('sha512-one', 'a\n', true))
  const again = npmDelta(null, side('sha512-one', 'a\n', true))
  const second = npmDelta(null, side('sha512-two', 'a\nb\n', true))
  const third = npmDelta(null, side('sha512-three', 'a\nb\nc\n'))
  await new Promise(resolve => { setTimeout(resolve, 20) })
  assert.deepEqual(read, ['sha512-one', 'sha512-two'], 'the third\'s files not read while two are counted, nor the first\'s twice')
  for (const release of held) release()
  assert.deepEqual(await Promise.all([first, again, second, third]).then(answers => answers.map(answer => answer.additions)), [1, 1, 2, 3])
  assert.deepEqual(read, ['sha512-one', 'sha512-two', 'sha512-three'])
})

test('a delta holds its turn till both sides\' files are read, though one fails first', async () => {
  const { npmDelta } = await import('../server-managed/npm-delta.ts')
  const read = []
  const releases = []
  const held = name => () => { read.push(name); return new Promise(resolve => { releases.push(() => resolve([{ path: 'index.js', bytes: Buffer.from('a\n') }])) }) }
  const failing = npmDelta({ integrity: 'sha512-fail-base', files: () => { read.push('fail-base'); return Promise.reject(new Error('gone')) } },
    { integrity: 'sha512-fail-other', files: held('fail-other') })
  const busy = npmDelta(null, { integrity: 'sha512-busy', files: held('busy') })
  const waiting = npmDelta(null, { integrity: 'sha512-waiting', files: held('waiting') })
  await new Promise(resolve => { setTimeout(resolve, 20) })
  assert.deepEqual(read, ['fail-base', 'fail-other', 'busy'], 'the third waits, the first\'s other side still read')
  releases[0]()
  await assert.rejects(failing, /gone/u)
  await new Promise(resolve => { setTimeout(resolve, 20) })
  assert.deepEqual(read, ['fail-base', 'fail-other', 'busy', 'waiting'], 'its turn given up once both are')
  for (const release of releases.slice(1)) release()
  await new Promise(resolve => { setTimeout(resolve, 20) })
  for (const release of releases.slice(2)) release()
  await Promise.all([busy, waiting])
})

test('a delta asked again while where it is kept is still being looked in shares the first\'s look and work, even where its own look would have ended after that work', async () => {
  const { npmDelta } = await import('../server-managed/npm-delta.ts')
  const [looks, read] = [[], []]
  const kept = { read() { return new Promise(resolve => { looks.push(resolve) }) }, write: () => Promise.resolve() }
  const side = { integrity: 'sha512-four', files() { read.push('sha512-four'); return Promise.resolve([{ path: 'index.js', bytes: Buffer.from('a\n') }]) } }
  const [first, again] = [npmDelta(null, side, kept), npmDelta(null, side, kept)]
  looks[0](null)
  assert.equal((await first).additions, 1)
  looks[1]?.(null)
  assert.equal((await again).additions, 1)
  assert.deepEqual([looks.length, read], [1, ['sha512-four']], 'looked for once, its files read once')
})
