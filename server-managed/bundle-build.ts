import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir, totalmem } from 'node:os'
import { join, posix } from 'node:path'
import { Worker } from 'node:worker_threads'
import { BUNDLE_BUILD_TIMEOUT_MS, type BundleBuildLeaseStore } from './bundle-build-leases.ts'
import { type BundleBuildDiagnostic, type BundleBuildStage, bundleBuildDiagnostic } from './bundle-build-diagnostics.js'
import type { BundleBuildConditions } from './db-methods.ts'

export class BundleBuildError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code }
}

interface BundleBuildInput {
  repoId: number
  commit: string
  entries: string[]
  directory: string
  options: { conditions?: string[]; mainFields?: string[]; metro?: boolean; platforms?: string[]; jsx?: boolean; packageManager?: 'soldeer' }
  // What the stored bundle records; null for Solidity, which takes no
  // conditions, and for entries given none, which stasis.config.json must
  // then list (the build checks: bundle-build-worker.js).
  conditions: BundleBuildConditions | null
  // The branch the commit was picked by, where it was: Stasis asks it first
  // when it holds the commit to the repo's own history, which GitHub's compare
  // tells of it, so nothing is taken on trust (one the commit isn't of is
  // looked past). Without it, Stasis lists the repo's tags and branches and
  // compares up to 100 of those.
  branch?: string
}

// A name git takes for a branch (git check-ref-format --branch), at most
// GitHub's length for one.
export function branchName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\p{Cc}\s~^:?*[\\]|\.\.|@\{|\/\/|^-|^\/|\/$|\.$|^@$|(?:^|\/)\.|\.lock(?:\/|$)/u.test(value)
}

function path(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\p{Cc}]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

const isScript = (entry: string) => /\.[cm]?[tj]sx?$/iu.test(entry)

// Whether a build takes `value` as an entry point, with others in its language.
export function buildableEntry(value: unknown): value is string {
  return path(value) && (isScript(value) || value.endsWith('.sol'))
}

export function parseBundleBuild(value: unknown): BundleBuildInput {
  const fail = (code = 'bad-request'): never => { throw new BundleBuildError(400, code) }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return fail()
  const { repoId, commit, entries, conditions, branch } = value as Record<string, unknown>
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || repoId <= 0
    || typeof commit !== 'string' || !/^[a-f\d]{40}$/u.test(commit)
    || !Array.isArray(entries) || entries.length === 0 || entries.length > 100 || !entries.every(path)
    || (branch != null && !branchName(branch))) return fail()
  const selected = [...new Set(entries as string[])]
  const scripts = selected.every(isScript)
  if (!scripts && !selected.every(entry => entry.endsWith('.sol'))) return fail('unsupported-entries')
  const parts = posix.dirname(selected[0]!).split('/').filter(part => part !== '.')
  for (const entry of selected) {
    const parent = posix.dirname(entry).split('/')
    while (parts.some((part, i) => parent[i] !== part)) parts.pop()
  }
  // Stasis builds Solidity with Soldeer alone. Named, a JS lockfile beside or
  // above the project no longer leaves it unable to tell which one installs it.
  const options: BundleBuildInput['options'] = scripts ? {} : { packageManager: 'soldeer' }
  let recorded: BundleBuildConditions | null = null
  if (scripts && conditions != null) {
    if (typeof conditions !== 'object' || Array.isArray(conditions)) return fail('bad-conditions')
    const { preset, conditions: names, platforms } = conditions as Record<string, unknown>
    if (typeof preset !== 'string' || !['node', 'browser', 'metro'].includes(preset) || !Array.isArray(names) || names.length > 16
      || !names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 64
        && !/^\.|^\d+$|[\s,/\\\p{Cc}]/u.test(name) && !['default', 'import', 'require'].includes(name))) return fail('bad-conditions')
    if (preset === 'metro') {
      if (names.length !== 1 || names[0] !== 'react-native') return fail('metro-conditions')
      if (!Array.isArray(platforms) || platforms.length === 0 || platforms.length > 2
        || !platforms.every(platform => ['ios', 'android'].includes(platform))) return fail('bad-conditions')
      // React Native's convention puts JSX in .js files, which Stasis parses as
      // JSX only on request. TypeScript is left to Stasis to detect.
      Object.assign(options, { metro: true, platforms: [...new Set(platforms)], jsx: true })
    } else {
      options.conditions = [...new Set(names)]
      if (preset === 'browser') options.mainFields = ['browser', 'module', 'main']
    }
    recorded = { preset: preset as BundleBuildConditions['preset'], conditions: [...new Set(names as string[])],
      platforms: options.platforms ?? [] }
  }
  return { repoId, commit, entries: selected, directory: parts.join('/'), options, conditions: recorded, ...(branchName(branch) && { branch }) }
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

interface BuiltBundle { bytes: Buffer; directory: string; filename: string }
interface BuildRequest {
  input: BundleBuildInput; github: string; token: string | null; maxBytes: number; scopes: (string | null)[]
  // Upstream's disk cache for what a build fetches (setCacheDir), or null for
  // none, as on Vercel. Resolved here: the worker's env holds NPM_TOKEN and
  // VERCEL_ENV alone.
  cacheDir: string | null
}
// A version a Stasis lockfile holds, as the worker tells it in place of a
// bundle (bundle-build-worker.js buildStasisLockfile); and what it is asked
// to build one of, with the `branch` the commit is of, where its asker knows
// it, as a bundle's is (BundleBuildInput).
export interface StasisDependency { name: string; version: string; integrity?: string; patch?: string }
export interface LockfileInput { repoId: number; commit: string; config: string; branch?: string }
interface LockfileRequest { input: LockfileInput; github: string; token: string | null; cacheDir: string | null }
// An extra per-process ceiling, one build at a time, its worker given the heap
// buildHeapLimitMib sizes; admission must also hold the shared DB lease.
const active = new Set<string>()
const MAX_ACTIVE_BUILDS = 1
// The build running behind no request (buildRepositoryLockfile), which one
// asked for takes the slot and the lease of: told to yield
// (`build-yielded`), and gone once its lease is released.
let behind: { yield: () => void; gone: Promise<void> } | null = null
// Who builds behind no request, as `active` and the shared lease name it.
const LOCKFILE_BUILDER = 'dependency-review'
// Where builds keep what they download of npm for those after them in this
// instance, where no cache directory is set, as on Vercel
// (bundle-build-worker.js instanceCache).
const INSTANCE_DIR = join(tmpdir(), 'triage-stasis-cache')
async function yielded(): Promise<void> {
  const running = behind
  if (!running) return
  running.yield()
  await running.gone
}

// What a build's worker may take of the JS heap, in MiB: the memory the
// process may use, its container's limit else the machine's, less
// RESERVED_MIB, at least the 512 MiB a build always had. A large project's
// tree, as a React Native app's, laid out and scanned in memory, takes more
// than 2 GiB, as `stasis github-bundle` takes what Node's default heap gives
// it. What is reserved is the server's, and the worker's own beyond its heap:
// the bytes of the files it lays out, its bundle's JSON (512 MiB at most, the
// worker's MAX_SERIALIZED_BYTES) and that compressed. Past it, Node
// terminates the worker (build-memory), not the process.
const RESERVED_MIB = 512
const MIN_BUILD_HEAP_MIB = 512
const processMemory = () => Math.min(process.constrainedMemory() || Infinity, totalmem())
export function buildHeapLimitMib(memory = processMemory()): number {
  return Math.max(MIN_BUILD_HEAP_MIB, Math.floor(memory / 1024 ** 2) - RESERVED_MIB)
}

// `work` under one of the deployment's leases, `userId`'s one at a time. One
// asked for first has this instance's build behind no request yield, and
// waits for its lease to be released, lest that hold a lease against it.
export async function withBundleBuildLease<T>(db: BundleBuildLeaseStore, userId: string, signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const owner = randomUUID(), started = performance.now(), timeout = new AbortController()
  const expired = () => timeout.abort(new BundleBuildError(504, 'build-timeout'))
  const timer = setTimeout(expired, BUNDLE_BUILD_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout.signal])
  let claimed = false
  try {
    if (userId !== LOCKFILE_BUILDER && behind) await yielded()
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
export function buildRepositoryBundle(userId: string, request: BuildRequest, signal: AbortSignal): Promise<BuiltBundle> {
  const context = { repoId: request.input.repoId, github: request.github, commit: request.input.commit, directory: request.input.directory, entryCount: request.input.entries.length }
  const asked = { ...request, instanceDir: INSTANCE_DIR }
  return runBuild<BuiltBundle & { bytes: Uint8Array }, BuiltBundle>(userId, asked, context, signal, message => {
    // A view of the bytes the worker handed over, not a copy of them.
    const { bytes } = message
    return { value: { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), directory: message.directory, filename: message.filename }, logged: { byteSize: bytes.length } }
  })
}

// A Stasis lockfile's dependencies in place of a bundle, for a repository's
// dependency review (stasis-dependencies.ts), built behind no request, under
// the deployment's lease as its one builder of them: in the same one slot,
// which it gives up to a build asked for, with its lease (`build-yielded`),
// and is refused while another holds (`build-busy`), to be built later.
export async function buildRepositoryLockfile(db: BundleBuildLeaseStore, request: LockfileRequest, signal: AbortSignal): Promise<StasisDependency[]> {
  if (behind || active.size >= MAX_ACTIVE_BUILDS) throw new BundleBuildError(429, 'build-busy')
  const context = { repoId: request.input.repoId, github: request.github, commit: request.input.commit, config: request.input.config, branch: request.input.branch, lockfileOnly: true }
  const asked = { ...request, instanceDir: INSTANCE_DIR, lockfileOnly: true }
  const yielding = new AbortController()
  let gone = () => {}
  behind = { yield: () => yielding.abort(new BundleBuildError(429, 'build-yielded')), gone: new Promise(resolve => { gone = resolve }) }
  try {
    return await withBundleBuildLease(db, LOCKFILE_BUILDER, AbortSignal.any([signal, yielding.signal]), leased => runBuild<{ dependencies: StasisDependency[] }, StasisDependency[]>(
      LOCKFILE_BUILDER, asked, context, leased, ({ dependencies }) => ({ value: dependencies, logged: { dependencies: dependencies.length } }), true))
  } finally {
    behind = null
    gone()
  }
}

// What a build's worker told last, by its type: its progress, memory or a
// note, its failure, else what it built.
type WorkerMessage<M> = M & { type?: string; stage?: BundleBuildStage; error?: string; status?: number; diagnostic?: BundleBuildDiagnostic
  memory?: Record<string, number>; event?: string; details?: Record<string, unknown> }

// `request` built in a worker of its own, `owner`'s one build at a time, what
// it built told by `built` of its last message, with what its log keeps of
// it; `background`, behind no request.
async function runBuild<M, T>(owner: string, request: { token: string | null }, about: Record<string, unknown>, signal: AbortSignal,
  built: (message: M) => { value: T; logged: Record<string, unknown> }, background = false): Promise<T> {
  const { token } = request
  // One asked for takes the slot of one running behind no request, where its lease didn't already.
  if (!background && behind) await yielded()
  if (active.has(owner) || active.size >= MAX_ACTIVE_BUILDS) throw new BundleBuildError(429, 'build-busy')
  signal.throwIfAborted()
  active.add(owner)
  let worker: Worker | undefined
  let workerUrl: URL | undefined
  let stage: BundleBuildStage = 'worker-start'
  const buildId = randomUUID(), started = performance.now()
  const heapLimitMib = buildHeapLimitMib()
  // How this Node was built, as it decides what a heap holds the same objects in.
  const { v8_enable_pointer_compression: pointerCompression, v8_enable_sandbox: v8Sandbox } = process.config.variables as Record<string, unknown>
  const context = { buildId, ...about, node: process.version, v8: process.versions.v8, pointerCompression, v8Sandbox,
    memoryMib: Math.round(processMemory() / 1024 ** 2), heapLimitMib }
  const log = (event: string, details: Record<string, unknown> = {}) => {
    const write = event === 'failed' ? console.error : console.info
    write('managed-bundle-build:', JSON.stringify({ ...context, workerUrl: workerUrl?.href, event, stage, elapsedMs: Math.round(performance.now() - started), ...details }))
  }
  try {
    workerUrl = new URL('./bundle-build-worker.js', import.meta.url)
    log('started')
    // Upstream reads NPM_TOKEN from the env for scoped packages, which npm
    // answers with 404 when private and asked without it. Stasis reads
    // VERCEL_ENV, set or not as here, to parse without oxc-parser's raw
    // transfer on Vercel, whose functions can't reserve its 6 GiB buffer.
    // Nothing else passes.
    const npmToken = process.env['NPM_TOKEN'], vercelEnv = process.env['VERCEL_ENV']
    const env = { ...(npmToken ? { NPM_TOKEN: npmToken } : {}), ...(vercelEnv === undefined ? {} : { VERCEL_ENV: vercelEnv }) }
    worker = new Worker(workerUrl, {
      workerData: { ...request, type: 'managed-bundle-build' }, env, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: heapLimitMib },
    })
    const running = worker
    return await new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      const fail = (status: number, code: string, details: Record<string, unknown> = {}) => {
        if (settled) return
        settled = true
        cleanup()
        log(code === 'build-cancelled' || code === 'build-yielded' ? 'cancelled' : 'failed', { code, ...details })
        reject(new BundleBuildError(status, code))
      }
      const timer = setTimeout(() => fail(504, 'build-timeout'), BUNDLE_BUILD_TIMEOUT_MS)
      const abort = () => signal.reason instanceof BundleBuildError ? fail(signal.reason.status, signal.reason.code) : fail(499, 'build-cancelled')
      signal.addEventListener('abort', abort, { once: true })
      // The worker's memory and notes are the log's alone: the response tells
      // what it built, or the error's code, and nothing of them.
      running.on('message', (message: WorkerMessage<M>) => {
        if (settled) return
        if (message.type === 'progress' && message.stage) { stage = message.stage; log('progress', { memory: message.memory }); return }
        if (message.type === 'memory') { log('memory', { memory: message.memory }); return }
        if (message.type === 'note' && typeof message.event === 'string') { log(message.event, message.details ?? {}); return }
        if (message.error) { fail(message.status ?? 422, message.error, { diagnostic: message.diagnostic, memory: message.memory }); return }
        settled = true
        cleanup()
        const { value, logged } = built(message)
        log('completed', logged)
        resolve(value)
      })
      // Past its heap (heapLimitMib), Node terminates the worker with ERR_WORKER_OUT_OF_MEMORY.
      running.once('error', error => {
        const outOfMemory = (error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY'
        fail(outOfMemory ? 413 : 422, outOfMemory ? 'build-memory' : 'build-failed', { diagnostic: bundleBuildDiagnostic(error, token) })
      })
      running.once('exit', exitCode => fail(422, 'build-failed', { exitCode }))
      if (signal.aborted) abort()
    })
  } catch (error) {
    if (!(error instanceof BundleBuildError)) {
      log('failed', { code: 'build-failed', diagnostic: bundleBuildDiagnostic(error, token) })
    }
    throw error
  } finally {
    try { await worker?.terminate() } finally { active.delete(owner) }
  }
}
