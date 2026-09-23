import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeTeamPath } from '../server-managed/repo-path.ts'

test('repository scopes preserve complete paths and reject oversized normalized values', () => {
  const boundary = 'a/'.repeat(249) + 'aa'
  assert.equal(boundary.length, 500)
  assert.deepEqual(normalizeTeamPath(boundary), { ok: true, path: boundary })
  assert.deepEqual(normalizeTeamPath(`/./${boundary}//`), { ok: true, path: boundary }, 'length is checked after normalization')
  for (const suffix of ['x', 'y', '/child']) {
    assert.deepEqual(normalizeTeamPath(boundary + suffix), { ok: false }, 'distinct directories must never collapse to the 500-character prefix')
  }
  assert.deepEqual(normalizeTeamPath('pkg/a//./sub'), { ok: true, path: 'pkg/a/sub' })
  assert.deepEqual(normalizeTeamPath('pkg/a/../b'), { ok: false })
  assert.deepEqual(normalizeTeamPath('/./'), { ok: true, path: null })
})

test('repository scopes never trim directory names or reinterpret literal Git path characters', () => {
  for (const space of [' ', '\u00A0', '\u1680', '\u2000', '\u2028', '\u202F', '\u3000', '\uFEFF']) {
    for (const path of [`${space}packages/auth`, `packages/auth${space}`, `./${space}packages/auth/`, `packages/auth${space}/sub`, space]) {
      assert.deepEqual(normalizeTeamPath(path), { ok: false }, `reject ${JSON.stringify(path)} rather than changing its identity`)
    }
  }
  assert.deepEqual(normalizeTeamPath('packages\\auth'), { ok: false }, 'a literal backslash is not a Git path separator')
  assert.deepEqual(normalizeTeamPath('packages/auth tools/sub'), { ok: true, path: 'packages/auth tools/sub' }, 'internal spaces keep their identity')
  assert.deepEqual(normalizeTeamPath('packages/Auth'), { ok: true, path: 'packages/Auth' }, 'case is preserved')
  assert.deepEqual(normalizeTeamPath(''), { ok: true, path: null })
})

test('repository scopes reject control characters before normalization can alias another directory', () => {
  assert.deepEqual(normalizeTeamPath('packages/auth'), { ok: true, path: 'packages/auth' })
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)]) {
    const char = String.fromCodePoint(code)
    for (const path of [`packages/au${char}th`, `${char}packages/auth`, `packages/auth${char}`, char]) {
      assert.deepEqual(normalizeTeamPath(path), { ok: false }, `reject ${JSON.stringify(path)} without changing its identity`)
    }
  }
})
