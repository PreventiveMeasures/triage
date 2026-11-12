// A team's board linked with its repository and severity filters,
// `/team/<slug>?repo=owner/name&severity=critical,high`
// (common/managed/team-filters.js). Its URL names them only on Kanban,
// whose board shows every triage status, and only while they are all the
// board is filtered by; a link opens the board filtered so.
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import './_polyfills.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { browserAt } from './_managed-browser.js'

const { managedRouteForIds, managedRoutePath, parseManagedRoute, resolveManagedRoute } = await import('../common/managed/routes.js')
const { state } = await import('../client/state.ts')
const { NO_REPO_SENTINEL, applyLinkedFilters, applyOpeningFilters, linkedFilters, resetFilters } = await import('../ui/view/filters.js')
const { clearMergedGroups, getShownGroups } = await import('../ui/view/group.js')
const { managedFindingSelectionRoute } = await import('../ui/view/finding-selection.js')

const teams = [{ id: 'team-id', slug: 'team', reports: [{ id: 'report-id', slug: 'report' }] }]
const parse = path => parseManagedRoute(new URL(path, 'https://triage.test'))

describe('team link routes', () => {
  it('reads and writes a team board\'s repository and severities, in severity order', () => {
    const route = parse('/team/team?severity=high,bogus,critical&repo=owner/a')
    assert.deepEqual(route, { view: 'findings', teamSlug: 'team', reportSlug: null, filters: { repo: 'owner/a', severities: ['critical', 'high'] } })
    assert.equal(managedRoutePath(route), '/team/team?repo=owner/a&severity=critical,high')
    assert.deepEqual(parse('/team/team?severity=low').filters, { severities: ['low'] })
    assert.deepEqual(parse('/team/team?repo=a%2Bb/c%20d').filters, { repo: 'a+b/c d' })
    assert.equal(managedRoutePath({ view: 'findings', teamSlug: 'team', filters: { repo: 'a+b/c d' } }), '/team/team?repo=a%2Bb/c%20d')
    for (const path of ['/team/team', '/team/team?repo=', '/team/team?severity=', '/team/team?severity=bogus', '/team/team?repo=a%01b', '/team/team?status=open']) {
      assert.equal(parse(path).filters, undefined, path)
    }
  })

  it('names them only on the team\'s own board, not a report\'s, a finding\'s or Files', () => {
    for (const path of ['/team/team/report/report?repo=owner/a', '/team/team/finding/x?severity=high', '/team/team/files?repo=owner/a']) {
      assert.equal(parse(path).filters, undefined, path)
    }
    const filters = { repo: 'owner/a', severities: ['high'] }
    assert.equal(managedRoutePath({ view: 'findings', teamSlug: 'team', reportSlug: 'report', filters }), '/team/team/report/report')
    assert.equal(managedRoutePath({ view: 'findings', teamSlug: 'team', finding: { id: 'x' }, filters }), '/team/team/finding/x')
    assert.equal(managedRoutePath({ view: 'files', teamSlug: 'team', filters }), '/team/team/files')
  })

  it('keeps them through resolution, and a link opens and stays on them', async () => {
    const filters = { repo: 'owner/a', severities: ['critical', 'high'] }
    const resolved = resolveManagedRoute({ view: 'findings', teamSlug: 'team', reportSlug: null, filters }, teams)
    assert.deepEqual(resolved, { view: 'findings', teamId: 'team-id', reportId: null, filters })
    assert.deepEqual(managedRouteForIds(resolved, teams), { view: 'findings', teamSlug: 'team', reportSlug: null, filters })
    const { browser } = browserAt('/team/team?severity=high,critical&repo=owner/a')
    let shown
    await createManagedHistory(browser).start(route => {
      shown = resolveManagedRoute(route, teams)
      return shown ? managedRouteForIds(shown, teams) : false
    })
    assert.deepEqual(shown.filters, filters)
    assert.equal(`${browser.location.pathname}${browser.location.search}`, '/team/team?repo=owner/a&severity=critical,high')
  })
})

describe('a team board\'s URL', () => {
  const finding = (id, repo, severity = 'high') => ({ id, severity, file: `src/${id}.js`, repo: { github: repo }, _reportName: 'r.json' })
  const groups = [[finding('a', 'owner/a', 'critical')], [finding('b', 'owner/b')]]
  const base = { view: 'findings', teamSlug: 'team', reportSlug: null }
  const route = (group = null) => managedFindingSelectionRoute(group, state)

  beforeEach(() => {
    state.serverMode = 'managed'
    state.reports = [{ fileName: 'r.json', groups }]
    state.workspaceMerges = []
    state.currentWorkspace = 'managed-team:team-id'
    clearMergedGroups()
    state.managedTeams = teams
    state.currentManagedTeam = 'team-id'
    state.currentManagedReport = null
    state.currentView = 'findings'
    state.viewMode = 'kanban'
    resetFilters()
    applyOpeningFilters(getShownGroups())
  })

  it('names the repository and severities only while they are all it is filtered by', () => {
    assert.deepEqual(route(), base)
    state.filterRepo = 'owner/a'
    assert.deepEqual(route(), { ...base, filters: { repo: 'owner/a' } })
    state.filterSeverities = new Set(['high', 'critical'])
    assert.deepEqual(route(), { ...base, filters: { repo: 'owner/a', severities: ['high', 'critical'] } })
    assert.equal(managedRoutePath(route()), '/team/team?repo=owner/a&severity=critical,high')
    for (const [key, value, unset] of [['filterInclude', 'needle', ''], ['filterConfMin', 5, state.filterConfMin],
      ['filterColors', new Set(['red']), new Set()], ['filterFlagged', 'yes', ''], ['filterSecurity', 'only', '']]) {
      state[key] = value
      assert.deepEqual(route(), base, `${key} is no filter a link names`)
      state[key] = unset
    }
    state.filterIncludeNegate = true
    assert.deepEqual(route().filters, { repo: 'owner/a', severities: ['high', 'critical'] }, 'negating no search filters nothing')
    state.filterRepo = NO_REPO_SENTINEL
    assert.equal(linkedFilters(), null, 'no link names "no repository"')
  })

  it('names them only on Kanban, on the team\'s own board, with no finding open', () => {
    state.filterRepo = 'owner/a'
    for (const mode of ['focus', 'table', 'list', 'grouped']) {
      state.viewMode = mode
      assert.deepEqual(route(), base, `${mode} filters by triage status too`)
    }
    state.viewMode = 'kanban'
    assert.deepEqual(route(groups[0]), { ...base, finding: { id: 'a' } })
    state.currentManagedReport = 'report-id'
    assert.deepEqual(route(), { ...base, reportSlug: 'report' })
  })

  it('applies a link\'s filters, leaving out a repository the board has none of', () => {
    applyLinkedFilters({ repo: 'owner/b', severities: ['critical', 'high'] })
    assert.equal(state.filterRepo, 'owner/b')
    assert.deepEqual([...state.filterSeverities], ['critical', 'high'])
    resetFilters()
    applyLinkedFilters({ repo: 'owner/missing', severities: ['low'] })
    assert.equal(state.filterRepo, '')
    assert.deepEqual([...state.filterSeverities], ['low'])
  })

  // A link opened on the board already showing (its load reset nothing)
  // shows what it would on a fresh one: the filters it names and no
  // others, the rest as the board opened, the reader's sort kept.
  it('replaces the board\'s filters, rather than adding to them', () => {
    Object.assign(state, { filterRepo: 'owner/a', filterInclude: 'needle', filterColors: new Set(['red']), filterConfMin: 7, sortBy: 'file' })
    applyLinkedFilters({ severities: ['high'] })
    assert.equal(state.filterRepo, '')
    assert.equal(state.filterInclude, '')
    assert.equal(state.filterColors.size, 0)
    assert.equal(state.filterConfMin, 0)
    assert.equal(state.sortBy, 'file')
    assert.deepEqual(route(), { ...base, filters: { severities: ['high'] } })
  })

  // The baseline is what the board opens on, the confidence floor it
  // chooses among it. A reset that clears that floor (to reveal a finding
  // under it) leaves a board a link would not open again.
  it('measures against the floor the board opens on, through a reset that clears it', () => {
    const scored = [[{ ...finding('c', 'owner/a'), confidence: 9 }], [{ ...finding('d', 'owner/b'), confidence: 2 }]]
    state.reports = [{ fileName: 'r.json', groups: scored }]
    clearMergedGroups()
    applyOpeningFilters(getShownGroups())
    assert.equal(state.filterConfMin, 3)
    state.filterRepo = 'owner/a'
    assert.deepEqual(route().filters, { repo: 'owner/a' })
    resetFilters()
    state.filterRepo = 'owner/a'
    assert.equal(state.filterConfMin, 0)
    assert.deepEqual(route(), base, 'the floor the link would open on is not the one shown')
    applyLinkedFilters({ repo: 'owner/a' })
    assert.equal(state.filterConfMin, 3, 'a link puts back the floor the board opened on')
    assert.deepEqual(route().filters, { repo: 'owner/a' })
  })
  // Outside Kanban a view shows one triage status, and its opening floor is
  // read off that status alone. A link is for Kanban's board, every status
  // on it, and opens on that board's floor whichever view loaded the team.
  it('opens on Kanban\'s floor, whichever view the team was loaded in', () => {
    const scored = [[{ ...finding('c', 'owner/a'), confidence: 9 }], [{ ...finding('d', 'owner/b'), confidence: 2 }]]
    state.reports = [{ fileName: 'r.json', groups: scored }]
    clearMergedGroups()
    state.triage.set('d', { triage: 'fixed' })
    try {
      state.viewMode = 'table'
      applyOpeningFilters(getShownGroups())
      assert.equal(state.filterConfMin, 0, 'the open finding alone sets no floor')
      state.viewMode = 'kanban'
      applyLinkedFilters({ severities: ['high'] })
      assert.equal(state.filterConfMin, 3)
      assert.deepEqual(route().filters, { severities: ['high'] })
    } finally {
      state.triage.delete('d')
    }
  })

  // The same board, loaded in Table and switched to Kanban by hand: what
  // it shows is still Table's floor, which a link would not open on.
  it('names nothing on a board switched to Kanban with another view\'s floor', () => {
    const scored = [[{ ...finding('c', 'owner/a'), confidence: 9 }], [{ ...finding('d', 'owner/b'), confidence: 2 }]]
    state.reports = [{ fileName: 'r.json', groups: scored }]
    clearMergedGroups()
    state.triage.set('d', { triage: 'fixed' })
    try {
      state.viewMode = 'table'
      applyOpeningFilters(getShownGroups())
      state.viewMode = 'kanban'
      state.filterSeverities = new Set(['high'])
      assert.deepEqual(route(), base, 'Table\'s floor of 0 is no floor a link opens on')
      state.filterConfMin = 3
      assert.deepEqual(route().filters, { severities: ['high'] })
    } finally {
      state.triage.delete('d')
    }
  })

  // render.js drops the range to 0—10 where a finding has no score: the
  // floor the board opens on is then none, whatever it would choose.
  it('takes no floor for a board without the confidence range', () => {
    const mixed = [[{ ...finding('c', 'owner/a'), confidence: 9 }], [{ ...finding('d', 'owner/b'), confidence: 2 }], [finding('e', 'owner/a')]]
    state.reports = [{ fileName: 'r.json', groups: mixed }]
    clearMergedGroups()
    state.filterConfMin = 0
    state.filterRepo = 'owner/a'
    assert.deepEqual(route().filters, { repo: 'owner/a' })
    applyLinkedFilters({ repo: 'owner/a' })
    assert.equal(state.filterConfMin, 0)
  })
})
