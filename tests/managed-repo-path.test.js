import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeTeamPath } from '../server-managed/repo-path.ts'

test('repository scopes preserve complete paths and reject oversized normalized values', () => {
  const boundary = 'a/'.repeat(249) + 'aa'
  assert.equal(boundary.length, 500)
  assert.deepEqual(normalizeTeamPath(boundary), { ok: true, path: boundary })
  assert.deepEqual(normalizeTeamPath(` /./${boundary}// `), { ok: true, path: boundary }, 'length is checked after normalization')
  for (const suffix of ['x', 'y', '/child']) {
    assert.deepEqual(normalizeTeamPath(boundary + suffix), { ok: false }, 'distinct directories must never collapse to the 500-character prefix')
  }
  assert.deepEqual(normalizeTeamPath('pkg\\a//./sub'), { ok: true, path: 'pkg/a/sub' })
  assert.deepEqual(normalizeTeamPath('pkg/a/../b'), { ok: false })
  assert.deepEqual(normalizeTeamPath('/./'), { ok: true, path: null })
})
