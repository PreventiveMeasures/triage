import assert from 'node:assert/strict'

export async function checkManagementCatalog(db) {
  const owner = await db.upsertUser({ githubUserId: 1, login: 'manager', name: null, avatarUrl: null }, 1)
  await db.setUserRole(owner, 'manage')
  await db.createSession({ id: 'catalog-session', userId: owner, csrfToken: 'csrf', expiresAt: 100 }, 1)
  for (const repoId of [1, 2]) {
    await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true,
      installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: owner }, 1)
  }
  await db.createTeam('catalog-team', 'Team', 1)
  await db.setTeamMember('catalog-team', owner, { dependencies: false, security: false })
  await db.setTeamRepo('catalog-team', 1, 'src')
  for (const [id, repoId, directory, uploadedBy] of [
    ['granted', 1, 'src/sub', null], ['owned', 2, '', owner], ['unassigned', null, '', owner],
    ['sibling', 1, 'src-other', owner], ['hidden', 2, '', null],
  ]) {
    await db.insertBundle({ id, filename: `${id}.map`, integrity: id, kind: 'sourcemap', byteSize: 2, repoId, repoDirectory: directory, uploadedBy }, 1)
    await db.insertReport({ id, filename: `${id}.json`, sha256: id, contentType: 'application/json', byteSize: 2, repoId,
      repoDirectory: directory, uploadedBy, bundleId: id === 'sibling' ? 'owned' : id, visible: false }, 1)
  }
  // An owned report must not disclose an inaccessible linked bundle's name.
  await db.insertReport({ id: 'hidden-link', filename: 'hidden-link.json', sha256: 'hidden-link', contentType: 'application/json',
    byteSize: 2, repoId: 1, repoDirectory: 'src', uploadedBy: owner, bundleId: 'hidden' }, 1)
  const reports = await db.getReportCatalog('catalog-session', 2)
  const bundles = await db.getBundleCatalog('catalog-session', 2)
  for (const catalog of [reports, bundles]) {
    assert.deepEqual(catalog.repos, [{ repoId: 1, fullName: 'org/repo1' }])
    assert.deepEqual(catalog.repoScopes.map(scope => ({ ...scope })), [{ repoId: 1, path: 'src' }])
  }
  assert.deepEqual(Object.fromEntries(reports.reports.map(r => [r.id, r.canChangeRepo])),
    { granted: true, 'hidden-link': true, owned: false, sibling: false, unassigned: true })
  assert.deepEqual(Object.fromEntries(bundles.bundles.map(b => [b.id, b.canChangeRepo])),
    { granted: true, owned: false, sibling: false, unassigned: true })
  assert.equal(reports.reports.find(r => r.id === 'hidden-link').bundleId, null)
  assert.equal(reports.reports.find(r => r.id === 'hidden-link').bundleFilename, null)
  assert.equal(reports.reports.find(r => r.id === 'sibling').bundleId, 'owned', 'ownership still grants bundle reads')
  assert.deepEqual((await db.listReadableBundleIds(owner, ['granted', 'granted', 'hidden', 'missing', 'owned'])).toSorted(), ['granted', 'owned'])
  await db.removeTeamMember('catalog-team', owner)
  assert.equal((await db.getReportCatalog('catalog-session', 3)).reports.some(r => r.id === 'granted'), false)
  await db.setUserRole(owner, 'admin')
  assert.ok((await db.getReportCatalog('catalog-session', 4)).reports.every(r => r.canChangeRepo))
  assert.equal((await db.getBundleCatalog('catalog-session', 4)).repoScopes, null)
  await db.setUserRole(owner, 'view')
  await assert.rejects(db.getReportCatalog('catalog-session', 5), { status: 403 })
  await assert.rejects(db.getBundleCatalog('catalog-session', 5), { status: 403 })
  await assert.rejects(db.getReportCatalog('catalog-session', 100), { status: 401 })
}
