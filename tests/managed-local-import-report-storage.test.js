import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipBytes } from '../common/gzip.js'
import { createManagedLocalImportSource } from '../client/managed/local-import.js'
import { ManagedLocalImport } from '../ui/managed/local-import.js'
import * as storage from '../client/storage.js'
import * as vault from '../client/passkey-vault.js'
import { importContentKey } from '../client/passkey-crypto.ts'

const files = new Map()
const missing = () => new DOMException('Missing', 'NotFoundError')
const dir = {
  *entries() { for (const name of files.keys()) yield [name, { kind: 'file' }] },
  getFileHandle(name, { create = false } = {}) {
    if (!files.has(name)) { if (!create) throw missing(); files.set(name, new Uint8Array()) }
    return {
      getFile: () => ({ arrayBuffer: () => files.get(name).slice().buffer }),
      createWritable: () => {
        let pending
        return { write(bytes) { pending = bytes.slice() }, close() { files.set(name, pending) }, abort() {} }
      },
    }
  },
  removeEntry(name) { if (!files.delete(name)) throw missing() },
}
navigator.storage = { getDirectory: () => ({ getDirectoryHandle: () => dir }) }

test('reselecting a report after refocus imports current disk bytes despite a warm text cache', async () => {
  for (const [backend, encoding] of [['opfs', 'gzip'], ['localStorage', 'gzip'], ['opfs', 'encrypted'], ['opfs', 'plain']]) {
    vault.__test__.reset()
    if (encoding === 'encrypted') {
      vault.__test__.setSessionKeyForTesting(await importContentKey(new Uint8Array(32).fill(42)))
      localStorage.setItem('deepview.passkey.v1', JSON.stringify({ enabled: true, credentialId: 'test-cred', prfSalt: 'test', userId: 'test-user' }))
    }
    const name = `${backend}-${encoding}.json`
    const before = '{"findings":[{"id":"before"}]}'
    const after = '{"findings":[{"id":"after"}]}'
    await storage.saveFile(name, before)
    const uploads = []
    const host = { localImportSource: createManagedLocalImportSource(), addController() {}, requestUpdate() {} }
    const ui = new ManagedLocalImport(host, 'report', file => { uploads.push(file) })
    ui.hostConnected()
    try {
      ui.toggle()
      await ui.refresh()
      ui.value = name
      await ui.importSelected()
      assert.equal(await uploads[0].text(), before)
      // A sibling document writes without notifying this realm's registries.
      let bytes = new TextEncoder().encode(after)
      if (encoding !== 'plain') bytes = await gzipBytes(bytes)
      if (encoding === 'encrypted') bytes = await vault.sealForOpfs(bytes, name)
      if (backend === 'opfs') files.set(name, bytes)
      else { files.delete(name); localStorage.setItem('deepview.report:' + name, bytes.toBase64()) }
      assert.equal(await storage.readFile(name), before, 'the ordinary reader still has its cached text')
      globalThis.dispatchEvent(new Event('focus'))
      await ui.refresh()
      ui.value = name
      await ui.importSelected()
      assert.equal(ui.error, '')
      assert.equal(await uploads[1].text(), after)
    } finally { ui.hostDisconnected(); vault.__test__.reset() }
  }
})
