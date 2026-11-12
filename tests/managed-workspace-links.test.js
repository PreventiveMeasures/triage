import './_polyfills.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { state } from '../client/state.ts'
import { clearManagedWorkspace, setManagedWorkspace } from '../client/managed/workspace.js'
import { duplicatesOf, ensureLinkedFindingsIndexed, linkFiles } from '../client/linked-findings-index.js'
import { findingTitleForId, reportRowsForFindingIds } from '../client/bundle-finding-index.js'
import { stampSecurityGroups } from '@preventive/report'

const repo = { github: 'org/app', directory: '' }
const records = [
  { id: 'report', filename: 'scan.json', repo, data: { findings: [{ id: 'a', title: 'Visible', isSecurity: true, isApp: true }, { id: 'b', title: 'Other' }] } },
  { id: 'links', filename: 'links.json', repo, data: { source: 'links', findings: [], links: [['a', 'b']] } },
]
afterEach(() => { clearManagedWorkspace(); state.serverMode = null; state.currentManagedTeam = null; state.managedSession = null })
test('managed links and report rows stay in the active team, with no local index read', async () => {
  state.serverMode = 'managed'
  state.localMode = false
  state.managedSession = { id: 'viewer', role: 'view' }
  state.currentManagedTeam = 'one'
  setManagedWorkspace('one', records)
  await ensureLinkedFindingsIndexed()
  assert.deepEqual(duplicatesOf('a'), ['b'])
  assert.equal(findingTitleForId('a'), 'Visible')
  assert.equal(reportRowsForFindingIds(['a'])[0].managedReportId, 'report')
  assert.equal(linkFiles()[0].name, 'links.json')
  const displayed = [{ id: 'a' }]
  stampSecurityGroups([displayed], { linkedIds: duplicatesOf, knownRows: reportRowsForFindingIds })
  assert.equal(displayed[0].isSecurity, true, 'a hidden security sibling classified on the server remains security in the UI')
  state.currentManagedTeam = 'two'
  assert.deepEqual(duplicatesOf('a'), [])
  assert.deepEqual(reportRowsForFindingIds(['a']), [])
  setManagedWorkspace('two', [records[0]])
  assert.deepEqual(duplicatesOf('a'), [])
  state.managedSession = { id: 'different-viewer', role: 'view' }
  assert.deepEqual(linkFiles(), [])
  assert.deepEqual(reportRowsForFindingIds(['a']), [])
  assert.equal(records[0].data.findings[0]._managedReportId, undefined, 'indexing preserves cached response objects')
})

// A finding naming the advised package's repository as its own reads as
// naming none (common/finding-repo.js): measured against the repo the team
// links the report to.
test('managed findings read without the advised package\'s repository', () => {
  state.serverMode = 'managed'
  state.localMode = false
  state.managedSession = { id: 'viewer', role: 'view' }
  state.currentManagedTeam = 'one'
  setManagedWorkspace('one', [{ id: 'report', filename: 'scan.json', repo: { github: 'org/app', directory: '' }, data: { findings: [
    { id: 'a', title: 'A', parent: 'p', repo: { github: 'expressjs/body-parser' }, advisory: { package: 'body-parser' } },
    { id: 'b', title: 'B', repo: { github: 'Org/App' }, advisory: { package: 'app' } },
  ] } }])
  const [advised, merged] = ['a', 'b'].map(id => reportRowsForFindingIds([id])[0].members[0])
  assert.equal(advised.repo, undefined)
  assert.equal(advised.parent, 'p')
  assert.deepEqual(merged.repo, { github: 'Org/App' })
})

// The commit a report read its repo at rides along while the repo the
// team links the report to is that one; another repo, or a report naming
// no commit, links at HEAD.
test('managed findings carry the report\'s commit only for the repo it names', () => {
  state.serverMode = 'managed'
  state.localMode = false
  state.managedSession = { id: 'viewer', role: 'view' }
  state.currentManagedTeam = 'one'
  const commit = 'b'.repeat(40)
  const report = (assigned, embedded) => ({ id: 'report', filename: 'scan.json', repo: { github: assigned, directory: '' },
    data: { repo: embedded, findings: [{ id: 'a', title: 'A' }] } })
  for (const [assigned, embedded, expected] of [
    ['Org/App', { github: 'org/app', commit }, commit],
    ['org/other', { github: 'org/app', commit }, ''],
    ['org/app', { github: 'org/app' }, ''],
    ['org/app', undefined, ''],
  ]) {
    setManagedWorkspace('one', [report(assigned, embedded)])
    assert.equal(reportRowsForFindingIds(['a'])[0].members[0]._repoCommit, expected, `${assigned} ← ${JSON.stringify(embedded)}`)
  }
})

test('global response links drive finding duplicates without introducing team link files', () => {
  state.serverMode = 'managed'
  state.localMode = false
  state.managedSession = { id: 'viewer', role: 'view' }
  state.currentManagedTeam = 'one'
  const reports = [records[0]]
  Object.defineProperty(reports, 'links', { value: [['a', 'b']] })
  setManagedWorkspace('one', reports)
  assert.deepEqual(duplicatesOf('a'), ['b'])
  assert.deepEqual(duplicatesOf('b'), ['a'])
  assert.deepEqual(linkFiles(), [], 'global reports never appear as team files')
  setManagedWorkspace('one', [records[0]])
  assert.deepEqual(duplicatesOf('a'), [], 'reloading after disable removes the old links')
})
