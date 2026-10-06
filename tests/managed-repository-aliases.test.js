import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { bundleIntegrity } from '../server-managed/bundle.ts'
import { checkRepositoryAliases } from './_managed-repository-aliases.js'
import { config, harness, memoryStore, setup } from './_managed-mutation-safety.js'
import { createSession } from '../server-managed/session.ts'

const path = '/api/admin/repositories/aliases'
async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const bundles = memoryStore(), reports = memoryStore(), session = await setup(db)
  const send = harness(db, reports, bundles)
  const alias = { oldRepo: 'org/old', oldPath: '', repoId: 2, newPath: 'projects/a' }
  const saved = await send(path, { session, body: alias })
  assert.equal(saved.status, 201)
  return { db, session, reports, bundles, send, alias: JSON.parse(saved.body) }
}
test('SQLite aliases validate, select the longest directory boundary and enforce admin writes', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkRepositoryAliases(db)
})

test('aliases assign new reports and bundles without modifying bytes, paths, findings or identities', async t => {
  const { db, session, send, reports, bundles, alias } = await fixture(t)
  const report = { repo: { github: 'ORG/OLD' }, findings: [{ id: 'original', repo: { github: 'org/old' }, file: 'src/a.js', evidence: [{ file: 'src/b.js' }] }] }
  const bytes = brotliCompressSync(Buffer.from(JSON.stringify({ version: 0, repo: { github: 'org/old' }, sources: { 'src/a.js': 'original' } })))
  report.bundleHashes = [bundleIntegrity(bytes)]
  const uploadReport = () => send('/api/admin/reports', { session, body: report })
  const uploadBundle = () => send('/api/admin/bundles', { session, body: bytes, headers: { 'x-bundle-filename': 'old.stasis.code.br' } })
  const uploadedBundle = await uploadBundle(), uploadedReport = await uploadReport()
  assert.equal(uploadedReport.status, 201)
  assert.equal(uploadedBundle.status, 201)
  const storedBundle = JSON.parse(uploadedBundle.body), storedReport = JSON.parse(uploadedReport.body)
  for (const item of [storedReport, storedBundle]) {
    assert.equal(item.repoId, 2)
    assert.equal(item.repoDirectory, 'projects/a')
  }
  assert.equal(storedReport.repoEmbedded, true)
  assert.equal((await db.getReport(storedReport.id)).bundleId, storedBundle.id)
  assert.equal(storedBundle.integrity, report.bundleHashes[0])
  assert.deepEqual(await reports.get(storedReport.id), Buffer.from(JSON.stringify(report)))
  assert.deepEqual(await bundles.get(storedBundle.id), bytes)
  assert.equal((await send(`${path}/${alias.id}`, { session, method: 'PATCH', body: { ...alias, repoId: 1, newPath: 'new/place' } })).status, 200)
  for (const result of [await uploadReport(), await uploadBundle()]) {
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).repoId, 2)
    assert.equal(JSON.parse(result.body).repoDirectory, 'projects/a')
  }
  report.findings[0].id = 'new-import'
  assert.equal(JSON.parse((await uploadReport()).body).repoDirectory, 'new/place')
  await send(`${path}/${alias.id}`, { session, method: 'DELETE' })
  assert.equal((await uploadBundle()).status, 200, 'removed aliases do not affect existing bundles')
  assert.equal((await uploadReport()).status, 200, 'removed aliases do not affect existing reports')
})

test('directory aliases keep suffixes and explicit or missing locations bypass auto-detection', async t => {
  const { session, send, alias } = await fixture(t)
  await send(`${path}/${alias.id}`, { session, method: 'PATCH', body: { ...alias, oldPath: 'a' } })
  for (const directory of ['a', 'a/src']) {
    const expected = directory.replace(/^a/u, 'projects/a')
    const report = await send('/api/admin/reports', { session, body: { repo: { github: 'org/old', directory }, findings: [] } })
    assert.equal(report.status, 201)
    assert.equal(JSON.parse(report.body).repoDirectory, expected)
    const body = brotliCompressSync(Buffer.from(JSON.stringify({ repo: { github: 'org/old', directory } })))
    const bundle = await send('/api/admin/bundles', { session, body, headers: { 'x-bundle-filename': 'old.stasis.code.br' } })
    assert.equal(bundle.status, 201)
    assert.equal(JSON.parse(bundle.body).repoDirectory, expected)
  }
  const unmatched = await send('/api/admin/reports', { session, body: { repo: { github: 'org/old', directory: 'another' }, findings: [] } })
  assert.equal(unmatched.status, 400)
  const explicit = await send('/api/admin/bundles', { session, body: brotliCompressSync(Buffer.from('{"repo":{"github":"org/old","directory":"a/explicit"}}')),
    headers: { 'x-bundle-filename': 'old.stasis.code.br', 'x-repo-id': '1', 'x-repo-directory': 'chosen' } })
  assert.equal(JSON.parse(explicit.body).repoId, 1)
  assert.equal(JSON.parse(explicit.body).repoDirectory, 'chosen')
  const unstamped = await send('/api/admin/reports', { session, body: { findings: [] }, headers: { 'x-repo-id': '1', 'x-repo-directory': 'selected' } })
  assert.equal(JSON.parse(unstamped.body).repoId, 1)
  assert.equal(JSON.parse(unstamped.body).repoDirectory, 'selected')
})

test('bundle paths infer a whole-bundle directory for new imports and live suggestions only', async t => {
  const { db, session, send, bundles } = await fixture(t)
  await db.selectRepo({ repoId: 3, fullName: 'org/mono', private: false, installationId: null, defaultBranch: 'main',
    htmlUrl: 'https://github.com/org/mono', addedBy: session.userId }, Date.now())
  const body = brotliCompressSync(Buffer.from(JSON.stringify({ version: 0, config: { scope: 'full' },
    repo: { github: 'org/c' }, formats: {}, imports: {}, sources: { 'a/src/x.js': 'x', 'a/icon.png': 'icon' } })))
  const upload = bytes => send('/api/admin/bundles', { session, body: bytes, headers: { 'x-bundle-filename': 'old.stasis.code.br' } })
  const stored = JSON.parse((await upload(body)).body)
  assert.equal(stored.repoId, null)
  const result = await send(path, { session, body: { oldRepo: 'org/c', oldPath: 'a', repoId: 3, newPath: 'projects/a' } })
  assert.equal(result.status, 201)
  const alias = JSON.parse(result.body)
  const suggest = prefix => send(`/api/admin/repositories/resolve?repo=org%2Fc&directory=&filePrefix=${encodeURIComponent(prefix)}`, { session, method: 'GET' })
  assert.deepEqual(JSON.parse((await suggest('a')).body).location, { repoId: 3, github: 'org/mono', directory: 'projects', mapped: true })
  assert.equal(JSON.parse((await suggest('ab')).body).location, null)
  assert.equal((await suggest('../a')).status, 400)
  assert.equal((await db.getBundle(stored.id)).repoId, null, 'new aliases only affect the suggestion for old bundles')
  assert.equal(JSON.parse((await upload(body)).body).repoId, null, 'identical reuploads retain their assignment')
  const newer = brotliCompressSync(Buffer.from(JSON.stringify({ version: 0, config: { scope: 'full' },
    repo: { github: 'org/c' }, formats: {}, imports: {}, sources: { 'a/src/x.js': 'new x', 'a/icon.png': 'icon' } })))
  const created = await upload(newer)
  assert.equal(created.status, 201)
  const mapped = JSON.parse(created.body)
  assert.equal(mapped.repoId, 3)
  assert.equal(mapped.repoDirectory, 'projects')
  assert.equal(mapped.integrity, bundleIntegrity(newer))
  assert.deepEqual(await bundles.get(mapped.id), newer)
  await send(`${path}/${alias.id}`, { session, method: 'PATCH', body: { ...alias, newPath: 'moved/b' } })
  assert.equal(JSON.parse((await suggest('a')).body).location, null, 'incompatible suffixes do not suggest path rewrites')
  assert.equal((await db.getBundle(mapped.id)).repoDirectory, 'projects')
})

test('invalid embedded bundle directories remain optional until a repository can be assigned', async t => {
  const { db, session, send, bundles, alias } = await fixture(t)
  const upload = (github, directory, extraHeaders = {}) => {
    const bytes = brotliCompressSync(Buffer.from(JSON.stringify({ repo: { github, directory } })))
    return send('/api/admin/bundles', { session, body: bytes, headers: { 'x-bundle-filename': 'opaque.stasis.code.br', ...extraHeaders } })
      .then(result => ({ result, bytes }))
  }
  for (const github of [undefined, 'not-a-repo', 'org/missing']) {
    const { result, bytes } = await upload(github, '../src')
    assert.equal(result.status, 201)
    const stored = JSON.parse(result.body)
    assert.equal(stored.repoId, null)
    assert.equal(stored.repoDirectory, '')
    assert.deepEqual(await bundles.get(stored.id), bytes)
    assert.equal((await upload(github, '../src')).result.status, 200)
  }
  for (const github of ['org/repo1', alias.oldRepo]) {
    assert.equal((await upload(github, '../src')).result.status, 400, 'connected or repository-wide alias destinations still validate inferred directories')
    const { result } = await upload(github, '../src', { 'x-repo-directory': 'chosen' })
    assert.equal(result.status, 201)
    const stored = JSON.parse(result.body)
    assert.equal(stored.repoId, github === 'org/repo1' ? 1 : 2)
    assert.equal(stored.repoDirectory, 'chosen', 'explicit directories replace invalid embedded defaults')
  }
  await db.deactivateRepo(1)
  assert.equal(JSON.parse((await upload('org/repo1', 'bad\\path')).result.body).repoId, null)
  const invalidHeader = await upload('org/another', '../src', { 'x-repo-directory': '../chosen' })
  assert.equal(invalidHeader.result.status, 400, 'explicit directory headers are validated even when no repository resolves')
  await send(`${path}/${alias.id}`, { session, method: 'PATCH', body: { ...alias, oldPath: 'a' } })
  const unmatchedAlias = await upload(alias.oldRepo, '../other')
  assert.equal(unmatchedAlias.result.status, 201)
  assert.equal(JSON.parse(unmatchedAlias.result.body).repoId, null, 'invalid paths cannot match directory aliases')
})

test('alias endpoints require admin and CSRF; imports enforce mapped destination permissions', async t => {
  const { db, session, send, alias } = await fixture(t)
  assert.equal((await send(path, { session, method: 'GET' })).status, 200)
  assert.equal((await send(path, { session, body: alias, headers: { 'x-csrf-token': 'wrong' } })).status, 403)
  assert.equal((await send(`${path}/${alias.id}`, { session, method: 'PATCH', body: alias, beforeBody: () => db.setUserRole(session.userId, 'manage') })).status, 403)
  assert.equal((await send(path, { session, method: 'GET' })).status, 403)
  const manager = await createSession(config, db, { githubUserId: 3, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(manager.userId, 'manage')
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamMember('team', manager.userId, { dependencies: true, security: true })
  await db.setTeamRepo('team', 2, 'projects/other')
  const body = { repo: { github: 'org/old' }, findings: [{ id: 'restricted' }] }
  const suggest = () => send('/api/admin/repositories/resolve?repo=org%2Fold', { session: manager, method: 'GET' })
  assert.equal(JSON.parse((await suggest()).body).location, null, 'suggestions do not disclose inaccessible alias destinations')
  assert.equal((await send('/api/admin/reports', { session: manager, body })).status, 403)
  await db.setTeamRepo('team', 2, 'projects/a')
  assert.equal(JSON.parse((await suggest()).body).location.repoId, 2)
  assert.equal((await send('/api/admin/reports', { session: manager, body })).status, 201)
})

for (const action of ['connect', 'alias']) {
  test(`an unmatched bundle stays unattached after ${action} and an identical reupload`, async t => {
    const { db, session, send } = await fixture(t)
    const body = brotliCompressSync(Buffer.from('{"repo":{"github":"org/missing","directory":"a"}}'))
    const upload = () => send('/api/admin/bundles', { session, body, headers: { 'x-bundle-filename': 'missing.stasis.code.br' } })
    const suggest = () => send('/api/admin/repositories/resolve?repo=org%2Fmissing&directory=a', { session, method: 'GET' })
    const first = await upload()
    assert.equal(first.status, 201)
    const saved = JSON.parse(first.body)
    assert.equal(saved.repoId, null)
    assert.equal(saved.repoDirectory, '')
    assert.equal(JSON.parse((await suggest()).body).location, null)
    if (action === 'connect') {
      await db.selectRepo({ repoId: 3, fullName: 'org/missing', private: false, installationId: null, defaultBranch: 'main',
        htmlUrl: 'https://github.com/org/missing', addedBy: session.userId }, Date.now())
    } else {
      assert.equal((await send(path, { session, body: { oldRepo: 'org/missing', oldPath: 'a', repoId: 2, newPath: 'projects/a' } })).status, 201)
    }
    assert.equal((await db.getBundle(saved.id)).repoId, null)
    assert.deepEqual(JSON.parse((await suggest()).body).location, action === 'connect'
      ? { repoId: 3, github: 'org/missing', directory: 'a', mapped: false }
      : { repoId: 2, github: 'org/repo2', directory: 'projects/a', mapped: true })
    const repeated = await upload()
    assert.equal(repeated.status, 200)
    assert.equal(JSON.parse(repeated.body).id, saved.id)
    assert.equal(JSON.parse(repeated.body).repoId, null)
    assert.equal(JSON.parse(repeated.body).repoDirectory, '')
    const assigned = await send('/api/admin/bundles/set-repo', { session, body: { bundleId: saved.id, repoId: action === 'connect' ? 3 : 2, directory: action === 'connect' ? 'a' : 'projects/a' } })
    assert.equal(assigned.status, 200)
    assert.equal((await db.getBundle(saved.id)).repoId, action === 'connect' ? 3 : 2)
  })
}
