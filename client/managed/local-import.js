import { hasAnyBundles, listBundles, listFiles, onFileMutated, readBundle, readFile } from '../storage.js'
import { isEncryptionEnabled, isUnlocked, onVaultStateChange, unlockEncryption } from '../passkey-vault.js'

// Created in the main bundle and injected into the lazy Manage pages. Importing
// storage/vault from that separate entry would create a second, locked session.
const defaultDeps = {
  hasAnyBundles, listBundles, listFiles, onFileMutated, readBundle, readFile,
  isEncryptionEnabled, isUnlocked, onVaultStateChange, unlockEncryption,
}
export function createManagedLocalImportSource(deps = defaultDeps) {
  const locked = () => deps.isEncryptionEnabled() && !deps.isUnlocked()
  const guard = (signal) => {
    let changed = false
    const unsubscribe = deps.onVaultStateChange(() => { changed = true })
    return {
      check() {
        signal?.throwIfAborted()
        if (locked() || changed) throw new Error('Local data is locked or has changed. Unlock it and select the file again.')
      },
      unsubscribe,
    }
  }
  const choices = async (kind) => kind === 'report'
    ? (await deps.listFiles()).map(name => ({ value: name, label: name }))
    : (await deps.listBundles()).map(bundle => ({ value: bundle.integrity, label: bundle.name, secondary: bundle.integrity }))
  return {
    get locked() { return locked() },
    async hasData(kind) {
      // Presence probes are safe while locked; don't decrypt bundle metadata.
      if (kind === 'report') return (await deps.listFiles()).length > 0
      return locked() ? deps.hasAnyBundles() : (await deps.listBundles()).length > 0
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
      const offVault = deps.onVaultStateChange(callback)
      const offFiles = deps.onFileMutated(callback)
      return () => { offVault(); offFiles() }
    },
    async importItem(kind, value, upload, { signal } = {}) {
      const access = guard(signal)
      try {
        access.check()
        const item = (await choices(kind)).find(option => option.value === value)
        access.check()
        if (!item) throw new Error('This file is no longer in local storage. Select another file.')
        const content = kind === 'report' ? await deps.readFile(value) : await deps.readBundle(value)
        access.check()
        const file = new File([content], item.label, { type: kind === 'report' ? 'text/plain' : 'application/octet-stream' })
        // Start the upload synchronously after the last guard. The vault only
        // gates access to local bytes; a later lock cannot recall a sent upload.
        return upload(file)
      } finally { access.unsubscribe() }
    },
  }
}
