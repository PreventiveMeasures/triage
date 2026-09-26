import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commitRevision, headFor, openDb } from '../server-e2e/db.ts'
import { openVercelBlobBackend } from '../server-e2e/objstore/blob-vercel.ts'
import { reapOrphans } from '../server-e2e/objstore/reaper.ts'
import { deleteObject, getLive, openObjstore } from '../server-e2e/objstore/store.ts'
import { openManagedVercelStorage } from '../server-managed/blob-vercel.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { openPostgresManagedDb } from '../server-managed/db-neon.ts'
import { openManagedStorage } from '../server-managed/storage.ts'
import { freshNeonDb, freshNeonObjstore } from './_neon-pglite.js'
import { sdkFixture } from './_managed-vercel.js'

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'triage-storage-isolation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function postgresManaged(pg) {
  // Tests use operations sequentially; PGlite has one connection.
  return openPostgresManagedDb(() => Promise.resolve({
    async query(sql, params) {
      if (!params && sql.includes(';')) { await pg.exec(sql); return { rows: [] } }
      const result = await pg.query(sql, params)
      return { ...result, rowCount: result.affectedRows }
    },
    release: () => Promise.resolve(),
  }))
}

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: e2e and managed schemas coexist without crossing reads or deletes`, async t => {
    const dir = await directory(t)
    let managed, objects, revisions
    if (backend === 'sqlite') {
      const path = join(dir, 'shared.db')
      revisions = openDb(path)
      objects = openObjstore(revisions.db, join(dir, 'objstore'))
      // Low-level compatibility only: the combined launcher rejects this path.
      managed = openSqliteManagedDb(path)
    } else {
      const revisionFixture = await freshNeonDb()
      const objectFixture = await freshNeonObjstore()
      assert.equal(revisionFixture.pg, objectFixture.pg, 'all metadata uses one database')
      revisions = revisionFixture.handle
      objects = objectFixture.handle
      t.after(objectFixture.cleanup)
      managed = await postgresManaged(revisionFixture.pg)
    }
    t.after(async () => { await managed.close(); await revisions.close() })
    const hash = 'a'.repeat(43), id = randomUUID(), incarnation = 'b'.repeat(22)
    await commitRevision(revisions, { tag: id, id: 'revision', base: null, keyframe: false,
      nonce: 'nonce', ciphertext: 'encrypted', signature: 'signature' })
    await objects.insertLiveIfAbsent.get(id, id, incarnation, hash, 9, 'c'.repeat(86), 1)
    const user = await managed.upsertUser({ githubUserId: 1, login: 'managed', name: null, avatarUrl: null }, 1)
    assert.equal((await managed.listUsers())[0].role, 'none', 'sharing storage does not grant the first login admin')
    await managed.setUserRole(user, 'admin')
    const report = { id, filename: 'report.json', contentType: 'application/json', byteSize: 9, sha256: hash,
      uploadedBy: user, uploadedByLogin: 'managed', repoId: null, repoDirectory: '', analyzer: null,
      visible: true, bundleId: null, bundleIntegrity: null }
    await managed.insertReport(report, 1)
    assert.equal((await managed.listReports(user)).length, 1)
    assert.equal((await managed.getReport(id)).sha256, hash)
    assert.equal(await headFor(revisions, id), 'revision')
    assert.equal((await getLive(objects, id, id)).contentHash, hash)
    assert.equal((await deleteObject(objects, id, id, 1, incarnation)).ok, true)
    assert.ok(await managed.getReport(id))
    assert.equal(await headFor(revisions, id), 'revision')
    await objects.insertLiveIfAbsent.get(id, id, incarnation, hash, 9, 'c'.repeat(86), 2)
    assert.equal(await managed.deleteReport(id), true)
    assert.equal((await getLive(objects, id, id)).contentHash, hash)
    assert.equal(await headFor(revisions, id), 'revision')
  })
}

test('local storage: colocated SQLite files keep managed bytes outside e2e cleanup', async t => {
  const dir = await directory(t)
  const revisions = openDb(join(dir, 'e2e.db'))
  const e2e = openObjstore(revisions.db, join(dir, 'objstore'))
  const managed = await openManagedStorage({ dbPath: join(dir, 'managed.db'), triageHistoryLimit: 0 })
  t.after(async () => { await managed.db.close(); await revisions.close() })
  const bytes = Buffer.from('managed plaintext'), id = randomUUID()
  await managed.reportStore.put(id, bytes)
  await managed.bundleStore.put(id, bytes, null)
  await managed.avatarStore.put(id, 'image/png', bytes)
  await reapOrphans(e2e, 0)
  assert.deepEqual(await managed.reportStore.get(id), bytes)
  assert.deepEqual(await managed.bundleStore.get(id, null), bytes)
  assert.deepEqual((await managed.avatarStore.get(id)).bytes, bytes)
  await managed.bundleStore.delete(id)
  assert.deepEqual(await managed.reportStore.get(id), bytes)
})

function sharedBlobFixture() {
  const fixture = sdkFixture()
  fixture.sdk.list = ({ prefix = '', mode }) => {
    const blobs = [], folders = new Set()
    for (const [pathname, object] of fixture.objects) {
      if (!pathname.startsWith(prefix)) continue
      const slash = pathname.indexOf('/', prefix.length)
      if (mode === 'folded' && slash !== -1) folders.add(pathname.slice(0, slash + 1))
      else blobs.push({ pathname, uploadedAt: object.uploadedAt, size: object.bytes.length })
    }
    return Promise.resolve({ blobs, folders: [...folders], hasMore: false })
  }
  return fixture
}

test('shared private Blob: e2e GC and managed deletes/reaping stay in their own namespaces', async t => {
  const { sdk, objects } = sharedBlobFixture()
  const revisions = openDb(':memory:')
  t.after(() => revisions.close())
  const dir = await directory(t)
  const e2e = openObjstore(revisions.db, dir)
  e2e.blob = await openVercelBlobBackend({ token: 'same-token', sdk })
  const managed = await openManagedVercelStorage('same-token', sdk)
  const id = randomUUID(), liveHash = 'a'.repeat(43), orphanHash = 'b'.repeat(43), tag = 'workspace'
  const bytes = Buffer.from('stored'), sid = 'c'.repeat(22)
  await e2e.insertLiveIfAbsent.get(tag, id, 'd'.repeat(22), liveHash, bytes.length, 'e'.repeat(86), 1)
  const livePath = `${tag}/${liveHash}.bin`, orphanPath = `${tag}/${orphanHash}.bin`
  const stagingPath = `${tag}/.staging/${sid}.bin`
  for (const path of [livePath, orphanPath, stagingPath]) objects.set(path, { bytes, uploadedAt: new Date(0) })
  await managed.reportStore.put(id, bytes)
  await managed.bundleStore.put(id, bytes, null)
  await managed.avatarStore.put(id, 'image/png', bytes)
  await managed.cacheStorage.put(id, 'v2-metadata.json.br', bytes)
  await managed.reportSourcesStorage.put(`${id}/v1-report/format/scope.json.gz`, bytes)
  await managed.uploadStore.put(id, bytes)
  const managedPaths = [...objects.keys()].filter(path => path.startsWith('.managed/'))
  // Age every managed object so TTL cannot accidentally protect it from e2e GC.
  for (const path of managedPaths) objects.get(path).uploadedAt = new Date(0)
  assert.ok((await e2e.blob.listWorkspaceTags()).includes('.managed'))
  await reapOrphans(e2e)
  assert.ok(objects.has(livePath))
  assert.equal(objects.has(orphanPath), false)
  assert.equal(objects.has(stagingPath), false)
  for (const path of managedPaths) assert.ok(objects.has(path), path)
  await managed.reapUploads()
  assert.equal(objects.has(`.managed/uploads/${id}`), false)
  await managed.cacheStorage.delete(id)
  await managed.reportSourcesStorage.delete(id)
  await managed.bundleStore.delete(id)
  await managed.reportStore.delete(id)
  assert.deepEqual([...objects.keys()].toSorted(), [livePath, `.managed/avatars/${id}`].toSorted())
  const live = await e2e.blob.openLiveReader(tag, liveHash)
  assert.equal(live.ok, true)
  const chunks = []
  for await (const chunk of live.reader.stream) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), bytes)
  await live.reader.close()
})
