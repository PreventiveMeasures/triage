import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Worker } from 'node:worker_threads'
import { BUNDLE_BUILD_TIMEOUT_MS, type BundleBuildLeaseStore } from './bundle-build-leases.ts'
import { type BundleBuildDiagnostic, type BundleBuildStage, bundleBuildDiagnostic } from './bundle-build-diagnostics.js'
import type { BundleBuildConditions } from './db-methods.ts'

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
  // What the stored bundle records; null for Solidity, which takes no conditions.
  conditions: BundleBuildConditions | null
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
  const scripts = selected.every(entry => /\.[cm]?[tj]sx?$/iu.test(entry))
  if (!scripts && !selected.every(entry => entry.endsWith('.sol'))) return fail('unsupported-entries')
  const parts = posix.dirname(selected[0]!).split('/').filter(part => part !== '.')
  for (const entry of selected) {
    const parent = posix.dirname(entry).split('/')
    while (parts.some((part, i) => parent[i] !== part)) parts.pop()
  }
  const options: BundleBuildInput['options'] = {}
  let recorded: BundleBuildConditions | null = null
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
    recorded = { preset: preset as BundleBuildConditions['preset'], conditions: [...new Set(names as string[])],
      platforms: options.platforms ?? [] }
  }
  return { repoId, commit, entries: selected, directory: parts.join('/'), options, conditions: recorded }
}

// A package name as a filename base: `@scope/name` as `scope-name`, or as
// `name` alone where it is `scope` or already starts with `scope-`. Null for
// a name npm could not publish by its length or leading dot.
function packageBase(name: string): string | null {
  const match = name.length <= 214 ? /^(?:@([^/.][^/]*)\/)?([^/.][^/]*)$/u.exec(name) : null
  if (!match) return null
  const base = match[2]!, scope = match[1]
  return scope === undefined || base === scope || base.startsWith(`${scope}-`) ? base : `${scope}-${base}`
}

// Same portable name and 255-character limit as Stasis's githubBundleFile
// (src/cmd/github-bundle.js), which is not a public package export, except
// that a usable `packageName` replaces both the repo and the directory.
export function githubBundleFilename(github: string, directory: string, commit: string, packageName: string | null = null): string {
  const portable = (value: string) => value.replaceAll(/[^\w.-]/gu, '_')
  const tail = `.${portable(commit.slice(0, 7))}.stasis.code.br`
  const named = packageName === null ? null : packageBase(packageName)
  if (named !== null) return `${portable(named)}${tail}`
  const repo = portable(github.replace('/', '-'))
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
  let workerUrl: URL | undefined
  let stage: BundleBuildStage = 'worker-start'
  const buildId = randomUUID(), started = performance.now()
  const context = { buildId, repoId: request.input.repoId, github: request.github, commit: request.input.commit,
    directory: request.input.directory, entryCount: request.input.entries.length, node: process.version }
  const log = (event: string, details: Record<string, unknown> = {}) => {
    const write = event === 'failed' ? console.error : console.info
    write('managed-bundle-build:', JSON.stringify({ ...context, workerUrl: workerUrl?.href, event, stage, elapsedMs: Math.round(performance.now() - started), ...details }))
  }
  try {
    workerUrl = new URL('./bundle-build-worker.js', import.meta.url)
    log('started')
    worker = new Worker(workerUrl, {
      workerData: { ...request, type: 'managed-bundle-build' }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
    })
    const running = worker
    return await new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      const fail = (status: number, code: string, details: Record<string, unknown> = {}) => {
        if (settled) return
        settled = true
        cleanup()
        log(code === 'build-cancelled' ? 'cancelled' : 'failed', { code, ...details })
        reject(new BundleBuildError(status, code))
      }
      const timer = setTimeout(() => fail(504, 'build-timeout'), BUNDLE_BUILD_TIMEOUT_MS)
      const abort = () => fail(signal.reason instanceof BundleBuildError ? signal.reason.status : 499,
        signal.reason instanceof BundleBuildError ? signal.reason.code : 'build-cancelled')
      signal.addEventListener('abort', abort, { once: true })
      running.on('message', (message: BuiltBundle & { type?: string; stage?: BundleBuildStage; error?: string; status?: number; diagnostic?: BundleBuildDiagnostic }) => {
        if (settled) return
        if (message.type === 'progress' && message.stage) { stage = message.stage; log('progress'); return }
        if (message.error) { fail(message.status ?? 422, message.error, { diagnostic: message.diagnostic }); return }
        settled = true
        cleanup()
        log('completed', { byteSize: message.bytes.length })
        resolve({ bytes: Buffer.from(message.bytes), directory: message.directory, filename: message.filename })
      })
      running.once('error', error => fail(422, 'build-failed', { diagnostic: bundleBuildDiagnostic(error, request.token) }))
      running.once('exit', exitCode => fail(422, 'build-failed', { exitCode }))
      if (signal.aborted) abort()
    })
  } catch (error) {
    if (!(error instanceof BundleBuildError)) {
      log('failed', { code: 'build-failed', diagnostic: bundleBuildDiagnostic(error, request.token) })
    }
    throw error
  } finally {
    try { await worker?.terminate() } finally { active.delete(userId) }
  }
}
