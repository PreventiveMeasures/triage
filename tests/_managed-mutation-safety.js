import { createHash, randomUUID } from 'node:crypto'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'

export const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 600_000,
  githubClientId: 'client', githubClientSecret: 'secret', oauthCallbackUrl: 'http://localhost/api/oauth/github/callback',
  maxReportBytes: 1_000_000, maxBundleBytes: 1_000_000 }
export function memoryStore() {
  const blobs = new Map()
  return { blobs, put(id, bytes) { blobs.set(id, bytes); return Promise.resolve() },
    get(id) { return Promise.resolve(blobs.get(id) ?? null) }, delete(id) { blobs.delete(id); return Promise.resolve() } }
}
export function harness(db, reports = memoryStore(), bundles = memoryStore(), uploads = memoryStore()) {
  const handler = createManagedRequestHandler({ config, db, reportStore: reports, bundleStore: bundles, uploadStore: uploads,
    originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  return async (path, { session, body, method = 'POST', beforeBody, headers = {} }) => {
    const req = { url: path, method, headers: { cookie: session.setCookie.split(';')[0], 'x-csrf-token': session.csrfToken, ...headers },
      async *[Symbol.asyncIterator]() { await beforeBody?.(); yield Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)) } }
    const res = { status: 0, headers: {}, body: '', writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
      end(value) { this.body = value ?? '' } }
    await handler(req, res)
    return res
  }
}
export async function setup(db) {
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  await db.setUserRole(session.userId, 'admin')
  for (const repoId of [1, 2]) {
    await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true,
      installationId: null, defaultBranch: 'main', htmlUrl: `https://github.com/org/repo${repoId}`, addedBy: session.userId }, Date.now())
  }
  return session
}
export async function seedReport(db, store, userId, repoId = 1) {
  const id = randomUUID()
  const bytes = Buffer.from(JSON.stringify({ source: 'deepview', findings: [{ id: 'shared-finding', title: 'Finding', file: 'a.js' }] }))
  await store.put(id, bytes)
  await db.insertReport({ id, filename: 'scan.json', contentType: 'application/json', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('base64url'), uploadedBy: userId, repoId, visible: false }, Date.now())
  return id
}
export async function seedBundle(db, store, userId, repoId = 1) {
  const id = randomUUID()
  const bytes = Buffer.from('bundle contents')
  await store.put(id, bytes)
  await db.insertBundle({ id, filename: 'bundle.bin', integrity: id, kind: null, byteSize: bytes.length, uploadedBy: userId, repoId }, Date.now())
  return id
}
export const removal = { repoId: 1, fullName: 'org/repo1', acknowledge: true, deleteTriage: false }
