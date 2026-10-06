import { readManagedReport } from '../../common/managed/report-content.ts'
import { computeSha512Integrity } from '../../common/integrity.js'

const collection = kind => kind === 'bundle' ? 'bundles' : 'reports'
const reportKey = (hash, analyzer) => JSON.stringify([hash, analyzer || ''])
const storedKeys = (kind, rows) => new Set(rows.map(row => kind === 'bundle' ? row.integrity : reportKey(row.sha256, row.analyzer)))

async function reportIdentity(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const parsed = readManagedReport(new TextDecoder().decode(bytes), file.name)
  if (!parsed.data) throw new Error(parsed.reason ?? 'Not a recognized report')
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toBase64({ alphabet: 'base64url', omitPadding: true })
  return { hash, key: reportKey(hash, typeof parsed.data.source === 'string' ? parsed.data.source : null) }
}

export async function prepareLocalContentImport(kind, { source, deps, api, signal }) {
  const raw = JSON.parse(await deps.hydrateKey('deepview.workspaces') || '[]')
  const workspaces = (Array.isArray(raw) ? raw : raw.workspaces ?? []).filter(ws => typeof ws.id === 'string' && typeof ws.name === 'string')
  signal.throwIfAborted()
  const options = await source.list(kind)
  const known = storedKeys(kind, (await api.send(`/api/admin/${collection(kind)}`))[collection(kind)])
  const groups = workspaces.map(ws => ({ id: ws.id, name: ws.name, items: [] }))
  const ungrouped = { id: null, name: 'Not in a workspace', items: [] }
  const items = []
  for (const option of options) {
    signal.throwIfAborted()
    const item = { value: option.value, name: option.label, key: option.value, synced: false, present: false, error: '' }
    if (kind === 'report') {
      try {
        Object.assign(item, await source.importItem(kind, item.value, reportIdentity, { signal }))
        item.syncHash = await deps.reportSyncHash(item.value)
      }
      catch (err) { signal.throwIfAborted(); item.error = String(err?.message ?? err) }
    }
    signal.throwIfAborted()
    item.present = known.has(item.key)
    let grouped = false
    workspaces.forEach((ws, index) => {
      if (!ws[collection(kind)]?.includes(item.value)) return
      const status = deps.localContentSyncStatus(ws.id, kind, item.value, item.syncHash)
      item.synced ||= status.synced
      groups[index].items.push({ item, ...status })
      grouped = true
    })
    if (!grouped) ungrouped.items.push({ item, synced: false, cached: false })
    items.push(item)
  }
  return { kind, items, groups: [...groups, ungrouped].filter(group => group.items.length > 0) }
}

export async function runLocalContentImport(plan, selected, { source, api, signal, progress = () => {}, imported = new Set() }) {
  const { kind } = plan
  const known = storedKeys(kind, (await api.send(`/api/admin/${collection(kind)}`))[collection(kind)])
  const chosen = new Set(selected)
  for (const item of plan.items) {
    signal.throwIfAborted()
    if (!chosen.has(item.value) || item.error || item.present) continue
    if (known.has(item.key)) { item.present = true; continue }
    progress(`Importing ${item.name}…`)
    await source.importItem(kind, item.value, async file => {
      const key = kind === 'report' ? (await reportIdentity(file)).key : await computeSha512Integrity(new Uint8Array(await file.arrayBuffer()))
      signal.throwIfAborted()
      if (key !== item.key) throw new Error(`${item.name} changed. Choose files again before importing.`)
      // No location override, workspace, team, triage or visibility mutations.
      // The ordinary upload endpoint applies only the file's embedded defaults.
      const result = await api.send(`/api/admin/${collection(kind)}`, file, { [`x-${kind}-filename`]: encodeURIComponent(file.name) })
      if (result.conflict) throw new Error(`Could not import ${item.name}. Try again.`)
    }, { signal })
    known.add(item.key); item.present = true; imported.add(item.value)
  }
  return imported.size
}
