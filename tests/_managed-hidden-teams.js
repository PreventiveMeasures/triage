import assert from 'node:assert/strict'

// Exercise the same authorization paths on SQLite and PostgreSQL.
export async function checkHiddenTeams(db) {
  const user = await db.upsertUser({ githubUserId: 1, login: 'member', name: null, avatarUrl: null }, 1)
  await db.setUserRole(user, 'manage')
  await db.createSession({ id: 'session', userId: user, csrfToken: 'csrf', expiresAt: Date.now() + 60_000 }, 1)
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: user }, 1)
  await db.createTeam('team', 'Team', 1)
  await db.setTeamRepo('team', 1, 'app')
  await db.setTeamMember('team', user, { dependencies: true, security: true })
  await db.insertReport({ id: 'report', filename: 'report.json', contentType: 'application/json', byteSize: 2, sha256: 'report',
    uploadedBy: null, repoId: 1, repoDirectory: 'app/src', visible: true, bundleIntegrity: 'bundle' }, 1)
  await db.insertBundle({ id: 'bundle', integrity: 'bundle', filename: 'bundle.map', kind: 'sourcemap', byteSize: 2,
    uploadedBy: null, repoId: 1, repoDirectory: 'app' }, 1)
  await db.recordActivity({ kind: 'delete', actor: 'admin', action: 'deleted a report', reportId: 'deleted',
    report: 'deleted.json', repoId: 1, repoDirectory: 'app' }, 2)
  assert.equal(await db.createWorkspaceShare('session', 2, 'team', 'share', { dependencies: true, security: true }), true)
  const history = () => db.listActivity({ page: 1, limit: 100, kind: 'all', query: '', contexts: [], userId: user })
  const original = await db.getUserTeamFeedSnapshot('session', 10)
  const [team] = await db.listTeams()
  assert.equal(team.hidden, false)
  assert.equal((await history()).total, 3)

  for (const role of ['admin', 'manage', 'triage', 'view']) {
    await db.setUserRole(user, role)
    assert.equal((await db.listTeamsForUser(user)).length, 1, role)
    assert.equal((await db.getTeamReportAccessSnapshot('session', 10, 'team')).teamId, 'team', role)
  }

  assert.equal(await db.setTeamHidden('missing', true, 2), false)
  assert.equal(await db.setTeamHidden('team', true, 2), true)
  assert.deepEqual(await db.listTeams(), [{ ...team, hidden: true }], 'members and scopes survive hiding')
  for (const role of ['admin', 'manage', 'triage', 'view']) {
    await db.setUserRole(user, role)
    assert.deepEqual(await db.listTeamsForUser(user), [], `${role} has no hidden team in the sidebar`)
    const feed = await db.getUserTeamFeedSnapshot('session', 10)
    assert.deepEqual(feed.teams, [])
    assert.notEqual(feed.revision, original.revision)
    assert.ok(feed.catalog > original.catalog)
    const workspace = await db.getTeamReportAccessSnapshot('session', 10, 'team', 'report')
    assert.equal(workspace.teamId, null, `${role} cannot preview a hidden team`)
    assert.deepEqual(workspace.reports, [])
    assert.deepEqual(workspace.repositories, [])
    assert.equal((await db.getReportAccessSnapshot('session', 10, ['report'])).reports.length, role === 'admin' ? 1 : 0,
      'only independent global admin access survives')
    assert.equal(Boolean((await db.getBundleAccessSnapshot('session', 10, 'bundle', 'team')).bundle), role === 'admin')
    assert.equal(await db.getWorkspaceShare('share'), null)
    assert.equal(await db.getWorkspaceShareFeedState('share'), null)
    assert.equal(await db.createWorkspaceShare('session', 10, 'team', `share-${role}`), false)
  }
  assert.deepEqual(await db.listRepoScopesForUser(user), [])
  assert.equal(await db.userCanReadRepo(user, 1), false)
  assert.equal(await db.userCanReadRepoPath(user, 1, 'app/src'), false)
  assert.equal(await db.userCanReadReport(user, 'report'), false)
  assert.equal(await db.userCanReadBundle(user, 'bundle'), false)
  assert.equal(await db.userCanReadBundleAdvisories(user, 'bundle', null), false)
  assert.deepEqual(await db.reportPermissionsFor(user, 'report'), { dependencies: false, security: false })
  assert.deepEqual(await db.listReports(user), [])
  assert.deepEqual(await db.listBundles(user), [])
  assert.deepEqual(await db.listReadableBundleIds(user, ['bundle']), [])
  assert.deepEqual(await db.listActivityReports(user), [])
  assert.equal((await history()).total, 0)
  await db.linkReportsToBundle('bundle', 'bundle', user)
  assert.equal((await db.getReport('report')).bundleId, null)
  await db.setUserRole(user, 'manage')
  assert.equal(await db.listWorkspaceShares('session', 10, 'team'), null)
  assert.deepEqual(await db.listManagedWorkspaceShares('session', 10), [])
  for (const method of ['mutateReport', 'mutateBundle']) {
    await assert.rejects(db[method]('session', method === 'mutateReport' ? 'report' : 'bundle', { type: 'visibility', visible: false }),
      { status: 404 }, 'manager mutations cannot use hidden-team grants')
  }

  assert.equal(await db.setTeamHidden('team', false, 3), true)
  assert.deepEqual(await db.listTeams(), [team])
  assert.equal((await db.listTeamsForUser(user)).length, 1)
  assert.equal(await db.userCanReadRepo(user, 1), true)
  assert.equal(await db.userCanReadRepoPath(user, 1, 'app/src'), true)
  assert.equal(await db.userCanReadReport(user, 'report'), true)
  assert.equal(await db.userCanReadBundle(user, 'bundle'), true)
  assert.equal(await db.userCanReadBundleAdvisories(user, 'bundle', 'team'), true)
  assert.equal((await db.getWorkspaceShare('share')).teamId, 'team', 'restoring re-enables existing shares')
  assert.equal((await history()).total, 3)
  await db.linkReportsToBundle('bundle', 'bundle', user)
  assert.equal((await db.getReport('report')).bundleId, 'bundle')

  // Another team's standard grant survives, but the hidden team's extra
  // dependencies/security permissions must not bleed into that grant.
  await db.createTeam('active', 'Active', 3)
  await db.setTeamRepo('active', 1, 'app')
  await db.setTeamMember('active', user, { dependencies: false, security: false })
  await db.setTeamHidden('team', true, 4)
  await db.setUserRole(user, 'view')
  assert.deepEqual((await db.listTeamsForUser(user)).map(row => row.id), ['active'])
  assert.equal(await db.userCanReadReport(user, 'report'), true)
  assert.equal(await db.userCanReadBundle(user, 'bundle'), true)
  assert.equal(await db.userCanReadRepoPath(user, 1, 'elsewhere'), false)
  assert.deepEqual(await db.reportPermissionsFor(user, 'report'), { dependencies: false, security: false })
  assert.deepEqual((await db.getReportAccessSnapshot('session', 10, ['report'])).reports[0].permissions, { dependencies: false, security: false })
  assert.equal(await db.userCanReadBundleAdvisories(user, 'bundle', null), false)
  assert.equal((await db.getTeamReportAccessSnapshot('session', 10, 'team')).teamId, null)
}
