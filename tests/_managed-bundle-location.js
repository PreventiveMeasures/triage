import assert from 'node:assert/strict'

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
