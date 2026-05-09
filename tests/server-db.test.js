// `server/db.js` — sqlite-backed revision storage. Integration is
// covered via tests/sync-server.test.js (full WS round-trips); this
// file targets the DB module directly: schema migration from the
// pre-keyframe column shape, `chainFrom` cutoff semantics (stale
// `from`, last-keyframe-as-root, full chain pre-keyframe), and the
// UNIQUE constraint that makes retransmits idempotent.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { chainFrom, headFor, insertRevision, openDb, revisionExists } from '../server/db.js'

let tmpCounter = 0
function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), `deepview-db-${++tmpCounter}-`))
  const file = path.join(dir, 'data.db')
  const handle = openDb(file)
  return {
    handle,
    cleanup: () => {
      handle.close()
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
  it('creates the workspace_revision table on a fresh DB', () => {
    const { handle, cleanup } = freshDb()
    try {
      // Insert one revision to verify the table is queryable.
      insertRevision(handle, rev({ id: 'r1' }))
      assert.equal(revisionExists(handle, 'tag-A', 'r1'), true)
    } finally { cleanup() }
  })

  it('migrates a legacy DB created before the keyframe column existed', () => {
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
        const head = headFor(handle, 'tag-A')
        assert.equal(head, 'pre-migration')
        const chain = chainFrom(handle, 'tag-A', null)
        assert.equal(chain.length, 1)
        assert.equal(chain[0].keyframe, 0, 'legacy revs default to non-keyframe')

        // New revs going in carry the keyframe flag.
        insertRevision(handle, rev({ id: 'post-migration', keyframe: true }))
        const chainAfter = chainFrom(handle, 'tag-A', null)
        // After a keyframe lands, chainFrom(null) returns from the
        // most-recent keyframe forward — so just the keyframe rev.
        assert.equal(chainAfter.length, 1)
        assert.equal(chainAfter[0].id, 'post-migration')
        assert.equal(chainAfter[0].keyframe, 1)
      } finally { handle.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('survives a second openDb call on the same file (idempotent migration)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-reopen-${++tmpCounter}-`))
    const file = path.join(dir, 'data.db')
    try {
      const h1 = openDb(file)
      insertRevision(h1, rev({ id: 'r1' }))
      h1.close()
      // Re-open — the schema CREATE-IF-NOT-EXISTS is idempotent, and
      // the ALTER TABLE in openDb is wrapped in try/catch so the
      // duplicate-column-name path doesn't escape.
      const h2 = openDb(file)
      try {
        // Pre-existing data is still readable.
        assert.equal(headFor(h2, 'tag-A'), 'r1')
      } finally { h2.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('headFor', () => {
  it('returns null for an unknown workspace tag', () => {
    const { handle, cleanup } = freshDb()
    try {
      assert.equal(headFor(handle, 'never-seen'), null)
    } finally { cleanup() }
  })

  it('returns the most recent revision id', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'first' }))
      insertRevision(handle, rev({ id: 'second', base: 'first' }))
      insertRevision(handle, rev({ id: 'third', base: 'second' }))
      assert.equal(headFor(handle, 'tag-A'), 'third')
    } finally { cleanup() }
  })

  it('scopes by workspace tag', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ tag: 'A', id: 'a1' }))
      insertRevision(handle, rev({ tag: 'B', id: 'b1' }))
      insertRevision(handle, rev({ tag: 'A', id: 'a2', base: 'a1' }))
      assert.equal(headFor(handle, 'A'), 'a2')
      assert.equal(headFor(handle, 'B'), 'b1')
    } finally { cleanup() }
  })
})

describe('chainFrom — cutoff semantics', () => {
  it('returns the full chain when from=null and no keyframe has landed', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      insertRevision(handle, rev({ id: 'r2', base: 'r1' }))
      insertRevision(handle, rev({ id: 'r3', base: 'r2' }))
      const chain = chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2', 'r3'])
    } finally { cleanup() }
  })

  it('returns from the latest keyframe forward when from=null and a keyframe exists', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      insertRevision(handle, rev({ id: 'r2', base: 'r1' }))
      insertRevision(handle, rev({ id: 'kf1', base: 'r2', keyframe: true }))
      insertRevision(handle, rev({ id: 'r4', base: 'kf1' }))
      insertRevision(handle, rev({ id: 'r5', base: 'r4' }))
      const chain = chainFrom(handle, 'tag-A', null)
      assert.deepEqual(chain.map((r) => r.id), ['kf1', 'r4', 'r5'])
    } finally { cleanup() }
  })

  it('returns only newer revisions when from=<known id>', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      insertRevision(handle, rev({ id: 'r2', base: 'r1' }))
      insertRevision(handle, rev({ id: 'r3', base: 'r2' }))
      insertRevision(handle, rev({ id: 'r4', base: 'r3' }))
      const chain = chainFrom(handle, 'tag-A', 'r2')
      assert.deepEqual(chain.map((r) => r.id), ['r3', 'r4'])
    } finally { cleanup() }
  })

  it('returns an empty chain when from=<head> (caller is up-to-date)', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      insertRevision(handle, rev({ id: 'r2', base: 'r1' }))
      assert.deepEqual(chainFrom(handle, 'tag-A', 'r2'), [])
    } finally { cleanup() }
  })

  it('falls back to the keyframe path when from=<unknown id>', () => {
    // A client supplies a `from` the server doesn't recognise (DB
    // reset / chain compaction / malicious peer). chainFrom skips
    // past everything before the latest keyframe, same as from=null.
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      insertRevision(handle, rev({ id: 'kf1', base: 'r1', keyframe: true }))
      insertRevision(handle, rev({ id: 'r3', base: 'kf1' }))
      const chain = chainFrom(handle, 'tag-A', 'never-existed')
      assert.deepEqual(chain.map((r) => r.id), ['kf1', 'r3'])
    } finally { cleanup() }
  })

  it('returns full chain on from=<unknown id> when no keyframe ever landed', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      insertRevision(handle, rev({ id: 'r2', base: 'r1' }))
      const chain = chainFrom(handle, 'tag-A', 'never-existed')
      assert.deepEqual(chain.map((r) => r.id), ['r1', 'r2'])
    } finally { cleanup() }
  })

  it('chain entries carry every signed-payload field for re-verification', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1', nonce: 'NN', ciphertext: 'CT', signature: 'SG' }))
      const [row] = chainFrom(handle, 'tag-A', null)
      assert.equal(row.id, 'r1')
      assert.equal(row.base, null)
      assert.equal(row.keyframe, 0)
      assert.equal(row.nonce, 'NN')
      assert.equal(row.ciphertext, 'CT')
      assert.equal(row.signature, 'SG')
    } finally { cleanup() }
  })
})

describe('insertRevision', () => {
  it('assigns monotonic seq starting from 1', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      insertRevision(handle, rev({ id: 'r2' }))
      insertRevision(handle, rev({ id: 'r3' }))
      const ordered = chainFrom(handle, 'tag-A', null)
      assert.deepEqual(ordered.map((r) => r.id), ['r1', 'r2', 'r3'])
    } finally { cleanup() }
  })

  it('UNIQUE (workspace_tag, id) blocks the same id from being inserted twice', () => {
    // The protocol relies on this for retransmit idempotency: a
    // client retrying a save under the same (tag, id) must NOT
    // create a duplicate row, even if the seq would be different.
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'dup' }))
      assert.throws(
        () => insertRevision(handle, rev({ id: 'dup' })),
        /UNIQUE constraint failed/iu,
      )
      // Chain is unchanged: the second insert was rejected.
      const chain = chainFrom(handle, 'tag-A', null)
      assert.equal(chain.length, 1)
    } finally { cleanup() }
  })

  it('different tags can share the same revision id (per-tag scope)', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ tag: 'A', id: 'shared' }))
      insertRevision(handle, rev({ tag: 'B', id: 'shared' }))
      assert.equal(headFor(handle, 'A'), 'shared')
      assert.equal(headFor(handle, 'B'), 'shared')
    } finally { cleanup() }
  })

  it('keyframe boolean is stored as 1 / 0', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1', keyframe: false }))
      insertRevision(handle, rev({ id: 'r2', keyframe: true }))
      // chainFrom(null) skips past everything before the latest
      // keyframe — so only `r2` (the keyframe) comes back. To inspect
      // r1's flag too, ask from r1 forward.
      const fromR1 = chainFrom(handle, 'tag-A', 'r1')
      assert.equal(fromR1.length, 1)
      assert.equal(fromR1[0].id, 'r2')
      assert.equal(fromR1[0].keyframe, 1, 'keyframe rev stored as 1')

      const fromHeadBack = chainFrom(handle, 'tag-A', null)
      assert.equal(fromHeadBack.length, 1, 'keyframe-cutoff returns only kf forward')
      assert.equal(fromHeadBack[0].keyframe, 1)

      // Insert a non-keyframe AFTER and verify it stores 0.
      insertRevision(handle, rev({ id: 'r3', base: 'r2', keyframe: false }))
      const post = chainFrom(handle, 'tag-A', 'r2')
      assert.equal(post[0].keyframe, 0, 'non-keyframe rev stored as 0')
    } finally { cleanup() }
  })

  it('null base is preserved (first revision in a chain)', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1', base: null }))
      const [row] = chainFrom(handle, 'tag-A', null)
      assert.equal(row.base, null)
    } finally { cleanup() }
  })
})

describe('revisionExists', () => {
  it('returns true for an inserted revision, false otherwise', () => {
    const { handle, cleanup } = freshDb()
    try {
      insertRevision(handle, rev({ id: 'r1' }))
      assert.equal(revisionExists(handle, 'tag-A', 'r1'), true)
      assert.equal(revisionExists(handle, 'tag-A', 'nope'), false)
      assert.equal(revisionExists(handle, 'tag-B', 'r1'), false, 'scoped by tag')
    } finally { cleanup() }
  })
})
