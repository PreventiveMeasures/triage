// Runs the backend-agnostic `server/db.ts` revision-storage suite
// against the NEON backend (`server/db-neon.ts`) instead of SQLite,
// using an in-process Postgres (PGlite) standing in for the real Neon
// driver (see `_neon-pglite.js`). The Neon path — `openNeonDb`,
// `tryCommitNeon`, the durability gate, the BIGINT coercion — had zero
// coverage before this file; these scenarios mirror the SQLite ones in
// `server-db.test.js` so the two backends are pinned to identical
// observable behaviour through the shared `commitRevision` / `chainFrom`
// / `headFor` / `revisionExists` API.
//
// NOT ported from the SQLite suite (SQLite-implementation-specific):
//   • parent-dir creation, the legacy `keyframe` ALTER migration, and
//     the STRICT-table guard — all `node:sqlite` / on-disk-file
//     concerns. The Neon analogues (DDL bootstrap, durability gate,
//     `keyframe` CHECK constraint) are covered below instead.
//   • the white-box tests that monkey-patch the SQLite handle's
//     `gatedInsert.get` statement. `tryCommitNeon` folds its gated
//     INSERT into one pipelined transaction (no standalone statement
//     object to wrap), so those SQLite probes don't apply to this
//     backend — the Neon analogues stage faults via `failNextCommit`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { chainFrom, commitRevision, headFor, revisionExists } from '../server/db.ts'
import { assertDurableSyncCommit, openNeonDb } from '../server/db-neon.ts'
import { failNextCommit, freshNeonDb } from './_neon-pglite.js'

let idCounter = 0
function rev(over = {}) {
  return {
    tag: 'tag-A',
    id: `id-${++idCounter}`,
    base: null,
    keyframe: false,
    nonce: 'nonce-x',
    ciphertext: 'ct-x',
    signature: 'sig-x',
    ...over,
  }
}

describe('openNeonDb — bootstrap + durability (PGlite)', () => {
  it('creates the workspace_revision table on a fresh DB', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      assert.equal(await revisionExists(handle, 'tag-A', 'r1'), true)
    } finally { await cleanup() }
  })

  it('DDL bootstrap is idempotent — a second openNeonDb on the same DB preserves data', async () => {
    // The Neon analogue of SQLite's idempotent-reopen test: the
    // bootstrap is `CREATE TABLE IF NOT EXISTS` under an advisory lock,
    // so re-running it against an already-initialised database is a
    // no-op and the existing rows survive.
    const { handle, connectionString, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      const reopened = await openNeonDb(connectionString)
      assert.equal(await headFor(reopened, 'tag-A'), 'r1')
      await reopened.close()
    } finally { await cleanup() }
  })

  it('assertDurableSyncCommit passes for the PGlite endpoint default', async () => {
    // openNeonDb already ran the gate during freshNeonDb without
    // throwing; assert the underlying level directly too.
    const { pg, cleanup } = await freshNeonDb()
    try {
      const sql = async (text) => (await pg.query(text)).rows
      await assertDurableSyncCommit(sql) // resolves (PGlite default is 'on')
      const [{ synchronous_commit: level }] = await pg.query(`SHOW synchronous_commit`).then((r) => r.rows)
      assert.ok(['local', 'on', 'remote_write', 'remote_apply'].includes(level), `durable level, got '${level}'`)
    } finally { await cleanup() }
  })

  it('assertDurableSyncCommit rejects an endpoint configured synchronous_commit=off', async () => {
    // Unit-level: the only level that skips the primary WAL fsync and
    // breaks the ack-implies-durable contract must fail the boot gate.
    const offSql = () => Promise.resolve([{ synchronous_commit: 'off' }])
    await assert.rejects(() => assertDurableSyncCommit(offSql), /synchronous_commit='off'/u)
  })

  it('keyframe CHECK constraint rejects values outside {0, 1} (operator-write guard)', async () => {
    // Postgres analogue of the SQLite STRICT guard: a direct DB write
    // of keyframe=2 would diverge the stored row from the signed
    // canonical (which only ever encodes 0/1). The CHECK rejects it.
    const { pg, cleanup } = await freshNeonDb()
    try {
      await assert.rejects(
        () => pg.query(
          `INSERT INTO workspace_revision
             (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          ['tag-A', 1, 'bad-kf', null, 2, 'n', 'c', 's', Date.now()],
        ),
        (err) => { assert.equal(err.code, '23514'); return true },
      )
    } finally { await cleanup() }
  })

  it('BIGINT seq round-trips into the JS safe-integer range', async () => {
    // `seq` is BIGINT on the Neon path (INTEGER→BIGINT vs SQLite). The
    // `num()` coercion every commit relies on assumes the driver hands
    // back a value that lands in the safe-integer range; pin the shape.
    const { handle, pg, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'r3', base: 'r2' }))
      const rows = await pg.query(`SELECT seq FROM workspace_revision ORDER BY seq`).then((r) => r.rows)
      const seqs = rows.map((r) => Number(r.seq))
      assert.deepEqual(seqs, [1, 2, 3])
      for (const s of seqs) assert.ok(Number.isSafeInteger(s))
    } finally { await cleanup() }
  })
})

describe('headFor (Neon)', () => {
  it('returns null for an unknown workspace tag', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      assert.equal(await headFor(handle, 'never-seen'), null)
    } finally { await cleanup() }
  })

  it('returns the most recent revision id', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'first' }))
      await commitRevision(handle, rev({ id: 'second', base: 'first' }))
      await commitRevision(handle, rev({ id: 'third', base: 'second' }))
      assert.equal(await headFor(handle, 'tag-A'), 'third')
    } finally { await cleanup() }
  })

  it('scopes by workspace tag', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ tag: 'A', id: 'a1' }))
      await commitRevision(handle, rev({ tag: 'B', id: 'b1' }))
      await commitRevision(handle, rev({ tag: 'A', id: 'a2', base: 'a1' }))
      assert.equal(await headFor(handle, 'A'), 'a2')
      assert.equal(await headFor(handle, 'B'), 'b1')
    } finally { await cleanup() }
  })
})

describe('chainFrom — cutoff semantics (Neon)', () => {
  it('returns the full chain when from=null and no keyframe has landed', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'r3', base: 'r2' }))
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2', 'r3'])
    } finally { await cleanup() }
  })

  it('returns from the latest keyframe forward when from=null and a keyframe exists', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'kf1', base: 'r2', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r4', base: 'kf1' }))
      await commitRevision(handle, rev({ id: 'r5', base: 'r4' }))
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['kf1', 'r4', 'r5'])
    } finally { await cleanup() }
  })

  it('returns only newer revisions when from=<known id>', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'r3', base: 'r2' }))
      await commitRevision(handle, rev({ id: 'r4', base: 'r3' }))
      const chain = await chainFrom(handle, 'tag-A', 'r2')
      assert.deepEqual(chain.map((r) => r.id), ['r3', 'r4'])
    } finally { await cleanup() }
  })

  it('returns an empty chain when from=<head> (caller is up-to-date)', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      assert.deepEqual(await chainFrom(handle, 'tag-A', 'r2'), [])
    } finally { await cleanup() }
  })

  it('falls back to the keyframe path when from=<unknown id>', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'kf1', base: 'r1', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r3', base: 'kf1' }))
      const chain = await chainFrom(handle, 'tag-A', 'never-existed')
      assert.deepEqual(chain.map((r) => r.id), ['kf1', 'r3'])
    } finally { await cleanup() }
  })

  it('returns full chain on from=<unknown id> when no keyframe ever landed', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      const chain = await chainFrom(handle, 'tag-A', 'never-existed')
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2'])
    } finally { await cleanup() }
  })

  it('uses the most recent keyframe when multiple keyframes exist', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'kf1', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r2', base: 'kf1' }))
      await commitRevision(handle, rev({ id: 'kf2', base: 'r2', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r4', base: 'kf2' }))
      await commitRevision(handle, rev({ id: 'kf3', base: 'r4', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r6', base: 'kf3' }))
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['kf3', 'r6'])
    } finally { await cleanup() }
  })

  it('returns post-keyframe revisions only when from=<keyframe id>', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'kf', base: 'r1', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r3', base: 'kf' }))
      const chain = await chainFrom(handle, 'tag-A', 'kf')
      assert.deepEqual(chain.map((r) => r.id), ['r3'])
    } finally { await cleanup() }
  })

  it('returns the in-between revisions when from=<id BEFORE the keyframe>', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'kf', base: 'r2', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r4', base: 'kf' }))
      const chain = await chainFrom(handle, 'tag-A', 'r1')
      assert.deepEqual(chain.map((r) => r.id), ['r2', 'kf', 'r4'])
    } finally { await cleanup() }
  })

  it('chain entries carry every signed-payload field for re-verification', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1', nonce: 'NN', ciphertext: 'CT', signature: 'SG' }))
      const [row] = await chainFrom(handle, 'tag-A', null)
      assert.equal(row.id, 'r1')
      assert.equal(row.base, null)
      assert.equal(row.keyframe, 0)
      assert.equal(row.nonce, 'NN')
      assert.equal(row.ciphertext, 'CT')
      assert.equal(row.signature, 'SG')
    } finally { await cleanup() }
  })
})

describe('commitRevision (Neon)', () => {
  it('assigns monotonic seq starting from 1', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'r3', base: 'r2' }))
      const ordered = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(ordered.map((r) => r.id), ['r1', 'r2', 'r3'])
    } finally { await cleanup() }
  })

  it('a same-id retransmit returns { kind: "duplicate" } — no throw, no extra row', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const first = await commitRevision(handle, rev({ id: 'dup' }))
      assert.equal(first.kind, 'inserted')
      const second = await commitRevision(handle, rev({ id: 'dup' }))
      assert.equal(second.kind, 'duplicate')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 1)
    } finally { await cleanup() }
  })

  it('a save with a stale base returns { kind: "stale-base", head } without inserting', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      const stale = await commitRevision(handle, rev({ id: 'r2b', base: 'r1' }))
      assert.equal(stale.kind, 'stale-base')
      assert.equal(stale.head, 'r2')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2'])
    } finally { await cleanup() }
  })

  it('different tags can share the same revision id (per-tag scope)', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ tag: 'A', id: 'shared' }))
      await commitRevision(handle, rev({ tag: 'B', id: 'shared' }))
      assert.equal(await headFor(handle, 'A'), 'shared')
      assert.equal(await headFor(handle, 'B'), 'shared')
    } finally { await cleanup() }
  })

  it('keyframe boolean is stored as 1 / 0', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1', keyframe: false }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1', keyframe: true }))
      const fromR1 = await chainFrom(handle, 'tag-A', 'r1')
      assert.equal(fromR1.length, 1)
      assert.equal(fromR1[0].id, 'r2')
      assert.equal(fromR1[0].keyframe, 1, 'keyframe rev stored as 1')

      const fromHeadBack = await chainFrom(handle, 'tag-A', null)
      assert.equal(fromHeadBack.length, 1, 'keyframe-cutoff returns only kf forward')
      assert.equal(fromHeadBack[0].keyframe, 1)

      await commitRevision(handle, rev({ id: 'r3', base: 'r2', keyframe: false }))
      const post = await chainFrom(handle, 'tag-A', 'r2')
      assert.equal(post[0].keyframe, 0, 'non-keyframe rev stored as 0')
    } finally { await cleanup() }
  })

  it('keyframe column uses strict === true (truthy-non-true values store as 0)', async () => {
    // Mirrors the SQLite parity test: `tryCommitNeon` coerces with
    // `keyframe === true ? 1 : 0`, so a JS caller smuggling 1 / "true"
    // / {} past the type system stores 0 — keeping the column in step
    // with the signed canonical (`keyframe === true ? '1' : ''`).
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'k-num', keyframe: /** @type {any} */ (1) }))
      await commitRevision(handle, rev({ id: 'k-str', base: 'k-num', keyframe: /** @type {any} */ ('true') }))
      await commitRevision(handle, rev({ id: 'k-obj', base: 'k-str', keyframe: /** @type {any} */ ({}) }))
      await commitRevision(handle, rev({ id: 'k-real', base: 'k-obj', keyframe: true }))
      const rows = await chainFrom(handle, 'tag-A', null)
      assert.equal(rows.length, 1, 'only the real keyframe cuts the chain')
      assert.equal(rows[0].id, 'k-real')
      assert.equal(rows[0].keyframe, 1)
      const fromHead = await chainFrom(handle, 'tag-A', 'k-num')
      const byId = Object.fromEntries(fromHead.map((r) => [r.id, r]))
      assert.equal(byId['k-str']?.keyframe, 0, 'string "true" → 0')
      assert.equal(byId['k-obj']?.keyframe, 0, 'object → 0')
      assert.equal(byId['k-real']?.keyframe, 1, 'genuine true → 1')
    } finally { await cleanup() }
  })

  it('null base is preserved (first revision in a chain)', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1', base: null }))
      const [row] = await chainFrom(handle, 'tag-A', null)
      assert.equal(row.base, null)
    } finally { await cleanup() }
  })
})

describe('commitRevision — concurrency via the single gated INSERT (Neon, no lock)', () => {
  // `tryCommitNeon` folds the dup-check / head-check / gated INSERT into
  // one pipelined transaction with NO commit-time advisory lock —
  // cross-replica fork-safety rests on the Postgres single-statement
  // snapshot + the `UNIQUE(workspace_tag, seq)` PK (see `tryCommitNeon`).
  // PGlite is single-connection so transactions serialise FIFO; these
  // tests pin the SAME observable outcomes the SQLite backend produces,
  // so the two backends stay in step. NOTE: single-connection PGlite
  // CANNOT reproduce a genuine cross-replica race — these confirm
  // commit-outcome parity, not the cross-replica snapshot+PK argument
  // (which needs a real-Postgres concurrency test; see `tryCommitNeon`).

  it('two concurrent same-id retransmits: one inserts, one duplicates; chain has one row', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const input = rev({ id: 'same-id' })
      const [ra, rb] = await Promise.all([
        commitRevision(handle, input),
        commitRevision(handle, { ...input }),
      ])
      assert.deepEqual([ra.kind, rb.kind].toSorted(), ['duplicate', 'inserted'])
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 1, 'exactly one row landed')
    } finally { await cleanup() }
  })

  it('two concurrent same-base different-id saves: one inserts, one stale-base; chain does NOT fork', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const [ra, rb] = await Promise.all([
        commitRevision(handle, rev({ id: 'a-id' })),
        commitRevision(handle, rev({ id: 'b-id' })),
      ])
      assert.deepEqual([ra.kind, rb.kind].toSorted(), ['inserted', 'stale-base'])
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 1, 'chain MUST NOT fork')
    } finally { await cleanup() }
  })

  it('N concurrent same-base saves: exactly one inserts, N-1 return stale-base', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const N = 10
      const inputs = Array.from({ length: N }, (_, i) => rev({ id: `r-${i}` }))
      const results = await Promise.all(inputs.map((r) => commitRevision(handle, r)))
      const inserted = results.filter((r) => r.kind === 'inserted')
      const stale = results.filter((r) => r.kind === 'stale-base')
      assert.equal(inserted.length, 1, 'exactly one save wins')
      assert.equal(stale.length, N - 1, 'all others see the advanced head')
      const winnerIdx = results.indexOf(inserted[0])
      const winnerId = inputs[winnerIdx].id
      for (const s of stale) assert.equal(s.head, winnerId, 'losers see the same head')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 1, 'only the winner is persisted')
    } finally { await cleanup() }
  })

  it('different workspaces both commit cleanly (per-tag scoped subqueries)', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const [ra, rb] = await Promise.all([
        commitRevision(handle, rev({ tag: 'ws-A', id: 'a1' })),
        commitRevision(handle, rev({ tag: 'ws-B', id: 'b1' })),
      ])
      assert.equal(ra.kind, 'inserted')
      assert.equal(rb.kind, 'inserted')
      assert.equal(await headFor(handle, 'ws-A'), 'a1')
      assert.equal(await headFor(handle, 'ws-B'), 'b1')
    } finally { await cleanup() }
  })

  it('pipelined saves on the same workspace: r2 with base=r1.id lands in FIFO order, both insert', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const [r1, r2] = await Promise.all([
        commitRevision(handle, rev({ id: 'r1' })),
        commitRevision(handle, rev({ id: 'r2', base: 'r1' })),
      ])
      assert.equal(r1.kind, 'inserted')
      assert.equal(r2.kind, 'inserted')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2'])
    } finally { await cleanup() }
  })

  it('mixed concurrent: same-id retransmit + two same-base different-id saves', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      const results = await Promise.all([
        commitRevision(handle, rev({ id: 'r1' })),
        commitRevision(handle, rev({ id: 'b', base: 'r1' })),
        commitRevision(handle, rev({ id: 'c', base: 'r1' })),
      ])
      const kinds = results.map((r) => r.kind).toSorted()
      assert.deepEqual(kinds, ['duplicate', 'inserted', 'stale-base'])
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 2)
    } finally { await cleanup() }
  })

  it('chainFrom is safe to call alongside concurrent commits — observed chains are valid prefixes', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      const N = 8
      const writers = []
      let prev = null
      for (let i = 0; i < N; i++) {
        const id = `r-${i}`
        // eslint-disable-next-line @typescript-eslint/no-loop-func
        writers.push(commitRevision(handle, rev({ id, base: prev })))
        prev = id
      }
      const readers = Array.from({ length: N }, () => chainFrom(handle, 'tag-A', null))
      const [writeResults, ...readSnapshots] = await Promise.all([
        Promise.all(writers),
        ...readers,
      ])
      for (const r of writeResults) assert.equal(r.kind, 'inserted')
      for (const snapshot of readSnapshots) {
        let expectedBase = null
        for (let i = 0; i < snapshot.length; i++) {
          assert.equal(snapshot[i].id, `r-${i}`, 'chain ids in order')
          assert.equal(snapshot[i].base, expectedBase, 'base points at predecessor')
          expectedBase = snapshot[i].id
        }
      }
    } finally { await cleanup() }
  })
})

describe('commitRevision — unique-violation recovery + error handling (Neon)', () => {
  // `tryCommitNeon` wraps the gated INSERT in a pipelined transaction
  // and, on a unique-violation, refetches to decide inserted vs
  // stale-base — the recovery that catches a cross-replica racer (or a
  // direct INSERT from an admin migration / repair script / future code
  // path) landing our seq or id first. This PK / UNIQUE backstop is what
  // makes the lockless commit fork-safe across replicas. PGlite is
  // single-connection so the race can't happen naturally; `failNextCommit`
  // stages the conflict the recovery is built for. Mirrors the SQLite
  // multi-process tests, which inject by making the SQLite handle's
  // gated-INSERT statement throw.

  it('unique-violation with a sibling at our seq (different id) → stale-base', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      failNextCommit({
        before: async (pg) => {
          await pg.query(
            `INSERT INTO workspace_revision
               (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            ['tag-A', 1, 'sibling-id', null, 0, 'n', 'c', 's', Date.now()],
          )
        },
        error: Object.assign(
          new Error('duplicate key value violates unique constraint "workspace_revision_pkey"'),
          { code: '23505' },
        ),
      })
      const result = await commitRevision(handle, rev({ id: 'our-id' }))
      assert.equal(result.kind, 'stale-base')
      assert.equal(result.head, 'sibling-id')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['sibling-id'], 'only the sibling row is in the chain')
    } finally { await cleanup() }
  })

  it('unique-violation where our id already landed → inserted (row is in the chain; broadcast)', async () => {
    // We can't distinguish "our INSERT succeeded but the driver wrapped
    // the ack as a unique-violation" from "a sibling committed our id
    // first". Either way the row IS in the chain, so `inserted` (not
    // `duplicate`) is the defensive choice — peers dedup by
    // content-addressed id, so a re-broadcast is harmless.
    const { handle, cleanup } = await freshNeonDb()
    try {
      failNextCommit({
        before: async (pg) => {
          await pg.query(
            `INSERT INTO workspace_revision
               (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            ['tag-A', 1, 'our-id', null, 0, 'n', 'c', 's', Date.now()],
          )
        },
        error: Object.assign(
          new Error('duplicate key value violates unique constraint "workspace_revision_workspace_tag_id_key"'),
          { code: '23505' },
        ),
      })
      const result = await commitRevision(handle, rev({ id: 'our-id' }))
      assert.equal(result.kind, 'inserted')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['our-id'])
    } finally { await cleanup() }
  })

  it('non-unique driver errors are NOT caught — they rethrow as rejections', async () => {
    // The catch is narrow: only unique-violations become recovery
    // outcomes. Network / connection errors must surface as real
    // failures so the operator sees them.
    const { handle, cleanup } = await freshNeonDb()
    try {
      failNextCommit({ error: new Error('connection refused') })
      await assert.rejects(() => commitRevision(handle, rev({ id: 'x' })), /connection refused/u)
      assert.deepEqual(await chainFrom(handle, 'tag-A', null), [], 'nothing inserted on a hard failure')
    } finally { await cleanup() }
  })

  it('a failed commit does not wedge the workspace — the next commit succeeds', async () => {
    // Neon analogue of the SQLite "failed commit doesn't wedge" test:
    // an aborted pipelined transaction rolls back cleanly (and holds no
    // commit-time lock to strand), so a subsequent commit on the same
    // workspace proceeds normally.
    const { handle, cleanup } = await freshNeonDb()
    try {
      failNextCommit({ error: new Error('synthetic failure') })
      await assert.rejects(() => commitRevision(handle, rev({ id: 'r1' })), /synthetic failure/u)
      const next = await commitRevision(handle, rev({ id: 'r2' }))
      assert.equal(next.kind, 'inserted')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['r2'])
    } finally { await cleanup() }
  })
})

describe('revisionExists (Neon)', () => {
  it('returns true for an inserted revision, false otherwise', async () => {
    const { handle, cleanup } = await freshNeonDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      assert.equal(await revisionExists(handle, 'tag-A', 'r1'), true)
      assert.equal(await revisionExists(handle, 'tag-A', 'nope'), false)
      assert.equal(await revisionExists(handle, 'tag-B', 'r1'), false, 'scoped by tag')
    } finally { await cleanup() }
  })
})
