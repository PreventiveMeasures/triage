import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import { probeTeams } from '../client/managed/session.js'
import { managedTeamBundleEntries } from '../ui/view/managed-bundle-navigation.js'
import { managedBundleStats } from '../ui/view/managed-sidebar.js'
import { managedScanSource } from '../ui/managed/scan-source.js'
import { ScanPage } from '../ui/scan/page.js'
import { bundleOptions } from '../ui/view/bundle-selector.js'

const bundle = { id: 'bundle', integrity: 'hash', filename: 'app.stasis.code.br', kind: 'stasis', repoId: 1,
  byteSize: 2048, summary: { files: 3, codeFiles: 2, lines: 1234, commit: 'a'.repeat(40) } }
const commitInfo = { sha: 'a'.repeat(40), github: 'org/app', tags: ['v1.0.0'],
  details: { subject: 'Release', authorName: 'Alice', authorLogin: 'alice', authoredAt: 1, committedAt: 2 } }

test('managed catalog counts reach sidebar tooltips and comparison entries without loading inventory', async t => {
  const fetches = t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ teams: [
    { id: 'team', name: 'Team', reports: [], bundles: [bundle] },
  ] })))
  const teams = await probeTeams()
  assert.equal(teams[0].bundles[0].summary.commit, bundle.summary.commit, 'the sidebar receives the source commit without a metadata request')
  assert.equal(fetches.mock.callCount(), 1)
  assert.equal(managedBundleStats(teams[0].bundles[0]), '2.0 KiB · 3 files · 1,234 LoC')
  const [entry] = managedTeamBundleEntries(teams)
  assert.equal(entry.kind, 'stasis')
  assert.deepEqual(entry.summary, bundle.summary)
  assert.equal(entry.commitInfo, null)
  assert.equal(managedBundleStats({}), '')
  assert.equal(managedBundleStats({ summary: { files: 0, lines: 0 } }), '0 files · 0 LoC')
})

test('catalog commit details and tags survive the team probe into sidebar rows and the bundle view', async t => {
  const malformed = [{ ...commitInfo, sha: 7 }, { ...commitInfo, github: null }, { ...commitInfo, tags: 'v1' }, 'commit', null]
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ teams: [{ id: 'team', name: 'Team', reports: [], bundles: [
    { ...bundle, commitInfo }, ...malformed.map((info, i) => ({ ...bundle, id: `bad-${i}`, commitInfo: info })),
    { ...bundle, id: 'partial', commitInfo: { ...commitInfo, tags: ['v2', 3], details: { subject: 7 } } },
  ] }] })))
  const [team] = await probeTeams()
  assert.deepEqual(team.bundles[0].commitInfo, commitInfo, 'the sidebar row keeps what its tooltip shows')
  assert.deepEqual(managedTeamBundleEntries([team])[0].commitInfo, commitInfo, 'and so does the bundle view')
  assert.deepEqual(team.bundles.slice(1, -1).map(b => b.commitInfo), malformed.map(() => null))
  assert.deepEqual(team.bundles.at(-1).commitInfo, { sha: commitInfo.sha, github: 'org/app', tags: ['v2'], details: null })
})

test('managed scan selectors show cached counts before opening bundles and preserve Code resource filtering', () => {
  const source = managedScanSource({ bundles: [bundle] })
  assert.equal(source.bundles[0].files, null)
  assert.equal(bundleOptions(source.bundles)[0].secondary, '2.0 KiB · 3 files · 1,234 LoC')
  const page = new ScanPage()
  page.source = source
  page.willUpdate(new Map([['source', null]]))
  for (const [mode, files] of [['code', 2], ['dependencies', 3]]) {
    page._mode = mode
    const panel = page._sourcePanel(page._bundle, [])
    const options = panel.values.flatMap(value => value?.values ?? []).find(value => Array.isArray(value) && value[0]?.id === bundle.id)
    assert.ok(options, 'source panel passes bundle choices to the selector')
    assert.equal(bundleOptions(options)[0].secondary, `2.0 KiB · ${files} files · 1,234 LoC`)
  }
  assert.deepEqual(source.bundles[0].summary, bundle.summary, 'mode switches retain full cached totals')
  const loaded = { ...source.bundles[0], files: [{ lines: 7 }] }
  assert.equal(bundleOptions([loaded])[0].secondary, '2.0 KiB · 1 files · 7 LoC', 'loaded/scoped inventory takes precedence')
  assert.equal(bundleOptions([{ filename: 'local.map' }])[0].secondary, '', 'local/e2e options still wait for their local inventory')
})
