import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { checkBundleBuildConditions, checkBundleProvenance } from './_managed-bundle-provenance.js'

const bundle = { integrity: 'hash', kind: 'stasis', byteSize: 1, uploadedBy: null, uploadedByLogin: 'alice', repoId: null }
const uploads = { page: 1, limit: 100, kind: 'upload', query: '', contexts: null }

test('SQLite bundle provenance labels builds and keeps them from upload renames', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkBundleProvenance(db)
})

test('SQLite records the conditions of server builds', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkBundleBuildConditions(db)
})

test('SQLite adds build conditions to existing bundles as unrecorded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-build-conditions-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  await db.insertBundle({ ...bundle, id: 'old', filename: 'old.stasis.code.br', provenance: 'build' }, 1)
  await db.close()
  const legacy = new DatabaseSync(file)
  legacy.exec('ALTER TABLE managed_bundle DROP COLUMN build_conditions')
  legacy.close()
  db = openSqliteManagedDb(file)
  t.after(() => db.close())
  assert.equal((await db.getBundle('old')).buildConditions, null)
  const conditions = { preset: 'browser', conditions: ['browser'], platforms: [] }
  await db.insertBundle({ ...bundle, id: 'new', integrity: 'new', filename: 'new.stasis.code.br', provenance: 'build', buildConditions: conditions }, 2)
  assert.deepEqual((await db.getBundle('new')).buildConditions, conditions)
})

test('SQLite adds unknown provenance to existing bundles and replaces the pre-build activity trigger', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-provenance-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(file)
  await db.insertBundle({ ...bundle, id: 'old', filename: 'old.stasis.code.br' }, 1)
  await db.close()
  // Recreate the schema and upload trigger from before provenance existed.
  const legacy = new DatabaseSync(file)
  legacy.exec(`DROP TRIGGER managed_bundle_activity;
    ALTER TABLE managed_bundle DROP COLUMN provenance;
    CREATE TRIGGER managed_bundle_activity AFTER INSERT ON managed_bundle
    BEGIN INSERT INTO managed_activity (id, kind, actor, action, repo, report_id, report, at, bundle_id, actor_id)
      SELECT 'bundle-upload:' || NEW.id, 'upload', NEW.uploaded_by_login, 'uploaded a bundle', NULL, NULL, NEW.filename, NEW.uploaded_at, NEW.id, NEW.uploaded_by; END;`)
  legacy.close()
  db = openSqliteManagedDb(file)
  t.after(() => db.close())
  assert.equal((await db.getBundle('old')).provenance, null)
  await db.insertBundle({ ...bundle, id: 'new', integrity: 'new', filename: 'new.stasis.code.br', provenance: 'build' }, 2)
  assert.deepEqual((await db.listActivity(uploads)).history.map(entry => [entry.report, entry.action]), [
    ['new.stasis.code.br', 'built a bundle'], ['old.stasis.code.br', 'uploaded a bundle'],
  ])
})
