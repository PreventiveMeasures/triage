import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkHiddenTeams } from './_managed-hidden-teams.js'

test('hidden teams disable navigation, grants and public links on SQLite', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkHiddenTeams(db)
})

test('SQLite migrates existing teams as visible and preserves hidden teams across restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hidden-teams-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  const db = openSqliteManagedDb(path)
  await db.createTeam('team', 'Team', 1)
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_team DROP COLUMN hidden')
  legacy.close()
  const upgraded = openSqliteManagedDb(path)
  assert.equal((await upgraded.getTeam('team')).hidden, false)
  await upgraded.setTeamHidden('team', true, 2)
  await upgraded.close()
  const reopened = openSqliteManagedDb(path)
  t.after(() => reopened.close())
  assert.equal((await reopened.getTeam('team')).hidden, true)
})
