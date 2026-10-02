import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { BUNDLE_BUILD_TIMEOUT_MS } from '../server-managed/bundle-build-leases.ts'
import { withBundleBuildLease } from '../server-managed/bundle-build.ts'
import { checkBundleBuildLeases } from './_managed-bundle-build-leases.js'

test('SQLite build leases coordinate separate instances, recover crashes, and survive reopening', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-build-leases-'))
  const file = join(dir, 'data.db')
  const db = openSqliteManagedDb(file), peer = openSqliteManagedDb(file), raw = new DatabaseSync(file)
  t.after(async () => { await db.close(); await peer.close(); raw.close(); await rm(dir, { recursive: true, force: true }) })
  await checkBundleBuildLeases(db, peer, owner => raw.prepare('UPDATE managed_bundle_build_lease SET expires_at = 0 WHERE owner = ?').run(owner))
  assert.equal(await db.claimBundleBuildLease('user-a', 'persisted'), true)
  const reopened = openSqliteManagedDb(file)
  try { assert.equal(await reopened.claimBundleBuildLease('user-a', 'new-owner'), false) } finally { await reopened.close() }
  const { expires_at: expires, now } = raw.prepare("SELECT expires_at, CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now FROM managed_bundle_build_lease").get()
  assert.ok(expires - now > BUNDLE_BUILD_TIMEOUT_MS && expires - now <= BUNDLE_BUILD_TIMEOUT_MS + 60_000)
})

test('SQLite existing databases acquire the lease table on startup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-build-upgrade-')), file = join(dir, 'data.db')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const original = openSqliteManagedDb(file)
  await original.close()
  const raw = new DatabaseSync(file)
  raw.exec('DROP TABLE managed_bundle_build_lease'); raw.close()
  const upgraded = openSqliteManagedDb(file)
  try { assert.equal(await upgraded.claimBundleBuildLease('user', 'owner'), true) } finally { await upgraded.close() }
})

test('shared admission fails closed for capacity, database errors, and unknown claim outcomes', async () => {
  for (const claim of [() => false, () => { throw new Error('connection lost after COMMIT') }]) {
    const db = { claimBundleBuildLease: claim, releaseBundleBuildLease: () => assert.fail('an unknown claim expires instead') }
    await assert.rejects(withBundleBuildLease(db, 'user', new AbortController().signal, () => assert.fail('no upstream work without admission')))
  }
})

test('shared admission releases only its own lease after success or failure', async () => {
  for (const fail of [false, true]) {
    let finished = false, owner, released = false
    const db = {
      claimBundleBuildLease(user, id) { assert.equal(user, 'user'); owner = id; return true },
      releaseBundleBuildLease(id) { assert.equal(id, owner); assert.equal(finished, true); released = true },
    }
    const work = withBundleBuildLease(db, 'user', new AbortController().signal, () => {
      finished = true
      if (fail) throw new Error('upstream failure')
      return Promise.resolve('bundle')
    })
    if (fail) await assert.rejects(work, /upstream failure/u)
    else assert.equal(await work, 'bundle')
    assert.equal(released, true)
  }
})

test('abort or timeout during a pending claim never starts work and releases an acquired slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const cancel of ['disconnect', 'timeout']) {
    const claim = Promise.withResolvers(), controller = new AbortController()
    let released = false
    const db = { claimBundleBuildLease: () => claim.promise, releaseBundleBuildLease: () => { released = true } }
    const pending = withBundleBuildLease(db, 'user', controller.signal, () => assert.fail('late admission must not start a worker'))
    if (cancel === 'disconnect') controller.abort()
    else t.mock.timers.tick(BUNDLE_BUILD_TIMEOUT_MS)
    claim.resolve(true)
    await assert.rejects(pending, cancel === 'disconnect' ? { name: 'AbortError' } : { code: 'build-timeout', status: 504 })
    assert.equal(released, true)
  }
})

test('timeout keeps the lease until canceled work has finished cleaning up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cleanup = Promise.withResolvers(), started = Promise.withResolvers()
  let released = false, signal
  const db = { claimBundleBuildLease: () => true, releaseBundleBuildLease: () => { released = true } }
  const pending = withBundleBuildLease(db, 'user', new AbortController().signal, async value => {
    signal = value; started.resolve()
    await cleanup.promise
    signal.throwIfAborted()
  })
  await started.promise
  t.mock.timers.tick(BUNDLE_BUILD_TIMEOUT_MS)
  assert.equal(signal.aborted, true)
  assert.equal(released, false, 'cancellation is not termination')
  cleanup.resolve()
  await assert.rejects(pending, { code: 'build-timeout' })
  assert.equal(released, true)
})
