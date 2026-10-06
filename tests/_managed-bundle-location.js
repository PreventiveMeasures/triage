import assert from 'node:assert/strict'

export async function checkBundleAccessSnapshots(db) {
  const user = await db.upsertUser({ githubUserId: 1, login: 'member', name: null, avatarUrl: null }, 1)
  await db.createSession({ id: 'session', userId: user, csrfToken: 'csrf', expiresAt: 1000 }, 1)
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: user }, 1)
  for (const [team, security] of [['secure', true], ['plain', false]]) {
    await db.createTeam(team, team, 1)
    await db.setTeamRepo(team, 1, 'app')
    await db.setTeamMember(team, user, { dependencies: false, security })
  }
  for (const [id, repoId, directory, uploadedBy] of [
    ['root', 1, '', null], ['child', 1, 'app/sub', null], ['sibling', 1, 'application', null],
    ['owned', 1, 'elsewhere', user], ['unassigned', null, '', null], ['owned-unassigned', null, '', user],
  ]) {
    await db.insertBundle({ id, integrity: id, filename: `${id}.stasis`, kind: 'stasis', byteSize: 12,
      repoId, repoDirectory: directory, uploadedBy }, 2)
  }
  for (const role of ['admin', 'manage', 'triage', 'view', 'none']) {
    await db.setUserRole(user, role)
    for (const id of ['root', 'child', 'sibling', 'owned', 'unassigned', 'owned-unassigned', 'missing']) {
      const bundle = await db.getBundle(id)
      const allowed = bundle && role !== 'none' && (role === 'admin' || (role === 'manage'
        ? await db.userCanReadBundle(user, id) : bundle.repoId !== null && await db.userCanReadRepoPath(user, bundle.repoId, bundle.repoDirectory)))
      for (const team of [undefined, null, 'secure', 'plain', 'missing']) {
        const access = await db.getBundleAccessSnapshot('session', 10, id, team)
        assert.deepEqual(access.bundle, allowed ? bundle : null, `${role}/${id}/${team}`)
        const security = Boolean(allowed && (['admin', 'manage'].includes(role)
          || team !== undefined && await db.userCanReadBundleAdvisories(user, id, team)))
        assert.equal(access.canReadAdvisories, security, `${role}/${id}/${team}`)
      }
    }
  }
  assert.equal(await db.getBundleAccessSnapshot('missing', 10, 'child'), null)
  assert.equal(await db.getBundleAccessSnapshot('session', 1000, 'child'), null)
}

// Run the same scope checks through both SQL adapters, including activity and
// public snapshots: none of those surfaces should fall back to repo-only access.
export async function checkBundleLocations(db) {
  const user = await db.upsertUser({ githubUserId: 1, login: 'member', name: null, avatarUrl: null }, 1)
  await db.setUserRole(user, 'manage')
  await db.createSession({ id: 'session', userId: user, csrfToken: 'csrf', expiresAt: 1000 }, 1)
  for (const repoId of [1, 2]) await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: user }, 1)
  for (const [team, directory] of [['root', ''], ['foo', 'foo'], ['literal', 'foo%']]) {
    await db.createTeam(team, team, 1)
    await db.setTeamRepo(team, 1, directory)
    await db.setTeamMember(team, user, { dependencies: true, security: true })
    await db.createWorkspaceShare('session', 2, team, team)
  }
  await db.setTeamRepo('foo', 1, 'foo/sub') // Overlapping paths must not duplicate bundles.
  const paths = { root: '', foo: 'foo', child: 'foo/sub', sibling: 'foobar', literal: 'foo%/sub' }
  for (const [id, directory] of Object.entries(paths)) {
    await db.insertBundle({ id, filename: `${id}.map`, integrity: id, kind: 'sourcemap', byteSize: 2, repoId: 1, repoDirectory: directory, uploadedBy: null }, 3)
  }
  await db.insertBundle({ id: 'foreign', filename: 'foreign.map', integrity: 'foreign', kind: 'sourcemap', byteSize: 2, repoId: 2, repoDirectory: 'foo', uploadedBy: null }, 3)
  const ids = bundles => bundles.map(b => b.id).toSorted()
  const teams = await db.listTeamsForUser(user)
  assert.deepEqual(ids(teams.find(t => t.id === 'root').bundles), Object.keys(paths).toSorted())
  assert.deepEqual(ids(teams.find(t => t.id === 'foo').bundles), ['child', 'foo'])
  assert.deepEqual(ids(teams.find(t => t.id === 'literal').bundles), ['literal'])
  for (const team of teams) {
    const share = await db.getWorkspaceShare(team.id)
    assert.deepEqual(share.team.bundles, team.bundles)
  }
  await db.removeTeamMember('root', user)
  await db.removeTeamMember('literal', user)
  assert.deepEqual(ids(await db.listBundles(user)), ['child', 'foo'])
  for (const id of [...Object.keys(paths), 'foreign']) {
    const visible = ['foo', 'child'].includes(id)
    assert.equal(await db.userCanReadBundle(user, id), visible, id)
    assert.equal(await db.userCanReadBundleAdvisories(user, id, null), visible, id)
    assert.equal(await db.userCanReadBundleAdvisories(user, id, 'foo'), visible, id)
  }
  const history = () => db.listActivity({ page: 1, limit: 100, kind: 'all', query: '', contexts: [], userId: user })
  assert.deepEqual((await history()).history.map(a => a.report).toSorted(), ['child.map', 'foo.map'])
  const revision = (await db.getUserTeamFeedSnapshot('session', 10)).revision
  await db.setBundleRepo('child', 1, 'foo/sub/deeper')
  assert.notEqual((await db.getUserTeamFeedSnapshot('session', 10)).revision, revision, 'directory edits notify clients even within the same team')
  await db.setBundleRepo('child', 1, 'foobar')
  assert.equal(await db.userCanReadBundle(user, 'child'), false)
  assert.deepEqual(ids((await db.listTeamsForUser(user))[0].bundles), ['foo'])
  assert.deepEqual(ids((await db.getWorkspaceShare('foo')).bundles), ['foo'])
  await db.recordActivity({ kind: 'delete', actor: 'admin', action: 'deleted a bundle', bundleId: 'foo', report: 'foo.map', repoId: 1, repoDirectory: 'foo' }, 4)
  await db.deleteBundle('foo')
  assert.deepEqual((await history()).history.map(a => a.report), ['foo.map'])
  await db.setBundleRepo('child', null, 'foo')
  assert.equal((await db.getBundle('child')).repoDirectory, '', 'detaching clears the directory')
}

export async function checkBundleVisibility(db) {
  const user = await db.upsertUser({ githubUserId: 1, login: 'member', name: null, avatarUrl: null }, 1)
  await db.setUserRole(user, 'manage')
  await db.createSession({ id: 'session', userId: user, csrfToken: 'csrf', expiresAt: Date.now() + 60_000 }, 1)
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: user }, 1)
  await db.createTeam('team', 'Team', 1)
  await db.setTeamRepo('team', 1, 'app')
  await db.setTeamMember('team', user, { dependencies: true, security: true })
  await db.insertBundle({ id: 'bundle', integrity: 'hash', filename: 'app.map', kind: 'sourcemap', byteSize: 2, repoId: 1, repoDirectory: 'app', uploadedBy: user }, 1)
  await db.insertReport({ id: 'report', filename: 'report.json', contentType: 'application/json', byteSize: 2, sha256: 'report-hash', repoId: 1, repoDirectory: 'app', uploadedBy: user, visible: false }, 1)
  await db.createWorkspaceShare('session', 10, 'team', 'share', { dependencies: true, security: true })
  const before = (await db.getUserTeamFeedSnapshot('session', 10)).revision
  assert.equal((await db.getWorkspaceShare('share')).bundles.length, 1)
  await db.mutateBundle('session', 'bundle', { type: 'visibility', visible: false })
  assert.equal((await db.getBundleByIntegrity('hash')).visible, false)
  assert.equal((await db.listBundles())[0].visible, false)
  assert.notEqual((await db.getUserTeamFeedSnapshot('session', 10)).revision, before, 'visibility changes reach managers through the feed')
  for (const role of ['admin', 'manage', 'triage', 'view', 'none']) {
    await db.setUserRole(user, role)
    const manager = ['admin', 'manage'].includes(role)
    const access = await db.getBundleAccessSnapshot('session', 10, 'bundle', 'team')
    assert.equal(access.bundle?.id ?? null, manager ? 'bundle' : null, role)
    const [team] = await db.listTeamsForUser(user)
    assert.deepEqual(team.bundles.map(b => [b.id, b.visible]), manager ? [['bundle', false]] : [], role)
    assert.deepEqual(team.reports.map(r => [r.id, r.visible]), manager ? [['report', false]] : [], role)
  }
  await db.setUserRole(user, 'manage')
  const share = await db.getWorkspaceShare('share')
  assert.deepEqual(share.bundles, [])
  assert.deepEqual(share.team.bundles, [])
  await db.setUserRole(user, 'manage')
  await db.mutateBundle('session', 'bundle', { type: 'visibility', visible: true })
  await db.setUserRole(user, 'view')
  assert.equal((await db.getBundleAccessSnapshot('session', 10, 'bundle')).bundle.visible, true)
  assert.equal((await db.listTeamsForUser(user))[0].bundles[0].visible, true)
  await db.setUserRole(user, 'manage')
  assert.equal((await db.getWorkspaceShare('share')).team.bundles[0].visible, true)
  await db.setBundleRepo('bundle', 1, 'elsewhere')
  await assert.rejects(db.mutateBundle('session', 'bundle', { type: 'visibility', visible: false }), { status: 403 }, 'ownership alone cannot mutate an out-of-scope bundle')
  assert.equal((await db.getBundle('bundle')).visible, true)
}
