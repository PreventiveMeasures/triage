// A finding on an advisory on its own npm package (`package.npm.name` is
// `advisory.package`) keeps its `repo` only when that repository is ours
// (common/finding-repo.js isStrayRepo): the managed server removes any other
// before a report leaves it, for every viewer, so the client never sees it.
// Ours is the team's repositories on a team's board, the instance's in a
// manager's preview, and the report's own in both.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { loadTeamReports, teamSnapshot } from '../server-managed/team-reports.ts'
import { filterReportData } from '../common/managed/report-filter.ts'
import { isStrayRepo, ourRepoSlugs, withoutStrayRepos } from '../common/finding-repo.js'
import { harness, memoryStore, setup } from './_managed-mutation-safety.js'

const advised = (id, github, npm = 'body-parser') => ({ id, title: id, file: 'package.json', package: { npm: { name: npm } },
  advisory: { package: 'body-parser', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }, ...(github ? { repo: { github } } : {}) })
const repos = findings => Object.fromEntries(findings.map(finding => [finding.id, finding.repo?.github ?? null]))

test('a stray repository is told by the advisory\'s package and our repositories', () => {
  const ours = ourRepoSlugs(['org/repo1', 'https://github.com/Org/Repo2.git', null, ''])
  assert.deepEqual([...ours].toSorted(), ['org/repo1', 'org/repo2'])
  assert.equal(isStrayRepo(advised('a', 'pillarjs/other'), ours), true)
  assert.equal(isStrayRepo(advised('a', 'expressjs/body-parser'), ours), true)
  for (const finding of [advised('a', 'ORG/repo1'), advised('a', 'https://github.com/org/repo2/tree/main'), advised('a', 'pillarjs/other', 'express'),
    advised('a', null), { ...advised('a', 'pillarjs/other'), advisory: undefined }]) {
    assert.equal(isStrayRepo(finding, ours), false, JSON.stringify(finding))
  }
  const data = { findings: [advised('stray', 'pillarjs/other'), [advised('kept', 'org/repo1'), { ...advised('nested', 'pillarjs/other'), parent: 'p' }]] }
  const out = withoutStrayRepos(data, ours)
  assert.equal(out.findings[0].repo, undefined)
  assert.deepEqual(out.findings[1][0].repo, { github: 'org/repo1' })
  assert.equal(out.findings[1][1].repo, undefined)
  assert.equal(out.findings[1][1].parent, 'p', 'only `repo` goes')
  assert.equal(withoutStrayRepos({ findings: [advised('kept', 'org/repo1')] }, ours).findings[0].repo.github, 'org/repo1')
  const unchanged = { findings: [advised('kept', 'org/repo1')] }
  assert.equal(withoutStrayRepos(unchanged, ours), unchanged)
})

// The permission filter reads a finding's repository for the organizations a
// viewer without dependency access may see: a stray one counts for none.
test('the permission filter removes a stray repository for every viewer, and counts none of its organization', () => {
  const ours = ourRepoSlugs(['owner/app'])
  const report = { repo: { github: 'owner/app' }, findings: [
    advised('advised', 'pillarjs/body-parser-fork'),
    { id: 'dependency', file: 'node_modules/body-parser/a.js', repo: { github: 'pillarjs/router' } },
  ] }
  assert.deepEqual(filterReportData(report, { dependencies: false, security: true }, undefined, undefined, ours).findings.map(f => f.id), ['advised'])
  assert.deepEqual(filterReportData(report, { dependencies: false, security: true }).findings.map(f => f.id), ['advised', 'dependency'],
    'without the rule its organization lets the dependency through')
  assert.equal(filterReportData(report, { dependencies: true, security: true }, undefined, undefined, ours).findings[0].repo, undefined)
})

test('the team\'s board and a manager\'s previews leave out a stray repository', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const session = await setup(db), store = memoryStore()
  const request = harness(db, store)
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, '')
  await db.setTeamMember('team', session.userId, { dependencies: false, security: true })
  const findings = [advised('stray', 'pillarjs/other'), advised('team', 'org/repo1'), advised('instance', 'Org/Repo2'),
    advised('other-package', 'pillarjs/other', 'express'), advised('none', null)]
  const bytes = Buffer.from(JSON.stringify({ findings }))
  await store.put('report', bytes)
  await db.insertReport({ id: 'report', filename: 'report.json', contentType: 'application/json', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('base64url'), uploadedBy: session.userId, repoId: 1, visible: true }, Date.now())

  const snapshot = await teamSnapshot(db, hashToken(session.setCookie.split(';')[0].slice(4)), 'team')
  const [board] = await loadTeamReports(db, store, snapshot)
  assert.deepEqual(repos(board.data.findings), { stray: null, team: 'org/repo1', instance: null, 'other-package': 'pillarjs/other', none: null })

  const send = async (path, options = {}) => JSON.parse((await request(path, { session, ...options })).body)
  const preview = { stray: null, team: 'org/repo1', instance: 'Org/Repo2', 'other-package': 'pillarjs/other', none: null }
  assert.deepEqual(repos((await send('/api/reports/report', { method: 'GET', headers: { accept: 'application/json' } })).data.findings), preview)
  assert.deepEqual(repos((await send('/api/reports/query', { body: { ids: ['report'] } })).reports[0].data.findings), preview)
})
