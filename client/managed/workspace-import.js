import { parseWorkspaceBundleBytes, parseWorkspaceJson } from '../workspace-format.js'
import { isEncryptedBundle } from '../workspace-bundle-crypto.js'
import { loadManagedFindings, readManagedReport } from '../../common/managed/report-content.ts'
import { reportRepoGithub } from '../../report/index.js'
import { normalizeEntry } from '../triage-entry.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_ENTRIES, parseTriageEntryPatch } from '../../common/managed/triage.ts'
import { normalizeTeamPath } from '../../server-managed/repo-path.ts'

export async function decodeWorkspaceFile(file, promptPassword) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isEncryptedBundle(bytes)) return promptPassword({ tryPassword: password => parseWorkspaceBundleBytes(bytes, password) })
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? parseWorkspaceBundleBytes(bytes) : parseWorkspaceJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export async function prepareWorkspaceImport(data, repos) {
  const lookup = new Map(), reports = []
  for (const item of data.reports) {
    if (typeof item?.name !== 'string' || !item.name || typeof item.content !== 'string') throw new Error('Every report must have a name and content.')
    const parsed = readManagedReport(item.content, item.name)
    if (!parsed.data) throw new Error(`${item.name}: ${parsed.reason ?? 'Unsupported report'}`)
    const embedded = reportRepoGithub(parsed.data)
    const github = embedded ?? reportRepoGithub(item) ?? reportRepoGithub({ repo: { github: data.repoUrls?.[item.name] } })
    const repoId = repos.find(repo => repo.fullName.toLowerCase() === github?.toLowerCase())?.repoId ?? null
    const directory = normalizeTeamPath(parsed.data.repo?.directory)
    if (!directory.ok) throw new Error(`${item.name}: invalid repository directory`)
    const findings = parsed.format === 'links' ? [] : (await loadManagedFindings(item.content, item.name))?.findings ?? []
    for (const finding of findings) if (finding.id) lookup.set(finding.id, finding)
    reports.push({ ...item, repoId, directory: directory.path ?? '', github, embedded, ids: [...new Set(findings.map(f => f.id).filter(Boolean))], uploaded: null })
  }
  const triage = Object.create(null)
  if (data.triage != null && (typeof data.triage !== 'object' || Array.isArray(data.triage))) throw new Error('Invalid workspace triage.')
  for (const [id, value] of Object.entries(data.triage ?? {})) {
    if (!lookup.has(id)) continue
    const normalized = normalizeEntry(value)
    if (!normalized) continue
    const { ignoredReports: _, ...entry } = normalized
    if (Object.keys(entry).length === 0) continue
    triage[id] = entry
  }
  const bundles = []
  for (const blob of data.bundleBlobs ?? []) {
    const bytes = Uint8Array.fromBase64(blob.data)
    const actual = `sha512-${new Uint8Array(await crypto.subtle.digest('SHA-512', bytes)).toBase64()}`
    if (actual !== blob.integrity) throw new Error(`${blob.name}: bundle integrity mismatch`)
    bundles.push({ name: blob.name, integrity: actual, bytes, uploaded: null })
  }
  return { name: data.workspace.name.slice(0, 100), reports, bundles, triage, lookup,
    references: data.bundles ?? [], team: null, completed: new Set(), importedIds: new Set() }
}

// Preserve fields omitted by the export. Disagreements only concern fields
// actually offered; imported comments are appended, never attributed or erased.
export function mergeImportTriage(incoming, snapshots) {
  const conflicts = [], entries = Object.create(null)
  for (const [id, offered] of Object.entries(incoming)) {
    const snapshot = snapshots[id]
    if (!snapshot) throw new Error('The server did not return the requested triage snapshot.')
    const current = snapshot.entry ?? {}
    const entry = entries[id] = { ...current }
    delete entry.comment
    for (const [property, value] of Object.entries(offered)) {
      if (property === 'comment') {
        if (snapshot.comments.some(comment => comment.body === value)) continue
        if (snapshot.comments.length > 0) conflicts.push({ id, property, local: snapshot.comments.map(c => c.body).join('\n\n'), imported: value })
        else entry.comment = value
      } else if (current[property] !== undefined && current[property] !== value) {
        const display = v => property === 'flagged' ? v ? 'flagged' : 'not flagged' : v
        conflicts.push({ id, property, local: display(current[property]), imported: display(value) })
      } else entry[property] = value
    }
  }
  return { entries, conflicts }
}

export function workspaceImportApi(request, session, signal) {
  async function send(path, body, extra = {}) {
    signal?.throwIfAborted()
    const response = await request(path, { credentials: 'same-origin', signal,
      ...(body === undefined ? {} : { method: 'POST', body: body instanceof File ? body : JSON.stringify(body) }),
      headers: { ...(body instanceof File ? {} : { 'content-type': 'application/json' }), 'x-csrf-token': session.csrfToken, ...extra } })
    signal?.throwIfAborted()
    if (response.status === 409) return { conflict: true }
    if (!response.ok) throw new Error(`Import request failed (HTTP ${response.status}). You can retry the remaining steps.`)
    const data = await response.json()
    signal?.throwIfAborted()
    return data
  }
  return { send }
}

async function resolveImportBatch(incoming, snapshots, lookup, resolveConflicts, signal) {
  signal?.throwIfAborted()
  const { entries, conflicts } = mergeImportTriage(incoming, snapshots)
  if (conflicts.length === 0) return entries
  const decisions = await resolveConflicts(conflicts, lookup, {
    title: 'Triage conflicts on import', intro: 'disagree with stored triage on',
    trailingNote: 'Imported comments are added alongside existing comments. Other choices apply to these finding IDs across all teams.',
    importedSideLabel: 'Apply imported',
  })
  signal?.throwIfAborted()
  if (!decisions) throw new Error('Triage conflict resolution was cancelled.')
  for (const conflict of conflicts) {
    const decision = decisions[`${conflict.id}:${conflict.property}`]
    if (!['local', 'imported'].includes(decision)) throw new Error('Resolve every triage conflict before importing.')
    if (decision === 'imported') entries[conflict.id][conflict.property] = incoming[conflict.id][conflict.property]
  }
  return entries
}

function writeBatches(entries, snapshots) {
  const batches = []
  let body = { entries: {}, expected: {} }
  for (const [id, value] of Object.entries(entries)) {
    const next = { entries: { ...body.entries, [id]: value }, expected: { ...body.expected, [id]: snapshots[id].version } }
    if (new TextEncoder().encode(JSON.stringify(next)).length <= MAX_TRIAGE_BODY_BYTES) { body = next; continue }
    if (Object.keys(body.entries).length === 0) throw new Error('This triage entry is too large to import.')
    batches.push(body)
    body = { entries: { [id]: value }, expected: { [id]: snapshots[id].version } }
  }
  if (Object.keys(body.entries).length > 0) batches.push(body)
  return batches
}

async function importReportTriage(plan, report, { api, resolveConflicts, signal }) {
  const ids = report.ids.filter(id => Object.hasOwn(plan.triage, id) && !plan.importedIds.has(id))
  const path = `/api/admin/reports/${encodeURIComponent(report.uploaded.id)}/import-triage`
  for (let start = 0; start < ids.length; start += MAX_TRIAGE_ENTRIES) {
    let pending = ids.slice(start, start + MAX_TRIAGE_ENTRIES)
    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
      signal?.throwIfAborted()
      const { snapshots } = await api.send(path, { findingIds: pending })
      const incoming = Object.fromEntries(pending.map(id => [id, plan.triage[id]]))
      const entries = await resolveImportBatch(incoming, snapshots, plan.lookup, resolveConflicts, signal)
      for (const body of writeBatches(entries, snapshots)) {
        signal?.throwIfAborted()
        if ((await api.send(path, body)).conflict) break
        Object.keys(body.entries).forEach(id => plan.importedIds.add(id))
      }
      pending = pending.filter(id => !plan.importedIds.has(id))
    }
    if (pending.length > 0) throw new Error('Stored triage keeps changing. Retry to resolve it against the latest values.')
  }
}

// Deduplication preserves the stored bundle's repository, ignoring the upload's
// repository header. Resolve access from the stored rows, including references
// whose bytes were omitted from the export. Never reassign an attached bundle.
async function grantWorkspaceBundles(plan, defaultRepo, api, step, knownBundles) {
  if (plan.bundles.length === 0 && plan.references.length === 0) return
  const bundles = knownBundles ?? (await api.send('/api/admin/bundles')).bundles
  const uploadedIds = new Set(plan.bundles.map(bundle => bundle.uploaded.id))
  if ([...uploadedIds].some(id => !bundles.some(bundle => bundle.id === id))) throw new Error('Could not verify the uploaded source bundles. Retry the import.')
  const references = new Set(plan.references)
  for (const bundle of bundles) {
    if (!uploadedIds.has(bundle.id) && !references.has(bundle.integrity)) continue
    const repoId = bundle.repoId ?? defaultRepo
    if (bundle.repoId == null) {
      await step(`bundle-repo:${bundle.id}`, () => api.send('/api/admin/bundles/set-repo', { bundleId: bundle.id, repoId }))
    }
    const path = bundle.repoId == null ? '' : bundle.repoDirectory ?? ''
    await step(`repo:${repoId}:${path}`, () => api.send('/api/admin/teams/set-repo', { teamId: plan.team.id, repoId, path }))
  }
}

export async function runWorkspaceImport(plan, { api, session, defaultRepo, includeTriage, resolveConflicts, signal, progress = () => {} }) {
  if (session?.role !== 'admin' || !session.csrfToken) throw new Error('An administrator session is required.')
  if (!plan.name.trim() || plan.name.trim().length > 100) throw new Error('Enter a team name of up to 100 characters.')
  if (includeTriage) {
    for (const [id, entry] of Object.entries(plan.triage)) {
      if (!id || id.length > MAX_FINDING_ID) throw new Error(`Triage finding IDs must be between 1 and ${MAX_FINDING_ID} characters. Choose Skip triage to import the files without it.`)
      if (parseTriageEntryPatch(entry) === 'invalid') throw new Error(`Triage for ${id} exceeds the managed server limits. Choose Skip triage to import the files without it.`)
    }
  }
  signal?.throwIfAborted()
  // An export may contain only bundle references: bytes are optional. Resolve
  // those before creating a team so unavailable references cannot leave an
  // empty team behind. Reuse the same catalog for the subsequent grants.
  let knownBundles = null
  if (plan.bundles.length === 0) {
    const references = new Set(plan.references)
    knownBundles = references.size > 0
      ? (await api.send('/api/admin/bundles')).bundles.filter(bundle => references.has(bundle.integrity)) : []
  }
  if (plan.reports.length === 0 && plan.bundles.length === 0 && knownBundles.length === 0) {
    throw new Error(plan.references.length > 0
      ? 'None of the referenced source bundles are available on the server. Export with bundle bytes included and try again.'
      : 'This workspace contains no report or bundle files.')
  }
  for (const report of plan.reports) {
    if (report.embedded && report.repoId == null) throw new Error(`Connect ${report.embedded} in Repositories before importing ${report.name}.`)
    if ((report.repoId ?? defaultRepo) == null) throw new Error(`Choose a repository for ${report.name}.`)
  }
  if ((plan.bundles.length > 0 || knownBundles.some(bundle => bundle.repoId == null)) && defaultRepo == null) throw new Error('Choose a repository for the source bundles.')
  const check = () => signal?.throwIfAborted()
  const step = async (key, work) => {
    check()
    if (!plan.completed.has(key)) { await work(); plan.completed.add(key) }
  }
  check()
  if (!plan.team) {
    const team = await api.send('/api/admin/teams', { name: plan.name.trim() })
    if (team.conflict) throw new Error('A team already has this name. Choose another name.')
    plan.team = team
  }
  await step('member', () => api.send('/api/admin/teams/set-member', { teamId: plan.team.id, userId: session.id, security: true, dependencies: true }))
  for (const bundle of plan.bundles) {
    check(); progress(`Importing ${bundle.name}…`)
    if (!bundle.uploaded) {
      bundle.uploaded = await api.send('/api/admin/bundles', new File([bundle.bytes], bundle.name), {
        'x-bundle-filename': encodeURIComponent(bundle.name), 'x-repo-id': String(defaultRepo),
      })
    }
  }
  await grantWorkspaceBundles(plan, defaultRepo, api, step, knownBundles)
  for (const report of plan.reports) {
    check(); progress(`Importing ${report.name}…`)
    const repoId = report.repoId ?? defaultRepo
    if (!report.uploaded) {
      const uploaded = await api.send('/api/admin/reports', new File([report.content], report.name), {
        'x-report-filename': encodeURIComponent(report.name), 'x-repo-id': String(repoId), 'x-repo-directory': encodeURIComponent(report.directory),
      })
      if (uploaded.conflict) throw new Error(`Could not reuse the stored report ${report.name}. Retry the import.`)
      report.uploaded = uploaded
    }
    // Reused reports keep their stored location, just like source bundles.
    // Only an unattached report needs the import's repository assignment.
    const stored = report.uploaded
    if (stored.repoId == null) {
      await step(`report-repo:${stored.id}`, async () => {
        const assigned = await api.send('/api/admin/reports/set-repo', { reportId: stored.id, repoId, directory: report.directory })
        if (assigned.conflict) throw new Error(`Could not assign the stored report ${report.name} to its repository.`)
        stored.repoId = repoId
        stored.repoDirectory = report.directory
      })
    }
    const path = stored.repoDirectory ?? ''
    await step(`repo:${stored.repoId}:${path}`, () => api.send('/api/admin/teams/set-repo', { teamId: plan.team.id, repoId: stored.repoId, path }))
    if (includeTriage) await importReportTriage(plan, report, { api, resolveConflicts, signal })
    await step(`publish:${report.uploaded.id}`, () => api.send('/api/admin/reports/set-visible', { reportId: report.uploaded.id, visible: true }))
  }
  return plan.team
}
