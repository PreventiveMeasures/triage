// A pnpm patch of an npm package version (server-managed/npm-patch.ts), as
// its dependency review reads it: its file held to the hash a lockfile names
// it by, read as git writes a diff, applied to the version's files as pnpm
// applies it; and a version's review as patched (http.ts), its files and its
// comparison as the patch changes them, the patch read of a repository its
// reader reads all of, at the commit and path the request names, and kept
// by its repository and hash for good; one its lockfile names by its hash
// alone found as its versions are told.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { brotliDecompressSync } from 'node:zlib'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { foundPatch, isPatchOf, keptPatch, parsePatch, patchKey, patchWeight, patchedFiles, readPatch, requestedPatch, withPatchFiles } from '../server-managed/npm-patch.ts'
import { patchStore } from '../server-managed/npm-kept.ts'
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
  // Its lines some lines off where it says they are, each hunk's as far off as
  // FUZZ lines either side of where its own header says, in the file as it
  // was, as patch-package looks; not as the hunks before found theirs.
  const moved = patchedFiles(files({ ...PACKAGE, 'index.js': `zero\nzero\n${LINES}` }), patch)
  assert.equal(texts(moved)['index.js'], 'zero\nzero\none\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n')
  assert.throws(() => patchedFiles(files({ ...PACKAGE, 'index.js': `${'zero\n'.repeat(21)}${LINES}` }), patch), failure('patch-does-not-apply'), 'not further')
  const two = parsePatch('diff --git a/w.js b/w.js\n--- a/w.js\n+++ b/w.js\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,3 @@\n j\n-k\n+K\n l\n')
  const abc = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n'
  assert.equal(texts(patchedFiles(files({ 'w.js': `${'z\n'.repeat(15)}${abc}` }), two))['w.js'], `${'z\n'.repeat(15)}${abc.replace('b', 'B').replace('k', 'K')}`)
  assert.throws(() => patchedFiles(files({ 'w.js': `${'z\n'.repeat(15)}${abc.replace('d\n', `d\n${'y\n'.repeat(10)}`)}` }), two), failure('patch-does-not-apply'),
    'a hunk 25 lines off, though 10 past the hunk before')
  for (const [why, changed] of [['its lines changed', { 'index.js': LINES.replace('three', 'THREE') }], ['a file it changes gone', { 'index.js': undefined }],
    ['a file it deletes gone', { 'gone.js': undefined }], ['one it renames to there', { 'new name.js': 'there\n' }],
    ['the bytes of one it changes not text', { 'index.js': Buffer.from([0, 1]) }]]) {
    const before = Object.fromEntries(Object.entries({ ...PACKAGE, ...changed }).filter(([, text]) => text !== undefined))
    assert.throws(() => patchedFiles(files(before), patch), failure('patch-does-not-apply'), why)
  }
  assert.equal(texts(patchedFiles(files({ ...PACKAGE, 'added.js': 'there\n' }), patch))['added.js'], 'added\nlast', 'one it adds written over one there')
  // Its lines the same but for the space they end in, those it keeps kept as
  // the file has them.
  const spaced = parsePatch('diff --git a/w.js b/w.js\n--- a/w.js\n+++ b/w.js\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n')
  assert.equal(texts(patchedFiles(files({ 'w.js': 'one  \ntwo\t\nthree\n' }), spaced))['w.js'], 'one  \nTWO\nthree\n')
  // Lines added with none it finds (git's -U0) put before the line its header
  // names, as patch-package puts them.
  const inserted = parsePatch('diff --git a/w.js b/w.js\n--- a/w.js\n+++ b/w.js\n@@ -2,0 +3 @@\n+new\n')
  assert.equal(texts(patchedFiles(files({ 'w.js': 'a\nb\nc\n' }), inserted))['w.js'], 'a\nnew\nb\nc\n')
  // Its last line with no ending, as it was and as it is; one it removes
  // found as one with its ending too, whose ending patch-package then adds.
  const unended = parsePatch('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n')
  assert.equal(texts(patchedFiles(files({ 'a.js': 'a\nb' }), unended))['a.js'], 'a\nc\n')
  assert.equal(texts(patchedFiles(files({ 'a.js': 'a\nb\n' }), unended))['a.js'], 'a\nc\n\n')
  // Quoted, as git writes a path past ASCII.
  const quoted = parsePatch('diff --git "a/\\303\\251.js" "b/\\303\\251.js"\ndeleted file mode 100644\nindex 1111111..0000000\n')
  assert.deepEqual(quoted.map(file => [file.path, file.deleted]), [['é.js', true]])
  // Its own lines ending in CRLFs, as an editor or autocrlf leaves it, read
  // as patch-package reads it: its headers but their CRs, the lines it adds
  // with them. One git wrote of a file whose lines end in CRLFs keeps its CRs.
  assert.deepEqual(texts(patchedFiles(files(PACKAGE), parsePatch(PATCH.replaceAll('\n', '\r\n')))), { 'added.js': 'added\r\nlast\r', 'image.bin': '\0\u0001\u0002',
    'index.js': 'one\nTWO\r\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\r\n', 'new name.js': 'new\r\n', 'package.json': '{}\n' })
  const ofCrlf = parsePatch('diff --git a/w.js b/w.js\n--- a/w.js\n+++ b/w.js\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n')
  assert.equal(texts(patchedFiles(files({ 'w.js': 'a\r\nb\r\n' }), ofCrlf))['w.js'], 'a\r\nc\r\n', 'a file of CRLFs patched as git wrote it')
  assert.equal(texts(patchedFiles(files({ 'w.js': 'a\nb\n' }), ofCrlf))['w.js'], 'a\nc\r\n', 'one of LFs too, its line added with its CR')
})

test('a patch of bytes, of a file outside the package, or that its lines miscount isn\'t read', () => {
  const head = 'diff --git a/x.bin b/x.bin\nindex 1111111..2222222 100644\n'
  assert.throws(() => parsePatch(`${head}GIT binary patch\nliteral 3\nKcmZ?\n`), failure('patch-unsupported'))
  assert.throws(() => parsePatch(`${head}Binary files a/x.bin and b/x.bin differ\n`), failure('patch-unsupported'))
  for (const patch of ['diff --git a/../x.js b/../x.js\n--- a/../x.js\n+++ b/../x.js\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/x.js b/x.js\n--- x.js\n+++ x.js\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-a\n+b\n',
    'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n?b\n',
    'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n\\ Something else\n+b\n',
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
  assert.ok(short > 5, `many short lines, many times their characters (${short})`)
  const tiny = ratio(of(Array.from({ length: 10_000 }, (_, at) => `@@ -${at + 1} +${at + 1} @@\n-a\n+b\n`).join('')))
  assert.ok(tiny > 15, `many tiny hunks, many times their characters (${tiny})`)
})

const sha256 = text => createHash('sha256').update(text).digest('hex')
// PATCH as another patch of the same changes, of a hash of its own: what
// comes before a patch's first file is no part of what it changes.
const variant = name => `# ${name}\n${PATCH}`
// RFC 4648's base32 of md5('a'), lowercase, unpadded, as pnpm 9 named a patch.
const MD5 = 'btaxlooa6g3kqmodthrgs5zgme'

test('a patch is held to the hash a lockfile names it by, as pnpm 10 and later hash it: a sha256 in hex of its text with its CRLFs as LFs; pnpm 9\'s md5 in base32 names none', () => {
  assert.equal(isPatchOf(PATCH, sha256(PATCH)), true)
  assert.equal(isPatchOf(`${PATCH}\n`, sha256(PATCH)), false)
  assert.equal(isPatchOf('a', MD5), false)
  assert.equal(isPatchOf(PATCH.replaceAll('\n', '\r\n'), sha256(PATCH)), true, 'as pnpm reads it, its CRLFs as LFs')
  assert.equal(isPatchOf(PATCH.replaceAll('\n', '\r\n'), sha256(PATCH.replaceAll('\n', '\r\n'))), false, 'not as it is')
  assert.deepEqual([sha256('+a\rb\n'), sha256('+ab\n')].map(hash => isPatchOf('+a\rb\r\n', hash)), [true, false], 'a CR that ends no line kept, as pnpm 12 keeps it')
  assert.deepEqual(['a'.repeat(64), MD5, 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(32), null].map(isPatchHash), [true, false, false, false, false, false])
  const where = { hash: 'a'.repeat(64), repoId: '1', commit: 'c'.repeat(40), path: 'patches/x.patch' }
  assert.deepEqual(requestedPatch(where), { ...where, repoId: 1 })
  assert.deepEqual(requestedPatch({ ...where, repoId: 'Org/some.repo-1' }), { ...where, repoId: 'Org/some.repo-1' }, 'its repository by its name')
  assert.deepEqual(requestedPatch({ ...where, path: null }), { hash: where.hash, repoId: 1, commit: where.commit }, 'its path left out, looked for at the commit')
  assert.deepEqual(requestedPatch({ hash: 'a'.repeat(64), repoId: null, commit: null, path: null }), { hash: 'a'.repeat(64) }, 'by its hash alone, as kept')
  assert.equal(requestedPatch({ hash: MD5 }), 'invalid')
  assert.equal(requestedPatch({ hash: null }), null, 'none named')
  for (const wrong of [{ repoId: '0' }, { repoId: 'x' }, { repoId: 'org/repo/more' }, { commit: 'c' }, { commit: null }, { repoId: null }, { path: '../x.patch' }, { path: '/x.patch' }, { path: 'a//x.patch' }, { hash: 'nope' },
    { hash: null }, { hash: MD5 }]) {
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
    if (url.pathname === `/repos/org/repo/git/trees/${commit}`) {
      return Promise.resolve(Response.json({ tree: Object.entries(held).map(([path, text]) => ({ type: 'blob', path, size: Buffer.byteLength(text) })), truncated: false }))
    }
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

test('a version as a patch changes it is read, compared and reviewed by one who reads the whole of the repository the patch is read of, the patch held to its hash, and kept by its repository and hash for good', async t => {
  const pkg = packageOf('patched-lib', '1.0.0', PACKAGE)
  const path = 'patches/patched-lib@1.0.0.patch'
  const [crlf, found] = [variant('crlf'), variant('found')]
  const h = await setup(t, pkg, { [path]: PATCH, 'patches/crlf.patch': crlf.replaceAll('\n', '\r\n'), 'patches/other.patch': variant('other'), 'patches/found.patch': found,
    'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'\n' })
  const hash = sha256(PATCH)
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
  // What its hash names is the same wherever a request says it is: read of GitHub no more, and told where it was read.
  const elsewhere = await h.send(`/api/npm/package?${query({ ...patch, patchCommit: 'd'.repeat(40), patchPath: 'moved/since.patch' })}`)
  assert.deepEqual([elsewhere.status, elsewhere.json().patch, h.asked], [200, { hash, repoId: 1, commit, path }, []], 'kept by its repository and hash, another commit and path its request\'s')
  assert.deepEqual((await patchStore(h.db).read(patchKey(1, hash))).value, { commit, path, text: PATCH }, 'beyond this instance, for good')
  assert.deepEqual((await h.send(`/api/npm/package?${query({ ...patch, patchHash: sha256(crlf), patchPath: 'patches/crlf.patch' })}`)).json().files.map(([file, , text]) => [file, text]),
    [['added.js', 'added\r\nlast\r'], ['image.bin', null], ['index.js', 'one\nTWO\r\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\r\n'], ['new name.js', 'new\r\n'],
      ['package.json', '{}\n']], 'one committed with CRLFs, its hash as pnpm hashes it, applied as pnpm applies it, the lines it adds with their CRs')

  const compared = (await h.send(`/api/npm/comparison?${query({ otherVersion: '(empty)', ...patch })}`)).json()
  assert.deepEqual(compared.files.onlyOther.map(row => row.path).toSorted(), ['added.js', 'image.bin', 'index.js', 'new name.js', 'package.json'], 'compared as patched')
  assert.deepEqual((await h.send(`/api/npm/comparison?${query({ otherVersion: '(empty)' })}`)).json().files.onlyOther.map(row => row.path).toSorted(),
    ['gone.js', 'image.bin', 'index.js', 'old name.js', 'package.json'], 'and unpatched apart')

  // Its repository by its name, a connected one its reader reads, whatever its case, as by its id.
  const other = { ...patch, patchRepoId: 'Org/Repo', patchHash: sha256(variant('other')), patchPath: 'patches/other.patch' }
  const named = await h.send(`/api/npm/package?${query(other)}`)
  assert.deepEqual([named.status, named.json().patch], [200, { hash: other.patchHash, repoId: 1, commit, path: 'patches/other.patch' }], 'read of the repository of that name, told by its id')

  // Its path left out: looked for among the commit's patches beside its pnpm lockfile, of a repository whose dependency review is on alone, each kept.
  const pathless = { patchHash: sha256(found), patchRepoId: '1', patchCommit: commit }
  assert.equal((await h.send(`/api/npm/package?${query(pathless)}`)).json().error, 'patch-not-found', 'none looked for where its dependency review is off')
  await h.db.setRepoDependencyReview(1, { enabled: true, required: 1, since: null })
  h.asked.length = 0
  assert.deepEqual((await h.send(`/api/npm/package?${query(pathless)}`, 'outsider')).json().error, 'no-repository', 'nor by one who reads none of it')
  const looked = await h.send(`/api/npm/package?${query(pathless)}`)
  assert.deepEqual([looked.status, looked.json().patch], [200, { hash: pathless.patchHash, repoId: 1, commit, path: 'patches/found.patch' }], 'found, and told where')
  assert.deepEqual(h.asked.toSorted(), [...['crlf', 'found', 'other', 'patched-lib%401.0.0'].map(name => `/repos/org/repo/contents/patches/${name}.patch`),
    `/repos/org/repo/git/trees/${commit}`], 'each of its patches read once')
  h.asked.length = 0
  assert.equal((await h.send(`/api/npm/package?${query({ patchHash: pathless.patchHash })}`)).json().patch.path, 'patches/found.patch', 'kept, by its hash alone as well')
  assert.equal((await h.send(`/api/npm/package?${query({ ...pathless, patchHash: 'e'.repeat(64) })}`)).json().error, 'patch-not-found', 'one none of them is')
  assert.deepEqual(h.asked, [], 'the commit looked in once')

  for (const [why, more, status, error] of [['one who reads none of its repository', { who: 'outsider' }, 404, 'no-repository'],
    ['one who reads none of it, by its name', { who: 'outsider', patchRepoId: 'org/repo' }, 404, 'no-repository'],
    ['a repository none connected has the name of', { patchRepoId: 'org/unconnected' }, 404, 'no-repository'],
    ['one signed out', { who: null }, 401, 'unauthenticated'],
    ['a patch other than its hash says', { patchHash: 'b'.repeat(64) }, 409, 'patch-mismatch'],
    ['one read at no commit yet, not at that one', { patchHash: 'e'.repeat(64), patchCommit: 'd'.repeat(40) }, 404, 'patch-not-found'],
    ['one pnpm 9 names by an md5', { patchHash: MD5 }, 400, 'bad-patch'],
    ['one outside the repository', { patchPath: '../x.patch' }, 400, 'bad-patch'],
    ['by its hash alone, one never kept', { patchHash: 'f'.repeat(64), patchRepoId: undefined, patchCommit: undefined, patchPath: undefined }, 404, 'patch-not-kept'],
    ['by its hash alone, one kept of a repository they read none of', { who: 'outsider', patchRepoId: undefined, patchCommit: undefined, patchPath: undefined }, 404, 'patch-not-kept'],
    ['a comparison\'s other version\'s patch for a version\'s files', { otherPatchHash: hash }, 400, 'bad-patch']]) {
    const { who = 'reviewer', ...fields } = more
    const asked = Object.fromEntries(Object.entries({ ...patch, ...fields }).filter(([, value]) => value !== undefined))
    const answer = await h.send(`/api/npm/package?${query(asked)}`, who)
    assert.deepEqual([answer.status, answer.json().error], [status, error], why)
  }
  assert.equal(h.asked.filter(asked => asked.includes('unconnected')).length, 0, 'GitHub asked of no repository by a name none connected has')
  assert.equal((await h.send(`/api/npm/versions?${new URLSearchParams({ name: 'patched-lib', ...patch })}`)).json().error, 'bad-patch', 'nor of what isn\'t a version\'s files')

  const context = { ecosystem: 'npm', package: 'patched-lib', version: '1.0.0', integrity: pkg.doc.dist.integrity, patchHash: hash }
  const save = (file, more = {}) => h.send('/api/npm/reviews', 'reviewer', { ...context, ...patch, action: 'save', file, status: 'accept', comment: '', ...more })
  assert.deepEqual((await h.send('/api/npm/reviews', 'reviewer', { ...context, patchHash: 'f'.repeat(64), action: 'save', file: 'added.js', status: 'accept', comment: '' })).json().error,
    'patch-not-kept', 'a change asked with where its patch is, or of one kept')
  assert.equal((await save('gone.js')).json().error, 'unknown-review-file', 'a file the patch deletes isn\'t among it')
  assert.equal((await save('image.bin')).json().error, 'non-text-review-file')
  const outsider = await h.send('/api/npm/reviews', 'outsider', { ...context, ...patch, action: 'save', file: 'added.js', status: 'accept', comment: '' })
  assert.deepEqual([outsider.status, outsider.json().error], [404, 'no-repository'], 'one who reads none of the repository its patch is in reviews none of it')
  // Asked by its repository's name, at another commit and path: kept as read, by its repository's id, where it was.
  let review = (await save('added.js', { patchRepoId: 'org/repo', patchCommit: 'd'.repeat(40), patchPath: 'moved/since.patch' })).json().review
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

  // By its hash alone, as kept: the version's files as it changes them; and, as a comparison's base, its files so, its review of that comparison apart.
  h.asked.length = 0
  const alone = await h.send(`/api/npm/package?${query({ patchHash: hash })}`)
  assert.deepEqual([alone.status, alone.json().patch, h.asked], [200, { hash, repoId: 1, commit, path }, []], 'as kept, where it was read, GitHub asked for none of it')
  const unpatching = (await h.send(`/api/npm/comparison?${query({ otherVersion: '1.0.0', otherPatchHash: hash })}`)).json().files
  assert.deepEqual([unpatching.changed.map(row => row.path), unpatching.onlyBase.map(row => row.path), unpatching.onlyOther.map(row => row.path)].map(paths => paths.filter(one => !one.includes('name')).toSorted()),
    [['index.js'], ['added.js'], ['gone.js']], 'compared with the version as its patch changes it')
  for (const [why, more, status, error] of [['of no base', { otherVersion: '(empty)', otherPatchHash: hash }, 400, 'bad-patch'], ['by more than its hash', { otherPatchHash: 'nope' }, 400, 'bad-patch'],
    ['one never kept', { otherPatchHash: 'f'.repeat(64) }, 404, 'patch-not-kept']]) {
    const answer = await h.send(`/api/npm/comparison?${query({ otherVersion: '1.0.0', ...more })}`)
    assert.deepEqual([answer.status, answer.json().error], [status, error], why)
  }
  const onPatched = { ecosystem: 'npm', package: 'patched-lib', version: '1.0.0', integrity: pkg.doc.dist.integrity, basePackage: 'patched-lib', baseVersion: '1.0.0',
    baseIntegrity: pkg.doc.dist.integrity, basePatchHash: hash }
  const based = await h.send('/api/npm/reviews', 'reviewer', { ...onPatched, action: 'save', file: 'index.js', status: 'accept', comment: '' })
  assert.deepEqual([based.status, based.json().review?.basePatchHash], [200, hash], 'a review against it, of the files that comparison changes')
  assert.equal((await h.send('/api/npm/reviews', 'reviewer', { ...onPatched, action: 'save', file: 'package.json', status: 'accept', comment: '' })).json().error, 'unknown-review-file')
  assert.deepEqual((await h.send(`/api/npm/reviews?${new URLSearchParams(onPatched)}`)).json().reviews.map(one => one.id), [based.json().review.id], 'listed by it')
  assert.deepEqual((await h.send(`/api/npm/reviews?${new URLSearchParams({ ...onPatched, basePatchHash: undefined })}`)).json().error, 'bad-review-context')
  const { basePatchHash: _basePatchHash, ...againstUnpatched } = onPatched
  assert.deepEqual((await h.send(`/api/npm/reviews?${new URLSearchParams(againstUnpatched)}`)).json().reviews, [], 'not against it unpatched')
  for (const [why, more, error] of [['of no base', { basePackage: undefined, baseVersion: undefined, baseIntegrity: undefined }, 'bad-review-context'],
    ['one never kept', { basePatchHash: 'f'.repeat(64) }, 'patch-not-kept']]) {
    const answer = await h.send('/api/npm/reviews', 'reviewer', { ...onPatched, ...more, action: 'save', file: 'index.js', status: 'accept', comment: '' })
    assert.equal(answer.json().error, error, why)
  }
})

// A repository's files, by path and the first character of the commit asked at, as GitHub's contents API answers them; and what was asked of it.
function githubFiles(t, held) {
  const asked = []
  t.mock.method(globalThis, 'fetch', input => {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname.slice('/repos/org/repo/contents/'.length))
    asked.push(`${path}@${url.searchParams.get('ref')[0]}`)
    const text = held[asked.at(-1)]
    if (text instanceof Response) return Promise.resolve(text.clone())
    return Promise.resolve(text === undefined ? Response.json({ message: 'Not Found' }, { status: 404 }) : Response.json(contents(path, text)))
  })
  return asked
}
// Patches kept beyond an instance, as npm-kept.ts patchStore keeps them.
const patchesKept = (kept = new Map()) => ({ kept, read: key => Promise.resolve(kept.has(key) ? { value: kept.get(key) } : null),
  readMany: keys => Promise.resolve(new Map(keys.flatMap(key => kept.has(key) ? [[key, { value: kept.get(key) }]] : []))),
  write: (key, patch) => { kept.set(key, patch); return Promise.resolve() } })
// A pull request's dependencies as told (pull-dependencies.ts), its lockfile in `web` read at `head`, locking `packages`.
const toldOf = (head, packages) => ({ base: 'b'.repeat(40), head, cut: false, lockfiles: [{ paths: ['web/pnpm-lock.yaml'], more: 0, moreLocked: 0, added: packages.slice(0, 1),
  locked: packages.map(pkg => ({ ...pkg })) }, { paths: ['bun.lock'], error: 'lockfile-unsupported' }] })
const lockedBy = (name, hash, more = {}) => ({ name, version: '1.0.0', source: 'registry', integrity: 'sha512-x', lockfile: 'pnpm', patchHash: hash, patchDir: 'web', ...more })
const filesOf = told => Object.fromEntries(told.lockfiles[0].locked.map(pkg => [pkg.name, pkg.patchPath ?? null]))

test('a patch its lockfile names by its hash alone is told its file as its versions are: the one its pnpm-workspace.yaml names, held to its hash, found once and kept by its repository and hash for good', async t => {
  const [named, every, moved] = [variant('named'), variant('every'), variant('moved')]
  const asked = githubFiles(t, { 'web/pnpm-workspace.yaml@1': 'patchedDependencies:\n  named@1.0.0: fixes/named.patch\n  every: ../shared/every.patch\n  moved@1.0.0: fixes/moved.patch\n',
    'web/fixes/named.patch@1': named, 'shared/every.patch@1': every, 'web/fixes/moved.patch@1': 'another\n' })
  const head = '1'.repeat(40)
  const packages = [lockedBy('named', sha256(named)), lockedBy('every', sha256(every)), lockedBy('moved', sha256(moved)), lockedBy('absent', 'd'.repeat(64)),
    lockedBy('listed', 'f'.repeat(64), { patchPath: 'web/patches/listed.patch' }), lockedBy('md5', MD5), { name: 'plain', version: '1.0.0', source: 'registry', lockfile: 'pnpm' }]
  const store = patchesKept()
  const told = { github: false }
  const answer = await withPatchFiles(toldOf(head, packages), 41, 'org/repo', 'token', store, told)
  assert.deepEqual(filesOf(answer), { named: 'web/fixes/named.patch', every: 'shared/every.patch', moved: null, absent: null, listed: 'web/patches/listed.patch', md5: null, plain: null },
    'its version\'s, else its package\'s, from its lockfile\'s directory; none where the file named is another patch, none is named, or pnpm 9 names it by an md5')
  assert.deepEqual([answer.lockfiles[0].added[0].patchPath, answer.lockfiles[1], told.github], ['web/fixes/named.patch', { paths: ['bun.lock'], error: 'lockfile-unsupported' }, true])
  assert.deepEqual(asked.toSorted(), ['shared/every.patch@1', 'web/fixes/moved.patch@1', 'web/fixes/named.patch@1', 'web/pnpm-workspace.yaml@1'], 'each file read once')
  assert.deepEqual(store.kept.get(patchKey(41, sha256(named))), { commit: head, path: 'web/fixes/named.patch', text: named }, 'kept with its text')
  assert.equal(store.kept.size, 2)

  // Told again: none looked for; at another commit, only those not found at the first.
  asked.length = 0
  const again = { github: false }
  assert.deepEqual(filesOf(await withPatchFiles(toldOf(head, packages), 41, 'org/repo', 'token', store, again)), filesOf(answer))
  assert.deepEqual([asked, again.github], [[], false], 'GitHub asked for none of them')
  assert.deepEqual(filesOf(await withPatchFiles(toldOf('2'.repeat(40), packages), 41, 'org/repo', 'token', store)), filesOf(answer), 'where each was found, its hash naming it at any commit')
  assert.deepEqual(asked, ['web/pnpm-workspace.yaml@2'], 'those not found looked for at the other commit')

  // Another repository's are none of this one's; one kept beyond the instance is told as kept.
  asked.length = 0
  const kept = patchesKept(new Map([[patchKey(42, sha256(named)), { commit: 'a'.repeat(40), path: 'kept/named.patch', text: named }]]))
  assert.deepEqual([filesOf(await withPatchFiles(toldOf(head, [lockedBy('named', sha256(named))]), 42, 'org/repo', 'token', kept)), asked], [{ named: 'kept/named.patch' }, []])
  assert.deepEqual(filesOf(await withPatchFiles(toldOf(head, [lockedBy('named', sha256(named))]), 43, 'org/repo', 'token', patchesKept())), { named: 'web/fixes/named.patch' })
  assert.ok(asked.includes('web/fixes/named.patch@1'), 'found anew for a repository none is kept of')

  // A file GitHub has no text of is none; GitHub failing fails the whole, as a lockfile's read does.
  t.mock.restoreAll()
  githubFiles(t, { 'web/pnpm-workspace.yaml@3': Response.json([{ type: 'file' }]), 'web/pnpm-workspace.yaml@4': Response.json({ message: 'Service Unavailable' }, { status: 503 }) })
  assert.deepEqual(filesOf(await withPatchFiles(toldOf('3'.repeat(40), [lockedBy('odd', 'c'.repeat(64))]), 41, 'org/repo', 'token', store)), { odd: null })
  await assert.rejects(withPatchFiles(toldOf('4'.repeat(40), [lockedBy('odd', 'c'.repeat(64))]), 41, 'org/repo', 'token', store), { message: 'github-status-503' })

  // As many looked for an answer as MAX_FOUND, its pnpm-workspace.yaml read for all of them once; the rest by the next.
  t.mock.restoreAll()
  const many = Array.from({ length: 102 }, (_, at) => lockedBy(`p${at}`, sha256(`p${at}`)))
  const looked = githubFiles(t, { 'web/pnpm-workspace.yaml@5': `patchedDependencies:\n${many.map(pkg => `  ${pkg.name}: fixes/${pkg.name}.patch\n`).join('')}` })
  await withPatchFiles(toldOf('5'.repeat(40), many), 41, 'org/repo', 'token', store)
  assert.equal(looked.length, 101)
  await withPatchFiles(toldOf('5'.repeat(40), many), 41, 'org/repo', 'token', store)
  assert.equal(looked.length, 104)
})

test('a default branch\'s patches whose files its lockfiles name are kept too, held to their hashes, so a link naming one by its hash alone finds it later', async t => {
  const text = variant('named file')
  const asked = githubFiles(t, { 'web/patches/named.patch@1': text, 'web/patches/other.patch@1': 'another\n' })
  const store = patchesKept()
  const pkgs = [lockedBy('named', sha256(text), { patchPath: 'web/patches/named.patch' }), lockedBy('other', sha256(variant('other file')), { patchPath: 'web/patches/other.patch' })]
  const told = toldOf('1'.repeat(40), pkgs)
  assert.deepEqual(filesOf(await withPatchFiles(told, 51, 'org/repo', 'token', store)), { named: 'web/patches/named.patch', other: 'web/patches/other.patch' })
  assert.deepEqual([asked, store.kept.size], [[], 0], 'a pull request\'s, not read')
  await withPatchFiles(told, 51, 'org/repo', 'token', store, undefined, { keepNamed: true })
  assert.deepEqual(asked.toSorted(), ['web/patches/named.patch@1', 'web/patches/other.patch@1'])
  assert.deepEqual([...store.kept], [[patchKey(51, sha256(text)), { commit: '1'.repeat(40), path: 'web/patches/named.patch', text }]], 'one other than its hash says, not')
  assert.deepEqual((await keptPatch([50, 51], sha256(text), store))?.source, { repoId: 51, commit: '1'.repeat(40), path: 'web/patches/named.patch' }, 'found by its hash alone')
  assert.equal(await keptPatch([50], sha256(text), store), null, 'of none of another repository')
  asked.length = 0
  await withPatchFiles(told, 51, 'org/repo', 'token', store, undefined, { keepNamed: true })
  assert.deepEqual(asked, [], 'each read once')
})

test('a patch kept beyond the instance is read of it, held to its hash again, GitHub asked for none of it; one kept other than its hash says read anew', async t => {
  const text = variant('kept')
  const asked = githubFiles(t, { 'patches/x.patch@c': text })
  const where = { hash: sha256(text), repoId: 31, commit, path: 'patches/x.patch' }
  const store = patchesKept(new Map([[patchKey(31, where.hash), { commit: 'a'.repeat(40), path: 'was/here.patch', text }], [patchKey(32, where.hash), { commit, path: 'x', text: `${text}\n` }]]))
  const told = { github: false }
  const read = await readPatch('org/repo', 'token', where, store, told)
  assert.deepEqual([read.source, read.files.length, asked, told.github], [{ repoId: 31, commit: 'a'.repeat(40), path: 'was/here.patch' }, 4, [], false], 'as kept, where it was read')
  await readPatch('org/repo', 'token', { ...where, repoId: 32 }, store, told)
  assert.deepEqual([asked, told.github, store.kept.get(patchKey(32, where.hash))], [['patches/x.patch@c'], true, { commit, path: 'patches/x.patch', text }], 'and kept in its place')
})

test('a patch named at a commit without its path is found among the commit\'s patches, each `.patch` file in a patches directory beside a pnpm lockfile or a stasis.config.json, each kept by its own hash, the commit looked in once', async t => {
  const [wanted, beside] = [variant('wanted'), variant('beside')]
  const asked = githubFiles(t, { 'web/patches/wanted.patch@1': wanted, 'patches/beside.patch@1': beside, 'web/patches/sub/nested.patch@1': variant('nested'),
    'docs/patches/elsewhere.patch@1': variant('elsewhere'), 'web/patches/notes.md@1': 'notes\n' })
  const paths = ['docs/patches/elsewhere.patch', 'package.json', 'patches/beside.patch', 'patches/large.patch', 'pnpm-lock.yaml', 'tools/patches/gone.patch',
    'tools/stasis.config.json', 'web/patches/notes.md', 'web/patches/sub/nested.patch', 'web/patches/wanted.patch', 'web/stasis.config.json']
  let lists = 0
  const listed = () => { lists += 1; return Promise.resolve({ files: paths, sizes: paths.map(path => path === 'patches/large.patch' ? 9 * 1024 * 1024 : 10) }) }
  const store = patchesKept()
  const where = { hash: sha256(wanted), repoId: 61, commit: '1'.repeat(40) }
  const told = { github: false }
  const read = await foundPatch('org/repo', 'token', where, store, listed, told)
  assert.deepEqual([read.source, read.files.length, told.github], [{ repoId: 61, commit: where.commit, path: 'web/patches/wanted.patch' }, 4, true])
  assert.deepEqual(asked.toSorted(), ['patches/beside.patch@1', 'tools/patches/gone.patch@1', 'web/patches/wanted.patch@1'], 'none elsewhere, nested, of another kind, or past MAX_PATCH_BYTES')
  assert.deepEqual([...store.kept.keys()].toSorted(), [patchKey(61, sha256(beside)), patchKey(61, sha256(wanted))].toSorted(), 'each kept by its own hash')

  asked.length = 0
  assert.equal((await foundPatch('org/repo', 'token', { ...where, hash: sha256(beside) }, store, listed)).source.path, 'patches/beside.patch', 'another of them, as kept')
  await assert.rejects(foundPatch('org/repo', 'token', { ...where, hash: 'd'.repeat(64) }, store, listed), failure('patch-not-found'), 'one none of them is')
  assert.deepEqual([asked, lists], [[], 1], 'the commit looked in once')
  await assert.rejects(foundPatch('org/repo', 'token', { ...where, repoId: 62 }, store, () => Promise.resolve(null)), failure('patch-not-found'), 'none where a repository isn\'t looked in')
  assert.equal((await foundPatch('org/repo', 'token', where, store, () => Promise.resolve(null))).source.path, 'web/patches/wanted.patch', 'but as kept')
})
