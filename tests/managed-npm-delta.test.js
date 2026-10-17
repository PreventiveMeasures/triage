// The lines a version changes against another, or against none, a whole
// package's (GET /api/npm/delta, server-managed/npm-delta.ts): added and
// removed, of its text files, as git's --numstat counts them, and, where
// some declaration files changed in types alone, those of the rest; kept by
// both sides' integrities, each version's access checked as it is asked.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { packageOf, registry, withToken } from './_managed-npm.js'

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
  return async (path, who = 'triage') => {
    const session = sessions[who]
    const req = Object.assign(Readable.from([]), { url: path, method: 'GET', headers: session ? { cookie: session.setCookie.split(';')[0] } : {} })
    // ServerResponse exposes Node's EventEmitter contract.
    // eslint-disable-next-line unicorn/prefer-event-target
    const res = Object.assign(new EventEmitter(), { status: 0, headers: {}, body: '', setTimeout() {},
      writeHead(status, headers) { this.status = status; this.headers = headers }, end(value) { this.body = JSON.parse(value); this.writableEnded = true } })
    await handler(req, res)
    return res
  }
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
  assert.deepEqual(res.body, { name: 'lib', version: '1.1.0', otherVersion: '1.0.0', additions: 3, deletions: 2, typeless: { additions: 2, deletions: 1 } },
    'the script\'s two and one, the declaration file\'s apart, the binary\'s none')
  assert.deepEqual((await send(delta('lib', '1.1.0', '(empty)'))).body, { name: 'lib', version: '1.1.0', otherVersion: null, additions: 5, deletions: 0,
    typeless: { additions: 4, deletions: 0 } }, 'its whole package\'s, an added declaration file holding types alone apart')
  assert.deepEqual((await send(delta('plain', '2.0.0', '1.0.0'))).body.typeless, null, 'none apart where no declaration file changed so')

  const tarballs = () => calls.filter(call => call.url.endsWith('.tgz')).length
  const read = tarballs()
  assert.equal((await send(delta('lib', '1.1.0', '1.0.0'))).body.additions, 3)
  assert.equal(tarballs(), read, 'kept: neither tarball read again')

  assert.equal((await send(delta('@corp/lib', '1.1.0', '(empty)'))).status, 404, 'a reader without private access gets nothing')
  assert.equal((await send(delta('@corp/lib', '1.1.0', '(empty)'), 'admin')).body.additions, 5)
  assert.equal((await send(delta('lib', '1.1.0', ''))).status, 400)
  assert.equal((await send(delta('lib', '1.1.0', '1.0.0'), null)).status, 401)
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
