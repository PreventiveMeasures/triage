import { migrateStoredIgnores } from '../ignored-triage.js'
import { parseWorkspaceBundleBytes, parseWorkspaceJson } from '../workspace-format.js'
import { isEncryptedBundle } from '../workspace-bundle-crypto.js'
import { findingsRepository, loadManagedFindings, ownFileDirectory, readManagedReport } from '../../common/managed/report-content.ts'
import { reportRepoGithub } from '@preventive/report'
import { normalizeEntry } from '../triage-entry.ts'
import { MAX_FINDING_ID, parseTriageEntryPatch } from '../../common/managed/triage.ts'
import { importTriageEntries } from './triage-import.js'
import { normalizeTeamPath } from '../../server-managed/repo-path.ts'
import { matchRepositoryAlias } from '../../common/managed/repository-alias.ts'

export async function decodeWorkspaceFile(file, promptPassword) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isEncryptedBundle(bytes)) return promptPassword({ tryPassword: password => parseWorkspaceBundleBytes(bytes, password) })
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? parseWorkspaceBundleBytes(bytes) : parseWorkspaceJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

// Every declared repository follows aliases, as on upload. A repository named
// by findings may also use their shared file directory, like the server.
function reportLocation(github, directory, repos, aliases, filePrefix = '') {
  const mapped = github ? matchRepositoryAlias(github, directory, aliases, filePrefix) : null
  const repo = repos.find(item => mapped ? item.repoId === mapped.repoId : item.fullName.toLowerCase() === github?.toLowerCase())
  return { repoId: repo?.repoId ?? null, directory: mapped?.directory ?? directory, github: repo?.fullName ?? github }
}

export async function prepareWorkspaceImport(data, repos, aliases = []) {
  const lookup = new Map(), reports = []
  for (const item of data.reports) {
    if (typeof item?.name !== 'string' || !item.name || typeof item.content !== 'string') throw new Error('Every report must have a name and content.')
    const parsed = readManagedReport(item.content, item.name)
    if (!parsed.data) throw new Error(`${item.name}: ${parsed.reason ?? 'Unsupported report'}`)
    const embedded = reportRepoGithub(parsed.data)
    // The repository local mode shows: embedded, typed for the report, or the
    // one its findings name.
    const typed = embedded ?? reportRepoGithub(item) ?? reportRepoGithub({ repo: { github: data.repoUrls?.[item.name] } })
    const declaredGithub = typed ?? findingsRepository(parsed.data)
    const filePrefix = embedded ? '' : ownFileDirectory(parsed.data)
    const directory = normalizeTeamPath(parsed.data.repo?.directory)
    if (!directory.ok) throw new Error(`${item.name}: invalid repository directory`)
    const findings = parsed.format === 'links' ? [] : (await loadManagedFindings(item.content, item.name))?.findings ?? []
    for (const finding of findings) if (finding.id) lookup.set(finding.id, finding)
    const declaredDirectory = directory.path ?? ''
    reports.push({ ...item, links: parsed.format === 'links', ...reportLocation(declaredGithub, declaredDirectory, repos, aliases, filePrefix),
      declaredGithub, declaredDirectory, filePrefix, embedded, ids: [...new Set(findings.map(f => f.id).filter(Boolean))], uploaded: null })
  }
  const triage = Object.create(null)
  if (data.triage != null && (typeof data.triage !== 'object' || Array.isArray(data.triage))) throw new Error('Invalid workspace triage.')
  const migrated = await migrateStoredIgnores(data.triage, name => data.reports.find(report => report.name === name)?.content)
  for (const [id, value] of Object.entries(migrated.entries)) {
    if (!lookup.has(id)) continue
    const normalized = normalizeEntry(value)
    if (!normalized) continue
    const { ignoredReports: _, scopedIgnoredReports: _scoped, ...entry } = normalized
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

// Deduplication preserves the stored bundle's repository, ignoring the upload's
// repository header. Resolve access from the stored rows, including references
// whose bytes were omitted from the export. Keep active assignments; inactive
// repositories cannot be granted to teams, so use the selected fallback there.
async function grantWorkspaceBundles(plan, defaultRepo, api, step, knownBundles, activeRepos) {
  if (plan.bundles.length === 0 && plan.references.length === 0) return
  const bundles = knownBundles ?? (await api.send('/api/admin/bundles')).bundles
  const uploadedIds = new Set(plan.bundles.map(bundle => bundle.uploaded.id))
  if ([...uploadedIds].some(id => !bundles.some(bundle => bundle.id === id))) throw new Error('Could not verify the uploaded source bundles. Retry the import.')
  const references = new Set(plan.references)
  for (const bundle of bundles) {
    if (!uploadedIds.has(bundle.id) && !references.has(bundle.integrity)) continue
    const reassign = !activeRepos.has(bundle.repoId)
    const repoId = reassign ? defaultRepo : bundle.repoId
    if (reassign) {
      await step(`bundle-repo:${bundle.id}:${repoId}`, () => api.send('/api/admin/bundles/set-repo', { bundleId: bundle.id, repoId }))
    }
    const path = reassign ? '' : bundle.repoDirectory ?? ''
    await step(`repo:${repoId}:${path}`, () => api.send('/api/admin/teams/set-repo', { teamId: plan.team.id, repoId, path }))
  }
}

async function importLinks(report, api) {
  if (!report.uploaded) report.uploaded = await api.send('/api/admin/deduplication', new File([report.content], report.name), { 'x-report-filename': encodeURIComponent(report.name) })
}

async function refreshReportLocations(plan, api) {
  const repos = (await api.send('/api/admin/repositories/browsable')).repos
  const reports = plan.reports.filter(item => !item.links && item.declaredGithub && !item.uploaded)
  if (reports.length > 0) {
    const { aliases = [] } = await api.send('/api/admin/repositories/aliases')
    for (const report of reports) Object.assign(report, reportLocation(report.declaredGithub, report.declaredDirectory, repos, aliases, report.filePrefix))
  }
  return new Set(repos.map(repo => repo.repoId))
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
  // Refresh the active set at execution time: the preview's catalogue may be
  // stale, and content deduplication can return records from inactive repos.
  const activeRepos = await refreshReportLocations(plan, api)
  for (const report of plan.reports.filter(item => !item.links)) {
    if (report.embedded && !activeRepos.has(report.repoId)) throw new Error(`Connect ${report.embedded} in Repositories before importing ${report.name}.`)
    if (!activeRepos.has(report.repoId) && !activeRepos.has(defaultRepo)) throw new Error(`Choose an active repository for ${report.name}.`)
  }
  if ((plan.bundles.length > 0 || knownBundles.some(bundle => !activeRepos.has(bundle.repoId))) && !activeRepos.has(defaultRepo)) throw new Error('Choose an active repository for the source bundles.')
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
        'x-bundle-filename': encodeURIComponent(bundle.name),
      })
    }
  }
  await grantWorkspaceBundles(plan, defaultRepo, api, step, knownBundles, activeRepos)
  for (const report of plan.reports) {
    check(); progress(`Importing ${report.name}…`)
    if (report.links) { await importLinks(report, api); continue }
    const repoId = activeRepos.has(report.repoId) ? report.repoId : defaultRepo
    if (!report.uploaded) {
      const uploaded = await api.send('/api/admin/reports', new File([report.content], report.name), {
        'x-report-filename': encodeURIComponent(report.name), 'x-repo-id': String(repoId), 'x-repo-directory': encodeURIComponent(report.directory),
      })
      if (uploaded.conflict) throw new Error(`Could not reuse the stored report ${report.name}. Retry the import.`)
      report.uploaded = uploaded
    }
    // Reused reports keep their stored location, just like source bundles.
    // Unattached reports and inactive assignments use the import's active repo.
    const stored = report.uploaded
    if (!activeRepos.has(stored.repoId)) {
      await step(`report-repo:${stored.id}:${repoId}:${report.directory}`, async () => {
        const assigned = await api.send('/api/admin/reports/set-repo', { reportId: stored.id, repoId, directory: report.directory })
        if (assigned.conflict) throw new Error(`Could not assign the stored report ${report.name} to its repository.`)
        stored.repoId = repoId
        stored.repoDirectory = report.directory
      })
    }
    const path = stored.repoDirectory ?? ''
    await step(`repo:${stored.repoId}:${path}`, () => api.send('/api/admin/teams/set-repo', { teamId: plan.team.id, repoId: stored.repoId, path }))
    if (includeTriage) {
      await importTriageEntries(plan.triage, {
        api, resolveConflicts, signal, ids: report.ids, importedIds: plan.importedIds, lookup: plan.lookup,
        path: `/api/admin/reports/${encodeURIComponent(report.uploaded.id)}/import-triage`,
      })
    }
    await step(`publish:${report.uploaded.id}`, () => api.send('/api/admin/reports/set-visible', { reportId: report.uploaded.id, visible: true }))
  }
  return plan.team
}
