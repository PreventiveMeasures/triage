// A pnpm patch of an npm package version (server-managed/npm-patch.ts), as
// its dependency review reads it: its file held to the hash a lockfile names
// it by, read as git writes a diff, applied to the version's files as pnpm
// applies it; and a version's review as patched (http.ts), its files and its
// comparison as the patch changes them, the patch read of a repository its
// reader reads all of, at the commit and path the request names.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { brotliDecompressSync } from 'node:zlib'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { isPatchOf, parsePatch, patchWeight, patchedFiles, requestedPatch } from '../server-managed/npm-patch.ts'
import { isPatchHash } from '../common/managed/npm-packages.js'
import { packageOf, registry } from './_managed-npm.js'

const files = entries => Object.entries(entries).map(([path, text]) => ({ path, bytes: typeof text === 'string' ? Buffer.from(text) : text }))
const texts = list => Object.fromEntries(list.map(({ path, bytes }) => [path, Buffer.from(bytes).toString()]))
const failure = code => error => error.message === code

// A patch as pnpm writes one (git's diff with its `a/` and `b/` prefixes):
// one file changed, one deleted with its lines left out, one added with no
// ending on its last line, and one renamed and changed, its paths with a
// space in them.
const PATCH = `diff --git a/index.js b/index.js
index 1111111..2222222 100644
--- a/index.js
+++ b/index.js
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
@@ -8,3 +8,4 @@
 eight
 nine
 ten
+eleven
diff --git a/gone.js b/gone.js
deleted file mode 100644
index 3333333..0000000
diff --git a/added.js b/added.js
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/added.js
@@ -0,0 +1,2 @@
+added
+last
\\ No newline at end of file
diff --git a/old name.js b/new name.js
similarity index 50%
rename from old name.js
rename to new name.js
index 5555555..6666666 100644
--- a/old name.js\t
+++ b/new name.js\t
@@ -1 +1 @@
-old
+new
`
const LINES = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n'
const PACKAGE = { 'package.json': '{}\n', 'index.js': LINES, 'gone.js': 'gone\n', 'old name.js': 'old\n', 'image.bin': Buffer.from([0, 1, 2]) }

test('a patch is read as git writes a diff, and applied as pnpm applies it: each file it changes, deletes, adds and renames', () => {
  const patch = parsePatch(PATCH)
  assert.deepEqual(patch.map(({ path, from, deleted, created, hunks }) => [path, from ?? null, Boolean(deleted), Boolean(created), hunks.length]), [
    ['index.js', null, false, false, 2], ['gone.js', null, true, false, 0], ['added.js', null, false, true, 1], ['new name.js', 'old name.js', false, false, 1],
  ])
  const patched = patchedFiles(files(PACKAGE), patch)
  assert.deepEqual(patched.map(file => file.path), ['added.js', 'image.bin', 'index.js', 'new name.js', 'package.json'], 'in the order of their paths')
  assert.deepEqual(texts(patched), { 'added.js': 'added\nlast', 'image.bin': '\0\u0001\u0002', 'index.js': 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n',
    'new name.js': 'new\n', 'package.json': '{}\n' })
  // Its lines some lines off where it says they are, as the hunks before found
  // theirs; and as far off as FUZZ lines either side.
  const moved = patchedFiles(files({ ...PACKAGE, 'index.js': `zero\nzero\n${LINES}` }), patch)
  assert.equal(texts(moved)['index.js'], 'zero\nzero\none\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n')
  assert.throws(() => patchedFiles(files({ ...PACKAGE, 'index.js': `${'zero\n'.repeat(21)}${LINES}` }), patch), failure('patch-does-not-apply'), 'not further')
  for (const [why, changed] of [['its lines changed', { 'index.js': LINES.replace('three', 'THREE') }], ['a file it changes gone', { 'index.js': undefined }],
    ['a file it deletes gone', { 'gone.js': undefined }], ['one it adds there', { 'added.js': 'there\n' }], ['one it renames to there', { 'new name.js': 'there\n' }],
    ['the bytes of one it changes not text', { 'index.js': Buffer.from([0, 1]) }]]) {
    const before = Object.fromEntries(Object.entries({ ...PACKAGE, ...changed }).filter(([, text]) => text !== undefined))
    assert.throws(() => patchedFiles(files(before), patch), failure('patch-does-not-apply'), why)
  }
  // Its last line with no ending, as it was and as it is.
  const unended = parsePatch('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n')
  assert.equal(texts(patchedFiles(files({ 'a.js': 'a\nb' }), unended))['a.js'], 'a\nc\n')
  assert.throws(() => patchedFiles(files({ 'a.js': 'a\nb\n' }), unended), failure('patch-does-not-apply'), 'not of a last line that has one')
  // Quoted, as git writes a path past ASCII.
  const quoted = parsePatch('diff --git "a/\\303\\251.js" "b/\\303\\251.js"\ndeleted file mode 100644\nindex 1111111..0000000\n')
  assert.deepEqual(quoted.map(file => [file.path, file.deleted]), [['é.js', true]])
  // Its own lines ending in CRLFs, as an editor or autocrlf leaves it: read
  // as git wrote it. One git wrote of a file whose lines end in CRLFs keeps
  // its CRs.
  assert.deepEqual(parsePatch(PATCH.replaceAll('\n', '\r\n')), patch, 'one of CRLFs read as git wrote it')
  const ofCrlf = parsePatch('diff --git a/w.js b/w.js\n--- a/w.js\n+++ b/w.js\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n')
  assert.equal(texts(patchedFiles(files({ 'w.js': 'a\r\nb\r\n' }), ofCrlf))['w.js'], 'a\r\nc\r\n', 'a file of CRLFs patched as git wrote it')
  assert.throws(() => patchedFiles(files({ 'w.js': 'a\nb\n' }), ofCrlf), failure('patch-does-not-apply'), 'not one of LFs')
})

test('a patch of bytes, of a file outside the package, or that its lines miscount isn\'t read', () => {
  const head = 'diff --git a/x.bin b/x.bin\nindex 1111111..2222222 100644\n'
  assert.throws(() => parsePatch(`${head}GIT binary patch\nliteral 3\nKcmZ?\n`), failure('patch-unsupported'))
  assert.throws(() => parsePatch(`${head}Binary files a/x.bin and b/x.bin differ\n`), failure('patch-unsupported'))
  for (const patch of ['diff --git a/../x.js b/../x.js\n--- a/../x.js\n+++ b/../x.js\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/x.js b/x.js\n--- x.js\n+++ x.js\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-a\n+b\n',
    'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n?b\n',
    'diff --git a/x.js b/y.js\n--- a/x.js\n+++ b/y.js\n@@ -1 +1 @@\n-a\n+b\n']) {
    assert.throws(() => parsePatch(patch), failure('patch-unreadable'), patch)
  }
  assert.deepEqual(parsePatch('Some preamble.\n'), [], 'none, what comes before the first file left out')
})

test('a patch read is kept by about the bytes it takes, as V8 takes them: its characters, and the room each line and hunk takes past them', () => {
  const of = hunks => `diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n${hunks}`
  // Its weight by the size of its text.
  const ratio = text => patchWeight(parsePatch(text)) / text.length
  const long = ratio(of(`@@ -1 +1 @@\n-${'a'.repeat(1 << 20)}\n+${'b'.repeat(1 << 20)}\n`))
  assert.ok(long > 1 && long < 1.01, `a few long lines, about their characters (${long})`)
  const short = ratio(of(`@@ -1,100000 +1,100000 @@\n${' a\n'.repeat(100_000)}`))
  assert.ok(short > 20, `many short lines, each on both sides, many times their characters (${short})`)
  const tiny = ratio(of(Array.from({ length: 10_000 }, (_, at) => `@@ -${at + 1} +${at + 1} @@\n-a\n+b\n`).join('')))
  assert.ok(tiny > 15, `many tiny hunks, many times their characters (${tiny})`)
})

test('a patch is held to the hash a lockfile names it by, as pnpm hashes it: a sha256 in hex, or pnpm 9\'s md5 in base32, of its text with its CRLFs as LFs', () => {
  const sha256 = text => createHash('sha256').update(text).digest('hex')
  assert.equal(isPatchOf(PATCH, sha256(PATCH)), true)
  assert.equal(isPatchOf(`${PATCH}\n`, sha256(PATCH)), false)
  // RFC 4648's base32 of md5('a'), lowercase, unpadded.
  assert.equal(isPatchOf('a', 'btaxlooa6g3kqmodthrgs5zgme'), true)
  assert.equal(isPatchOf('b', 'btaxlooa6g3kqmodthrgs5zgme'), false)
  assert.equal(isPatchOf(PATCH.replaceAll('\n', '\r\n'), sha256(PATCH)), true, 'as pnpm reads it, its CRLFs as LFs')
  assert.equal(isPatchOf(PATCH.replaceAll('\n', '\r\n'), sha256(PATCH.replaceAll('\n', '\r\n'))), true, 'or as it is')
  assert.deepEqual(['a'.repeat(64), 'btaxlooa6g3kqmodthrgs5zgme', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(32), null].map(isPatchHash), [true, true, false, false, false, false])
  const where = { hash: 'a'.repeat(64), repoId: '1', commit: 'c'.repeat(40), path: 'patches/x.patch' }
  assert.deepEqual(requestedPatch(where), { ...where, repoId: 1 })
  assert.equal(requestedPatch({ hash: 'a'.repeat(64), repoId: null, commit: null, path: null }), null, 'its hash alone names not where it is')
  for (const wrong of [{ repoId: '0' }, { repoId: 'x' }, { commit: 'c' }, { path: '../x.patch' }, { path: '/x.patch' }, { path: 'a//x.patch' }, { hash: 'nope' }, { hash: null }]) {
    assert.equal(requestedPatch({ ...where, ...wrong }), 'invalid', JSON.stringify(wrong))
  }
})

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3_600_000 }
const repo = { repoId: 1, fullName: 'org/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }
const publicMetadata = { id: 1, full_name: 'org/repo', private: false, visibility: 'public', default_branch: 'main' }
const commit = 'c'.repeat(40)
// A file as GitHub's contents API answers it: its bytes, hashed to its blob.
function contents(path, text) {
  const bytes = Buffer.from(text)
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  return { type: 'file', path, size: bytes.length, sha, encoding: 'base64', content: bytes.toString('base64') }
}

// A server, the registry serving `pkg`, and GitHub the repository whose
// files at `commit` are `held`: `reviewer` reviews in a team that has the
// repository, whole; `outsider` in one that hasn't it.
async function setup(t, pkg, held) {
  const db = openSqliteManagedDb(':memory:')
  const server = createServer(createManagedRequestHandler({ db, config, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} }))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    const stopping = new Promise(resolve => { server.close(resolve) })
    server.closeAllConnections()
    await stopping
    await db.close()
  })
  const users = {}
  for (const [at, [login, role]] of [['admin', 'admin'], ['reviewer', 'triage'], ['outsider', 'triage']].entries()) {
    const session = await createSession(config, db, { githubUserId: at + 1, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    await db.setUserTokens(session.userId, { accessToken: 'token', refreshToken: null, expiresAt: null })
    users[login] = { ...session, cookie: session.setCookie.split(';')[0], sid: hashToken(session.setCookie.split(';')[0].slice(4)) }
  }
  await db.selectRepo(repo, Date.now())
  for (const [team, who] of [['reviewers', 'reviewer'], ['others', 'outsider']]) {
    await db.createTeam(team, team, Date.now())
    await db.setTeamMember(team, users[who].userId, { dependencies: true, security: false })
    await db.setTeamDependencyReview(users.admin.sid, team, true)
  }
  await db.setTeamRepo('reviewers', 1, null)
  registry(t, [pkg])
  const registryFetch = globalThis.fetch
  const asked = []
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(String(input))
    if (url.hostname !== 'api.github.com') return registryFetch(input, init)
    if (url.pathname === '/repos/org/repo') return Promise.resolve(Response.json(publicMetadata))
    asked.push(url.pathname)
    const path = url.pathname.startsWith('/repos/org/repo/contents/') ? decodeURIComponent(url.pathname.slice('/repos/org/repo/contents/'.length)) : null
    const text = url.searchParams.get('ref') === commit ? held[path] : undefined
    return Promise.resolve(text === undefined ? Response.json({ message: 'Not Found' }, { status: 404 }) : Response.json(contents(path, text)))
  })
  function send(path, who = 'reviewer', body = undefined) {
    const user = users[who]
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: body ? 'POST' : 'GET', headers: {
        ...user ? { cookie: user.cookie, 'x-csrf-token': user.csrfToken } : {}, ...body ? { 'content-type': 'application/json' } : {},
      } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({ status: res.statusCode, json: () => JSON.parse((res.headers['content-encoding'] === 'br' ? brotliDecompressSync(bytes) : bytes).toString()) })
        })
      })
      req.on('error', reject)
      req.end(body && JSON.stringify(body))
    })
  }
  return { db, users, send, asked }
}

test('a version as a patch changes it is read, compared and reviewed by one who reads the whole of the repository the patch is read of, the patch held to its hash', async t => {
  const pkg = packageOf('patched-lib', '1.0.0', PACKAGE)
  const path = 'patches/patched-lib@1.0.0.patch'
  const h = await setup(t, pkg, { [path]: PATCH, 'patches/crlf.patch': PATCH.replaceAll('\n', '\r\n') })
  const hash = createHash('sha256').update(PATCH).digest('hex')
  const patch = { patchHash: hash, patchRepoId: '1', patchCommit: commit, patchPath: path }
  const query = more => new URLSearchParams({ name: 'patched-lib', version: '1.0.0', ...more })

  const read = await h.send(`/api/npm/package?${query(patch)}`)
  assert.equal(read.status, 200)
  const body = read.json()
  assert.deepEqual(body.patch, { hash, repoId: 1, commit, path })
  assert.deepEqual(body.files.map(([file]) => file), ['added.js', 'image.bin', 'index.js', 'new name.js', 'package.json'], 'its files as the patch changes them')
  assert.equal(body.files.find(([file]) => file === 'index.js')[2], 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n')
  assert.deepEqual(h.asked, [`/repos/org/repo/contents/${path.replace('@', '%40')}`], 'its patch read of the repository at the commit named')
  h.asked.length = 0
  assert.equal((await h.send(`/api/npm/package?${query(patch)}`)).status, 200)
  assert.deepEqual(h.asked, [], 'and kept, what a commit holds never changing')
  assert.deepEqual((await h.send(`/api/npm/package?${query({ ...patch, patchPath: 'patches/crlf.patch' })}`)).json().files, body.files,
    'one committed with CRLFs, its hash as pnpm hashes it, read as git wrote it')

  const compared = (await h.send(`/api/npm/comparison?${query({ otherVersion: '(empty)', ...patch })}`)).json()
  assert.deepEqual(compared.files.onlyOther.map(row => row.path).toSorted(), ['added.js', 'image.bin', 'index.js', 'new name.js', 'package.json'], 'compared as patched')
  assert.deepEqual((await h.send(`/api/npm/comparison?${query({ otherVersion: '(empty)' })}`)).json().files.onlyOther.map(row => row.path).toSorted(),
    ['gone.js', 'image.bin', 'index.js', 'old name.js', 'package.json'], 'and unpatched apart')

  for (const [why, more, status, error] of [['one who reads none of its repository', { who: 'outsider' }, 404, 'no-repository'],
    ['one signed out', { who: null }, 401, 'unauthenticated'],
    ['a patch other than its hash says', { patchHash: 'b'.repeat(64) }, 409, 'patch-mismatch'],
    ['one not at that commit', { patchCommit: 'd'.repeat(40) }, 404, 'patch-not-found'],
    ['one outside the repository', { patchPath: '../x.patch' }, 400, 'bad-patch'],
    ['its hash alone', { patchRepoId: undefined, patchCommit: undefined, patchPath: undefined }, 400, 'bad-patch']]) {
    const { who = 'reviewer', ...fields } = more
    const asked = Object.fromEntries(Object.entries({ ...patch, ...fields }).filter(([, value]) => value !== undefined))
    const answer = await h.send(`/api/npm/package?${query(asked)}`, who)
    assert.deepEqual([answer.status, answer.json().error], [status, error], why)
  }
  assert.equal((await h.send(`/api/npm/versions?${new URLSearchParams({ name: 'patched-lib', ...patch })}`)).json().error, 'bad-patch', 'nor of what isn\'t a version\'s files')

  const context = { ecosystem: 'npm', package: 'patched-lib', version: '1.0.0', integrity: pkg.doc.dist.integrity, patchHash: hash }
  const save = (file, more = {}) => h.send('/api/npm/reviews', 'reviewer', { ...context, ...patch, action: 'save', file, status: 'accept', comment: '', ...more })
  assert.deepEqual((await h.send('/api/npm/reviews', 'reviewer', { ...context, action: 'save', file: 'added.js', status: 'accept', comment: '' })).json().error,
    'bad-review-context', 'a change asked with where its patch is')
  assert.equal((await save('gone.js')).json().error, 'unknown-review-file', 'a file the patch deletes isn\'t among it')
  assert.equal((await save('image.bin')).json().error, 'non-text-review-file')
  const outsider = await h.send('/api/npm/reviews', 'outsider', { ...context, ...patch, action: 'save', file: 'added.js', status: 'accept', comment: '' })
  assert.deepEqual([outsider.status, outsider.json().error], [404, 'no-repository'], 'one who reads none of the repository its patch is in reviews none of it')
  let review = (await save('added.js')).json().review
  assert.deepEqual([review.patchHash, review.patchSource], [hash, { repoId: 1, commit, path }], 'a review of it as patched, where its patch was read kept')
  for (const file of ['index.js', 'new name.js', 'package.json']) review = (await save(file, { reviewId: review.id, revision: review.revision })).json().review
  const published = await h.send('/api/npm/reviews', 'reviewer', { ...context, ...patch, action: 'publish', reviewId: review.id, revision: review.revision, teamIds: ['reviewers'],
    finalStatus: 'accept', finalComment: '' })
  assert.equal(published.status, 200, JSON.stringify(published.json()))
  review = published.json().review
  assert.deepEqual([review.files, review.nonTextFiles, review.coverage], [['added.js', 'image.bin', 'index.js', 'new name.js', 'package.json'], ['image.bin'], 'partial'],
    'published as of the files as the patch changes them')
  const listed = await h.send(`/api/npm/reviews?${new URLSearchParams({ ...context, allBases: 'true' })}`)
  assert.deepEqual(listed.json().reviews.map(one => one.id), [review.id], 'listed by its patch')
  const { patchHash: _patchHash, ...unpatched } = context
  assert.deepEqual((await h.send(`/api/npm/reviews?${new URLSearchParams({ ...unpatched, allBases: 'true' })}`)).json().reviews, [], 'not as the version unpatched')
  assert.equal((await h.send(`/api/npm/reviews/latest?${new URLSearchParams({ package: 'patched-lib', version: '1.0.0', integrity: context.integrity, patchHash: hash })}`)).json().review.id,
    review.id)
  assert.equal((await h.send(`/api/npm/reviews/latest?${new URLSearchParams({ package: 'patched-lib', version: '1.0.0', integrity: context.integrity })}`)).json().review, null)
  assert.equal((await h.send('/api/npm/reviews', 'reviewer', { ...context, action: 'revoke', reviewId: review.id, revision: review.revision })).status, 200,
    'revoked with no need to read its patch')
})
