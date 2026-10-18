import { createHash } from 'node:crypto'

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
