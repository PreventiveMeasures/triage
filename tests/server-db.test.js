// `server/db.ts` — revision storage. Schema migration from the
// pre-keyframe column shape, `chainFrom` cutoff semantics (stale
// `from`, last-keyframe-as-root, full chain pre-keyframe), and the
// inserted / duplicate / stale-base outcomes of `commitRevision`.
// All DB helpers are async — tests `await` accordingly.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { chainFrom, commitRevision, headFor, openDb, revisionExists } from '../server/db.ts'

let tmpCounter = 0
function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), `deepview-db-${++tmpCounter}-`))
  const file = path.join(dir, 'data.db')
  const handle = openDb(file)
  return {
    handle,
    cleanup: async () => {
      await handle.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function rev(over = {}) {
  return {
    tag: 'tag-A',
    id: `id-${++tmpCounter}`,
    base: null,
    keyframe: false,
    nonce: 'nonce-x',
    ciphertext: 'ct-x',
    signature: 'sig-x',
    ...over,
  }
}

describe('openDb — schema + migration', () => {
  it('creates the workspace_revision table on a fresh DB', async () => {
    const { handle, cleanup } = freshDb()
    try {
      // Insert one revision to verify the table is queryable.
      await commitRevision(handle, rev({ id: 'r1' }))
      assert.equal(await revisionExists(handle, 'tag-A', 'r1'), true)
    } finally { await cleanup() }
  })

  it('creates missing parent directories for the SQLite file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-nested-db-${++tmpCounter}-`))
    const file = path.join(dir, 'nested', 'data.db')
    const handle = openDb(file)
    try {
      await commitRevision(handle, rev({ id: 'nested-r1' }))
      assert.equal(await revisionExists(handle, 'tag-A', 'nested-r1'), true)
    } finally {
      await handle.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates a legacy DB created before the keyframe column existed', async () => {
    // Build a pre-migration schema by hand: same columns minus
    // `keyframe`. openDb's idempotent ALTER TABLE adds the column.
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-legacy-${++tmpCounter}-`))
    const file = path.join(dir, 'data.db')
    try {
      const raw = new DatabaseSync(file)
      raw.exec(`
        CREATE TABLE workspace_revision (
          workspace_tag TEXT NOT NULL,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          base TEXT,
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          signature TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_tag, seq),
          UNIQUE (workspace_tag, id)
        ) STRICT;
      `)
      raw.prepare(`
        INSERT INTO workspace_revision
          (workspace_tag, seq, id, base, nonce, ciphertext, signature, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('tag-A', 1, 'pre-migration', null, 'n', 'c', 's', Date.now())
      raw.close()

      // Reopen via openDb — the ALTER TABLE adds `keyframe`.
      const handle = openDb(file)
      try {
        // Pre-migration row should still be readable; new column
        // defaults to 0 (= non-keyframe).
        const head = await headFor(handle, 'tag-A')
        assert.equal(head, 'pre-migration')
        const chain = await chainFrom(handle, 'tag-A', null)
        assert.equal(chain.length, 1)
        assert.equal(chain[0].keyframe, 0, 'legacy revs default to non-keyframe')

        // New revs going in carry the keyframe flag. Thread base
        // onto the existing pre-migration row — commitRevision rejects
        // a stale base inside its lock.
        await commitRevision(handle, rev({ id: 'post-migration', base: 'pre-migration', keyframe: true }))
        const chainAfter = await chainFrom(handle, 'tag-A', null)
        // After a keyframe lands, chainFrom(null) returns from the
        // most-recent keyframe forward — so just the keyframe rev.
        assert.equal(chainAfter.length, 1)
        assert.equal(chainAfter[0].id, 'post-migration')
        assert.equal(chainAfter[0].keyframe, 1)
      } finally { await handle.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('survives a second openDb call on the same file (idempotent migration)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-reopen-${++tmpCounter}-`))
    const file = path.join(dir, 'data.db')
    try {
      const h1 = openDb(file)
      await commitRevision(h1, rev({ id: 'r1' }))
      await h1.close()
      // Re-open — the schema CREATE-IF-NOT-EXISTS is idempotent, and
      // openDb's `keyframe` migration inspects PRAGMA table_info and
      // only runs `ALTER TABLE ADD COLUMN` when the column is genuinely
      // missing, so a re-open on an already-migrated DB is a no-op
      // for the migration step.
      const h2 = openDb(file)
      try {
        // Pre-existing data is still readable.
        assert.equal(await headFor(h2, 'tag-A'), 'r1')
      } finally { await h2.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('headFor', () => {
  it('returns null for an unknown workspace tag', async () => {
    const { handle, cleanup } = freshDb()
    try {
      assert.equal(await headFor(handle, 'never-seen'), null)
    } finally { await cleanup() }
  })

  it('returns the most recent revision id', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'first' }))
      await commitRevision(handle, rev({ id: 'second', base: 'first' }))
      await commitRevision(handle, rev({ id: 'third', base: 'second' }))
      assert.equal(await headFor(handle, 'tag-A'), 'third')
    } finally { await cleanup() }
  })

  it('scopes by workspace tag', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ tag: 'A', id: 'a1' }))
      await commitRevision(handle, rev({ tag: 'B', id: 'b1' }))
      await commitRevision(handle, rev({ tag: 'A', id: 'a2', base: 'a1' }))
      assert.equal(await headFor(handle, 'A'), 'a2')
      assert.equal(await headFor(handle, 'B'), 'b1')
    } finally { await cleanup() }
  })
})

describe('chainFrom — cutoff semantics', () => {
  it('returns the full chain when from=null and no keyframe has landed', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'r3', base: 'r2' }))
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2', 'r3'])
    } finally { await cleanup() }
  })

  it('returns from the latest keyframe forward when from=null and a keyframe exists', async () => {
    const { handle, cleanup } = freshDb()
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
    const { handle, cleanup } = freshDb()
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
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      assert.deepEqual(await chainFrom(handle, 'tag-A', 'r2'), [])
    } finally { await cleanup() }
  })

  it('falls back to the keyframe path when from=<unknown id>', async () => {
    // A client supplies a `from` the server doesn't recognise (DB
    // reset / chain compaction / malicious peer). chainFrom skips
    // past everything before the latest keyframe, same as from=null.
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'kf1', base: 'r1', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r3', base: 'kf1' }))
      const chain = await chainFrom(handle, 'tag-A', 'never-existed')
      assert.deepEqual(chain.map((r) => r.id), ['kf1', 'r3'])
    } finally { await cleanup() }
  })

  it('returns full chain on from=<unknown id> when no keyframe ever landed', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      const chain = await chainFrom(handle, 'tag-A', 'never-existed')
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2'])
    } finally { await cleanup() }
  })

  it('uses the most recent keyframe when multiple keyframes exist', async () => {
    // `lastKeyframeSeq` returns MAX(seq) across keyframe rows. A
    // workspace with kf1 → reg → kf2 → reg → kf3 → reg should anchor
    // catch-up at kf3, dropping everything before. Pin so a
    // refactor that switched to "first keyframe" wouldn't regress.
    const { handle, cleanup } = freshDb()
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
    // The known-from path: seqOfId(kf) → chainAfterSeq(kf.seq)
    // returns rows with seq STRICTLY greater than kf.seq. The
    // keyframe itself isn't echoed back — the client already has it
    // (that's why they passed it as `from`). Pin so a future
    // chainAfterSeq → chainFromSeq swap (inclusive vs exclusive)
    // would surface here.
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'kf', base: 'r1', keyframe: true }))
      await commitRevision(handle, rev({ id: 'r3', base: 'kf' }))
      const chain = await chainFrom(handle, 'tag-A', 'kf')
      assert.deepEqual(chain.map((r) => r.id), ['r3'])
    } finally { await cleanup() }
  })

  it('returns the in-between revisions when from=<id BEFORE the keyframe>', async () => {
    // The known-from path is purely "everything after row.seq" — it
    // does NOT promote the catch-up to the keyframe even when one
    // exists in between. The client expects continuity (each rev's
    // base = its predecessor's id), so we can't skip the gap. Pin
    // the wasteful-but-correct behaviour so an over-eager
    // optimisation that bypasses pre-keyframe deltas would surface
    // here as a continuity break.
    const { handle, cleanup } = freshDb()
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
    const { handle, cleanup } = freshDb()
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

describe('commitRevision', () => {
  it('assigns monotonic seq starting from 1', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      await commitRevision(handle, rev({ id: 'r3', base: 'r2' }))
      const ordered = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(ordered.map((r) => r.id), ['r1', 'r2', 'r3'])
    } finally { await cleanup() }
  })

  it('a same-id retransmit returns { kind: "duplicate" } — no throw, no extra row', async () => {
    // The protocol relies on this for retransmit idempotency: a
    // client retrying a save under the same (tag, id) gets an ack-
    // shaped result (not a thrown UNIQUE error), and the chain is
    // unchanged. The lock-protected dup check inside commitRevision
    // turns a would-be SQLite UNIQUE-constraint throw into a
    // structured `duplicate` outcome the handler can short-circuit
    // cleanly.
    const { handle, cleanup } = freshDb()
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
    // commitRevision's base-equality check sits inside the same
    // lock as the INSERT. Pre-fix, two concurrent saves with the
    // same base and different ids would both pass an out-of-lock
    // base check and both insert, forking the chain. Tested
    // sequentially here — the first commit advances the head; the
    // second is forced to use the (now stale) original base and
    // must bail.
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1' }))
      const stale = await commitRevision(handle, rev({ id: 'r2b', base: 'r1' }))
      assert.equal(stale.kind, 'stale-base')
      assert.equal(stale.head, 'r2')
      const chain = await chainFrom(handle, 'tag-A', null)
      // Only r1, r2 — the stale `r2b` did NOT insert.
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2'])
    } finally { await cleanup() }
  })

  it('different tags can share the same revision id (per-tag scope)', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ tag: 'A', id: 'shared' }))
      await commitRevision(handle, rev({ tag: 'B', id: 'shared' }))
      assert.equal(await headFor(handle, 'A'), 'shared')
      assert.equal(await headFor(handle, 'B'), 'shared')
    } finally { await cleanup() }
  })

  it('keyframe boolean is stored as 1 / 0', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1', keyframe: false }))
      await commitRevision(handle, rev({ id: 'r2', base: 'r1', keyframe: true }))
      // chainFrom(null) skips past everything before the latest
      // keyframe — so only `r2` (the keyframe) comes back. To inspect
      // r1's flag too, ask from r1 forward.
      const fromR1 = await chainFrom(handle, 'tag-A', 'r1')
      assert.equal(fromR1.length, 1)
      assert.equal(fromR1[0].id, 'r2')
      assert.equal(fromR1[0].keyframe, 1, 'keyframe rev stored as 1')

      const fromHeadBack = await chainFrom(handle, 'tag-A', null)
      assert.equal(fromHeadBack.length, 1, 'keyframe-cutoff returns only kf forward')
      assert.equal(fromHeadBack[0].keyframe, 1)

      // Insert a non-keyframe AFTER and verify it stores 0.
      await commitRevision(handle, rev({ id: 'r3', base: 'r2', keyframe: false }))
      const post = await chainFrom(handle, 'tag-A', 'r2')
      assert.equal(post[0].keyframe, 0, 'non-keyframe rev stored as 0')
    } finally { await cleanup() }
  })

  it('keyframe column uses strict === true (truthy-non-true values store as 0)', async () => {
    // PR #56 hardened the storage coercion from `keyframe ? 1 : 0`
    // to `keyframe === true ? 1 : 0`. The canonical signed bytes
    // use `keyframe === true ? '1' : ''` — if the storage path
    // accepted a truthy-non-true value (`1`, `"true"`, `{}`) as
    // `1`, the stored row would say keyframe-yes while the signed
    // canonical said keyframe-no, breaking chain-replay verifies
    // for peers who recompute. TypeScript narrows `keyframe:
    // boolean` at compile time; this test pins the runtime
    // behavior against a JS caller (test fixture, dynamic import)
    // that smuggles a non-strict value past the type system.
    const { handle, cleanup } = freshDb()
    try {
      // Cast to suppress the TS check the production code relies on;
      // tests run as .js so the cast is purely for documentation.
      await commitRevision(handle, rev({ id: 'k-num',  keyframe: /** @type {any} */ (1) }))
      await commitRevision(handle, rev({ id: 'k-str',  base: 'k-num', keyframe: /** @type {any} */ ('true') }))
      await commitRevision(handle, rev({ id: 'k-obj',  base: 'k-str', keyframe: /** @type {any} */ ({}) }))
      await commitRevision(handle, rev({ id: 'k-real', base: 'k-obj', keyframe: true }))
      const rows = await chainFrom(handle, 'tag-A', null)
      // chainFrom(null) skips to the latest keyframe — only the
      // genuine `keyframe: true` row should make the cut.
      assert.equal(rows.length, 1, 'only the real keyframe cuts the chain')
      assert.equal(rows[0].id, 'k-real')
      assert.equal(rows[0].keyframe, 1)
      // Walk the prior rows explicitly and assert they ALL stored 0.
      const fromHead = await chainFrom(handle, 'tag-A', 'k-num')
      const byId = Object.fromEntries(fromHead.map((r) => [r.id, r]))
      assert.equal(byId['k-str']?.keyframe, 0, 'string "true" → 0')
      assert.equal(byId['k-obj']?.keyframe, 0, 'object → 0')
      assert.equal(byId['k-real']?.keyframe, 1, 'genuine true → 1')
    } finally { await cleanup() }
  })

  it('null base is preserved (first revision in a chain)', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1', base: null }))
      const [row] = await chainFrom(handle, 'tag-A', null)
      assert.equal(row.base, null)
    } finally { await cleanup() }
  })
})

describe('commitRevision — concurrency under the per-workspace_tag lock', () => {
  // The async refactor moved every DB op behind an `await`. The lock
  // is the only thing keeping the dup-recheck / base-check / MAX(seq)
  // / INSERT quartet atomic against concurrent saves on the same
  // workspace. These tests exercise the lock contract end-to-end by
  // firing concurrent `commitRevision` calls via Promise.all and
  // pinning the post-conditions.

  it('two concurrent same-id retransmits: one inserts, one duplicates; chain has one row', async () => {
    // Pre-fix, the post-sig dup recheck sat OUTSIDE the lock — two
    // concurrent same-id retransmits could both pass the recheck and
    // both reach INSERT, with the second throwing on UNIQUE and the
    // originator never seeing an ack. Lock-protected dup recheck
    // turns the loser into a clean `duplicate` outcome.
    const { handle, cleanup } = freshDb()
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
    // The chain-fork bug the audit found. Without the lock-protected
    // base check, BOTH saves would have inserted (UNIQUE is on id,
    // not on base) and the chain would have two distinct rows with
    // the same base — clients would see a continuity break. With the
    // fix, the loser's base check (under the lock) sees the new head
    // and returns stale-base.
    const { handle, cleanup } = freshDb()
    try {
      const a = rev({ id: 'a-id' })   // base: null
      const b = rev({ id: 'b-id' })   // base: null
      const [ra, rb] = await Promise.all([
        commitRevision(handle, a),
        commitRevision(handle, b),
      ])
      assert.deepEqual([ra.kind, rb.kind].toSorted(), ['inserted', 'stale-base'])
      const chain = await chainFrom(handle, 'tag-A', null)
      // Critical invariant: ONE row, not two. Pin against a future
      // regression that scopes the lock too narrowly again.
      assert.equal(chain.length, 1, 'chain MUST NOT fork')
    } finally { await cleanup() }
  })

  it('N concurrent same-base saves: exactly one inserts, N-1 return stale-base', async () => {
    // Scale the same-base race up to stress the lock's FIFO contract
    // under load. Each subsequent acquirer's base check (under its
    // own lock-protected critical section) must see the head the
    // first winner advanced to, so every loser returns stale-base —
    // not duplicate (different ids) and not inserted (would re-fork).
    const { handle, cleanup } = freshDb()
    try {
      const N = 10
      const inputs = Array.from({ length: N }, (_, i) => rev({ id: `r-${i}` }))
      const results = await Promise.all(inputs.map((r) => commitRevision(handle, r)))
      const inserted = results.filter((r) => r.kind === 'inserted')
      const stale = results.filter((r) => r.kind === 'stale-base')
      assert.equal(inserted.length, 1, 'exactly one save wins')
      assert.equal(stale.length, N - 1, 'all others see the advanced head')
      // Every stale-base outcome carries the winner's id as `head`.
      const winnerIdx = results.indexOf(inserted[0])
      const winnerId = inputs[winnerIdx].id
      for (const s of stale) assert.equal(s.head, winnerId, 'losers see the same head')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 1, 'only the winner is persisted')
    } finally { await cleanup() }
  })

  it('different workspaces do not serialise through the same queue (per-key lock)', async () => {
    // KeyedAsyncLock keys on workspace_tag. Concurrent commits on
    // distinct tags must run in parallel — otherwise a slow save on
    // one workspace would head-of-line block every other workspace.
    const { handle, cleanup } = freshDb()
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
    // Real-world case: a client emits two revisions back-to-back
    // before the first ack arrives. Promise.all kicks both off; the
    // lock serialises r1 first (it enters the queue first), advances
    // the head; r2's base check then matches against the freshly
    // landed head. Both succeed.
    const { handle, cleanup } = freshDb()
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
    // Three concurrent commits against a pre-existing head r1:
    //   • a same-id retransmit of r1 — must return duplicate
    //   • two same-base (r1) competing different-id saves — exactly
    //     one wins (inserted), the other gets stale-base
    // Chain ends up with two rows total.
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      const dup = rev({ id: 'r1' })
      const b = rev({ id: 'b', base: 'r1' })
      const c = rev({ id: 'c', base: 'r1' })
      const results = await Promise.all([
        commitRevision(handle, dup),
        commitRevision(handle, b),
        commitRevision(handle, c),
      ])
      const kinds = results.map((r) => r.kind).toSorted()
      assert.deepEqual(kinds, ['duplicate', 'inserted', 'stale-base'])
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 2)
    } finally { await cleanup() }
  })

  it('lock body executes serially: critical sections do not overlap', async () => {
    // Direct check that the lock is doing what the contract claims —
    // monkey-patch the gated-INSERT await inside commitRevision's
    // critical section (the one statement every committed save runs
    // under the lock) to count concurrent entries, with an artificial
    // setImmediate yield so a hypothetical non-serialised
    // implementation would have ample opportunity to interleave.
    const { handle, cleanup } = freshDb()
    try {
      let inside = 0
      let maxInside = 0
      const originalGet = handle.gatedInsert.get.bind(handle.gatedInsert)
      handle.gatedInsert.get = async (...args) => {
        inside += 1
        if (inside > maxInside) maxInside = inside
        await new Promise((resolve) => { setImmediate(resolve) })
        const result = await originalGet(...args)
        inside -= 1
        return result
      }
      const N = 5
      // Pipeline the saves so each one's base matches the prior winner —
      // this means every save lands as 'inserted' (not stale-base),
      // and we get N distinct lock acquisitions to observe overlap on.
      // FIFO ordering of the lock guarantees the chain is r-0 → r-1 → …
      const inputs = Array.from({ length: N }, (_, i) =>
        rev({ id: `r-${i}`, base: i === 0 ? null : `r-${i - 1}` }))
      const results = await Promise.all(inputs.map((r) => commitRevision(handle, r)))
      for (const r of results) assert.equal(r.kind, 'inserted')
      assert.equal(maxInside, 1, 'lock body MUST execute serially')
    } finally { await cleanup() }
  })

  it('a thrown error inside commitRevision releases the lock for the next commit', async () => {
    // KeyedAsyncLock's `finally` releases on throw. Plumb a failure
    // through the gated INSERT once, then verify the next call
    // on the same workspace acquires cleanly and inserts.
    const { handle, cleanup } = freshDb()
    try {
      const originalGet = handle.gatedInsert.get.bind(handle.gatedInsert)
      let injected = false
      handle.gatedInsert.get = (...args) => {
        if (!injected) { injected = true; return Promise.reject(new Error('synthetic failure')) }
        return originalGet(...args)
      }
      await assert.rejects(
        () => commitRevision(handle, rev({ id: 'r1' })),
        /synthetic failure/u,
      )
      // The lock must have released. A subsequent commit on the same
      // workspace acquires cleanly.
      const next = await commitRevision(handle, rev({ id: 'r2' }))
      assert.equal(next.kind, 'inserted')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['r2'])
    } finally { await cleanup() }
  })

  it('throws when invoked on a Handle not created by openDb (no lock found)', async () => {
    // The lock is stored in a module-private WeakMap keyed by
    // Handle. A hand-constructed Handle literal has no lock entry,
    // so commitRevision fails loud rather than silently bypassing
    // serialisation.
    await assert.rejects(
      () => commitRevision({}, rev({ id: 'x' })),
      /handle not opened via openDb/u,
    )
  })

  // Insert a sibling row directly via the raw DatabaseSync, bypassing
  // the gated commit, to simulate a sibling Node process attached to
  // the same SQLite file landing a row our in-process lock can't see.
  // The gated INSERT computes `seq` itself, so the white-box recovery
  // tests below stage the conflict by writing a row here and then
  // making the gated INSERT throw the unique-violation it would hit.
  function seedSibling(handle, { id, seq = 1, base = null }) {
    handle.db.prepare(`
      INSERT INTO workspace_revision
        (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
      VALUES (?, ?, ?, ?, 0, 'n', 'c', 's', ?)
    `).run('tag-A', seq, id, base, Date.now())
  }

  it('multi-process PK violation on INSERT: caught, refetched → stale-base', async () => {
    // Cross-process race: our in-process lock can't serialise
    // against a sibling Node process attached to the same DB. The
    // sibling lands a row at OUR computed seq; our INSERT throws a
    // unique-violation. The catch in commitRevision refetches and
    // returns the standard `stale-base` outcome so the originator
    // gets a workspace-state catch-up instead of a silent failure.
    const { handle, cleanup } = freshDb()
    try {
      const originalGet = handle.gatedInsert.get.bind(handle.gatedInsert)
      let injected = false
      handle.gatedInsert.get = (...args) => {
        if (injected) return originalGet(...args)
        injected = true
        // Simulate a sibling row landing first — at our seq, different
        // id — then throw the PK violation our INSERT would hit.
        seedSibling(handle, { id: 'sibling-id' })
        throw new Error('UNIQUE constraint failed: workspace_revision.workspace_tag, workspace_revision.seq')
      }
      const result = await commitRevision(handle, rev({ id: 'our-id' }))
      assert.equal(result.kind, 'stale-base')
      assert.equal(result.head, 'sibling-id')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['sibling-id'], 'only the sibling row is in the chain')
    } finally { await cleanup() }
  })

  it('multi-process UNIQUE id violation on INSERT: caught, refetched → inserted (row is in chain; broadcast)', async () => {
    // The hard case: the row is in the chain after a unique-violation
    // catch. We cannot distinguish "we successfully INSERTed and a
    // retry layer wrapped the response as a unique-violation" from
    // "a sibling process committed our id first". Either way the row
    // IS in the chain. Returning `inserted` here (rather than the
    // earlier `duplicate`) is the defensive choice — handleSave
    // broadcasts to peers; clients dedup by content-addressed id, so
    // an idempotent re-broadcast is harmless. Returning `duplicate`
    // (the prior shape) would have silently dropped peers' broadcast
    // when our INSERT was the one that landed.
    const { handle, cleanup } = freshDb()
    try {
      const originalGet = handle.gatedInsert.get.bind(handle.gatedInsert)
      let injected = false
      handle.gatedInsert.get = (...args) => {
        if (injected) return originalGet(...args)
        injected = true
        // A sibling lands OUR id first, then our INSERT throws the
        // UNIQUE(workspace_tag, id) violation. Recovery finds the row
        // present → inserted.
        seedSibling(handle, { id: 'our-id' })
        throw new Error('UNIQUE constraint failed: workspace_revision.workspace_tag, workspace_revision.id')
      }
      const result = await commitRevision(handle, rev({ id: 'our-id' }))
      assert.equal(result.kind, 'inserted')
      const chain = await chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['our-id'])
    } finally { await cleanup() }
  })

  it('Postgres unique-violation (SQLSTATE 23505) is recognised the same way', async () => {
    // SQLite throws with a "UNIQUE constraint failed" message;
    // Postgres / Neon throws a NeonDbError with `code: '23505'`.
    // `isUniqueViolation` matches either shape — pin both paths.
    const { handle, cleanup } = freshDb()
    try {
      const originalGet = handle.gatedInsert.get.bind(handle.gatedInsert)
      let injected = false
      handle.gatedInsert.get = (...args) => {
        if (injected) return originalGet(...args)
        injected = true
        seedSibling(handle, { id: 'pg-sibling' })
        const err = new Error('duplicate key value violates unique constraint "workspace_revision_pkey"')
        err.code = '23505'
        throw err
      }
      const result = await commitRevision(handle, rev({ id: 'our-id' }))
      assert.equal(result.kind, 'stale-base')
      assert.equal(result.head, 'pg-sibling')
    } finally { await cleanup() }
  })

  it('non-unique driver errors are NOT caught — they rethrow as rejections', async () => {
    // The catch is narrow: only unique-violations are converted to
    // recovery outcomes. Network / connection / non-existent-column
    // errors must surface as real failures so the operator sees them.
    const { handle, cleanup } = freshDb()
    try {
      handle.gatedInsert.get = () => Promise.reject(new Error('connection refused'))
      await assert.rejects(
        () => commitRevision(handle, rev({ id: 'x' })),
        /connection refused/u,
      )
    } finally { await cleanup() }
  })

  it('chainFrom is safe to call alongside concurrent commits — no torn reads, no inserts seen mid-write', async () => {
    // chainFrom does NOT acquire the writeLock (reads do not need
    // serialisation against writes). It may return a snapshot from
    // before or after a concurrent commit, but never a torn snapshot.
    // Stress-check by interleaving N commits with N chain reads and
    // asserting every observed chain is a valid prefix of the final
    // chain (no skipped seqs, no broken parent pointers).
    const { handle, cleanup } = freshDb()
    try {
      const N = 8
      // Sequential setup of a linear chain so chainFrom has something
      // to read; concurrent commits append fresh rows.
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
      // Every writer inserted (pipelined chain).
      for (const r of writeResults) assert.equal(r.kind, 'inserted')
      // Every reader observed a valid prefix: ids in order r-0, r-1,
      // …, and each row's base points at its predecessor.
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

describe('revisionExists', () => {
  it('returns true for an inserted revision, false otherwise', async () => {
    const { handle, cleanup } = freshDb()
    try {
      await commitRevision(handle, rev({ id: 'r1' }))
      assert.equal(await revisionExists(handle, 'tag-A', 'r1'), true)
      assert.equal(await revisionExists(handle, 'tag-A', 'nope'), false)
      assert.equal(await revisionExists(handle, 'tag-B', 'r1'), false, 'scoped by tag')
    } finally { await cleanup() }
  })
})

describe('openDb — STRICT migration guard', () => {
  // `CREATE TABLE IF NOT EXISTS … STRICT` is a no-op when the table
  // already exists, so a deployment upgraded from a pre-STRICT
  // version would silently keep its non-STRICT shape. openDb must
  // detect this and fail-loud so the operator runs a migration.
  it('throws when an existing workspace_revision is non-STRICT', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-db-strict-${++tmpCounter}-`))
    const file = path.join(dir, 'data.db')
    try {
      // Pre-create the table WITHOUT the STRICT marker, simulating a
      // legacy deployment.
      const seed = new DatabaseSync(file)
      seed.exec(`
        CREATE TABLE workspace_revision (
          workspace_tag TEXT NOT NULL,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          base TEXT,
          keyframe INTEGER NOT NULL DEFAULT 0,
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          signature TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_tag, seq),
          UNIQUE (workspace_tag, id)
        );
      `)
      seed.close()
      assert.throws(() => openDb(file), /non-STRICT/u)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('closes the underlying DB handle when init throws (counts close() via spy)', () => {
    // Regression test for the close-on-throw path. WAL mode allows
    // concurrent connections, so opening the file again from a fresh
    // DatabaseSync wouldn't fail even if the original handle leaked.
    // The only reliable test is to count `close()` invocations on
    // the prototype: the production code must close BEFORE re-
    // throwing, otherwise the catch-and-cleanup is unreachable.
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-db-leak-${++tmpCounter}-`))
    const file = path.join(dir, 'data.db')
    const originalClose = DatabaseSync.prototype.close
    let closeCalls = 0
    DatabaseSync.prototype.close = function spyClose(...args) {
      closeCalls++
      return originalClose.apply(this, args)
    }
    try {
      const seed = new DatabaseSync(file)
      seed.exec(`
        CREATE TABLE workspace_revision (
          workspace_tag TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
          base TEXT, keyframe INTEGER NOT NULL DEFAULT 0,
          nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, signature TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_tag, seq), UNIQUE (workspace_tag, id)
        );
      `)
      seed.close() // counted: 1
      const before = closeCalls
      assert.throws(() => openDb(file), /non-STRICT/u)
      // openDb's catch must have called close() exactly once on its
      // internal DatabaseSync before rethrowing.
      assert.equal(closeCalls - before, 1, 'openDb closed its internal handle on throw')
    } finally {
      DatabaseSync.prototype.close = originalClose
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a freshly-created (STRICT) DB without throwing', async () => {
    const { cleanup } = freshDb()
    await cleanup()
  })
})
