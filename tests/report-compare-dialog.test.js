import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

class TestDialog {
  static styles = []
  _settled = false
}
let files, listed, managed, opened, reads
const state = { currentFile: null }
mock.module('../client/index.js', { namedExports: {
  LINKS_KIND: 'links', getKind: name => name === 'links.json' ? 'links' : 'default',
  isManagedUiMode: () => managed, state,
  listFiles: () => listed ?? Promise.resolve([...files.keys()]),
  readFile: name => { reads.push(name); return files.get(name) ?? Promise.reject(new Error('File not found')) },
} })
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: {
  AppDialog: TestDialog, openAppDialog: name => { opened.push(name); return Promise.resolve() },
} })
const { openReportCompareDialog } = await import('../ui/view/dialogs/report-compare-dialog.js')
const Dialog = customElements.get('report-compare-dialog')
const report = id => JSON.stringify({ findings: [{ id }] })
beforeEach(() => {
  files = new Map([['a.json', report('a')], ['b.json', report('b')], ['links.json', '[]']])
  reads = []; opened = []; listed = null; managed = false; state.currentFile = null
})

test('opens only on explicit invocation and rejects managed mode', async () => {
  assert.deepEqual(opened, [])
  await openReportCompareDialog()
  assert.deepEqual(opened, ['report-compare-dialog'])
  managed = true
  assert.throws(openReportCompareDialog, /local\/E2E/u)
})

test('saved report picker excludes links and seeds the current file without navigating', async () => {
  state.currentFile = 'b.json'
  const view = new Dialog()
  await view._loadCatalog()
  assert.deepEqual(view._names, ['a.json', 'b.json'])
  assert.deepEqual(view._sides.map(side => side.name), ['b.json', 'a.json'])
  assert.deepEqual(view._diff.removed, ['b'])
  assert.deepEqual(view._diff.added, ['a'])
  assert.equal(state.currentFile, 'b.json')
})

test('an older read cannot overwrite a more recent selection', async () => {
  const gate = Promise.withResolvers()
  files.set('slow.json', gate.promise)
  const view = new Dialog()
  const first = view._select(0, 'slow.json')
  await view._select(0, 'a.json')
  gate.resolve(report('stale'))
  await first
  assert.deepEqual([...view._sides[0].report.byId.keys()], ['a'])
})

test('file uploads work without storage and are not replaced by a delayed catalog', async () => {
  const gate = Promise.withResolvers()
  listed = gate.promise
  const view = new Dialog()
  const loading = view._loadCatalog()
  await view._select(0, 'upload.json', { text: () => Promise.resolve(report('upload')) })
  gate.resolve(['a.json', 'b.json'])
  await loading
  assert.equal(view._sides[0].name, 'upload.json')
  assert.equal(reads.includes('upload.json'), false)
  assert.deepEqual(view._diff.removed, ['upload'])
})

test('read failures clear old results, and reselecting a valid file recovers', async () => {
  const view = new Dialog()
  await view._loadCatalog()
  await view._select(1, 'missing.json')
  assert.equal(view._diff, null)
  assert.match(view._sides[1].error, /File not found/u)
  files.set('broken.json', '{}')
  await view._select(1, 'broken.json')
  assert.match(view._sides[1].error, /not a report/u)
  await view._select(1, 'b.json')
  assert.deepEqual(view._diff.added, ['b'])
  assert.equal(view._sides[1].error, '')
})

test('links from direct files or unclassified saved files clear results and show an error', async () => {
  const content = JSON.stringify([[{ id: 'a' }, { id: 'b' }]])
  files.set('unclassified.json', content)
  for (const directFile of [false, true]) {
    const view = new Dialog()
    await view._loadCatalog()
    assert.ok(view._diff)
    assert.ok(view._names.includes('unclassified.json'), 'the kind cache has not recognized the links file')
    await view._select(1, 'unclassified.json', directFile ? { text: () => Promise.resolve(content) } : undefined)
    assert.equal(view._diff, null)
    assert.equal(view._sides[1].report, null)
    assert.match(view._sides[1].error, /links file.*groups.*findings/u)
    await view._select(1, 'b.json')
    assert.deepEqual(view._diff.added, ['b'])
    assert.equal(view._sides[1].error, '')
  }
})

test('swap reverses the diff without rereading storage; clearing a side clears results', async () => {
  const view = new Dialog()
  await view._loadCatalog()
  const readCount = reads.length
  view._swap()
  assert.deepEqual(view._diff.added, ['a'])
  assert.deepEqual(view._diff.removed, ['b'])
  assert.equal(reads.length, readCount)
  await view._select(0, '')
  assert.equal(view._diff, null)
})

test('closing discards in-flight results and a failed catalog still permits direct files', async () => {
  const gate = Promise.withResolvers()
  files.set('slow.json', gate.promise)
  const view = new Dialog()
  const pending = view._select(0, 'slow.json')
  view._settled = true
  gate.resolve(report('late'))
  await pending
  assert.equal(view._sides[0].report, null)
  const next = new Dialog()
  listed = Promise.reject(new Error('Vault locked'))
  await next._loadCatalog()
  assert.match(next._catalogError, /Vault locked/u)
  await next._select(0, 'one.json', { text: () => Promise.resolve(report('one')) })
  await next._select(1, 'two.json', { text: () => Promise.resolve(report('two')) })
  assert.deepEqual(next._diff.added, ['two'])
})
