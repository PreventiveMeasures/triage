import { createHash } from 'node:crypto'
import { GithubApiError, githubUnreachable, throwGithubResponseError } from './github-errors.ts'
import { timed } from './request-timing.ts'

const API_VERSION = '2022-11-28'
export const USER_AGENT = 'deepview-triage'

// Only outstanding reads: a completed answer (or failure) is never reused.
// Keep transports and credentials separate, including anonymous reads. When
// full, new reads proceed normally rather than waiting for an unrelated one.
const MAX_PENDING_READS = 1000
type PendingRead = { promise: Promise<unknown>; shared: boolean }
const pendingReads = new WeakMap<typeof fetch, Map<string, PendingRead>>()

// Invalidate installation credentials and access verdicts when GitHub rejects
// a token, including when several callers share the rejected request.
const rejectedTokenListeners = new Set<(token: string, fetchImpl: typeof fetch) => void>()
export function onTokenRejected(listener: (token: string, fetchImpl: typeof fetch) => void): void {
  rejectedTokenListeners.add(listener)
}
export function tokenRejected(token: string, fetchImpl: typeof fetch): void {
  for (const listener of rejectedTokenListeners) listener(token, fetchImpl)
}

export async function shareGithubRead<T>(fetchImpl: typeof fetch, request: string, read: () => Promise<T>): Promise<T> {
  let pending = pendingReads.get(fetchImpl)
  if (!pending) { pending = new Map(); pendingReads.set(fetchImpl, pending) }
  // The request includes credentials and query variables. Retain only its hash.
  const key = createHash('sha256').update(request).digest('hex')
  const held = pending.get(key)
  if (held) {
    held.shared = true
    return structuredClone(await held.promise) as T
  }
  if (pending.size >= MAX_PENDING_READS) return read()
  const entry: PendingRead = { promise: read(), shared: false }
  pending.set(key, entry)
  try {
    const value = await entry.promise
    // Independent objects for coalesced callers, without copying large trees
    // or histories when nobody joined the read.
    return (entry.shared ? structuredClone(value) : value) as T
  } finally { pending.delete(key) }
}

// GitHub's answers to GETs that came with an ETag, by the request (its URL
// and credential, hashed as outstanding reads are; an installation's token,
// which the App mints anew every few minutes on every instance, as the
// installations' one credential, GitHub telling apart which may read what):
// the next asked again If-None-Match, GitHub checking the credential as
// ever, and a 304, which it doesn't count against the rate limit, answered
// by the body kept. Each transport's own, as many as MAX_TAGGED_READS and
// MAX_TAGGED_BYTES hold, the least recently used first to go; none larger
// than MAX_TAGGED_READ_BYTES. Those one this process doesn't hold, read of
// the store kept beyond it (keepTaggedReadsIn), as a serverless instance
// starting anew holds none, as many as fit it (MAX_STORED_READ_BYTES).
const MAX_TAGGED_READS = 1000
const MAX_TAGGED_BYTES = 32 * 1024 * 1024
const MAX_TAGGED_READ_BYTES = 1024 * 1024
const MAX_STORED_READ_BYTES = 256 * 1024
export type TaggedRead = { etag: string; text: string }
const taggedReads = new WeakMap<typeof fetch, { reads: Map<string, TaggedRead>; bytes: number }>()
const taggedOf = (fetchImpl: typeof fetch) => {
  let tagged = taggedReads.get(fetchImpl)
  if (!tagged) taggedReads.set(fetchImpl, tagged = { reads: new Map(), bytes: 0 })
  return tagged
}
const requestKey = (request: string) => createHash('sha256').update(request).digest('hex')
// A GET's request as its answer is kept by: its URL and credential.
const taggedRequest = (url: string, token: string | null) => JSON.stringify([url, token?.startsWith('ghs_') ? { installation: true } : token])

// Where GitHub's tagged answers are kept beyond this process (http.ts
// registers the database's), by the request's key; its failures are none
// kept, or none written.
export interface TaggedStore { read(key: string): Promise<TaggedRead | null>; write(key: string, read: TaggedRead): Promise<void> }
let taggedStore: TaggedStore | null = null
export function keepTaggedReadsIn(store: TaggedStore | null): void { taggedStore = store }

// The answer kept to `request`, its ETag and body as GitHub wrote it: as
// this process holds it, else, where a store is kept beyond it, as that
// keeps it.
export function taggedRead(fetchImpl: typeof fetch, request: string): TaggedRead | undefined | Promise<TaggedRead | undefined> {
  const { reads } = taggedOf(fetchImpl)
  const key = requestKey(request)
  const read = reads.get(key)
  if (read) { reads.delete(key); reads.set(key, read); return read }
  return taggedStore ? storedTaggedRead(fetchImpl, key, taggedStore) : undefined
}
async function storedTaggedRead(fetchImpl: typeof fetch, key: string, store: TaggedStore) {
  const stored = await store.read(key).catch(() => null)
  if (!stored || typeof stored.etag !== 'string' || typeof stored.text !== 'string') return undefined
  holdTaggedRead(fetchImpl, key, stored)
  return stored
}

// `text` kept as GitHub's answer to `request`, by its ETag.
export async function keepTaggedRead(fetchImpl: typeof fetch, request: string, etag: string, text: string): Promise<void> {
  const key = requestKey(request)
  holdTaggedRead(fetchImpl, key, { etag, text })
  if (text.length <= MAX_STORED_READ_BYTES) await taggedStore?.write(key, { etag, text }).catch(() => {})
}
function holdTaggedRead(fetchImpl: typeof fetch, key: string, read: TaggedRead) {
  const tagged = taggedOf(fetchImpl)
  const before = tagged.reads.get(key)
  if (before) { tagged.reads.delete(key); tagged.bytes -= before.text.length }
  if (read.text.length > MAX_TAGGED_READ_BYTES) return
  tagged.reads.set(key, read)
  tagged.bytes += read.text.length
  for (const [oldest, held] of tagged.reads) {
    if (tagged.reads.size <= MAX_TAGGED_READS && tagged.bytes <= MAX_TAGGED_BYTES) break
    tagged.reads.delete(oldest)
    tagged.bytes -= held.text.length
  }
}

// One GitHub API call returning parsed JSON, optionally Bearer-authed by a
// user token, App JWT, or installation token, `body` sent as JSON (a GraphQL
// query's, given longer to answer). Network / non-2xx / malformed fold into a
// GithubApiError (401 passes through for the caller to handle). Identical GETs
// share an outstanding read through its body; one GitHub answered with an
// ETag is asked again If-None-Match, its body kept answering a 304
// (taggedRead). POSTs only opt in for read-only GraphQL
// queries (repository-history.ts), never for mutations or token mints.
export function githubJson(url: string, token: string | null, fetchImpl: typeof fetch, method: 'GET' | 'POST' = 'GET', body?: unknown,
  readOnly = method === 'GET'): Promise<unknown> {
  if (readOnly) return shareGithubRead(fetchImpl, JSON.stringify([url, token, method, body]), () => githubJson(url, token, fetchImpl, method, body, false))
  const request = method === 'GET' && body === undefined ? taggedRequest(url, token) : null
  // Each call told in its request's Server-Timing (request-timing.ts).
  return timed('gh', async () => {
    const held = request === null ? undefined : taggedRead(fetchImpl, request)
    const tagged = held instanceof Promise ? await held : held
    let res: Response
    const started = Date.now()
    try {
      res = await fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(body === undefined ? 10_000 : 20_000),
        redirect: 'error',
        headers: {
          ...(token == null ? {} : { authorization: `Bearer ${token}` }), 'accept': 'application/vnd.github+json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'user-agent': USER_AGENT, 'x-github-api-version': API_VERSION,
          ...(tagged ? { 'if-none-match': tagged.etag } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) { throw githubUnreachable(error, started) }
    if (res.status === 401 && token) tokenRejected(token, fetchImpl)
    if (res.status === 304 && tagged) return JSON.parse(tagged.text) as unknown
    if (!res.ok) await throwGithubResponseError(res)
    // The answer's body is read within the same timeout: one not read whole is
    // GitHub not reached, as one not answered is; only one that isn't JSON is
    // malformed.
    const etag = request === null ? null : res.headers?.get('etag') ?? null
    let text: string | null = null, value: unknown
    try {
      if (etag === null) return await res.json()
      text = await res.text()
      value = JSON.parse(text)
    } catch (error) {
      throw error instanceof SyntaxError ? new GithubApiError(502, 'github-malformed') : githubUnreachable(error, started)
    }
    await keepTaggedRead(fetchImpl, request!, etag, text)
    return value
  })
}
