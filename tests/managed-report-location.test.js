import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { config, harness, memoryStore, setup } from './_managed-mutation-safety.js'
import { managedCsv } from './_managed-csv.js'

// Claude Security Markdown and Codex CSV name the repository on each finding,
// never at report level, so these reports are not repoEmbedded.
function claudeMarkdown(repository) {
  return ['# Markdown security finding', '', '## Details', 'A finding.', '', '## Location', '[src/a.js](https://example.test/src/a.js#L1)',
    '', '---', '**Severity:** high', `**Repository:** ${repository}`].join('\n')
}
const json = (findings, extra = {}) => Buffer.from(JSON.stringify({ source: 'deepview', ...extra, findings }))
const finding = (id, github, file = `${id}.js`) => ({ id, file, ...(github ? { repo: { github } } : {}) })

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await setup(db)
  const send = harness(db, memoryStore(), memoryStore())
  const upload = async (body, filename = 'report.json', headers = {}, as = session) => {
    const result = await send('/api/admin/reports', { session: as, body: Buffer.from(body), headers: { 'x-report-filename': filename, ...headers } })
    assert.ok([200, 201].includes(result.status), result.body)
    return JSON.parse(result.body)
  }
  const suggest = async (id, as = session) => {
    const result = await send(`/api/admin/reports/${id}/location`, { session: as, method: 'GET' })
    return { status: result.status, location: result.status === 200 ? JSON.parse(result.body).location : undefined }
  }
  return { db, session, send, upload, suggest }
}

test('reports without their own repository are assigned the connected repository their findings name', async t => {
  const { upload } = await fixture(t)
  const markdown = await upload(claudeMarkdown('Org/Repo1'), 'report.md')
  assert.deepEqual([markdown.repoId, markdown.repoDirectory, markdown.repoEmbedded], [1, '', false])
  const csv = await upload(managedCsv.replaceAll(',o/r,', ',org/repo2,'), 'export.csv', { 'content-type': 'text/csv' })
  assert.deepEqual([csv.repoId, csv.repoDirectory], [2, ''], 'Codex rows under dependency directories agree with the rest')
  const dependencies = await upload(json([finding('own', 'org/repo1'), finding('dep', 'lodash/lodash', 'node_modules/lodash/x.js'), finding('unnamed')]))
  assert.equal(dependencies.repoId, 1, 'dependency and unnamed findings do not compete with the report repository')
  const layout = await upload(json([finding('app', 'org/repo2', 'src/app.js'), finding('upstream', 'lodash/lodash', 'dependencies/lodash/x.js')]))
  assert.equal(layout.repoId, 2, 'the dependencies/ layout is a dependency directory when no node_modules or vendor path exists')
  const upstream = await upload(json([finding('only-upstream', 'org/repo1', 'dependencies/pkg/x.js')]))
  assert.equal(upstream.repoId, null, 'a repository named only by dependency findings is not the report repository')
  const vendored = await upload(json([finding('vendored', 'org/repo2', 'vendor/own.js'), finding('module', 'lodash/lodash', 'node_modules/lodash/x.js')]))
  assert.equal(vendored.repoId, 2, 'with node_modules present, vendor/ is own source as in the local view')
  const malformed = await upload(json([null, 'text', finding('object', 'org/repo1')]))
  assert.equal(malformed.repoId, 1, 'non-object findings are ignored')
  const directory = await upload(json([finding('dir', 'org/repo2')], { repo: { directory: 'packages/a' } }))
  assert.deepEqual([directory.repoId, directory.repoDirectory, directory.repoEmbedded], [2, 'packages/a', false])
  const header = await upload(json([finding('header', 'org/repo2')]), 'report.json', { 'x-repo-directory': 'chosen' })
  assert.deepEqual([header.repoId, header.repoDirectory], [2, 'chosen'], 'an explicit directory overrides the inferred one')
  const explicit = await upload(json([finding('explicit', 'org/repo2')]), 'report.json', { 'x-repo-id': '1' })
  assert.equal(explicit.repoId, 1, 'an explicit repository wins')
  for (const findings of [[finding('a', 'org/repo1'), finding('b', 'org/repo2')], [finding('none')], [finding('missing', 'org/missing')]]) {
    const stored = await upload(json(findings))
    assert.deepEqual([stored.repoId, stored.repoDirectory], [null, ''], JSON.stringify(findings))
  }
})

test('report location suggestions resolve current connections and aliases without changing the assignment', async t => {
  const { db, session, send, upload, suggest } = await fixture(t)
  const missing = await upload(json([finding('missing', 'org/missing')], { repo: { directory: 'a/src' } }))
  assert.equal(missing.repoId, null)
  assert.deepEqual(await suggest(missing.id), { status: 200, location: { repoId: null, github: 'org/missing', directory: 'a/src' } })
  await db.selectRepo({ repoId: 3, fullName: 'Org/Missing', private: false, installationId: null, defaultBranch: 'main',
    htmlUrl: 'https://github.com/org/missing', addedBy: session.userId }, Date.now())
  assert.deepEqual((await suggest(missing.id)).location, { repoId: 3, github: 'Org/Missing', directory: 'a/src' })
  assert.equal(await send('/api/admin/repositories/aliases', { session, body: { oldRepo: 'org/missing', oldPath: 'a', repoId: 2, newPath: 'projects/a' } }).then(r => r.status), 201)
  assert.deepEqual((await suggest(missing.id)).location, { repoId: 2, github: 'org/repo2', directory: 'projects/a/src' })
  assert.equal((await db.getReport(missing.id)).repoId, null, 'suggestions never assign')
  const aliased = await upload(json([finding('aliased', 'org/missing', 'a/src/x.js')]))
  assert.deepEqual([aliased.repoId, aliased.repoDirectory], [2, 'projects'], 'shared finding paths can select a directory alias')
  const withDependency = await upload(json([finding('own-aliased', 'org/missing', 'a/src/y.js'),
    { ...finding('dep-aliased', 'lodash/lodash', 'node_modules/lodash/x.js'), evidence: [{ file: 'node_modules/lodash/y.js' }] }]))
  assert.deepEqual([withDependency.repoId, withDependency.repoDirectory], [2, 'projects'], 'dependency paths do not hide a directory alias')
  assert.deepEqual((await suggest(withDependency.id)).location, { repoId: 2, github: 'org/repo2', directory: 'projects' })
  const unnamed = await upload(json([finding('unnamed')]))
  assert.deepEqual(await suggest(unnamed.id), { status: 200, location: null })
  const embedded = await upload(json([finding('embedded', 'org/repo2')], { repo: { github: 'org/repo1' } }))
  assert.equal(embedded.repoEmbedded, true)
  assert.deepEqual(await suggest(embedded.id), { status: 200, location: null })
  assert.equal((await suggest('00000000-0000-4000-8000-000000000000')).status, 404)
  assert.equal((await send(`/api/admin/reports/${unnamed.id}/location`, { session, method: 'POST', body: {} })).status, 405)
})

test('managers are assigned and offered only destinations within their grants', async t => {
  const { db, upload, suggest } = await fixture(t)
  const manager = await createSession(config, db, { githubUserId: 3, login: 'manager', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(manager.userId, 'manage')
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamMember('team', manager.userId, { dependencies: true, security: true })
  await db.setTeamRepo('team', 2, 'projects/other')
  const outside = await upload(json([finding('outside', 'org/repo2')]), 'report.json', {}, manager)
  assert.equal(outside.repoId, null, 'an inaccessible inferred location leaves the report unattached instead of rejecting it')
  assert.deepEqual((await suggest(outside.id, manager)).location, { repoId: null, github: 'org/repo2', directory: null })
  const hidden = await upload(json([finding('hidden', 'org/repo1')]))
  assert.equal(hidden.repoId, 1)
  assert.equal((await suggest(hidden.id, manager)).status, 404, 'reports outside management access are not probeable')
  await db.setTeamRepo('team', 2, '')
  assert.deepEqual((await suggest(outside.id, manager)).location, { repoId: 2, github: 'org/repo2', directory: null })
  const inside = await upload(json([finding('inside', 'org/repo2')]), 'report.json', {}, manager)
  assert.equal(inside.repoId, 2)
})
