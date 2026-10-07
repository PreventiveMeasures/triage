import './_polyfills.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { prepareLocalContentImport, runLocalContentImport } from '../client/managed/content-import.js'
import { localContentSyncStatus } from '../client/sync/objstore-presence.js'

const hash = text => createHash('sha256').update(text).digest('base64url')
const integrity = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const report = (id, repo) => JSON.stringify({ source: 'test', findings: [{ id, file: 'a.js' }], ...(repo ? { repo } : {}) })

function fixture(kind, files, workspaces = [], stored = []) {
  const reads = [], requests = [], signal = new AbortController().signal
  const source = {
    list: () => [...files].map(([value, file]) => ({ value, label: file.name })),
    importItem: (type, value, use) => { assert.equal(type, kind); reads.push(value); return use(files.get(value)) },
  }
  const deps = {
    hydrateKey: key => { assert.equal(key, 'deepview.workspaces'); return JSON.stringify({ workspaces }) },
    reportSyncHash: async value => hash(await files.get(value).text()),
    localContentSyncStatus: (workspaceId, type, value, contentHash) => {
      assert.equal(type, kind)
      if (kind === 'report') assert.ok(contentHash)
      return { synced: workspaceId === 'cloud', cached: true }
    },
  }
  const api = { send: (path, body, headers) => {
    assert.equal(path, `/api/admin/${kind}s`, 'no team, triage, location or publication endpoints')
    requests.push({ path, body, headers })
    return body ? { id: 'uploaded' } : { [`${kind}s`]: stored }
  } }
  return { source, deps, api, signal, reads, requests }
}

test('bundle preview groups all local files by workspace, shares selections and disables stored content', async () => {
  const files = new Map(['shared', 'present', 'local', 'loose'].map(name => [integrity(name), new File([name], `${name}.bundle`)]))
  const workspaces = [
    { id: 'cloud', name: 'Cloud workspace', privateKey: 'never upload', bundles: [integrity('shared'), integrity('present')] },
    { id: 'local', name: 'Local workspace', bundles: [integrity('shared'), integrity('local')] },
  ]
  const f = fixture('bundle', files, workspaces, [{ integrity: integrity('present') }])
  const plan = await prepareLocalContentImport('bundle', f)
  assert.deepEqual(plan.groups.map(group => group.name), ['Cloud workspace', 'Local workspace', 'Not in a workspace'])
  assert.equal(plan.groups[0].items[0].item, plan.groups[1].items[0].item)
  assert.deepEqual(plan.items.map(({ synced, present }) => ({ synced, present })), [
    { synced: true, present: false }, { synced: true, present: true }, { synced: false, present: false }, { synced: false, present: false },
  ])
  assert.equal(f.reads.length, 0, 'bundle bytes are only read after selection')
  assert.equal(f.requests.every(request => request.body === undefined), true)
  const count = await runLocalContentImport(plan, [integrity('shared'), integrity('present'), integrity('local')], f)
  assert.equal(count, 2)
  assert.deepEqual(f.reads, [integrity('shared'), integrity('local')])
  for (const request of f.requests.filter(row => row.body)) {
    assert.ok(request.body instanceof File)
    assert.deepEqual(Object.keys(request.headers), ['x-bundle-filename'])
  }
})

test('report duplicates use content and analyzer, preserve embedded locations, and never inherit workspace metadata', async () => {
  const bare = report('bare'), embedded = report('embedded', { github: 'org/repo', directory: 'src' })
  const files = new Map([
    ['old.json', new File([report('old')], 'old.json')],
    ['renamed.json', new File([embedded], 'renamed.json')],
    ['bare.json', new File([bare], 'bare.json')],
    ['same-content.json', new File([bare], 'same-content.json')],
  ])
  const f = fixture('report', files, [{ id: 'cloud', name: 'Workspace', reports: [...files.keys()], repo: 'wrong/repo' }],
    [{ filename: 'different.json', sha256: hash(report('old')), analyzer: 'test' }, { filename: 'bare.json', sha256: 'different-hash', analyzer: 'test' }])
  const plan = await prepareLocalContentImport('report', f)
  assert.deepEqual(plan.items.map(item => item.present), [true, false, false, false])
  assert.equal(await runLocalContentImport(plan, [...files.keys()], f), 2, 'identical local copies upload once')
  const uploads = f.requests.filter(request => request.body)
  assert.deepEqual(await Promise.all(uploads.map(request => request.body.text())), [embedded, bare])
  for (const upload of uploads) assert.deepEqual(Object.keys(upload.headers), ['x-report-filename'])
})

test('execution refreshes existing content and rejects changed preview bytes before sending', async () => {
  for (const kind of ['report', 'bundle']) {
    const before = kind === 'report' ? report('before') : 'before'
    const value = kind === 'report' ? 'report.json' : integrity(before)
    const files = new Map([[value, new File([before], value)]])
    const stored = []
    const f = fixture(kind, files, [], stored)
    const plan = await prepareLocalContentImport(kind, f)
    files.set(value, new File([kind === 'report' ? report('after') : 'after'], value))
    await assert.rejects(runLocalContentImport(plan, [value], f), /changed/u)
    assert.equal(f.requests.some(request => request.body), false)
    stored.push(kind === 'report' ? { sha256: hash(before), analyzer: 'test' } : { integrity: value })
    assert.equal(await runLocalContentImport(plan, [value], f), 0)
    assert.equal(plan.items[0].present, true)
  }
})

test('selection excludes unchecked and unreadable reports; successful partial uploads are not retried', async () => {
  const files = new Map(['one', 'two', 'invalid'].map(name => [`${name}.json`, new File([name === 'invalid' ? 'not a report' : report(name)], `${name}.json`)]))
  const f = fixture('report', files)
  const plan = await prepareLocalContentImport('report', f)
  assert.ok(plan.items[2].error)
  const send = f.api.send
  let fail = true
  f.api.send = (path, body, headers) => {
    if (fail && body?.name === 'two.json') throw new Error('temporary failure')
    return send(path, body, headers)
  }
  const imported = new Set()
  await assert.rejects(runLocalContentImport(plan, [...files.keys()], { ...f, imported }), /temporary failure/u)
  assert.deepEqual([...imported], ['one.json'])
  fail = false
  assert.equal(await runLocalContentImport(plan, ['two.json', 'invalid.json'], { ...f, imported }), 2)
  assert.deepEqual(f.requests.filter(request => request.body).map(request => request.body.name), ['one.json', 'two.json'])
})

test('last-known cloud status requires matching report bytes and supports immutable bundle identities', () => {
  const key = 'deepview.objstore-presence.import-test'
  localStorage.setItem(key, JSON.stringify({ names: { tag: 'report.json' }, bundles: { bundle: 'sha512-bundle' },
    baselines: { tag: { version: 1, incarnation: 'v1', synced: true, hash: 'original-bytes' } } }))
  try {
    assert.deepEqual(localContentSyncStatus('import-test', 'report', 'report.json', 'original-bytes'), { synced: true, cached: true })
    assert.equal(localContentSyncStatus('import-test', 'report', 'report.json', 'changed').synced, false)
    assert.equal(localContentSyncStatus('import-test', 'report', 'other.json', 'original-bytes').synced, false)
    assert.equal(localContentSyncStatus('import-test', 'bundle', 'sha512-bundle').synced, true)
    assert.equal(localContentSyncStatus('import-test', 'bundle', 'sha512-other').synced, false)
    assert.equal(localContentSyncStatus('unknown-workspace', 'report', 'report.json', 'original-bytes').synced, false)
  } finally { localStorage.removeItem(key) }
})

const forbidden = () => Object.assign(new Error('Import request failed (HTTP 403: csrf-mismatch). You can retry the remaining steps.'),
  { detail: 'Import request failed (HTTP 403: csrf-mismatch).' })

test('a failed report does not stop the rest, every failure is named, and importing again retries only failures', async () => {
  const files = new Map(['one', 'two', 'three', 'four'].map(name => [`${name}.json`, new File([report(name)], `${name}.json`)]))
  const f = fixture('report', files)
  const plan = await prepareLocalContentImport('report', f)
  const send = f.api.send
  let fail = true
  f.api.send = (path, body, headers) => {
    if (fail && body?.name === 'two.json') throw forbidden()
    if (fail && body?.name === 'four.json') throw new Error('temporary failure')
    return send(path, body, headers)
  }
  const imported = new Set()
  await assert.rejects(runLocalContentImport(plan, [...files.keys()], { ...f, imported }), {
    message: 'Imported 2 of 4 reports. Could not import two.json: Import request failed (HTTP 403: csrf-mismatch); four.json: temporary failure. Import again to retry them.',
  })
  assert.deepEqual([...imported], ['one.json', 'three.json'])
  fail = false
  assert.equal(await runLocalContentImport(plan, [...files.keys()], { ...f, imported }), 4)
  assert.deepEqual(f.requests.filter(request => request.body).map(request => request.body.name), ['one.json', 'three.json', 'two.json', 'four.json'])
})

test('cancellation still ends a local import', async () => {
  const files = new Map(['one', 'two', 'three'].map(name => [`${name}.json`, new File([report(name)], `${name}.json`)]))
  const f = fixture('report', files)
  const plan = await prepareLocalContentImport('report', f)
  const controller = new AbortController()
  const send = f.api.send
  f.api.send = (path, body, headers) => {
    if (body?.name === 'two.json') { controller.abort(); throw new DOMException('Managed session changed', 'AbortError') }
    return send(path, body, headers)
  }
  await assert.rejects(runLocalContentImport(plan, [...files.keys()], { ...f, signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(f.requests.filter(request => request.body).map(request => request.body.name), ['one.json'])
})
