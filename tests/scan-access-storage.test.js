import './_polyfills.js'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { forgetScanAccess, hasSavedScanAccess, readSavedScanAccess, saveScanAccess } from '../client/scan-access.js'
import * as storage from '../client/secure-storage.js'
import * as vault from '../client/passkey-vault.js'
import { hasEnvelopeMagic, importContentKey, openEnvelope } from '../client/passkey-crypto.ts'

const KEY = 'deepview.scan.access'
const credentials = { server: 'https://scan.example/', deepview: 'deepview-test-key', provider: 'anthropic', token: 'sk-ant-test-token' }

beforeEach(() => {
  storage.__test__.reset()
  vault.__test__.reset()
  localStorage.clear()
})

test('Save keeps one credential object, restores only for the same service, and Forget removes it', async () => {
  assert.equal(hasSavedScanAccess(), false)
  await saveScanAccess(credentials)
  assert.deepEqual(JSON.parse(localStorage.getItem(KEY)), credentials)
  storage.__test__.reset()
  await storage.hydrate()
  assert.equal(hasSavedScanAccess(), true)
  assert.deepEqual(readSavedScanAccess(credentials.server), credentials)
  assert.equal(readSavedScanAccess('https://different.example/'), null)
  assert.equal(readSavedScanAccess('https://scan.example/other/'), null)
  assert.equal(hasSavedScanAccess(), true, 'Forget remains available even for another service')
  await forgetScanAccess()
  assert.equal(hasSavedScanAccess(), false)
  assert.equal(localStorage.getItem(KEY), null)
})

test('credentials use a single encrypted envelope and survive hydration and encryption migration', async () => {
  await saveScanAccess(credentials)
  const key = await importContentKey(new Uint8Array(32).fill(42))
  vault.__test__.setSessionKeyForTesting(key)
  await storage.migrateToEncrypted({})
  const bytes = Uint8Array.fromBase64(localStorage.getItem(KEY))
  assert.ok(hasEnvelopeMagic(bytes))
  assert.equal(localStorage.getItem(KEY).includes(credentials.deepview), false)
  const aad = new TextEncoder().encode(`deepview.secure.v1|test-user|${KEY}`)
  const decoded = await openEnvelope(key, bytes, aad)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decoded)), credentials)
  storage.__test__.reset()
  await storage.hydrate()
  assert.deepEqual(readSavedScanAccess(credentials.server), credentials)
  const updated = { ...credentials, token: 'sk-ant-updated-token' }
  await saveScanAccess(updated)
  assert.ok(hasEnvelopeMagic(Uint8Array.fromBase64(localStorage.getItem(KEY))))
  await storage.migrateToPlaintext({ open: (data, tag) => openEnvelope(key, data, tag) })
  assert.deepEqual(JSON.parse(localStorage.getItem(KEY)), updated)
})

test('a locked vault refuses to save credentials as plaintext', async () => {
  localStorage.setItem('deepview.passkey.v1', JSON.stringify({ enabled: true, credentialId: 'cred', prfSalt: 'salt', userId: 'user', createdAt: Date.now() }))
  assert.equal(vault.isEncryptionEnabled(), true)
  await assert.rejects(saveScanAccess(credentials), /vault locked/u)
  assert.equal(localStorage.getItem(KEY), null)
  assert.equal(hasSavedScanAccess(), false)
})

test('malformed saved values can be forgotten and a failed save never claims to be saved', async () => {
  await storage.setItem(KEY, 'invalid-json')
  assert.equal(readSavedScanAccess(credentials.server), null)
  assert.equal(hasSavedScanAccess(), true)
  await forgetScanAccess()
  const original = localStorage.setItem
  localStorage.setItem = () => { throw new Error('quota exceeded') }
  try {
    await assert.rejects(saveScanAccess(credentials), /quota exceeded/u)
    assert.equal(hasSavedScanAccess(), false)
  } finally { localStorage.setItem = original }
})

test('saved Moonshot selections use the provider ID independently of model prefixes', async () => {
  const moonshot = { ...credentials, provider: 'moonshot', token: 'sk-kimi-test' }
  await saveScanAccess(moonshot)
  assert.deepEqual(readSavedScanAccess(credentials.server), moonshot)
  await storage.setItem(KEY, JSON.stringify({ ...moonshot, provider: 'moonshotai' }))
  assert.deepEqual(readSavedScanAccess(credentials.server), moonshot, 'restore earlier saved selections with the correct provider ID')
})
