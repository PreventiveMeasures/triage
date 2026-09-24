import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'

test('legacy team links migrate without widening access, and multiple paths survive reopening', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-team-paths-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  const userId = await db.upsertUser({ githubUserId: 1, login: 'member', name: 'Team Member', avatarUrl: null }, 100)
  await db.selectRepo({ repoId: 7, fullName: 'owner/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'h', addedBy: userId }, 100)
  for (const id of ['scoped', 'whole']) await db.createTeam(id, id, 100)
  await db.setTeamMember('scoped', userId, { dependencies: false, security: false })
  await db.insertBundle({ id: 'bundle', integrity: 'sha512-bundle', filename: 'source.stasis', kind: 'stasis', byteSize: 1, uploadedBy: userId, repoId: 7 }, 100)
  for (const directory of ['packages/a', 'packages/a/sub', 'packages/b', 'packages/c']) {
    await db.insertReport({ id: directory, filename: `${directory}.json`, contentType: 'application/json', byteSize: 1, sha256: directory, uploadedBy: userId, repoId: 7, repoDirectory: directory, visible: true }, 100)
  }
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec(`DROP TABLE team_repo;
    CREATE TABLE team_repo (
      team_id TEXT NOT NULL REFERENCES managed_team(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES selected_repo(repo_id) ON DELETE CASCADE,
      path TEXT, PRIMARY KEY (team_id, repo_id)
    ) STRICT;
    CREATE INDEX team_repo_repo_idx ON team_repo(repo_id);
    INSERT INTO team_repo VALUES ('scoped', 7, 'packages/a'), ('whole', 7, NULL);`)
  legacy.close()
  db = openSqliteManagedDb(path)
  try {
    assert.deepEqual((await db.listTeams()).map(team => [team.id, team.repos.map(repo => repo.path)]), [['scoped', ['packages/a']], ['whole', [null]]])
    assert.equal(await db.userCanReadReport(userId, 'packages/b'), false)
    await db.setTeamRepo('scoped', 7, 'packages/b')
    await db.setTeamRepo('scoped', 7, 'packages/a/sub')
    const scoped = (await db.listTeamsForUser(userId))[0]
    assert.equal(scoped.reports.length, 3, 'overlapping scopes do not duplicate reports')
    assert.equal(scoped.bundles.length, 1, 'multiple paths do not duplicate bundles')
    assert.equal(await db.userCanReadReport(userId, 'packages/c'), false)
    await db.close()
    db = openSqliteManagedDb(path)
    assert.equal((await db.listTeams()).find(team => team.id === 'scoped').repos.length, 3)
    assert.equal(await db.removeTeamRepo('scoped', 7, 'packages/a'), true)
    assert.equal(await db.userCanReadReport(userId, 'packages/a'), false)
    assert.equal(await db.userCanReadReport(userId, 'packages/a/sub'), true)
    await db.setTeamRepo('scoped', 7, null)
    assert.deepEqual((await db.listTeams()).find(team => team.id === 'scoped').repos.map(repo => repo.path), [null])
    assert.equal(await db.userCanReadReport(userId, 'packages/c'), true)
    assert.equal(await db.removeTeamRepo('scoped', 7, null), true)
    assert.equal(await db.userCanReadReport(userId, 'packages/c'), false)
    await db.deleteTeam('whole')
    assert.equal((await db.listTeams()).length, 1)
  } finally { await db.close() }
})
