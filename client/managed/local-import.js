import { hasStoredBundleBytes, listBundles, listFiles, onBundleMutated, onFileMutated, readBundle, readFileFresh, withStoredItem } from '../storage.js'
import { isEncryptionEnabled, isUnlocked, onVaultStateChange, unlockEncryption } from '../passkey-vault.js'
import { getFileKinds } from '../counts.js'
import { LINKS_KIND, parseLinkedFindings } from '../linked-findings.js'

// Created in the main bundle and injected into the lazy Manage pages. Importing
// storage/vault from that separate entry would create a second, locked session.
const defaultDeps = {
  getFileKinds, hasStoredBundleBytes, listBundles, listFiles, onBundleMutated, onFileMutated, readBundle, readFile: readFileFresh, withStoredItem,
  isEncryptionEnabled, isUnlocked, onVaultStateChange, unlockEncryption,
}
export function createManagedLocalImportSource(deps = defaultDeps) {
  const locked = () => deps.isEncryptionEnabled() && !deps.isUnlocked()
  const guard = (signal, kind, value) => {
    let changed = false
    let itemChanged = false
    const offVault = deps.onVaultStateChange(() => { changed = true })
    // Both readers can finish with an old snapshot after a mutation. Watch the
    // selected filename/integrity from before listing until upload handoff.
    const subscribeItem = kind === 'report' ? deps.onFileMutated : deps.onBundleMutated
    const offItem = value === undefined ? null : subscribeItem(id => {
      if (id === value) itemChanged = true
    })
    return {
      check() {
        signal?.throwIfAborted()
        if (locked() || changed) throw new Error('Local data is locked or has changed. Unlock it and select the file again.')
        if (itemChanged) throw new Error(`This local ${kind} changed. Select it again before importing.`)
      },
      unsubscribe() { offVault(); offItem?.() },
    }
  }
  const reportNames = async () => {
    const names = await deps.listFiles()
    if (names.length === 0) return names
    const kinds = await deps.getFileKinds(names)
    return names.filter(name => kinds.get(name) !== LINKS_KIND)
  }
  const choices = async (kind) => kind === 'report'
    ? (await reportNames()).map(name => ({ value: name, label: name }))
    : (await deps.listBundles()).map(bundle => ({ value: bundle.integrity, label: bundle.name, secondary: bundle.integrity }))
  return {
    get locked() { return locked() },
    async hasData(kind) {
      // Presence probes are safe while locked; don't decrypt bundle metadata.
      if (kind === 'report') return (await reportNames()).length > 0
      return locked() ? deps.hasStoredBundleBytes() : (await deps.listBundles()).length > 0
    },
    async list(kind) {
      const access = guard()
      try {
        access.check()
        const items = await choices(kind)
        access.check()
        return items
      } finally { access.unsubscribe() }
    },
    unlock(options) { return deps.unlockEncryption(options) },
    subscribe(callback) {
      const offVault = deps.onVaultStateChange(() => callback())
      const offFiles = deps.onFileMutated(value => callback({ kind: 'report', value }))
      const offBundles = deps.onBundleMutated(value => callback({ kind: 'bundle', value }))
      return () => { offVault(); offFiles(); offBundles() }
    },
    async importItem(kind, value, upload, { signal } = {}) {
      const access = guard(signal, kind, value)
      try {
        access.check()
        const { result: uploadResult } = await deps.withStoredItem(kind, value, async () => {
          access.check()
          const item = (await choices(kind)).find(option => option.value === value)
          access.check()
          if (!item) throw new Error('This file is no longer in local storage. Select another file.')
          const content = kind === 'report' ? await deps.readFile(value) : await deps.readBundle(value)
          access.check()
          // Kind metadata can be missing or stale; validate the selected bytes
          // too, without reading every local document to populate the picker.
          if (kind === 'report' && parseLinkedFindings(content)) throw new Error('Links files cannot be imported as reports. Select a report.')
          const file = new File([content], item.label, { type: kind === 'report' ? 'text/plain' : 'application/octet-stream' })
          // Start the upload synchronously after the last guard. Later local
          // changes or a vault lock cannot recall an already sent upload.
          // Box the upload promise so the lock covers only the local read and
          // handoff, not the server response. Release the mutation guard here too.
          try {
            const result = Promise.resolve(upload(file))
            // Web Locks may settle on a later task than an immediate rejection.
            // Mark it handled now; returning it below still propagates failure.
            void result.catch(() => {})
            return { result }
          } finally { access.unsubscribe() }
        })
        return uploadResult
      } finally { access.unsubscribe() }
    },
  }
}
