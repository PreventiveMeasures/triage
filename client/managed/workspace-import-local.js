// Lazy reader; dependency handles use the main bundle's storage/vault session.
export function localTriageReader(deps) {
  const locked = () => deps.isEncryptionEnabled() && !deps.isUnlocked()
  return {
    get locked() { return locked() },
    unlock: options => deps.unlockEncryption(options),
    async read({ signal } = {}) {
      let changed = false
      const off = deps.onVaultStateChange(() => { changed = true })
      const check = () => {
        signal?.throwIfAborted()
        if (locked() || changed) throw new Error('Local data was locked or changed. Unlock it and import triage again.')
      }
      try {
        check()
        const triage = await deps.readTriageBlob()
        check()
        return triage
      } finally { off() }
    },
  }
}

export function localWorkspaceReader(deps) {
  const locked = () => deps.isEncryptionEnabled() && !deps.isUnlocked()
  async function workspaces() {
    const raw = JSON.parse(await deps.hydrateKey('deepview.workspaces') || '[]')
    return (Array.isArray(raw) ? raw : raw.workspaces ?? []).filter(ws => typeof ws.id === 'string' && typeof ws.name === 'string')
  }
  async function guarded(work, signal) {
    let changed = false
    const off = [deps.onVaultStateChange, deps.onFileMutated, deps.onBundleMutated].map(subscribe => subscribe(() => { changed = true }))
    const check = () => {
      signal?.throwIfAborted()
      if (locked() || changed) throw new Error('Local data was locked or changed. Unlock it and select the workspace again.')
    }
    try { check(); const result = await work(check); check(); return result }
    finally { off.forEach(unsubscribe => unsubscribe()) }
  }
  return {
    get locked() { return locked() },
    unlock: options => deps.unlockEncryption(options),
    list: ({ signal } = {}) => guarded(async () => (await workspaces()).map(ws => ({ id: ws.id, name: ws.name })), signal),
    read: (id, { signal } = {}) => guarded(async check => {
      const ws = (await workspaces()).find(row => row.id === id)
      if (!ws) throw new Error('This local workspace no longer exists.')
      const snapshot = JSON.stringify(ws)
      const repoUrls = JSON.parse(await deps.hydrateKey('deepview.repoUrls') || '{}')
      const reports = []
      for (const name of ws.reports ?? []) {
        check()
        const content = await deps.withStoredItem('report', name, () => deps.readFile(name))
        check()
        reports.push({ name, content, ...(repoUrls[name] ? { repo: { github: repoUrls[name] } } : {}) })
      }
      const bundles = await deps.listBundles()
      const bundleBlobs = []
      for (const integrity of ws.bundles ?? []) {
        check()
        const meta = bundles.find(row => row.integrity === integrity)
        if (!meta) continue
        const bytes = await deps.withStoredItem('bundle', integrity, () => deps.readBundle(integrity))
        check()
        bundleBlobs.push({ integrity, name: meta.name, data: bytes.toBase64() })
      }
      const triage = await deps.readTriageBlob() ?? {}
      if (JSON.stringify((await workspaces()).find(row => row.id === id)) !== snapshot) throw new Error('The local workspace changed. Select it again.')
      // Private keys never leave the local source.
      return { version: 1, workspace: { id, name: ws.name, privateKey: '' }, reports,
        bundles: ws.bundles ?? [], bundleBlobs, triage, repoUrls }
    }, signal),
  }
}
