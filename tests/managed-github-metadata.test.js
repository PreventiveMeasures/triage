import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkGithubCommitStore, checkGithubMetadataStore } from './_managed-github-metadata.js'

test('SQLite upgrades existing databases and retains GitHub metadata across restarts without eviction', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-github-metadata-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  await openSqliteManagedDb(path).close()
  const legacy = new DatabaseSync(path)
  legacy.exec('DROP TABLE managed_github_metadata')
  legacy.exec('DROP TABLE managed_github_repository_visibility')
  legacy.close()
  const db = openSqliteManagedDb(path)
  const merged = await checkGithubMetadataStore(db)
  await db.close()
  const reopened = openSqliteManagedDb(path)
  try {
    assert.deepEqual(await reopened.listGithubMetadata([merged.key]), [merged])
    assert.deepEqual(await reopened.listGithubRepositoryVisibility([8]), [{ repoId: 8, github: 'Org/Public', public: true, checkedAt: 1 }])
  }
  finally { await reopened.close() }
})

test('SQLite adds closure reasons and attempts to an existing metadata table without discarding its cache', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-github-reasons-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  const db = openSqliteManagedDb(path)
  const cached = { key: '7:issue:9', title: 'Legacy issue', description: 'Retained body', status: 'closed', stateReason: null, fetchedAt: 1, attemptedAt: null }
  await db.setGithubMetadata([cached])
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_github_metadata DROP COLUMN state_reason')
  legacy.exec('ALTER TABLE managed_github_metadata DROP COLUMN attempted_at')
  legacy.exec('DROP TABLE managed_github_repository_visibility')
  legacy.close()
  for (let i = 0; i < 2; i++) {
    const upgraded = openSqliteManagedDb(path)
    try {
      assert.deepEqual(await upgraded.listGithubMetadata([cached.key]), [cached])
      cached.stateReason = 'completed'
      cached.fetchedAt++
      await upgraded.setGithubMetadata([cached])
      cached.attemptedAt = 100 + i
      await upgraded.recordGithubMetadataAttempts([cached.key], cached.attemptedAt)
    } finally { await upgraded.close() }
  }
})

test('SQLite adds the commit and tag caches to existing databases, keeps commits across restarts and drops tags with their repository', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-github-commits-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  await openSqliteManagedDb(path).close()
  const legacy = new DatabaseSync(path)
  legacy.exec('DROP TABLE managed_github_tag_listing; DROP TABLE managed_github_tag; DROP TABLE managed_github_commit')
  legacy.close()
  const db = openSqliteManagedDb(path)
  await db.selectRepo({ repoId: 7, fullName: 'Org/Repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }, Date.now())
  const commit = await checkGithubCommitStore(db)
  await db.close()
  const reopened = openSqliteManagedDb(path)
  try {
    assert.deepEqual(await reopened.listGithubCommits([commit.key]), [commit])
    assert.deepEqual(await reopened.listGithubCommitTags([commit.key]), [{ key: commit.key, name: 'v1' }])
  } finally { await reopened.close() }
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA foreign_keys = ON; DELETE FROM managed_selected_repo WHERE repo_id = 7')
  raw.close()
  const removed = openSqliteManagedDb(path)
  try {
    assert.deepEqual(await removed.listGithubCommitTags([commit.key]), [], 'tags go with their repository')
    assert.deepEqual(await removed.listGithubCommits([commit.key]), [commit], 'commit details are kept like PR metadata')
  } finally { await removed.close() }
})
