import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkBundleAccessSnapshots, checkBundleLocations, checkBundleVisibility } from './_managed-bundle-location.js'

test('bundle access snapshots preserve role, owner, directory and advisory grants', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkBundleAccessSnapshots(db)
})

test('SQLite bundle directories scope team catalogs, access, advisories, public links, and activity', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkBundleLocations(db)
})

test('SQLite migrates existing bundles to root and persists editable directories across restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-bundle-location-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  let db = openSqliteManagedDb(path)
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }, 1)
  await db.insertBundle({ id: 'bundle', filename: 'source.map', integrity: 'hash', kind: 'sourcemap', byteSize: 2, repoId: 1, uploadedBy: null }, 1)
  await db.close()
  const legacy = new DatabaseSync(path)
  legacy.exec('ALTER TABLE managed_bundle DROP COLUMN repo_directory; ALTER TABLE managed_bundle DROP COLUMN visible')
  legacy.close()
  db = openSqliteManagedDb(path)
  assert.equal((await db.getBundle('bundle')).repoDirectory, '')
  assert.equal((await db.getBundle('bundle')).visible, true, 'existing bundles retain visibility')
  await db.setBundleVisible('bundle', false)
  await db.setBundleRepo('bundle', 1, 'foo/sub')
  await db.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.equal((await db.getBundleByIntegrity('hash')).repoDirectory, 'foo/sub')
  assert.equal((await db.getBundle('bundle')).visible, false, 'reopening preserves hidden bundles')
  assert.equal((await db.listBundles())[0].repoDirectory, 'foo/sub')
})


test('SQLite bundle visibility controls catalogs, access, public links and feed revisions', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkBundleVisibility(db)
})
