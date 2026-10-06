import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterManagedTeams } from '../ui/view/managed-sidebar.js'

const shared = Object.freeze({ id: 'shared', filename: 'Web-App.map' })
const teams = Object.freeze([
  Object.freeze({ id: 'a', name: 'Alpha', reports: Object.freeze([
    Object.freeze({ id: 'report-a', filename: 'Web-Security.json' }),
    Object.freeze({ id: 'report-b', filename: 'other.json' }),
  ]), bundles: Object.freeze([shared]) }),
  Object.freeze({ id: 'b', name: 'Beta', reports: Object.freeze([
    Object.freeze({ id: 'report-c', filename: 'worker.json' }),
  ]), bundles: Object.freeze([shared]) }),
  Object.freeze({ id: 'empty', name: 'Empty' }),
])

test('managed sidebar filters loaded filenames case-insensitively and keeps their parent teams', () => {
  const result = filterManagedTeams(teams, '  WEB  ')
  assert.deepEqual(result.map(({ team, reports, bundles }) => [team.id, reports.map(r => r.id), bundles.map(b => b.id)]), [
    ['a', ['report-a'], ['shared']], ['b', [], ['shared']],
  ])
  assert.equal(result[0].team, teams[0], 'team clicks retain the full original catalogue')
  assert.equal(result[1].team, teams[1], 'a shared bundle retains the clicked team')
  assert.equal(result[0].reports[0], teams[0].reports[0])
  assert.equal(result[0].bundles[0], shared)
})

test('managed search matches team names and hides unrelated children like local search', () => {
  const result = filterManagedTeams(teams, 'ALPHA')
  assert.deepEqual(result, [{ team: teams[0], reports: [], bundles: [] }])
  assert.deepEqual(filterManagedTeams(teams, 'missing'), [])
  assert.deepEqual(filterManagedTeams(null, 'web'), [])
})

test('clearing the managed query restores every team, report and bundle', () => {
  filterManagedTeams(teams, 'web')
  for (const query of ['', '   ']) {
    assert.deepEqual(filterManagedTeams(teams, query), teams.map(team => ({ team, reports: team.reports ?? [], bundles: team.bundles ?? [] })))
  }
})

test('App team sections match workspace navigation, search and manual collapse behavior', async () => {
  const { ManagedTeamSections } = await import('../ui/view/managed-sidebar.js')
  const sections = new ManagedTeamSections()
  const state = { managedSession: { id: 'user', role: 'manage' }, managedTeams: teams,
    currentManagedTeam: 'a', currentManagedReport: null, currentView: 'findings' }
  sections.sync(state)
  assert.equal(sections.shown('a', 'reports', true, false), false)
  assert.equal(sections.shown('a', 'bundles', true, false), false)
  assert.equal(sections.shown('a', 'reports', false, false), true, 'ordinary teams remain expanded')
  sections.sync({ ...state, currentManagedReport: 'report-a' })
  assert.equal(sections.shown('a', 'reports', true, false), true)
  sections.toggle('a', 'reports')
  sections.sync({ ...state, currentManagedReport: 'report-a' })
  assert.equal(sections.shown('a', 'reports', true, false), false, 'repaint preserves manual collapse')
  assert.equal(sections.shown('a', 'reports', true, true), true, 'search reveals temporarily')
  assert.equal(sections.shown('a', 'reports', true, false), false)
  sections.sync({ ...state, currentView: 'bundles', bundleDetails: { managedId: 'shared' } })
  assert.equal(sections.shown('a', 'bundles', true, false), true)
  assert.equal(sections.shown('b', 'bundles', true, false), false, 'only the focused team expands')
  assert.equal(sections.shown('a', 'reports', true, false), false)
  sections.sync({ ...state, managedSession: { id: 'other', role: 'manage' } })
  assert.equal(sections.shown('a', 'bundles', true, false), false, 'account changes reset choices')
})
