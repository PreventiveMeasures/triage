import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { after, mock, test } from 'node:test'
import { startPglite } from './_pglite.js'

// The managed Neon store over pg-pool's lease semantics: an idle connection is
// handed out again, a released one returns to the idle list unless discarded,
// and a double release throws. Queries run on one PGlite connection.
const pg = await startPglite()
after(() => pg.close())
let failQueries = false
// eslint-disable-next-line unicorn/prefer-event-target
class Pool extends EventEmitter {
  static last
  constructor(options) {
    super()
    Object.assign(this, { options, created: 0, discarded: 0, ended: 0, idle: [], leased: new Set() })
    Pool.last = this
  }
  connect() {
    if (this.ended) return Promise.reject(new Error('Cannot use a pool after calling end on the pool'))
    let client = this.idle.pop()
    if (!client) {
      this.created++
      // eslint-disable-next-line unicorn/prefer-event-target
      client = Object.assign(new EventEmitter(), { async query(sql, params) {
        if (failQueries) throw new Error('injected connection failure')
        if (!params && sql.includes(';')) { await pg.exec(sql); return { rows: [] } }
        const result = await pg.query(sql, params)
        return { ...result, rowCount: result.affectedRows }
      } })
    }
    this.leased.add(client)
    client.release = discard => {
      if (!this.leased.delete(client)) throw new Error('Release called on client which has already been released to the pool.')
      if (discard) this.discarded++
      else this.idle.push(client)
    }
    return Promise.resolve(client)
  }
  end() { this.ended++; return Promise.resolve() }
}
mock.module('../server-e2e/neon-driver.ts', { exports: { Pool, neonConfig: {} } })
const { openNeonManagedDb } = await import('../server-managed/db-neon.ts')

test('Neon connections are pooled across requests and discarded after failures', async () => {
  const attached = []
  const db = await openNeonManagedDb('postgres://neon.example/db', {}, pool => attached.push(pool))
  const pool = Pool.last
  assert.deepEqual(attached, [pool], 'serverless hosts attach the pool before it hands out connections')
  assert.equal(pool.options.connectionString, 'postgres://neon.example/db')
  assert.equal(pool.options.max, Infinity, 'leases are as unbounded as before')
  assert.ok(pool.options.idleTimeoutMillis > 3_000, 'idle connections outlast a feed poll interval')
  assert.ok(pool.listenerCount('error') > 0, 'idle disconnects are handled')
  assert.equal(pool.created, 1)

  for (let i = 0; i < 3; i++) assert.equal(await db.withRequest(() => db.getReport('missing')), null)
  assert.equal(await db.getReport('missing'), null)
  assert.equal(pool.created, 1, 'initialization, requests and lone operations share one connection')

  let open
  const gate = new Promise(resolve => { open = resolve })
  const held = db.withRequest(async () => { await db.getReport('missing'); await gate })
  await db.withRequest(() => db.getReport('missing'))
  open(); await held
  assert.equal(pool.created, 2, 'concurrent requests lease distinct connections')
  assert.equal(pool.idle.length, 2)

  await assert.rejects(db.withRequest(async () => { await db.getReport('missing'); throw new Error('request failed') }), /request failed/u)
  assert.equal(pool.discarded, 1, 'a failed request discards its connection')
  await assert.rejects(db.setTeamRepo('missing', 123, ''), /foreign key/u)
  assert.equal(pool.discarded, 2, 'a failed operation discards its connection')

  await db.withRequest(async () => {
    await db.getReport('missing')
    for (const client of pool.leased) client.emit('error', new Error('Connection terminated unexpectedly'))
  })
  assert.equal(pool.discarded, 3, 'a connection that failed while leased is not reused')
  assert.equal(pool.leased.size, 0)

  await db.close(); await db.close()
  assert.equal(pool.ended, 1, 'closing ends the pool once')
})

test('Neon pool is ended when initialization fails', async () => {
  failQueries = true
  try { await assert.rejects(openNeonManagedDb('postgres://neon.example/db'), /injected connection failure/u) }
  finally { failQueries = false }
  assert.equal(Pool.last.discarded, 1)
  assert.equal(Pool.last.leased.size, 0)
  assert.equal(Pool.last.ended, 1)
})
