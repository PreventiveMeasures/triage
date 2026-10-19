import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { packageOf, registry, withToken } from './_managed-npm.js'

async function fixture(t, more = {}) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const config = { sessionCookieName: 'sid', sessionTtlMs: 3600000 }
  const sessions = {}
  for (const [i, role] of ['admin', 'triage', 'view'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    sessions[role] = session
  }
  // A team the triage user reviews in, as drafts are begun by one who
  // publishes to some team.
  await db.createTeam('reviewers', 'Reviewers', Date.now())
  await db.setTeamMember('reviewers', sessions.triage.userId, { dependencies: true, security: false })
  await db.setTeamDependencyReview(hashToken(sessions.admin.setCookie.split(';')[0].slice(4)), 'reviewers', true)
  const handler = createManagedRequestHandler({ db, config, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {}, ...more })
  async function send(path, { body, who = 'triage', csrf = true, method = body ? 'POST' : 'GET' } = {}) {
    const session = sessions[who]
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { url: path, method,
      headers: { ...(session ? { cookie: session.setCookie.split(';')[0], ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}) } : {}) } })
    // ServerResponse exposes Node's EventEmitter contract.
    // eslint-disable-next-line unicorn/prefer-event-target
    const res = Object.assign(new EventEmitter(), { status: 0, headers: {}, body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers }, end(value) { this.body = JSON.parse(value); this.writableEnded = true } })
    await handler(req, res)
    return res
  }
  return { db, sessions, send }
}
const url = context => `/api/npm/reviews?${new URLSearchParams(Object.entries(context).filter(([, value]) => value !== null))}`

test('non-text verdicts and notes are disabled, and binaries keep published coverage partial', async t => {
  const h = await fixture(t)
  const binary = Buffer.from([0, 1, 255]), changedBinary = Buffer.from([0, 2, 255])
  const before = packageOf('review-binary', '1.0.0', { 'package.json': '{}', 'removed.bin': Buffer.from([0, 4, 254]),
    'changed.bin': binary, 'to-text.js': binary, 'to-binary.js': 'old text', 'unchanged.bin': binary })
  const after = packageOf('review-binary', '2.0.0', { 'package.json': '{"version":"2.0.0"}', 'added.bin': binary,
    'changed.bin': changedBinary, 'to-text.js': 'new text', 'to-binary.js': binary, 'unchanged.bin': binary, 'empty.txt': '' })
  registry(t, [after, before])
  await h.db.createTeam('binary-team', 'Binary team', Date.now())
  await h.db.setTeamMember('binary-team', h.sessions.triage.userId, { dependencies: true, security: true })
  await h.send('/api/admin/teams/set-dependency-review', { who: 'admin', body: { teamId: 'binary-team', enabled: true } })
  const target = { ecosystem: 'npm', package: after.doc.name, version: after.doc.version, integrity: after.doc.dist.integrity }
  for (const base of [{}, { basePackage: before.doc.name, baseVersion: before.doc.version, baseIntegrity: before.doc.dist.integrity }]) {
    const context = { ...target, ...base }
    const nonTextFiles = base.basePackage ? ['added.bin', 'changed.bin', 'removed.bin', 'to-binary.js', 'to-text.js']
      : ['added.bin', 'changed.bin', 'to-binary.js', 'unchanged.bin']
    for (const file of nonTextFiles) {
      for (const status of ['accept', 'accept-with-nits', 'request-changes', 'reject']) {
        const blocked = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file, status, comment: '' } })
        assert.equal(blocked.status, 400, `${file}: ${JSON.stringify(blocked.body)}`)
        assert.equal(blocked.body.error, 'non-text-review-file')
      }
    }
    const note = '* Inspect this externally.\n* Keep the original bytes.'
    assert.equal((await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'added.bin', status: null, comment: note } })).status, 400)
    let review
    const texts = base.basePackage ? ['package.json', 'empty.txt'] : ['package.json', 'empty.txt', 'to-text.js']
    for (const file of texts) {
      const saved = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', reviewId: review?.id, revision: review?.revision, file, status: 'accept', comment: '' } })
      assert.equal(saved.status, 200, JSON.stringify(saved.body))
      review = saved.body.review
    }
    // A verdict saved before this restriction must not make a binary checked.
    review = await h.db.changeDependencyReview({ ...context, basePackage: base.basePackage ?? null, baseVersion: base.baseVersion ?? null, baseIntegrity: base.baseIntegrity ?? null },
      hashToken(h.sessions.triage.setCookie.split(';')[0].slice(4)), { action: 'save', reviewId: review.id, revision: review.revision, entryId: null,
        entry: { file: 'added.bin', status: 'accept', comment: note } }, Date.now())
    const response = await h.send('/api/npm/reviews', { body: { ...context, action: 'publish', reviewId: review.id, revision: review.revision,
      teamIds: ['binary-team'], finalStatus: 'accept', files: texts, nonTextFiles: [], coverage: 'full' } })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const published = response.body.review
    assert.deepEqual(published.nonTextFiles, nonTextFiles.toSorted())
    assert.equal(published.coverage, 'partial')
    assert.equal(published.checkedFiles, texts.length)
    assert.equal(published.totalFiles, texts.length + nonTextFiles.length)
    assert.equal(published.files.includes('removed.bin'), Boolean(base.basePackage))
    assert.equal(published.files.includes('unchanged.bin'), !base.basePackage)
    const reloaded = (await h.send(url(context))).body.reviews.find(row => row.id === review.id)
    const listed = (await h.send('/api/npm/reviews/mine')).body.reviews.find(row => row.id === review.id)
    for (const result of [reloaded, listed]) {
      assert.equal(result.coverage, 'partial'); assert.equal(result.checkedFiles, texts.length)
      assert.deepEqual(result.nonTextFiles, published.nonTextFiles)
      assert.equal(result.entries.find(row => row.file === 'added.bin').comment, note)
    }
  }
})

test('publication enforces detected malware and critical vulnerabilities using server evidence', async t => {
  const h = await fixture(t)
  const cases = [
    { name: 'review-malware', alert: 'malware', allowed: ['reject'], error: 'review-malware' },
    { name: 'review-malware-cwe', range: '*', cwe: ['CWE-506'], allowed: ['reject'], error: 'review-malware' },
    { name: 'review-malware-title', range: '*', title: 'Version contains malware', cwe: ['CWE-200'], allowed: ['reject'], error: 'review-malware' },
    { name: 'review-malware-takedown', takenDown: true, allowed: ['reject'], error: 'review-malware' },
    { name: 'review-fixed-malware', range: '<2.0.0', cwe: ['CWE-506'], allowed: ['accept', 'accept-with-nits', 'request-changes', 'reject'] },
    { name: 'review-critical-socket', alert: 'criticalCVE', allowed: ['request-changes', 'reject'], error: 'review-critical-vulnerability' },
    { name: 'review-critical-advisory', range: '*', allowed: ['request-changes', 'reject'], error: 'review-critical-vulnerability' },
    { name: 'review-fixed-advisory', range: '<2.0.0', allowed: ['accept', 'accept-with-nits', 'request-changes', 'reject'] },
  ]
  const packages = cases.map(({ name }) => ({ ...packageOf(name, '2.0.0', { 'package.json': JSON.stringify({ name, version: '2.0.0' }) }), versions: ['2.0.0', '1.0.0'] }))
  registry(t, packages)
  const registryFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const address = String(input)
    const takenDown = cases.find(row => row.takenDown && address === `https://registry.npmjs.org/${row.name}`)
    if (takenDown) {return registryFetch(input, init).then(async response => {
      const doc = await response.json()
      doc['dist-tags'].latest = '0.0.1-security'
      doc.versions['0.0.1-security'] = { description: 'security holding package', _npmUser: { name: 'npm' } }
      return Response.json(doc)
    })}
    const socket = /^https:\/\/firewall-api\.socket\.dev\/purl\/(.+)$/u.exec(address)
    if (socket) {
      const name = decodeURIComponent(socket[1]).slice('pkg:npm/'.length).split('@')[0]
      const found = cases.find(row => row.name === name)
      return Promise.resolve(Response.json({ name, version: '2.0.0', alerts: found?.alert ? [{ type: found.alert, severity: 'critical' }] : [] }))
    }
    if (address.endsWith('/-/npm/v1/security/advisories/bulk')) {
      const queried = JSON.parse(init.body)
      return Promise.resolve(Response.json(Object.fromEntries(Object.keys(queried).map(name => {
        const found = cases.find(row => row.name === name)
        return [name, found?.range ? [{ id: 901, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: found.title ?? 'Critical example', severity: 'critical', vulnerable_versions: found.range, cwe: found.cwe ?? [] }] : []]
      }))))
    }
    return registryFetch(input, init)
  })
  await h.db.createTeam('policy-team', 'Policy team', Date.now())
  await h.db.setTeamMember('policy-team', h.sessions.triage.userId, { dependencies: true, security: true })
  await h.send('/api/admin/teams/set-dependency-review', { who: 'admin', body: { teamId: 'policy-team', enabled: true } })
  for (const [index, item] of cases.entries()) {
    const context = { ecosystem: 'npm', package: item.name, version: '2.0.0', integrity: packages[index].doc.dist.integrity }
    const saved = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'package.json', comment: '', status: 'accept' } })
    assert.equal(saved.status, 200)
    const { id: reviewId, revision } = saved.body.review
    const publish = { ...context, action: 'publish', reviewId, revision, teamIds: ['policy-team'], finalComment: '' }
    for (const finalStatus of ['accept', 'accept-with-nits', 'request-changes'].filter(status => !item.allowed.includes(status))) {
      const blocked = await h.send('/api/npm/reviews', { body: { ...publish, finalStatus, verdictLimit: 'accept', socket: null, advisories: [] } })
      assert.equal(blocked.status, 400, `${item.name}: ${JSON.stringify(blocked.body)}`)
      assert.equal(blocked.body.error, item.error)
      assert.equal((await h.send(url(context))).body.reviews[0].publishedAt, null)
    }
    const published = await h.send('/api/npm/reviews', { body: { ...publish, finalStatus: item.allowed[0] } })
    assert.equal(published.status, 200, `${item.name}: ${JSON.stringify(published.body)}`)
    assert.equal(published.body.review.status, item.allowed[0])
  }
})

test('review API validates bytes and file scope, protects identity, and publishes whole sets', async t => {
  const h = await fixture(t)
  const after = packageOf('lib', '2.0.0', { 'index.js': 'new\n', 'package.json': '{"name":"lib","version":"2.0.0"}' })
  const before = packageOf('lib', '1.0.0', { 'removed.js': 'gone\n' })
  registry(t, [after, before])
  const context = { ecosystem: 'npm', package: 'lib', version: '2.0.0', integrity: after.doc.dist.integrity,
    basePackage: 'lib', baseVersion: '1.0.0', baseIntegrity: before.doc.dist.integrity }
  const body = { ...context, action: 'save', file: 'removed.js', comment: '* Intentional removal\n* Keep the fallback.', status: 'accept', user: 'forged' }
  assert.equal((await h.send(url(context), { who: 'anonymous' })).status, 401)
  assert.equal((await h.send('/api/npm/reviews', { body, csrf: false })).status, 403)
  assert.equal((await h.send('/api/npm/reviews', { body, who: 'view' })).status, 403)
  for (const patch of [{ status: 'approve' }, { status: ['accept'] }, { action: ['save'] }, { status: null, comment: '' }, { comment: 'x'.repeat(20001) }, { file: '../escape' }, { file: null, status: null }, { file: undefined, status: null }]) {
    assert.equal((await h.send('/api/npm/reviews', { body: { ...body, ...patch } })).status, 400)
  }
  for (const patch of [{ integrity: 'sha512-wrong' }, { baseIntegrity: 'sha512-wrong' }, { version: 'latest' }]) {
    assert.equal((await h.send('/api/npm/reviews', { body: { ...body, ...patch } })).status, 409)
  }
  const saved = await h.send('/api/npm/reviews', { body })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  let review = saved.body.review
  assert.equal(review.user, h.sessions.triage.userId)
  assert.equal(review.entries[0].file, 'removed.js', 'removed files are reviewable against the base')
  assert.equal(review.entries[0].comment, body.comment, 'notes are stored exactly as typed')
  assert.equal((await h.send(url(context), { who: 'admin' })).body.reviews.length, 0, 'admin sees no other user private review')
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: true, security: false })
  const toggle = { teamId: 'team', enabled: true }
  assert.equal((await h.send('/api/admin/teams/set-dependency-review', { body: toggle })).status, 403)
  assert.equal((await h.send('/api/admin/teams/set-dependency-review', { body: toggle, who: 'admin' })).status, 200)
  assert.deepEqual((await h.send(url(context))).body.teams, [{ id: 'reviewers', name: 'Reviewers' }, { id: 'team', name: 'Team' }])
  const publish = { ...context, action: 'publish', reviewId: review.id, revision: review.revision, teamIds: [], finalStatus: 'accept', finalComment: 'Removal checked.' }
  assert.equal((await h.send('/api/npm/reviews', { body: publish })).status, 400)
  const blocked = await h.send('/api/npm/reviews', { body: { ...publish, teamIds: ['team'], files: ['removed.js'], coverage: 'full' } })
  assert.equal(blocked.status, 400)
  assert.equal(blocked.body.error, 'package-json-not-reviewed', 'forged coverage cannot bypass the package.json check')
  assert.equal((await h.send(url(context))).body.reviews[0].publishedAt, null)
  review = (await h.send('/api/npm/reviews', { body: { ...body, reviewId: review.id, revision: review.revision,
    file: 'package.json', comment: '', status: 'accept' } })).body.review
  const published = await h.send('/api/npm/reviews', { body: { ...publish, revision: review.revision, teamIds: ['team'] } })
  assert.equal(published.status, 200)
  assert.ok(published.body.review.publishedAt)
  assert.equal(published.body.review.coverage, 'partial')
  assert.equal(published.body.review.checkedFiles, 2)
  assert.equal(published.body.review.totalFiles, 3)
  assert.equal(published.body.review.status, 'accept')
  assert.equal(published.body.review.comment, 'Removal checked.')
  assert.equal(published.body.review.entries.find(entry => entry.file === 'removed.js').comment, body.comment)
  // A list's versions kept read of the database at once, none apart.
  const [one, many] = [t.mock.method(h.db, 'getUpstreamCacheEntry'), t.mock.method(h.db, 'getUpstreamCacheEntries')]
  assert.equal((await h.send('/api/npm/reviews/mine')).body.reviews[0].id, review.id)
  assert.deepEqual([one.mock.calls.filter(call => call.arguments[0].startsWith('npm/version-documents/')).length, many.mock.callCount()], [0, 1])
  one.mock.restore()
  many.mock.restore()
  assert.deepEqual((await h.send('/api/npm/reviews/mine', { who: 'admin' })).body.reviews, [])
  const edited = await h.send('/api/npm/reviews', { body: { ...body, reviewId: review.id, revision: published.body.review.revision, entryId: review.entries[0].id, comment: 'overwrite' } })
  assert.equal(edited.status, 409)
})

test('a review is written only of tarballs its versions\' integrity and shasum name, those shasums kept with it', async t => {
  const h = await fixture(t)
  const after = packageOf('hashed', '2.0.0', { 'index.js': 'new\n', 'package.json': '{"name":"hashed","version":"2.0.0"}' })
  const before = packageOf('hashed', '1.0.0', { 'index.js': 'old\n' })
  // Each named by its integrity, and by a shasum its bytes are not.
  const misnamed = packageOf('misnamed', '1.0.0', { 'index.js': 'x\n' }), misnamedBase = packageOf('misnamed', '0.1.0', { 'index.js': 'y\n' })
  for (const pkg of [misnamed, misnamedBase]) pkg.doc.dist.shasum = '0'.repeat(40)
  registry(t, [after, before, misnamed, misnamedBase])
  const context = { ecosystem: 'npm', package: 'hashed', version: '2.0.0', integrity: after.doc.dist.integrity,
    basePackage: 'hashed', baseVersion: '1.0.0', baseIntegrity: before.doc.dist.integrity }
  const send = (body, at = context) => h.send('/api/npm/reviews', { body: { ...at, ...body } })
  const session = hashToken(h.sessions.triage.setCookie.split(';')[0].slice(4))
  // A draft begun with none told of its tarballs keeps them once saved.
  let review = await h.db.changeDependencyReview(context, session, { action: 'start', reviewId: null, revision: null }, Date.now())
  assert.deepEqual([review.shasum, review.baseShasum], [null, null])
  review = (await send({ action: 'save', reviewId: review.id, revision: review.revision, file: 'index.js', status: 'accept', comment: '' })).body.review
  assert.deepEqual([review.shasum, review.baseShasum], [after.doc.dist.shasum, before.doc.dist.shasum])
  review = (await send({ action: 'save', reviewId: review.id, revision: review.revision, file: 'package.json', status: 'accept', comment: '' })).body.review
  const published = await send({ action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['reviewers'], finalStatus: 'accept' })
  assert.equal(published.status, 200, JSON.stringify(published.body))
  assert.deepEqual([published.body.review.shasum, published.body.review.baseShasum], [after.doc.dist.shasum, before.doc.dist.shasum])
  const listed = (await h.send('/api/npm/reviews/mine')).body.reviews.find(row => row.id === review.id)
  assert.deepEqual([listed.shasum, listed.baseShasum], [after.doc.dist.shasum, before.doc.dist.shasum], 'as listed')
  const continued = await send({ action: 'continue', reviewId: review.id, revision: published.body.review.revision })
  assert.deepEqual([continued.body.review.shasum, continued.body.review.baseShasum], [after.doc.dist.shasum, before.doc.dist.shasum], 'as continued')
  const whole = { ...context, basePackage: null, baseVersion: null, baseIntegrity: null }
  assert.deepEqual([(await send({ action: 'start' }, whole)).body.review.shasum, (await h.send(url(whole))).body.reviews[0].baseShasum], [after.doc.dist.shasum, null],
    'none of a base where it reads its package whole')
  // A tarball its shasum does not name, as the version's or as its base, is no review's, begun or saved.
  const misnamedContext = { ecosystem: 'npm', package: 'misnamed', version: '1.0.0', integrity: misnamed.doc.dist.integrity, basePackage: null, baseVersion: null, baseIntegrity: null }
  const misnamedBased = { ...context, basePackage: 'misnamed', baseVersion: '0.1.0', baseIntegrity: misnamedBase.doc.dist.integrity }
  for (const at of [misnamedContext, misnamedBased]) {
    for (const body of [{ action: 'start' }, { action: 'save', file: 'index.js', status: 'accept', comment: '' }]) {
      const refused = await send(body, at)
      assert.deepEqual([refused.status, refused.body.error], [502, 'upstream-invalid'], JSON.stringify([at, body]))
    }
    assert.deepEqual((await h.send(url(at))).body.reviews, [])
  }
})

test('reviews recheck private access to both packages, including before publication', async t => {
  const h = await fixture(t)
  withToken(t)
  const after = packageOf('public', '2.0.0', { 'index.js': 'new' })
  const before = { ...packageOf('@private/base', '1.0.0', { 'index.js': 'old' }), private: true }
  registry(t, [after, before])
  const context = { ecosystem: 'npm', package: 'public', version: '2.0.0', integrity: after.doc.dist.integrity,
    basePackage: '@private/base', baseVersion: '1.0.0', baseIntegrity: before.doc.dist.integrity }
  assert.equal((await h.send(url(context))).status, 404)
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: true, security: false })
  const adminId = hashToken(h.sessions.admin.setCookie.split(';')[0].slice(4))
  await h.db.setTeamNpmScopes(adminId, 'team', ['@private'])
  await h.db.setTeamDependencyReview(adminId, 'team', true)
  const saved = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'index.js', status: 'reject', comment: 'Do not upgrade' } })
  assert.equal(saved.status, 200)
  const latest = '/api/npm/reviews/latest?' + new URLSearchParams({ package: context.package, version: context.version, integrity: context.integrity })
  const versionReviews = `${url({ ...context, basePackage: null, baseVersion: null, baseIntegrity: null })}&allBases=true`
  assert.equal((await h.send('/api/npm/reviews/mine')).body.reviews[0].id, saved.body.review.id)
  assert.equal((await h.send(latest)).body.review.id, saved.body.review.id)
  assert.equal((await h.send(versionReviews)).body.reviews[0].id, saved.body.review.id)
  await h.db.setTeamNpmScopes(adminId, 'team', [])
  assert.deepEqual((await h.send('/api/npm/reviews/mine')).body.reviews, [])
  assert.equal((await h.send(latest)).body.review, null)
  assert.deepEqual((await h.send(versionReviews)).body.reviews, [], 'a public target cannot expose notes about an inaccessible private base')
  assert.equal((await h.send(url(context))).status, 404)
  assert.equal((await h.send('/api/npm/reviews', { body: { ...context, action: 'publish', reviewId: saved.body.review.id, revision: 1, teamIds: ['team'] } })).status, 404)
})

test('final verdict is mandatory and constrained, while coverage is derived from package bytes', async t => {
  const h = await fixture(t)
  const pkg = packageOf('all-files', '1.0.0', { 'package.json': '{}', 'b.js': 'b', 'c.bin': Buffer.from([0, 255]), 'empty': '' })
  registry(t, [pkg])
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: true, security: false })
  await h.send('/api/admin/teams/set-dependency-review', { who: 'admin', body: { teamId: 'team', enabled: true } })
  const context = { ecosystem: 'npm', package: 'all-files', version: '1.0.0', integrity: pkg.doc.dist.integrity }
  let review = (await h.send('/api/npm/reviews', { body: { ...context, action: 'start' } })).body.review
  assert.deepEqual(review.entries, [])
  const publish = patch => h.send('/api/npm/reviews', { body: { ...context, action: 'publish', reviewId: review.id,
    revision: review.revision, teamIds: ['team'], files: [], coverage: 'full', ...patch } })
  assert.equal((await publish({})).status, 400, 'a final verdict is required even with no checks')
  for (const file of ['package.json', 'b.js', 'empty']) {
    review = (await h.send('/api/npm/reviews', { body: { ...context, action: 'save', reviewId: review.id, revision: review.revision,
      file, status: file === 'b.js' ? 'request-changes' : 'accept', comment: '' } })).body.review
  }
  assert.equal((await publish({ finalStatus: 'accept' })).status, 400)
  assert.equal((await publish({ finalStatus: 'accept-with-nits' })).status, 400)
  const result = await publish({ finalStatus: 'request-changes', finalComment: 'Check the remaining file.' })
  assert.equal(result.status, 200)
  review = result.body.review
  assert.equal(review.coverage, 'partial')
  assert.equal(review.totalFiles, 4, 'client cannot forge file coverage')
  assert.equal(review.checkedFiles, 3)
  assert.equal(review.comment, 'Check the remaining file.')
  assert.equal((await publish({ finalStatus: 'reject', finalComment: 'Overwrite' })).status, 409, 'the final verdict is frozen too')
  assert.equal((await h.send('/api/npm/reviews/mine', { who: 'anonymous' })).status, 401)
  assert.equal((await h.send('/api/npm/reviews/mine?beforeTime=oops&beforeId=id')).status, 400)
})


test('a saved verdict can be cleared without adding a note, leaving publication unavailable', async t => {
  const h = await fixture(t), pkg = packageOf('clear-verdict', '1.0.0', { 'index.js': 'new\n' })
  registry(t, [pkg])
  const context = { ecosystem: 'npm', package: pkg.doc.name, version: '1.0.0', integrity: pkg.doc.dist.integrity }
  const saved = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'index.js', status: 'accept', comment: '' } })
  assert.equal(saved.status, 200)
  const review = saved.body.review
  const cleared = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'index.js', status: null, comment: '',
    reviewId: review.id, revision: review.revision, entryId: review.entries[0].id } })
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.body.review.entries, [])
  assert.deepEqual((await h.send('/api/npm/reviews/mine')).body.reviews[0].entries, [])
})

test('discard requires author, CSRF and current revision, without fetching package contents', async t => {
  const h = await fixture(t)
  const sid = hashToken(h.sessions.triage.setCookie.split(';')[0].slice(4))
  const context = { ecosystem: 'npm', package: '@removed/private', version: '1.0.0', integrity: 'sha512-gone',
    basePackage: null, baseVersion: null, baseIntegrity: null }
  const review = await h.db.changeDependencyReview(context, sid, { action: 'save', reviewId: null, revision: null,
    entryId: null, entry: { file: 'index.js', status: 'accept', comment: 'Checked.' } }, Date.now())
  const body = { reviewId: review.id, revision: review.revision }, path = '/api/npm/reviews/discard'
  assert.equal((await h.send(path)).status, 405)
  assert.equal((await h.send(path, { body, who: 'anonymous' })).status, 401)
  assert.equal((await h.send(path, { body, csrf: false })).status, 403)
  assert.equal((await h.send(path, { body, who: 'view' })).status, 403)
  assert.equal((await h.send(path, { body, who: 'admin' })).status, 409)
  for (const bad of [{}, [], { ...body, reviewId: '' }, { ...body, reviewId: ['id'] }, { ...body, revision: '1' }, { ...body, revision: 0 }]) {
    assert.equal((await h.send(path, { body: bad })).status, 400)
  }
  assert.equal((await h.send(path, { body: { ...body, revision: 2 } })).status, 409)
  assert.equal((await h.db.listOwnDependencyReviews(h.sessions.triage.userId, null)).reviews.length, 1)
  assert.equal((await h.send(path, { body })).status, 200)
  assert.deepEqual((await h.send('/api/npm/reviews/mine')).body.reviews, [])
  assert.equal((await h.send(path, { body })).status, 409)
})

test('latest review is specific to the author and exact target, across different bases', async t => {
  const h = await fixture(t), sid = hashToken(h.sessions.triage.setCookie.split(';')[0].slice(4))
  const after = packageOf('lib', '2.0.0', {}), before = packageOf('other-lib', '1.0.0', {})
  registry(t, [after, before])
  const context = { ecosystem: 'npm', package: 'lib', version: '2.0.0', integrity: after.doc.dist.integrity,
    basePackage: null, baseVersion: null, baseIntegrity: null }
  const create = (patch, time) => h.db.changeDependencyReview({ ...context, ...patch }, sid, { action: 'start', reviewId: null, revision: null }, time)
  const first = await create({}, 100)
  const latest = await create({ basePackage: 'other-lib', baseVersion: '1.0.0', baseIntegrity: before.doc.dist.integrity }, 200)
  await create({ version: '3.0.0' }, 300)
  await create({ integrity: 'sha512-different' }, 400)
  const path = '/api/npm/reviews/latest?' + new URLSearchParams({ package: context.package, version: context.version, integrity: context.integrity })
  assert.equal((await h.send(path, { who: 'anonymous' })).status, 401)
  assert.equal((await h.send('/api/npm/reviews/latest')).status, 400)
  assert.equal((await h.send(path, { method: 'POST' })).status, 405)
  assert.equal((await h.send(path, { who: 'admin' })).body.review, null)
  const response = await h.send(path)
  assert.equal(response.status, 200)
  assert.equal(response.body.review.id, latest.id)
  assert.equal(response.body.review.basePackage, 'other-lib')
  assert.deepEqual((await h.send(url(context))).body.reviews.map(review => review.id), [first.id])
  const allBases = `${url(context)}&allBases=true`
  assert.deepEqual((await h.send(allBases)).body.reviews.map(review => review.id), [first.id, latest.id])
  assert.deepEqual((await h.send(allBases, { who: 'admin' })).body.reviews, [], 'a version list does not expose another author’s unpublished reviews')
})


test('review saves use displayed paths after root moves and retain non-text restrictions', async t => {
  const h = await fixture(t)
  const before = packageOf('review-move', '1.0.0', { 'a.js': 'a', 'b.js': 'b', 'old.js': 'old', 'old.bin': Buffer.from([0, 255]) })
  const after = packageOf('review-move', '2.0.0', { 'src/a.js': 'a', 'src/b.js': 'b', 'package.json': '{}' })
  registry(t, [before, after])
  const context = { ecosystem: 'npm', package: after.doc.name, version: after.doc.version, integrity: after.doc.dist.integrity,
    basePackage: before.doc.name, baseVersion: before.doc.version, baseIntegrity: before.doc.dist.integrity }
  const save = (file, status, comment = '') => h.send('/api/npm/reviews', { body: { ...context, action: 'save', file, status, comment } })
  for (const path of ['old.js', 'src/a.js', 'missing.js']) {
    const response = await save(path, 'accept')
    assert.equal(response.status, 400)
    assert.equal(response.body.error, 'unknown-review-file')
  }
  const saved = await save('src/old.js', 'accept')
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const binary = await save('src/old.bin', 'accept')
  assert.equal(binary.status, 400)
  assert.equal(binary.body.error, 'non-text-review-file')
  const note = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', reviewId: saved.body.review.id,
    revision: saved.body.review.revision, file: 'src/old.bin', status: null, comment: 'Removed binary' } })
  assert.equal(note.status, 400)
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: true, security: true })
  await h.send('/api/admin/teams/set-dependency-review', { who: 'admin', body: { teamId: 'team', enabled: true } })
  const manifest = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', reviewId: saved.body.review.id,
    revision: saved.body.review.revision, file: 'package.json', status: 'accept', comment: '' } })
  assert.equal(manifest.status, 200)
  const published = await h.send('/api/npm/reviews', { body: { ...context, action: 'publish', reviewId: manifest.body.review.id,
    revision: manifest.body.review.revision, finalStatus: 'reject', teamIds: ['team'] } })
  assert.equal(published.status, 200, JSON.stringify(published.body))
  assert.deepEqual(published.body.review.files, ['package.json', 'src/old.bin', 'src/old.js'])
  assert.deepEqual(published.body.review.nonTextFiles, ['src/old.bin'])
  assert.equal(published.body.review.coverage, 'partial')
})

test('review lists recheck target access and session after registry reads, preserving pagination', async t => {
  const h = await fixture(t)
  withToken(t)
  const pkg = { ...packageOf('@secret/listed', '1.0.0', { 'index.js': 'secret' }), private: true }
  registry(t, [pkg])
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: true, security: true })
  const sid = hashToken(h.sessions.triage.setCookie.split(';')[0].slice(4))
  const admin = hashToken(h.sessions.admin.setCookie.split(';')[0].slice(4))
  await h.db.setTeamNpmScopes(admin, 'team', ['@secret'])
  const context = { ecosystem: 'npm', package: pkg.doc.name, version: pkg.doc.version, integrity: pkg.doc.dist.integrity,
    basePackage: null, baseVersion: null, baseIntegrity: null }
  const review = await h.db.changeDependencyReview(context, sid, { action: 'start', reviewId: null, revision: null }, Date.now())
  const next = { time: review.time, id: review.id }
  t.mock.method(h.db, 'listOwnDependencyReviews', () => Promise.resolve({ reviews: [review], next }))
  assert.equal((await h.send('/api/npm/reviews/mine')).body.reviews[0].id, review.id)
  // Revocation during even a cached registry lookup must be enforced before returning notes.
  const listScopes = h.db.listUserNpmScopes.bind(h.db)
  let reads = 0
  t.mock.method(h.db, 'listUserNpmScopes', async user => {
    if (++reads === 2) await h.db.setTeamNpmScopes(admin, 'team', [])
    return listScopes(user)
  })
  const hidden = await h.send('/api/npm/reviews/mine')
  assert.equal(hidden.status, 200)
  assert.deepEqual(hidden.body, { reviews: [], next })
  // A team's, as its Dependencies tab lists them, held to the same access.
  const teams = []
  t.mock.method(h.db, 'listTeamDependencyReviews', (teamId, user, before) => {
    teams.push([teamId, user, before])
    return Promise.resolve(teamId === 'team' ? { reviews: [review], next: null } : null)
  })
  const listed = await h.send('/api/npm/reviews/team?' + new URLSearchParams({ teamId: 'team', beforeTime: '5', beforeId: 'r' }))
  assert.deepEqual([listed.status, listed.body], [200, { reviews: [], next: null }], 'the private package no longer readable, none of its reviews')
  assert.deepEqual(teams, [['team', h.sessions.triage.userId, { time: 5, id: 'r' }]])
  // Its scopes taken while npm is read: asked again after, with the team's
  // access, in one statement, none of it told.
  await h.db.setTeamNpmScopes(admin, 'team', ['@secret'])
  const fetched = globalThis.fetch
  const fetching = t.mock.method(globalThis, 'fetch', async (...args) => {
    await h.db.setTeamNpmScopes(admin, 'team', [])
    return fetched(...args)
  })
  const rechecks = t.mock.method(h.db, 'getNpmReviewReader')
  const taken = await h.send('/api/npm/reviews/team?teamId=team')
  assert.deepEqual([taken.status, taken.body.reviews, rechecks.mock.callCount()], [200, [], 1])
  assert.ok(fetching.mock.callCount() > 0, 'npm read meanwhile')
  fetching.mock.restore()
  assert.equal((await h.send('/api/npm/reviews/team?teamId=elsewhere')).status, 404)
  for (const bad of ['', '?teamId=team&beforeTime=x&beforeId=r', '?teamId=team&beforeId=r']) assert.equal((await h.send(`/api/npm/reviews/team${bad}`)).status, 400, bad)
  const latest = '/api/npm/reviews/latest?' + new URLSearchParams({ package: context.package, version: context.version, integrity: context.integrity })
  assert.equal((await h.send(latest)).body.review, null)
  await h.db.setTeamNpmScopes(admin, 'team', ['@secret'])
  reads = 0
  t.mock.method(h.db, 'listUserNpmScopes', async user => {
    if (++reads === 1) await h.db.setUserRole(user, 'none')
    return listScopes(user)
  })
  assert.equal((await h.send('/api/npm/reviews/mine')).status, 401)
})

test('a page of reviews of more versions than npm\'s reads hold at once is read a few at a time, each version once', async t => {
  const h = await fixture(t)
  const pkgs = Array.from({ length: 40 }, (_, i) => packageOf(`lib-${i}`, '1.0.0', { 'index.js': `${i}` }))
  const calls = registry(t, pkgs)
  const reviews = pkgs.map(({ doc }, i) => ({ id: `r${i}`, package: doc.name, version: doc.version, integrity: doc.dist.integrity,
    ...i % 2 ? { basePackage: pkgs[i - 1].doc.name, baseVersion: '1.0.0', baseIntegrity: pkgs[i - 1].doc.dist.integrity } : { basePackage: null, baseVersion: null, baseIntegrity: null } }))
  t.mock.method(h.db, 'listTeamDependencyReviews', () => Promise.resolve({ reviews, next: null }))
  const listed = await h.send('/api/npm/reviews/team?teamId=reviewers')
  assert.deepEqual([listed.status, listed.body.reviews?.length], [200, 40])
  assert.equal(new Set(calls.map(call => call.url)).size, calls.length, 'a base another review\'s target read once')
  // Its membership taken after the page is chosen, while npm is read: none of it.
  t.mock.method(h.db, 'listTeamDependencyReviews', async () => {
    await h.db.setTeamMember('reviewers', h.sessions.triage.userId, { dependencies: false, security: false })
    return { reviews, next: null }
  })
  assert.deepEqual(await h.send('/api/npm/reviews/team?teamId=reviewers').then(res => [res.status, res.body]), [404, { error: 'no-team' }])
})

test('where the host formats dependency reviews, one\'s own published reviews are told formatted, each alone, as published, read and listed; another\'s never', async t => {
  const given = []
  const formatDependencyReviews = input => { given.push(input); return Promise.resolve(`Reviewed ${input.reviews[0].new.name} by ${input.reviews[0].reviewer}`) }
  const h = await fixture(t, { reviewedDependencies: { lookup: () => Promise.resolve(false), formatDependencyReviews } })
  const pkg = packageOf('formatted', '1.0.0', { 'index.js': 'x' })
  registry(t, [pkg])
  const context = { ecosystem: 'npm', package: 'formatted', version: '1.0.0', integrity: pkg.doc.dist.integrity }
  const published = {}
  for (const who of ['triage', 'admin']) {
    let review = (await h.send('/api/npm/reviews', { who, body: { ...context, action: 'start' } })).body.review
    assert.equal(Object.hasOwn(review, 'formatted'), false, 'a draft formatted never')
    review = (await h.send('/api/npm/reviews', { who, body: { ...context, action: 'save', reviewId: review.id, revision: review.revision, file: 'index.js', status: 'accept', comment: 'Fine.' } })).body.review
    published[who] = (await h.send('/api/npm/reviews', { who, body: { ...context, action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['reviewers'],
      files: [], coverage: 'full', finalStatus: 'accept', finalComment: '' } })).body.review
  }
  assert.deepEqual([published.triage.formatted, published.admin.formatted], ['Reviewed formatted by triage', 'Reviewed formatted by admin'], 'each one\'s own, as published')
  given.length = 0
  const listed = (await h.send(url({ ...context, basePackage: null, baseVersion: null, baseIntegrity: null }))).body.reviews
  assert.deepEqual(listed.map(review => [review.userLogin, review.formatted ?? null]).toSorted(), [['admin', null], ['triage', 'Reviewed formatted by triage']], 'another\'s read, unformatted')
  assert.equal((await h.send('/api/npm/reviews/mine')).body.reviews[0].formatted, 'Reviewed formatted by triage')
  const latest = '/api/npm/reviews/latest?' + new URLSearchParams({ package: 'formatted', version: '1.0.0', integrity: pkg.doc.dist.integrity })
  assert.equal((await h.send(latest)).body.review.formatted, 'Reviewed formatted by triage')
  assert.deepEqual(given.flatMap(input => input.reviews.map(review => review.reviewer)), ['triage', 'triage', 'triage'], 'the host given one\'s own alone')
})

test('the session says who publishes reviews to some team: an admin, in no team, as well as a member who reviews', async t => {
  const h = await fixture(t)
  const session = async who => (await h.send('/api/auth/session', { who })).body
  assert.equal((await session('triage')).dependencyReview, true)
  assert.equal((await session('admin')).dependencyReview, true, 'an admin reviews in teams they aren\'t in')
  assert.equal(Object.hasOwn(await session('view'), 'dependencyReview'), false)
  await h.db.setTeamMember('reviewers', h.sessions.triage.userId, { dependencies: false, security: true })
  assert.equal(Object.hasOwn(await session('triage'), 'dependencyReview'), false, 'a triage member without Dependencies reviews none')
  const pkg = packageOf('lib', '1.0.0', { 'index.js': 'x' })
  registry(t, [pkg])
  const started = await h.send('/api/npm/reviews', { body: { ecosystem: 'npm', package: 'lib', version: '1.0.0', integrity: pkg.doc.dist.integrity, action: 'start' } })
  assert.deepEqual([started.status, started.body], [403, { error: 'review-access-required' }], 'nor begins a draft')
})
