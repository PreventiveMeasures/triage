import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Worker } from 'node:worker_threads'
import { BUNDLE_BUILD_TIMEOUT_MS, type BundleBuildLeaseStore } from './bundle-build-leases.ts'

export class BundleBuildError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code }
}

export interface BundleBuildInput {
  repoId: number
  commit: string
  entries: string[]
  directory: string
  options: { conditions?: string[]; mainFields?: string[]; metro?: boolean; platforms?: string[]; typescript?: boolean; jsx?: boolean }
}

function path(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\p{Cc}]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

export function parseBundleBuild(value: unknown): BundleBuildInput {
  const fail = (code = 'bad-request'): never => { throw new BundleBuildError(400, code) }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return fail()
  const { repoId, commit, entries, conditions } = value as Record<string, unknown>
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || repoId <= 0
    || typeof commit !== 'string' || !/^[a-f\d]{40}$/u.test(commit)
    || !Array.isArray(entries) || entries.length === 0 || entries.length > 100 || !entries.every(path)) return fail()
  const selected = [...new Set(entries as string[])]
  const scripts = selected.every(entry => /\.[mc]?[jt]s$/u.test(entry))
  if (!scripts && !selected.every(entry => entry.endsWith('.sol'))) return fail('unsupported-entries')
  const parts = posix.dirname(selected[0]!).split('/').filter(part => part !== '.')
  for (const entry of selected) {
    const parent = posix.dirname(entry).split('/')
    while (parts.some((part, i) => parent[i] !== part)) parts.pop()
  }
  const options: BundleBuildInput['options'] = {}
  if (scripts) {
    if (conditions == null || typeof conditions !== 'object' || Array.isArray(conditions)) return fail('bad-conditions')
    const { preset, conditions: names, platforms } = conditions as Record<string, unknown>
    if (!['node', 'browser', 'metro'].includes(String(preset)) || !Array.isArray(names) || names.length > 16
      || !names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 64
        && !/^\.|^\d+$|[\s,/\\\p{Cc}]/u.test(name) && !['default', 'import', 'require'].includes(name))) return fail('bad-conditions')
    if (preset === 'metro') {
      if (names.length !== 1 || names[0] !== 'react-native') return fail('metro-conditions')
      if (!Array.isArray(platforms) || platforms.length === 0 || platforms.length > 2
        || !platforms.every(platform => ['ios', 'android'].includes(platform))) return fail('bad-conditions')
      Object.assign(options, { metro: true, platforms: [...new Set(platforms)] })
    } else {
      options.conditions = [...new Set(names)]
      if (preset === 'browser') options.mainFields = ['browser', 'module', 'main']
    }
    options.typescript = true
    options.jsx = true
  }
  return { repoId, commit, entries: selected, directory: parts.join('/'), options }
}

// Same portable name and 255-character limit as Stasis's githubBundleFile
// (src/cmd/github-bundle.js), which is not a public package export.
export function githubBundleFilename(github: string, directory: string, commit: string): string {
  const portable = (value: string) => value.replaceAll(/[^\w.-]/gu, '_')
  const repo = portable(github.replace('/', '-'))
  const tail = `.${portable(commit.slice(0, 7))}.stasis.code.br`
  if (!directory) return `${repo}${tail}`
  const room = 255 - `${repo}.${tail}`.length
  let dir = portable(directory.replaceAll('/', '-'))
  if (dir.length > room) dir = `${dir.slice(0, room - 9)}_${createHash('sha256').update(directory).digest('hex').slice(0, 8)}`
  return `${repo}.${dir}${tail}`
}

export interface BuiltBundle { bytes: Uint8Array; directory: string; filename: string }
export interface BuildRequest { input: BundleBuildInput; github: string; token: string | null; maxBytes: number; scopes: (string | null)[] }
// An extra per-process ceiling; admission must also hold the shared DB lease.
const active = new Set<string>()

export async function withBundleBuildLease<T>(db: BundleBuildLeaseStore, userId: string, signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const owner = randomUUID(), started = performance.now(), timeout = new AbortController()
  const expired = () => timeout.abort(new BundleBuildError(504, 'build-timeout'))
  const timer = setTimeout(expired, BUNDLE_BUILD_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout.signal])
  let claimed = false
  try {
    claimed = await db.claimBundleBuildLease(userId, owner)
    if (!claimed) throw new BundleBuildError(429, 'build-busy')
    // Account for a slow/lost claim response or a suspended invocation before
    // starting work. The three-minute budget starts before lease acquisition.
    if (performance.now() - started >= BUNDLE_BUILD_TIMEOUT_MS) expired()
    combined.throwIfAborted()
    return await work(combined)
  } catch (error) {
    if (timeout.signal.aborted && !signal.aborted) throw timeout.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    // buildRepositoryBundle waits for worker termination before settling.
    // Unknown claim/release outcomes expire safely without starting more work.
    if (claimed) await db.releaseBundleBuildLease(owner)
  }
}

// Parsing repositories and compressing bundles stays off the HTTP event loop.
// Cap concurrent builds, terminate disconnected/timed-out work, and share no
// credentials or mutable Stasis state between requests.
export async function buildRepositoryBundle(userId: string, request: BuildRequest, signal: AbortSignal): Promise<BuiltBundle> {
  if (active.has(userId) || active.size >= 2) throw new BundleBuildError(429, 'build-busy')
  signal.throwIfAborted()
  active.add(userId)
  let worker: Worker | undefined
  try {
    worker = new Worker(new URL('./bundle-build-worker.js', import.meta.url), {
      workerData: { ...request, type: 'managed-bundle-build' }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
    })
    const running = worker
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BundleBuildError(504, 'build-timeout')), BUNDLE_BUILD_TIMEOUT_MS)
      const abort = () => reject(new BundleBuildError(499, 'build-cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      running.once('message', (message: BuiltBundle & { error?: string; status?: number }) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (message.error) reject(new BundleBuildError(message.status ?? 422, message.error))
        else resolve({ ...message, bytes: Buffer.from(message.bytes) })
      })
      running.once('error', () => reject(new BundleBuildError(422, 'build-failed')))
      running.once('exit', () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(new BundleBuildError(422, 'build-failed'))
      })
    })
  } finally {
    try { await worker?.terminate() } finally { active.delete(userId) }
  }
}
