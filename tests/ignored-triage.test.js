import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateIgnoredReports, migrateStoredIgnores, setFindingTriage, sharedFindingTriage, usesReportIgnore } from '../client/ignored-triage.js'
import { applyChangeset, computeChangeset, rebaseLocalState } from '../client/sync/triage-changeset.ts'
import { normalizeEntry } from '../client/triage-entry.ts'

const own = { id: 'finding', file: 'src/app.js', isApp: false, _reportName: 'own.json' }
const dependency = { ...own, file: 'node_modules/lib/index.js', _reportName: 'dep.json' }
const app = { ...dependency, isApp: true, _reportName: 'app.json' }
const report = (finding) => ({ name: finding._reportName, groups: [[finding]] })

test('App and own-code ignore uses shared triage and restore preserves other annotations', () => {
  for (const finding of [own, app]) {
    const map = new Map([['finding', { color: 'red', comment: 'reason', flagged: false, fix: 'PR' }]])
    setFindingTriage(map, finding, 'ignored')
    assert.deepEqual(map.get('finding'), { color: 'red', comment: 'reason', flagged: false, fix: 'PR', triage: 'ignored' })
    assert.equal(sharedFindingTriage({ ...finding, _reportName: 'rescan.json' }, map.get('finding')), 'ignored')
    setFindingTriage(map, finding, 'untriaged')
    assert.deepEqual(map.get('finding'), { color: 'red', comment: 'reason', flagged: false, fix: 'PR' })
  }
})

test('dependency ignore remains per report, independent of shared ignore on the same id', () => {
  const map = new Map()
  setFindingTriage(map, own, 'ignored')
  setFindingTriage(map, dependency, 'ignored')
  assert.deepEqual(map.get('finding'), { triage: 'ignored', ignoredReports: ['dep.json'] })
  assert.equal(sharedFindingTriage(dependency, map.get('finding')), undefined)
  setFindingTriage(map, dependency, 'untriaged')
  assert.deepEqual(map.get('finding'), { triage: 'ignored' })
  setFindingTriage(map, dependency, 'ignored')
  setFindingTriage(map, own, 'untriaged')
  assert.deepEqual(map.get('finding'), { ignoredReports: ['dep.json'] })
})

test('migration promotes only App/own report occurrences, preserves unknown scopes and decisions', () => {
  const map = new Map([
    ['finding', { color: 'red', ignoredReports: ['own.json', 'dep.json', 'app.json', 'missing.json'] }],
    ['already-fixed', { triage: 'fixed', comment: 'done', ignoredReports: ['own.json'] }],
  ])
  const reports = [report(own), report(dependency), report(app), report({ ...own, id: 'already-fixed' })]
  assert.equal(migrateIgnoredReports(map, reports), true)
  assert.deepEqual(map.get('finding'), { color: 'red', triage: 'ignored', ignoredReports: ['dep.json', 'missing.json'] })
  assert.deepEqual(map.get('already-fixed'), { triage: 'fixed', comment: 'done' })
  assert.equal(migrateIgnoredReports(map, reports), false)
})

test('report content migration derives App layer, respects dependency directory precedence, and defers missing files', async () => {
  const entries = {
    app: { ignoredReports: ['app.json'] },
    own: { ignoredReports: ['code.json'] },
    dependency: { ignoredReports: ['code.json'] },
    absent: { ignoredReports: ['missing.json'] },
  }
  const contents = {
    'app.json': JSON.stringify({ source: 'codex-security', findings: [{ id: 'app', file: 'node_modules/pkg/a.js' }] }),
    'code.json': JSON.stringify({ findings: [
      { id: 'own', file: 'vendor/own.js' }, { id: 'dependency', file: 'node_modules/pkg/a.js' },
    ] }),
  }
  const migrated = await migrateStoredIgnores(entries, name => contents[name])
  assert.equal(migrated.changed, true)
  assert.deepEqual(migrated.entries, {
    app: { triage: 'ignored' }, own: { triage: 'ignored' },
    dependency: { ignoredReports: ['code.json'] }, absent: { ignoredReports: ['missing.json'] },
  })
  assert.deepEqual(entries.app, { ignoredReports: ['app.json'] }, 'detached import must not mutate its source')
  assert.equal(usesReportIgnore({ ...dependency, file: 'vendor/pkg/a.php' }), true)
  assert.equal(usesReportIgnore({ ...dependency, file: 'dependencies/pkg/a.js' }), true)
})

test('shared ignored and dependency scopes round-trip through changesets and concurrent edits', () => {
  const entry = { triage: 'ignored', ignoredReports: ['dependency.json'] }
  assert.deepEqual(normalizeEntry(entry), entry)
  assert.deepEqual(applyChangeset({}, computeChangeset({}, { f: entry })).f, entry)
  // A peer changes the shared status while this device ignores another report.
  const base = { f: { ignoredReports: ['dependency.json'] } }
  const local = { f: { ignoredReports: ['dependency.json', 'second.json'] } }
  const remote = { f: entry }
  assert.deepEqual(rebaseLocalState(base, local, remote).f, { triage: 'ignored', ignoredReports: ['dependency.json', 'second.json'] })
  // A local shared restore must preserve the peer's independent report change.
  assert.deepEqual(rebaseLocalState(remote, base, { f: { triage: 'ignored', ignoredReports: ['dependency.json', 'second.json'] } }).f,
    { ignoredReports: ['dependency.json', 'second.json'] })
})


test('migration retains a dependency scope when one report also contains an App copy of its id', async () => {
  const content = JSON.stringify({ findings: [null, 'malformed member',
    { id: 'same', file: 'node_modules/pkg/a.js', isApp: true },
    { id: 'same', file: 'node_modules/pkg/a.js', isApp: false },
  ] })
  const result = await migrateStoredIgnores({ same: { ignoredReports: ['both.json'] } }, () => content)
  assert.deepEqual(result.entries, { same: { triage: 'ignored', ignoredReports: ['both.json'] } })
  assert.equal((await migrateStoredIgnores(result.entries, () => content)).changed, false)
})

test('switching from another bucket to shared ignored preserves a peer dependency ignore', () => {
  assert.deepEqual(rebaseLocalState({ f: { triage: 'fixed' } }, { f: { triage: 'ignored' } },
    { f: { ignoredReports: ['dependency.json'] } }).f,
  { triage: 'ignored', ignoredReports: ['dependency.json'] })
})
