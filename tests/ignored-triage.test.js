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
  assert.deepEqual(map.get('finding'), { triage: 'ignored', ignoredReports: ['dep.json'], scopedIgnoredReports: ['dep.json'] })
  assert.equal(sharedFindingTriage(dependency, map.get('finding')), undefined)
  setFindingTriage(map, dependency, 'untriaged')
  assert.deepEqual(map.get('finding'), { triage: 'ignored' })
  setFindingTriage(map, dependency, 'ignored')
  setFindingTriage(map, own, 'untriaged')
  assert.deepEqual(map.get('finding'), { ignoredReports: ['dep.json'], scopedIgnoredReports: ['dep.json'] })
})

test('Windows and mixed-separator dependency ignores stay per report', () => {
  for (const directory of ['node_modules', 'vendor', 'dependencies']) {
    for (const file of [`${directory}\\pkg\\a.js`, `C:\\project\\${directory}\\pkg\\a.js`, `x\\${directory}/pkg\\a.js`]) {
      const finding = { ...dependency, file }
      const map = new Map()
      setFindingTriage(map, finding, 'ignored')
      assert.deepEqual(map.get('finding'), { ignoredReports: ['dep.json'], scopedIgnoredReports: ['dep.json'] }, file)
      assert.equal(sharedFindingTriage(finding, { triage: 'ignored' }), undefined, file)
      setFindingTriage(map, finding, 'untriaged')
      assert.equal(map.has('finding'), false, file)
      setFindingTriage(map, { ...finding, isApp: true }, 'ignored')
      assert.deepEqual(map.get('finding'), { triage: 'ignored' }, `App: ${file}`)
    }
    assert.equal(usesReportIgnore({ ...dependency, file: `x\\my-${directory}\\a.js` }), false)
    assert.equal(usesReportIgnore({ ...dependency, file: `x\\${directory}-copy\\a.js` }), false)
  }
})

test('stored Windows dependency ignores survive migration while App and own ignores become shared', async () => {
  for (const directory of ['node_modules', 'vendor', 'dependencies']) {
    const content = JSON.stringify({ findings: [
      { id: 'dependency', file: `x\\${directory}\\pkg\\a.js`, isApp: false },
      { id: 'app', file: `x\\${directory}\\pkg\\a.js`, isApp: true },
      { id: 'own', file: 'src\\a.js', isApp: false },
    ] })
    const entries = Object.fromEntries(['dependency', 'app', 'own'].map(id => [id, { ignoredReports: ['windows.json'] }]))
    const result = await migrateStoredIgnores(entries, () => content)
    assert.deepEqual(result.entries, {
      dependency: { ignoredReports: ['windows.json'], scopedIgnoredReports: ['windows.json'] }, app: { triage: 'ignored' }, own: { triage: 'ignored' },
    }, directory)
    assert.equal((await migrateStoredIgnores(result.entries, () => content)).changed, false)
  }
})

test('Windows tree paths select the dependency directory before migrating own-code ignores', async () => {
  for (const treeFile of ['x\\node_modules\\pkg\\a.js', 'x\\node_modules/pkg\\a.js']) {
    const content = JSON.stringify({
      tree: { [treeFile]: {} },
      findings: [{ id: 'own', file: 'vendor/own.js', isApp: false }],
    })
    const result = await migrateStoredIgnores({ own: { ignoredReports: ['windows.json'] } }, () => content)
    assert.deepEqual(result.entries, { own: { triage: 'ignored' } })
  }
})

test('migration promotes only App/own report occurrences, preserves unknown scopes and decisions', () => {
  const map = new Map([
    ['finding', { color: 'red', ignoredReports: ['own.json', 'dep.json', 'app.json', 'missing.json'] }],
    ['already-fixed', { triage: 'fixed', comment: 'done', ignoredReports: ['own.json'] }],
  ])
  const reports = [report(own), report(dependency), report(app), report({ ...own, id: 'already-fixed' })]
  assert.equal(migrateIgnoredReports(map, reports), true)
  assert.deepEqual(map.get('finding'), { color: 'red', triage: 'ignored', ignoredReports: ['dep.json', 'missing.json'], scopedIgnoredReports: ['dep.json'] })
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
    dependency: { ignoredReports: ['code.json'], scopedIgnoredReports: ['code.json'] }, absent: { ignoredReports: ['missing.json'] },
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
  assert.deepEqual(result.entries, { same: { triage: 'ignored', ignoredReports: ['both.json'], scopedIgnoredReports: ['both.json'] } })
  assert.equal((await migrateStoredIgnores(result.entries, () => content)).changed, false)
})

test('shared ignore actions preserve an independent dependency ignore in the same report', () => {
  for (const shared of [own, app]) {
    const finding = { ...shared, _reportName: 'both.json' }
    const dep = { ...dependency, _reportName: finding._reportName }
    const map = new Map([['finding', { ignoredReports: ['both.json'] }]])
    const reports = [{ name: 'both.json', groups: [[finding], [dep]] }]
    const scoped = { ignoredReports: ['both.json'], scopedIgnoredReports: ['both.json'] }
    migrateIgnoredReports(map, reports)
    assert.deepEqual(map.get('finding'), { triage: 'ignored', ...scoped })
    setFindingTriage(map, finding, 'untriaged')
    assert.deepEqual(map.get('finding'), scoped)
    assert.equal(migrateIgnoredReports(map, reports), false, 'saving must not undo a shared restore')
    setFindingTriage(map, finding, 'ignored')
    assert.deepEqual(map.get('finding'), { triage: 'ignored', ...scoped })
    setFindingTriage(map, dep, 'untriaged')
    assert.deepEqual(map.get('finding'), { triage: 'ignored' })
  }
})

test('new dependency ignores do not migrate onto an App copy of the same id', () => {
  const dep = { ...dependency, _reportName: 'both.json' }
  const map = new Map()
  setFindingTriage(map, dep, 'ignored')
  assert.equal(migrateIgnoredReports(map, [{ name: 'both.json', groups: [[dep, { ...dep, isApp: true }]] }]), false)
  assert.equal(map.get('finding').triage, undefined)
})

test('migration markers survive changesets and rebase without marking unknown legacy scopes', async () => {
  const before = { f: { ignoredReports: ['dep.json', 'missing.json'] } }
  const scoped = { ...before.f, scopedIgnoredReports: ['dep.json'] }
  const changes = computeChangeset(before, { f: scoped })
  assert.deepEqual(changes.f, scoped, 'classification alone is a persisted change')
  const merged = rebaseLocalState(before, { f: scoped }, { f: { ...before.f, comment: 'peer' } })
  assert.deepEqual(merged.f, { ...scoped, comment: 'peer' })
  const reads = []
  const migrated = await migrateStoredIgnores(applyChangeset(before, changes), name => {
    reads.push(name)
    return JSON.stringify({ findings: [{ id: 'f', file: 'src/own.js' }] })
  })
  assert.deepEqual(reads, ['missing.json'])
  assert.deepEqual(migrated.entries.f, { triage: 'ignored', ignoredReports: ['dep.json'], scopedIgnoredReports: ['dep.json'] })
  assert.deepEqual(normalizeEntry({ ...scoped, ignoredReports: ['missing.json'] }), { ignoredReports: ['missing.json'] })
})

test('migration leaves malformed ignore fields for the normal import validator', async () => {
  const entries = { invalid: { ignoredReports: 'not-an-array' }, marked: { ignoredReports: ['dep.json'], scopedIgnoredReports: ['dep.json'] } }
  const result = await migrateStoredIgnores(entries, () => assert.fail('no legacy report scopes to read'))
  assert.deepEqual(result, { entries, changed: false })
})

test('switching from another bucket to shared ignored preserves a peer dependency ignore', () => {
  assert.deepEqual(rebaseLocalState({ f: { triage: 'fixed' } }, { f: { triage: 'ignored' } },
    { f: { ignoredReports: ['dependency.json'] } }).f,
  { triage: 'ignored', ignoredReports: ['dependency.json'] })
})
