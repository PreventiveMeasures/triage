import './_polyfills.js'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createManagedLocalImportSource } from '../client/managed/local-import.js'
import { getKind } from '../client/counts.js'
import { importContentKey } from '../client/passkey-crypto.ts'
import * as secureStorage from '../client/secure-storage.js'
import * as vault from '../client/passkey-vault.js'

const COUNTS_KEY = 'deepview.fileCounts'
const counts = (source = 'links') => JSON.stringify({ __v: 4, 'links.json': { count: 2, source } })
const names = new Set()
const dir = {
  *entries() { for (const name of names) yield [name, { kind: 'file' }] },
  getFileHandle() { assert.fail('presence and picker choices must not read local documents') },
}
navigator.storage = { getDirectory: () => ({ getDirectoryHandle: () => dir }) }

beforeEach(() => {
  vault.__test__.reset()
  secureStorage.__test__.reset()
  localStorage.clear()
  names.clear()
})

test('fresh managed report import loads persisted kinds without hydrating unrelated local state', async (t) => {
  assert.equal(getKind('links.json'), undefined, 'the sidebar kind cache can already be empty')
  names.add('links.json')
  localStorage.setItem(COUNTS_KEY, counts())
  localStorage.setItem('deepview.workspaces', '[{"id":"private-workspace"}]')
  let fullHydrations = 0
  t.after(secureStorage.onAfterHydrate(() => { fullHydrations++ }))
  const source = createManagedLocalImportSource()
  assert.equal(await source.hasData('report'), false)
  assert.deepEqual(await source.list('report'), [])
  names.add('report.json')
  assert.equal(await source.hasData('report'), true)
  assert.deepEqual(await source.list('report'), [{ value: 'report.json', label: 'report.json' }])
  assert.equal(secureStorage.getItem('deepview.workspaces'), null)
  assert.equal(fullHydrations, 0, 'import metadata must not start the local boot subscribers')
  // A later refresh uses current persisted kinds, not the earlier sidebar cache.
  localStorage.setItem(COUNTS_KEY, counts('deepsec'))
  assert.deepEqual((await source.list('report')).map(item => item.value), ['links.json', 'report.json'])
})

test('encrypted kind metadata is loaded after unlock even after a locked presence probe', async () => {
  const key = await importContentKey(new Uint8Array(32).fill(42))
  vault.__test__.setSessionKeyForTesting(key)
  await secureStorage.setItem(COUNTS_KEY, counts())
  vault.__test__.reset()
  secureStorage.__test__.reset()
  localStorage.setItem('deepview.passkey.v1', JSON.stringify({ enabled: true, credentialId: 'test-cred', prfSalt: 'test', userId: 'test-user' }))
  names.add('links.json')
  const source = createManagedLocalImportSource()
  assert.equal(source.locked, true)
  assert.equal(await source.hasData('report'), true, 'encrypted kinds are unknown until the user unlocks')
  assert.equal(secureStorage.getItem(COUNTS_KEY), null)
  await assert.rejects(source.list('report'), /locked/u)
  vault.__test__.setSessionKeyForTesting(key)
  assert.equal(await source.hasData('report'), false)
  assert.deepEqual(await source.list('report'), [])
})
