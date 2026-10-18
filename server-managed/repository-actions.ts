// A repository's GitHub Actions in a risk scan (repository-risk.ts): its
// workflows and its own actions scanned (risk scanWorkflow), and the
// references they make resolved (risk resolveAction). Of a public
// repository, a reference resolved and what GitHub answers are kept for
// every scan, as many repositories use the same few actions.
import { type ActionsSource, type ResolvedAction, type ScanOptions, type WorkflowScan, dockerfileFindings, keptSource, ownFilesOf, resolveAction,
  scanWorkflow, usesOfKey } from '../risk/index.js'
import type { OpenedRepository } from './repository-risk-read.ts'
import type { Lru } from './lru.ts'
import type { KeptStore } from './npm-kept.ts'
import { type Queue, queue } from './queue.ts'
import { RISK_KEPT_MS, type RiskFailure, failureOf } from './repository-risk-assess.ts'

export const WORKFLOWS_DIR = '.github/workflows'
// How many files of a repository's Actions are read, and how large.
const MAX_FILES = 200
const MAX_FILE_CHARS = 1024 * 1024
// How many references a scan resolves, how deep it follows what they name,
// and how many at once.
const MAX_ACTIONS = 1000
const MAX_DEPTH = 4
const RESOLVERS = 4

// A file of a repository's Actions: its text, or why it couldn't be had.
export type ActionsFile = { path: string; kind: 'workflow' | 'action' | 'dockerfile' } & ({ text: string } | RiskFailure)
export type WorkflowsRead = { files: ActionsFile[] } | RiskFailure

// What a scan tells of them: the workflows' paths, each file's scan, and
// each reference resolved, or why not.
export type WorkflowsLine = { type: 'workflows'; repo: number } & ({ paths: string[] } | RiskFailure)
export type WorkflowLine = { type: 'workflow'; repo: number; path: string; kind: ActionsFile['kind'] } & (WorkflowScan | RiskFailure)
export type ActionLine = { type: 'action' } & (ResolvedAction | { key: string } & RiskFailure)

// A reference to resolve, by the owner of the workflow naming it.
export interface ActionRef { key: string; owner: string | null; depth: number }

// What reading a repository's Actions asks of it.
export type ActionsReading = Required<Pick<OpenedRepository, 'workflows' | 'file'>>

// A file's text, or why not: one GitHub hasn't, or larger than read.
async function readFile(reading: ActionsReading, path: string): Promise<{ text: string } | RiskFailure> {
  try {
    const text = await reading.file(path)
    return text.length > MAX_FILE_CHARS ? { error: 'workflow-too-large' } : { text }
  } catch (error) { return failureOf(error) }
}

// Whether a read holds what any read of its commit would: no file that
// couldn't be had for a while, as GitHub's limits are.
export const lastingRead = (read: WorkflowsRead) => !('error' in read) && read.files.every(file => 'text' in file || file.error === 'workflow-too-large' || file.error === 'github-not-found')

// An action's directory, by its metadata's path.
const actionDir = (path: string) => path.replace(/\/?action\.ya?ml$/u, '')
const inRepository = (path: string) => !path.split('/').includes('..')
const notFound = (read: { text: string } | RiskFailure) => 'error' in read && read.error === 'github-not-found'

// A repository's workflows, the actions of its own they use in turn (`./`
// as the workspace has it, the repository checked out first) and those's
// Dockerfiles, MAX_FILES at most; why not, where they couldn't be listed.
export async function readActions(reading: ActionsReading): Promise<WorkflowsRead> {
  let listed
  try { listed = await reading.workflows() } catch (error) { return failureOf(error, 'listing its workflows') }
  const files: ActionsFile[] = await Promise.all(listed.slice(0, MAX_FILES).map(async path => ({ path, kind: 'workflow' as const, ...await readFile(reading, path) })))
  const seen = new Set<string>()
  for (let at = 0; at < files.length; at++) {
    const file = files[at]!
    if (!('text' in file) || file.kind === 'dockerfile') continue
    const { actions, dockerfile } = ownFilesOf(file.kind, file.text)
    const path = dockerfile && [actionDir(file.path), dockerfile].filter(Boolean).join('/')
    if (path && inRepository(path) && files.length < MAX_FILES) files.push({ path, kind: 'dockerfile', ...await readFile(reading, path) })
    for (const dir of actions) {
      if (files.length >= MAX_FILES || seen.has(dir) || !inRepository(dir) || !seen.add(dir)) continue
      const named = dir === '' ? 'action' : `${dir}/action`, yml = await readFile(reading, `${named}.yml`)
      const yaml = notFound(yml) ? await readFile(reading, `${named}.yaml`) : null
      files.push(yaml && !notFound(yaml) ? { path: `${named}.yaml`, kind: 'action', ...yaml } : { path: `${named}.yml`, kind: 'action', ...yml })
    }
  }
  return { files }
}

// A lockfile's packages, by name and by `name@version`, and those only
// devDependencies need.
export function lockedNames(path: string, packages: readonly { name: string; version: string | null; dev?: true }[]) {
  const dev = new Map<string, boolean>()
  for (const { name, version, dev: only } of packages) for (const key of version ? [name, `${name}@${version}`] : [name]) dev.set(key, (dev.get(key) ?? true) && only === true)
  return { path, names: new Set(dev.keys()), dev: new Set([...dev].flatMap(([name, only]) => only ? [name] : [])) }
}

// The lines a repository's Actions read are told by, and the references
// they make to resolve. `lockfiles`, its lockfiles' packages' names by path.
export function actionsLines(repo: number, owner: string, read: WorkflowsRead, lockfiles: NonNullable<ScanOptions['lockfiles']>) {
  if ('error' in read) return { lines: [{ type: 'workflows', repo, ...read } as WorkflowsLine], refs: [] as ActionRef[] }
  const lines: (WorkflowsLine | WorkflowLine)[] = [{ type: 'workflows', repo, paths: read.files.filter(file => file.kind === 'workflow').map(file => file.path) }]
  const refs = new Map<string, ActionRef>()
  // Its own actions by their directories and workflows by their paths, as a step or a job uses one.
  const actions = new Map(read.files.flatMap(file => file.kind !== 'dockerfile' && 'text' in file ? [[file.kind === 'action' ? actionDir(file.path) : file.path, file.text] as const] : []))
  for (const file of read.files) {
    const scan = 'error' in file ? file : file.kind === 'dockerfile' ? { uses: [], findings: dockerfileFindings(file.text) } : scanWorkflow(file.kind, file.text, { owner, lockfiles, actions })
    lines.push({ type: 'workflow', repo, path: file.path, kind: file.kind, ...scan })
    if ('uses' in scan) for (const uses of scan.uses) if (uses.kind === 'action' || uses.kind === 'workflow') refs.set(uses.key!, { key: uses.key!, owner, depth: 0 })
  }
  return { lines, refs: [...refs.values()] }
}

export type ActionAnswers = Lru<{ at: number; answer: unknown }>
// An answer's weight: an entry of a list, a kilobyte of a file.
export const answerWeight = ({ answer }: { at: number; answer: unknown }) => Array.isArray(answer) ? answer.length + 1
  : typeof answer === 'string' ? Math.ceil(answer.length / 1024) + 1 : ((answer as { branches?: unknown[] } | null)?.branches?.length ?? 0) + 1

const isCommit = (text: string) => /^[\da-f]{40}$/u.test(text)

// `source`, what it answers of a public repository kept for every scan, the
// same whoever asks: of a commit while kept (but none, as one can be pushed
// later), the rest for RISK_KEPT_MS. A private one's, or one missing, never.
export function sharedSource(source: ActionsSource, answers: ActionAnswers): ActionsSource {
  const keyOf = (what: string, name: string, ...more: string[]) => [what, name.toLowerCase(), ...more].join('\0')
  const kept = (key: string, lasting = false) => {
    const at = answers.get(key)
    return at && ((lasting && at.answer !== null) || Date.now() - at.at < RISK_KEPT_MS) ? at : undefined
  }
  async function shared<T>(name: string, key: string, lasting: boolean, ask: () => Promise<T>): Promise<T> {
    if (!kept(keyOf('repo', name))) return ask()
    const at = kept(key, lasting)
    if (at) return at.answer as T
    const answer = await ask()
    answers.set(key, { at: Date.now(), answer })
    return answer
  }
  return {
    async repo(name) {
      const at = kept(keyOf('repo', name))
      if (at) return at.answer as Awaited<ReturnType<ActionsSource['repo']>>
      const info = await source.repo(name)
      if (info?.private === false) for (const each of [name, info.fullName]) answers.set(keyOf('repo', each), { at: Date.now(), answer: info })
      return info
    },
    tags: name => shared(name, keyOf('tags', name), false, () => source.tags(name)),
    tag: (name, tag) => shared(name, keyOf('tag', name, tag), false, () => source.tag(name, tag)),
    branch: (name, branch) => shared(name, keyOf('branch', name, branch), false, () => source.branch(name, branch)),
    branches: name => shared(name, keyOf('branches', name), false, () => source.branches(name)),
    contains: (name, base, sha) => shared(name, keyOf('contains', name, base, sha), isCommit(base), () => source.contains(name, base, sha)),
    file: (name, path, commit) => shared(name, keyOf('file', name, path, commit), isCommit(commit), () => source.file(name, path, commit)),
  }
}

export interface ActionsResolving {
  source: ActionsSource
  signal: AbortSignal
  tell(line: ActionLine): void
  memory: Lru<{ at: number; line: ActionLine }>
  answers: ActionAnswers
  store?: KeptStore<ActionLine> | undefined
}

// A reference's line: kept, else resolved, and kept where it is a public
// repository's; why not, where it couldn't be.
async function resolved(resolving: ActionsResolving, source: ActionsSource, { key, owner }: ActionRef): Promise<ActionLine | null> {
  const kept = resolving.memory.get(key) ?? await resolving.store?.read(key).then(row => row && { at: row.at, line: row.value })
  if (kept && Date.now() - kept.at < RISK_KEPT_MS) { resolving.memory.set(key, kept); return kept.line }
  const uses = usesOfKey(key)
  if (!uses) return { type: 'action', key, error: 'invalid-uses' }
  let found: ResolvedAction
  try { found = await resolveAction(uses, source, { owner }) } catch (error) { return resolving.signal.aborted ? null : { type: 'action', key, ...failureOf(error) } }
  const line: ActionLine = { type: 'action', ...found }
  if (found.repository?.private === false) {
    const at = Date.now()
    resolving.memory.set(key, { at, line })
    await resolving.store?.write(key, line, at)
  }
  return line
}

// Whether a reference is named by a workflow of its repository's owner.
const ownOwners = ({ key, owner }: ActionRef) => key.split('/')[0] === owner?.toLowerCase()

// Resolves the references added, and those they name in turn, each once a
// scan, RESOLVERS at once, each told as it is; once more where another
// owner's workflow names one its own owner's did, as a repository missing is
// red then, or one is met nearer, its own followed as far as they then go. `close` settles once all are told, or the scan stops.
export function resolvingActions(resolving: ActionsResolving) {
  const source = keptSource(sharedSource(resolving.source, resolving.answers))
  const pending: Queue<ActionRef> = queue(resolving.signal)
  const latest = new Map<string, ActionRef>()
  let closed = false, waiting = 0
  const settle = () => { if (closed && waiting === 0) pending.close() }
  const add = (refs: ActionRef[]) => {
    for (const ref of refs) {
      const first = latest.get(ref.key)
      if (ref.depth > MAX_DEPTH || (first ? (!ownOwners(first) || ownOwners(ref)) && first.depth <= ref.depth : latest.size >= MAX_ACTIONS)) continue
      const kept = first ? { ...ref, owner: ownOwners(first) ? ref.owner : first.owner, depth: Math.min(ref.depth, first.depth) } : ref
      latest.set(ref.key, kept)
      waiting++
      pending.add(kept)
    }
  }
  const work = async () => {
    for (let ref = await pending.take(); ref !== undefined; ref = await pending.take()) {
      try {
        const line = await resolved(resolving, source, ref)
        if (line && latest.get(ref.key) === ref) {
          resolving.tell(line)
          const owner = 'repository' in line ? (line.repository?.fullName ?? line.repo).split('/')[0]! : ref.owner
          if ('uses' in line) add(line.uses.map(key => ({ key, owner, depth: ref.depth + 1 })))
        }
      } finally { waiting--; settle() }
    }
  }
  const workers = Array.from({ length: RESOLVERS }, work)
  return { add, async close() { closed = true; settle(); await Promise.all(workers) } }
}
