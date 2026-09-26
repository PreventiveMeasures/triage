import './_polyfills.js'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { state } from '../client/state.ts'
import { clearManagedWorkspace, setManagedWorkspace } from '../client/managed/workspace.js'
import { duplicatesOf, ensureLinkedFindingsIndexed, linkFiles } from '../client/linked-findings-index.js'
import { findingTitleForId, reportRowsForFindingIds } from '../client/bundle-finding-index.js'
import { stampSecurityGroups } from '../report/index.js'

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
