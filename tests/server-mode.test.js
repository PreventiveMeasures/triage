import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyServerMode, parseServerInfo } from '../client/sync/server-mode.ts'

test('parseServerInfo: valid e2e (managed absent or null both normalize to null)', () => {
  assert.deepEqual(parseServerInfo({ mode: 'e2e' }), { mode: 'e2e', managed: null })
  assert.deepEqual(parseServerInfo({ mode: 'e2e', managed: null }), { mode: 'e2e', managed: null })
  // The `server-info` frame carries a `type` discriminant — ignored.
  assert.deepEqual(
    parseServerInfo({ type: 'server-info', mode: 'e2e', managed: null }),
    { mode: 'e2e', managed: null },
  )
})

test('parseServerInfo: valid managed with login entry points', () => {
  assert.deepEqual(
    parseServerInfo({ mode: 'managed', managed: { loginPath: '/api/auth/github/login', cookieName: '__Host-dvsid' } }),
    { mode: 'managed', managed: { loginPath: '/api/auth/github/login', cookieName: '__Host-dvsid' } },
  )
})

test('parseServerInfo: managed object with a malformed shape degrades to managed:null', () => {
  assert.deepEqual(parseServerInfo({ mode: 'managed', managed: { loginPath: 5 } }), { mode: 'managed', managed: null })
  assert.deepEqual(parseServerInfo({ mode: 'managed', managed: { loginPath: '/x' } }), { mode: 'managed', managed: null })
  assert.deepEqual(parseServerInfo({ mode: 'managed', managed: 'nope' }), { mode: 'managed', managed: null })
})

test('parseServerInfo: rejects non-objects and unknown modes', () => {
  assert.equal(parseServerInfo(null), null)
  assert.equal(parseServerInfo(undefined), null)
  assert.equal(parseServerInfo('e2e'), null)
  assert.equal(parseServerInfo(42), null)
  assert.equal(parseServerInfo({}), null)
  assert.equal(parseServerInfo({ mode: 'other' }), null)
  assert.equal(parseServerInfo({ mode: '' }), null)
})

test('classifyServerMode: first / match / mismatch', () => {
  // Nothing cached yet — accept whatever the server reports.
  assert.equal(classifyServerMode(null, 'e2e'), 'first')
  assert.equal(classifyServerMode(null, 'managed'), 'first')
  // Same protocol — proceed.
  assert.equal(classifyServerMode('e2e', 'e2e'), 'match')
  assert.equal(classifyServerMode('managed', 'managed'), 'match')
  // Cross-mode — refused (both directions).
  assert.equal(classifyServerMode('e2e', 'managed'), 'mismatch')
  assert.equal(classifyServerMode('managed', 'e2e'), 'mismatch')
})
