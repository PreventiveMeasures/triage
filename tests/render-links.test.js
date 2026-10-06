import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'
import { state } from '../client/state.ts'
import { deleteFile, saveFile } from '../client/storage.js'
import { ensureBundleFindingsIndexed } from '../client/bundle-finding-index.js'
import { clearManagedWorkspace, setManagedWorkspace } from '../client/managed/workspace.js'

mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, _key, template) => items.map(template) } })
const { renderLinksView } = await import('../ui/view/render-links.js')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, index) => text + renderText(value.values[index])).join('')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

const names = []
afterEach(async () => {
  for (const name of names.splice(0)) await deleteFile(name)
  state.triage.clear()
  state.currentLinks = null
  clearManagedWorkspace()
  state.serverMode = null
  state.managedSession = null
  state.currentManagedTeam = null
})

async function openLocalReports(id, reports) {
  state.localMode = true
  for (const [name, data] of Object.entries(reports)) {
    names.push(name)
    await saveFile(name, JSON.stringify(data))
  }
  await ensureBundleFindingsIndexed()
  state.currentLinks = { name: 'links.json', groups: [[id]], skipped: 0 }
}

test('Links dependency statuses ignore shared ignores and show report-specific counts', async () => {
  const id = 'links-dependency'
  const data = { findings: [{ id, title: 'Dependency', file: 'node_modules/pkg/a.js', isApp: false }] }
  await openLocalReports(id, { 'dep-a.json': data, 'dep-b.json': data })
  state.triage.set(id, { triage: 'ignored' })
  assert.doesNotMatch(renderText(renderLinksView()), /links-finding-status/u)
  state.triage.set(id, { triage: 'ignored', ignoredReports: ['dep-a.json'] })
  const partial = renderText(renderLinksView())
  assert.match(partial, /Ignored in 1\/2 reports/u)
  assert.match(partial, /links-finding-status triage-ignored\s+data-tooltip=dep-a\.json\s+>Ignored in 1\/2 reports/u)
  state.triage.set(id, { triage: 'ignored', ignoredReports: ['dep-a.json', 'dep-b.json'] })
  assert.match(renderText(renderLinksView()), />Ignored<\/span>/u)
  state.triage.set(id, { triage: 'fixed' })
  assert.match(renderText(renderLinksView()), />Fixed<\/span>/u)
})

test('Links keeps own, App, and dependency occurrences in their correct ignore scopes', async () => {
  const id = 'links-shared'
  const finding = { id, title: 'Same finding', file: 'node_modules/pkg/a.js', isApp: false }
  await openLocalReports(id, {
    'own.json': { findings: [{ ...finding, file: 'vendor/own.js' }], tree: { 'node_modules/pkg/a.js': {} } },
    'app.json': { findings: [{ ...finding, isApp: true }] },
    'dependency.json': { findings: [finding] },
  })
  state.triage.set(id, { triage: 'ignored' })
  let view = renderText(renderLinksView())
  assert.equal((view.match(/links-report-row-single/gu) ?? []).length, 2, 'different ignore scopes must not share a row')
  assert.equal((view.match(/>Ignored<\/span>/gu) ?? []).length, 1, 'shared ignore applies to the own/App row only')
  state.triage.set(id, { ignoredReports: ['own.json', 'app.json', 'dependency.json'] })
  view = renderText(renderLinksView())
  assert.equal((view.match(/>Ignored<\/span>/gu) ?? []).length, 1, 'report ignores apply to the dependency row only')
})

test('managed Links classifies members with the whole report dependency directory', () => {
  state.serverMode = 'managed'
  state.localMode = false
  state.managedSession = { id: 'viewer', role: 'view' }
  state.currentManagedTeam = 'team'
  const id = 'managed-links-own'
  setManagedWorkspace('team', [{ id: 'managed-report', filename: 'managed.json', repo: {}, data: {
    findings: [{ id, title: 'Own code', file: 'vendor/own.js', isApp: false },
      { id: 'other', file: 'node_modules/pkg/a.js', isApp: false }],
  } }])
  state.currentLinks = { name: 'links.json', groups: [[id]], skipped: 0 }
  state.triage.set(id, { triage: 'ignored' })
  assert.match(renderText(renderLinksView()), />Ignored<\/span>/u)
  state.triage.set(id, { ignoredReports: ['managed.json'] })
  assert.doesNotMatch(renderText(renderLinksView()), /links-finding-status/u)
})
