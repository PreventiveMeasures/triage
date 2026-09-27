import './_polyfills.js'
import './_password-crypto-mock.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { decodeWorkspaceFile, prepareWorkspaceImport, runWorkspaceImport, workspaceImportApi } from '../client/managed/workspace-import.js'
import { localWorkspaceReader } from '../client/managed/workspace-import-local.js'
import { encryptBundle } from '../client/workspace-bundle-crypto.js'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES } from '../common/managed/triage.ts'

const repos = [{ repoId: 7, fullName: 'org/repo' }]
const session = { id: 'admin', role: 'admin', csrfToken: 'csrf' }
const report = { name: 'report.json', content: JSON.stringify({ repo: { github: 'org/repo', directory: 'src' }, findings: [{ id: 'f', file: 'a.js' }] }) }
const exported = () => ({ version: 1, workspace: { id: 'local', name: 'Workspace', privateKey: 'NEVER UPLOAD' }, reports: [report], bundles: [], triage: { f: { color: 'red', comment: 'Imported', flagged: false, ignoredReports: ['report.json'] }, other: { color: 'blue' } } })
const snapshot = (entry = null, comments = [], version = '1') => ({ entry, comments, version })

function serverMock() {
  const calls = []
  let onTriage = body => body.findingIds ? { snapshots: Object.fromEntries(body.findingIds.map(id => [id, snapshot()])) } : { ok: true }
  let failPublish = false
  const api = { send(path, body, headers) {
    calls.push({ path, body, headers })
    if (path.endsWith('/import-triage')) return onTriage(body)
    if (path === '/api/admin/teams') return { id: 'team', name: body.name }
    if (path === '/api/admin/reports') return { id: `report-${calls.length}` }
    if (path === '/api/admin/bundles') return body ? { id: 'bundle' } : { bundles: [{ id: 'bundle', repoId: 7 }] }
    if (path.endsWith('/set-visible') && failPublish) throw new Error('temporarily unavailable')
    return { ok: true }
  } }
  return { api, calls, get onTriage() { return onTriage }, set onTriage(fn) { onTriage = fn }, get failPublish() { return failPublish }, set failPublish(value) { failPublish = value } }
}

test('workspace file decoding accepts JSON, gzip and encrypted exports with password retry/cancellation', async () => {
  const data = exported()
  const json = JSON.stringify(data)
  const gzip = gzipSync(json)
  for (const bytes of [json, gzip]) assert.deepEqual(await decodeWorkspaceFile(new File([bytes], 'workspace'), () => assert.fail('no password')), data)
  const encrypted = await encryptBundle(gzip, 'password')
  assert.deepEqual(await decodeWorkspaceFile(new File([encrypted], 'workspace.enc'), async ({ tryPassword }) => {
    await assert.rejects(tryPassword('wrong'), /password/u)
    return tryPassword('password')
  }), data)
  assert.equal(await decodeWorkspaceFile(new File([encrypted], 'workspace.enc'), () => null), null)
  await assert.rejects(decodeWorkspaceFile(new File(['{}'], 'bad.json')), /workspace export/u)
})

test('preparation keeps report paths and link reports, limits triage to findings, and validates bundle hashes', async () => {
  const data = exported()
  data.reports.push({ name: 'links.json', content: JSON.stringify([[{ id: 'f' }, { id: 'g' }]]) })
  const bytes = new TextEncoder().encode('source bundle')
  const integrity = `sha512-${new Uint8Array(await crypto.subtle.digest('SHA-512', bytes)).toBase64()}`
  data.bundles = [integrity]
  data.bundleBlobs = [{ name: 'source.map', integrity, data: bytes.toBase64() }]
  const plan = await prepareWorkspaceImport(data, repos)
  assert.equal(plan.name, 'Workspace')
  assert.equal(plan.reports[0].directory, 'src')
  assert.equal(plan.reports[0].repoId, 7)
  assert.deepEqual(plan.reports[1].ids, [])
  assert.deepEqual({ ...plan.triage }, { f: { color: 'red', comment: 'Imported', flagged: false } })
  assert.deepEqual(plan.bundles[0].bytes, bytes)
  data.bundleBlobs[0].data = new Uint8Array([0]).toBase64()
  await assert.rejects(prepareWorkspaceImport(data, repos), /integrity mismatch/u)
})

test('imports reports and bundles into a named team; skip triage never reads or writes annotations', async () => {
  const plan = await prepareWorkspaceImport(exported(), repos)
  plan.bundles = [{ name: 'bundle.map', bytes: new Uint8Array([1]) }]
  const mock = serverMock()
  assert.equal((await runWorkspaceImport(plan, { api: mock.api, session, defaultRepo: 7, includeTriage: false })).id, 'team')
  assert.deepEqual(mock.calls[0].body, { name: 'Workspace' })
  assert.deepEqual(mock.calls.find(call => call.path.endsWith('/set-member')).body, { teamId: 'team', userId: 'admin', security: true, dependencies: true })
  assert.equal(mock.calls.filter(call => call.path.endsWith('/import-triage')).length, 0)
  const upload = mock.calls.find(call => call.path === '/api/admin/reports')
  assert.equal(await upload.body.text(), report.content)
  assert.equal(upload.headers['x-repo-directory'], 'src')
  assert.equal(JSON.stringify(mock.calls).includes('NEVER UPLOAD'), false)
})

test('conflicts preserve omitted fields, reprompt after a concurrent edit, and import shared IDs only once', async () => {
  const data = exported()
  data.reports.push({ ...report, name: 'rescan.json' })
  const plan = await prepareWorkspaceImport(data, repos)
  const mock = serverMock()
  let prompts = 0, reads = 0, writes = 0
  mock.onTriage = body => {
    if (body.findingIds) return { snapshots: { f: snapshot({ color: ++reads === 1 ? 'blue' : 'green', fix: 'keep', flagged: true }, [{ body: 'Stored comment' }], String(reads)) } }
    writes++
    assert.deepEqual(body.entries.f, { color: 'red', fix: 'keep', flagged: false })
    assert.equal(body.expected.f, String(reads))
    return { conflict: writes === 1 }
  }
  const resolveConflicts = conflicts => {
    prompts++
    assert.equal(conflicts.find(c => c.property === 'color').local, prompts === 1 ? 'blue' : 'green')
    assert.equal(conflicts.find(c => c.property === 'flagged').local, 'flagged')
    return Object.fromEntries(conflicts.map(c => [`${c.id}:${c.property}`, c.property === 'comment' ? 'local' : 'imported']))
  }
  await runWorkspaceImport(plan, { api: mock.api, session, includeTriage: true, resolveConflicts })
  assert.equal(prompts, 2)
  assert.equal(reads, 2)
  assert.equal(mock.calls.filter(call => call.path.endsWith('/set-visible')).length, 2)
})

test('retry resumes a partially completed import without duplicating its team, uploads, or triage', async () => {
  const plan = await prepareWorkspaceImport(exported(), repos)
  const mock = serverMock()
  mock.failPublish = true
  const options = { api: mock.api, session, includeTriage: true }
  await assert.rejects(runWorkspaceImport(plan, options), /temporarily/u)
  mock.failPublish = false
  await runWorkspaceImport(plan, options)
  assert.equal(mock.calls.filter(call => call.path === '/api/admin/teams').length, 1)
  assert.equal(mock.calls.filter(call => call.path === '/api/admin/reports').length, 1)
  assert.equal(mock.calls.filter(call => call.path.endsWith('/import-triage')).length, 2)
})

test('session cancellation while resolving prevents triage writes and publication', async () => {
  const plan = await prepareWorkspaceImport(exported(), repos)
  const mock = serverMock()
  mock.onTriage = body => { assert.ok(body.findingIds); return { snapshots: { f: snapshot({ color: 'blue' }) } } }
  const controller = new AbortController()
  await assert.rejects(runWorkspaceImport(plan, { api: mock.api, session, includeTriage: true, signal: controller.signal,
    resolveConflicts() { controller.abort(); return { 'f:color': 'imported' } },
  }), { name: 'AbortError' })
  assert.equal(mock.calls.some(call => call.path.endsWith('/set-visible')), false)
})

test('large triage imports batch reads and keep UTF-8 write bodies within the server limit', async () => {
  const plan = await prepareWorkspaceImport(exported(), repos)
  plan.reports[0].ids = Array.from({ length: 201 }, (_, i) => `id-${i}`)
  plan.triage = Object.fromEntries(plan.reports[0].ids.map(id => [id, { comment: '\u0001'.repeat(10000), fix: 'é'.repeat(10000) }]))
  const mock = serverMock()
  await runWorkspaceImport(plan, { api: mock.api, session, includeTriage: true })
  const calls = mock.calls.filter(call => call.path.endsWith('/import-triage'))
  assert.deepEqual(calls.filter(call => call.body.findingIds).map(call => call.body.findingIds.length), [200, 1])
  for (const call of calls) assert.ok(new TextEncoder().encode(JSON.stringify(call.body)).length <= MAX_TRIAGE_BODY_BYTES)
  assert.equal(plan.importedIds.size, 201)
})

test('authenticated transport handles JSON/File bodies, CSRF, cancellation and conflict status', async () => {
  const calls = []
  const controller = new AbortController()
  const api = workspaceImportApi((path, options) => { calls.push({ path, options }); return Response.json({}, { status: 409 }) }, session, controller.signal)
  assert.deepEqual(await api.send('/write', { test: 1 }), { conflict: true })
  assert.equal(calls[0].options.headers['x-csrf-token'], 'csrf')
  assert.equal(calls[0].options.body, '{"test":1}')
  const file = new File(['test'], 'report.json')
  await api.send('/upload', file)
  assert.equal(calls[1].options.body, file)
  controller.abort()
  await assert.rejects(api.send('/write', {}), { name: 'AbortError' })
  assert.equal(calls.length, 2)
})

function localFixture() {
  let unlocked = false
  const listeners = new Set()
  const workspaces = { version: 1, workspaces: [{ id: 'local', name: 'Local workspace', reports: ['report.json'], bundles: ['missing'], privateKey: 'secret' }] }
  const deps = {
    isEncryptionEnabled: () => true, isUnlocked: () => unlocked,
    unlockEncryption: () => { unlocked = true; for (const listener of listeners) listener(); return true },
    onVaultStateChange: cb => { listeners.add(cb); return () => listeners.delete(cb) },
    onFileMutated: cb => { listeners.add(cb); return () => listeners.delete(cb) },
    onBundleMutated: cb => { listeners.add(cb); return () => listeners.delete(cb) },
    hydrateKey: key => JSON.stringify(key === 'deepview.workspaces' ? workspaces : { 'report.json': 'org/repo' }),
    withStoredItem: (_kind, _key, fn) => fn(), readFile: () => report.content, listBundles: () => [],
    readTriageBlob: () => ({ f: { color: 'red' } }),
  }
  return { deps, reader: localWorkspaceReader(deps), listeners, workspaces }
}

test('local reader requires unlock, reads stored files/triage, and never transfers workspace keys', async () => {
  const { reader } = localFixture()
  await assert.rejects(reader.list(), /locked/u)
  await reader.unlock()
  assert.deepEqual(await reader.list(), [{ id: 'local', name: 'Local workspace' }])
  const data = await reader.read('local')
  assert.equal(data.workspace.privateKey, '')
  assert.equal(data.reports[0].content, report.content)
  assert.deepEqual(data.triage, { f: { color: 'red' } })
  assert.deepEqual(data.bundles, ['missing'])
})

test('local reader rejects files or membership changed during snapshot capture and releases listeners', async () => {
  for (const mutateWorkspace of [false, true]) {
    const f = localFixture()
    await f.reader.unlock()
    f.deps.readFile = () => {
      if (mutateWorkspace) f.workspaces.workspaces[0].name = 'Changed'
      else for (const listener of f.listeners) listener()
      return report.content
    }
    await assert.rejects(f.reader.read('local'), /changed/u)
    assert.equal(f.listeners.size, 0)
  }
})

test('oversized local triage can be skipped; importing it fails before creating managed records', async () => {
  const data = exported()
  data.triage.f.comment = 'x'.repeat(10001)
  const plan = await prepareWorkspaceImport(data, repos)
  const mock = serverMock()
  await assert.rejects(runWorkspaceImport(plan, { api: mock.api, session, includeTriage: true }), /Skip triage/u)
  assert.equal(mock.calls.length, 0)
  await runWorkspaceImport(plan, { api: mock.api, session, includeTriage: false })
  assert.equal(plan.team.id, 'team')
})

test('oversized triage finding IDs fail before mutations and can be skipped on retry', async () => {
  const id = 'f'.repeat(MAX_FINDING_ID + 1)
  const data = exported()
  data.reports = [{ ...report, content: JSON.stringify({ repo: { github: 'org/repo' }, findings: [{ id, file: 'a.js' }] }) }]
  data.triage = { [id]: { color: 'red' } }
  const plan = await prepareWorkspaceImport(data, repos)
  assert.deepEqual(plan.triage[id], { color: 'red' })
  const mock = serverMock()
  await assert.rejects(runWorkspaceImport(plan, { api: mock.api, session, includeTriage: true }), /finding IDs.*Skip triage/u)
  assert.equal(mock.calls.length, 0)
  assert.equal(plan.team, null)
  assert.equal(plan.reports[0].uploaded, null)
  await runWorkspaceImport(plan, { api: mock.api, session, includeTriage: false })
  assert.equal(plan.team.id, 'team')
  assert.equal(mock.calls.some(call => call.path.endsWith('/import-triage')), false)
})

test('triage finding IDs at the server character limit import successfully', async () => {
  const id = 'é'.repeat(MAX_FINDING_ID)
  const data = exported()
  data.reports = [{ ...report, content: JSON.stringify({ repo: { github: 'org/repo' }, findings: [{ id, file: 'a.js' }] }) }]
  data.triage = { [id]: { color: 'red' } }
  const plan = await prepareWorkspaceImport(data, repos)
  const mock = serverMock()
  await runWorkspaceImport(plan, { api: mock.api, session, includeTriage: true })
  const calls = mock.calls.filter(call => call.path.endsWith('/import-triage'))
  assert.deepEqual(calls[0].body.findingIds, [id])
  assert.deepEqual(calls[1].body.entries, { [id]: { color: 'red' } })
  assert.equal(plan.importedIds.has(id), true)
})

test('a missing bundle catalog row stops publication and a retry reuses its completed upload', async () => {
  const plan = await prepareWorkspaceImport(exported(), repos)
  plan.bundles = [{ name: 'bundle.map', bytes: new Uint8Array([1]) }]
  const mock = serverMock()
  const original = mock.api.send
  let missing = true
  mock.api.send = (path, body, headers) => {
    if (path === '/api/admin/bundles' && body === undefined) return { bundles: missing ? [] : [{ id: 'bundle', repoId: 9 }] }
    return original(path, body, headers)
  }
  const options = { api: mock.api, session, defaultRepo: 7, includeTriage: false }
  await assert.rejects(runWorkspaceImport(plan, options), /verify.*source bundles/u)
  assert.equal(mock.calls.some(call => call.path.endsWith('/set-visible')), false)
  missing = false
  await runWorkspaceImport(plan, options)
  assert.equal(mock.calls.filter(call => call.path === '/api/admin/bundles').length, 1)
  const grants = mock.calls.filter(call => call.path === '/api/admin/teams/set-repo').map(call => call.body)
  assert.deepEqual(grants, [{ teamId: 'team', repoId: 9, path: '' }, { teamId: 'team', repoId: 7, path: 'src' }])
})

for (const assigned of [true, false]) {
  test(`bundle-reference-only workspaces import stored ${assigned ? 'assigned' : 'unassigned'} bundles without uploading bytes`, async () => {
    const plan = await prepareWorkspaceImport({ ...exported(), reports: [], bundles: ['sha512-existing', 'sha512-missing'] }, repos)
    const mock = serverMock()
    const original = mock.api.send
    mock.api.send = (path, body, headers) => {
      const result = original(path, body, headers)
      if (path === '/api/admin/bundles' && body === undefined) {
        return { bundles: [
          { id: 'bundle', integrity: 'sha512-existing', repoId: assigned ? 9 : null, repoDirectory: assigned ? 'foo' : '' },
          { id: 'unrelated', integrity: 'sha512-unrelated', repoId: 10 },
        ] }
      }
      return result
    }
    await runWorkspaceImport(plan, { api: mock.api, session, defaultRepo: assigned ? null : 7, includeTriage: false })
    assert.equal(plan.team.name, 'Workspace')
    assert.deepEqual(mock.calls[0], { path: '/api/admin/bundles', body: undefined, headers: undefined })
    assert.equal(mock.calls.filter(call => call.path === '/api/admin/bundles').length, 1, 'resolve once and never upload')
    assert.equal(mock.calls.some(call => call.path.startsWith('/api/admin/reports')), false)
    assert.deepEqual(mock.calls.filter(call => call.path.endsWith('/set-repo')).map(call => call.body), assigned
      ? [{ teamId: 'team', repoId: 9, path: 'foo' }]
      : [{ bundleId: 'bundle', repoId: 7 }, { teamId: 'team', repoId: 7, path: '' }])
  })
}

test('empty or unavailable bundle-reference-only workspaces fail before creating a team', async () => {
  for (const references of [[], ['sha512-unavailable']]) {
    const plan = await prepareWorkspaceImport({ ...exported(), reports: [], bundles: references }, repos)
    const mock = serverMock()
    await assert.rejects(runWorkspaceImport(plan, { api: mock.api, session, defaultRepo: 7, includeTriage: false }), references.length > 0 ? /None.*available.*bundle bytes/u : /no report or bundle/u)
    assert.equal(plan.team, null)
    assert.equal(mock.calls.some(call => call.body !== undefined), false, 'validation performs no mutations')
  }
})

test('an unassigned reference requires a repository before creating a team', async () => {
  const plan = await prepareWorkspaceImport({ ...exported(), reports: [], bundles: ['sha512-existing'] }, repos)
  const calls = []
  const api = { send(path, body) { calls.push({ path, body }); return { bundles: [{ id: 'bundle', integrity: 'sha512-existing', repoId: null }] } } }
  await assert.rejects(runWorkspaceImport(plan, { api, session, includeTriage: false }), /Choose a repository/u)
  assert.equal(plan.team, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body, undefined)
})
