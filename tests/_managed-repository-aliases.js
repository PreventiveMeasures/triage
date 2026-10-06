import assert from 'node:assert/strict'
import { setup } from './_managed-mutation-safety.js'
import { hashToken } from '../server-managed/crypto.ts'

export async function checkRepositoryAliases(db) {
  const session = await setup(db), sid = hashToken(session.setCookie.split(';')[0].slice(4))
  const root = await db.saveRepositoryAlias(sid, null, { oldRepo: 'https://github.com/Org/Old', oldPath: '', repoId: 2, newPath: './projects/a/' })
  assert.deepEqual(root, { id: root.id, oldRepo: 'org/old', oldPath: '', repoId: 2, newPath: 'projects/a' })
  const nested = await db.saveRepositoryAlias(sid, null, { oldRepo: 'org/old', oldPath: 'a/', repoId: 1, newPath: '' })
  assert.deepEqual(await db.getRepositoryImportLocation('ORG/OLD', ''), { repoId: 2, directory: 'projects/a' })
  assert.deepEqual(await db.getRepositoryImportLocation('org/old', 'a/src'), { repoId: 1, directory: 'src' })
  assert.deepEqual(await db.getRepositoryImportLocation('org/old', 'another/src'), { repoId: 2, directory: 'projects/a/another/src' })
  assert.deepEqual(await db.getRepositoryImportLocation('org/repo1', 'src'), { repoId: 1, directory: 'src' })
  assert.deepEqual(await db.getRepositoryImportLocation('org/missing', ''), { repoId: null, directory: '' })
  assert.equal((await db.listRepositoryAliases()).length, 2)
  await assert.rejects(db.saveRepositoryAlias(sid, null, { ...nested, oldRepo: 'ORG/OLD', oldPath: './a/' }), /alias-exists/u)
  for (const field of ['oldPath', 'newPath']) {
    for (const bad of ['../src', 'a/../b', ' leading', 'trailing ', 'a\\b', 'a\nb', 2]) {
      await assert.rejects(db.saveRepositoryAlias(sid, null, { ...root, [field]: bad }), /bad-directory/u)
    }
  }
  await assert.rejects(db.saveRepositoryAlias(sid, null, { ...root, oldRepo: 'not-a-repo' }), /bad-old-repo/u)
  await assert.rejects(db.saveRepositoryAlias(sid, null, { ...root, repoId: 3 }), /bad-repo/u)
  const edited = await db.saveRepositoryAlias(sid, nested.id, { ...nested, newPath: 'moved' })
  assert.equal(edited.id, nested.id)
  assert.deepEqual(await db.getRepositoryImportLocation('org/old', 'a/src'), { repoId: 1, directory: 'moved/src' })
  await db.deactivateRepo(1)
  assert.deepEqual(await db.getRepositoryImportLocation('org/old', 'a/src'), { repoId: null, directory: 'moved/src' })
  await assert.rejects(db.saveRepositoryAlias(sid, nested.id, nested), /bad-repo/u)
  await db.deleteRepo(1)
  assert.deepEqual((await db.listRepositoryAliases()).map(row => ({ ...row })), [root], 'removing a destination removes its aliases')
  await db.setUserRole(session.userId, 'manage')
  await assert.rejects(db.saveRepositoryAlias(sid, root.id, root), /forbidden/u)
  await assert.rejects(db.deleteRepositoryAlias(sid, root.id), /forbidden/u)
  await db.setUserRole(session.userId, 'admin')
  await db.deleteRepositoryAlias(sid, root.id)
  assert.deepEqual(await db.listRepositoryAliases(), [])
}
