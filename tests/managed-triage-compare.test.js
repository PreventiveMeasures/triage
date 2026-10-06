import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareTriageEntries, prepareLocalTriageComparison } from '../client/managed/triage-compare.js'

const snapshot = (entry = null, bodies = []) => ({ entry, comments: bodies.map(body => ({ body })) })

test('comparison includes missing values on either side, mismatches, explicit false and local ignores', () => {
  const local = { color: 'red', triage: 'fixed', comment: 'Local note', flagged: false, ignoredReports: ['a.json', 'a.json'] }
  const managed = snapshot({ color: 'blue', fix: 'https://example.test/fix' }, ['Managed note'])
  assert.deepEqual(compareTriageEntries(local, managed).map(({ property, kind }) => [property, kind]), [
    ['triage', 'local-only'], ['color', 'mismatch'], ['fix', 'managed-only'], ['flagged', 'local-only'], ['comment', 'mismatch'], ['ignoredReports', 'local-only'],
  ])
  assert.equal(compareTriageEntries(local, managed)[3].local, false)
  assert.deepEqual(compareTriageEntries(local, managed).at(-1).local, ['a.json'])
  assert.deepEqual(compareTriageEntries(undefined, snapshot({ flagged: false })), [
    { property: 'flagged', local: undefined, managed: false, kind: 'managed-only' },
  ])
  assert.deepEqual(compareTriageEntries({ deleted: true, color: '', comment: '', flagged: false }, snapshot({ triage: 'deleted', flagged: false })), [])
  assert.deepEqual(compareTriageEntries(undefined, snapshot()), [])
})

test('all comment differences remain visible when the local body already occurs in managed comments', () => {
  assert.deepEqual(compareTriageEntries({ comment: 'Same' }, snapshot(null, ['Same'])), [])
  const [extra] = compareTriageEntries({ comment: 'Same' }, snapshot(null, ['Extra', 'Same']))
  assert.equal(extra.kind, 'managed-only')
  assert.deepEqual(extra.local, [{ text: 'Same', different: false }])
  assert.deepEqual(extra.managed, [{ text: 'Extra', different: true }, { text: 'Same', different: false }])
  const [duplicate] = compareTriageEntries({ comment: 'Same' }, snapshot(null, ['Same', 'Same']))
  assert.deepEqual(duplicate.managed.map(item => item.different), [false, true])
  assert.equal(compareTriageEntries({ comment: 'Local' }, snapshot())[0].kind, 'local-only')
  assert.equal(compareTriageEntries(undefined, snapshot(null, ['Managed']))[0].kind, 'managed-only')
})

function fixture(files, triage, catalog, snapshots) {
  const controller = new AbortController(), requests = []
  return {
    controller, requests, signal: controller.signal,
    source: {
      list: () => Object.keys(files).map(value => ({ value, label: value })),
      importItem: (_kind, value, read) => read(new File([typeof files[value] === 'string' ? files[value] : JSON.stringify({ findings: files[value] })], value)),
    },
    readTriage: () => triage,
    api: { send: (path, body) => {
      requests.push({ path, body })
      if (body) {
        assert.deepEqual(Object.keys(body), ['findingIds'], 'comparison never sends annotations or writes')
        return { snapshots: Object.fromEntries(body.findingIds.map(id => [id, snapshots[id]])) }
      }
      return catalog(path)
    } },
  }
}

test('compares shared findings even with no local annotation, deduplicates pages, and keeps unmatched IDs local', async () => {
  const f = fixture({ 'first.json': [{ id: 'local', file: 'a.js' }, { id: 'managed' }, { id: 'same' }, { id: 'foreign' }],
    'second.json': [{ id: 'managed' }] }, { local: { color: 'red' }, same: { triage: 'fixed' }, foreign: { comment: 'Private' }, orphan: { color: 'blue' } },
  path => ({ reports: [{ id: path.includes('?') ? 'second' : 'first', findingIds: path.includes('?') ? ['managed', 'same', 'orphan'] : ['local', 'managed', 'server-only'] }],
    nextCursor: path.includes('?') ? null : 'next page' }),
  { local: snapshot(), managed: snapshot({ triage: 'inprogress' }), same: snapshot({ triage: 'fixed' }) })
  const result = await prepareLocalTriageComparison(f)
  assert.equal(result.matched, 3)
  assert.equal(result.localFindings, 4)
  assert.deepEqual(result.findings.map(row => [row.id, row.differences[0].kind]), [['local', 'local-only'], ['managed', 'managed-only']])
  assert.deepEqual(result.findings[1].finding.reports, ['first.json', 'second.json'])
  assert.deepEqual(f.requests.filter(row => row.body).map(row => row.body.findingIds), [['local', 'managed'], ['same']])
  assert.equal(JSON.stringify(f.requests).includes('Private'), false)
  assert.equal(f.requests.some(row => row.path.endsWith('?after=next%20page')), true)
})

test('snapshot reads are bounded and comparison errors cannot silently hide shared findings', async () => {
  const ids = Array.from({ length: 405 }, (_, index) => `f${index}`)
  const f = fixture({ 'many.json': ids.map(id => ({ id })) }, {}, () => ({ reports: [{ id: 'r', findingIds: ids }] }),
    Object.fromEntries(ids.map(id => [id, snapshot({ flagged: true })])))
  assert.equal((await prepareLocalTriageComparison(f)).findings.length, 405)
  assert.deepEqual(f.requests.filter(row => row.body).map(row => row.body.findingIds.length), [200, 200, 5])
  const missing = fixture({ 'r.json': [{ id: 'f' }] }, {}, () => ({ reports: [{ id: 'r', findingIds: ['f'] }] }), {})
  await assert.rejects(prepareLocalTriageComparison(missing), /did not return/u)
  const cancelled = fixture({ 'r.json': [{ id: 'f' }] }, {}, () => {
    cancelled.controller.abort()
    return { reports: [{ id: 'r', findingIds: ['f'] }] }
  }, {})
  await assert.rejects(prepareLocalTriageComparison(cancelled), { name: 'AbortError' })
  assert.equal(cancelled.requests.length, 1)
})

test('unreadable reports are disclosed and do not imply that there are no differences', async () => {
  const f = fixture({ 'bad.json': 'not a report', 'good.json': [{ id: 'shared' }] }, {},
    () => ({ reports: [{ id: 'r', findingIds: ['shared'] }] }), { shared: snapshot({ color: 'blue' }) })
  const result = await prepareLocalTriageComparison(f)
  assert.equal(result.skipped[0].name, 'bad.json')
  assert.ok(result.skipped[0].reason)
  assert.equal(result.matched, 1)
  assert.equal(result.findings.length, 1)
  const empty = fixture({}, {}, () => assert.fail('no local findings to compare'), {})
  assert.deepEqual(await prepareLocalTriageComparison(empty), { localFindings: 0, matched: 0, skipped: [], findings: [] })
})
