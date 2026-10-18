// A repository's GitHub Actions in a repository risk scan (repository-risk.ts):
// its workflows and the actions of its own they use, each scanned (risk
// scanWorkflow), and the references they make resolved (risk resolveAction),
// MAX_DEPTH deep and MAX_ACTIONS in all, a public repository's kept for
// RISK_KEPT_MS by its key: a private one's is the admin's own access's alone.
import { YamlError } from '@preventive/lockfile/yaml.js'
import { type ActionsSource, type ResolvedAction, type ScanOptions, type WorkflowScan, actionInstalls, keptSource, readWorkflow, resolveAction,
  scanWorkflow, usesOfKey, workflowUses } from '../risk/index.js'
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

// A file of a repository's Actions read: a workflow, or an action of its
// own, its text or why it couldn't be had.
export type ActionsFile = { path: string; kind: 'workflow' | 'action' } & ({ text: string } | RiskFailure)
export type WorkflowsRead = { files: ActionsFile[] } | RiskFailure

// What a scan tells of them: a repository's workflows' paths, each file's
// findings and references, or why not, and each reference resolved, or why
// not, by its key and the owner of the workflow that named it first.
export type WorkflowsLine = { type: 'workflows'; repo: number } & ({ paths: string[] } | RiskFailure)
export type WorkflowLine = { type: 'workflow'; repo: number; path: string; kind: 'workflow' | 'action' } & (WorkflowScan | RiskFailure)
export type ActionLine = { type: 'action' } & (ResolvedAction | { key: string } & RiskFailure)

// A reference to resolve: its key, the owner of the workflow naming it, and
// how deep it is named.
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

// The actions of the repository's own a file uses, by the directory each is
// in: `./path` as the workspace has it, which is the repository where it
// was checked out first, and `$/path`.
function ownActions(text: string, kind: 'workflow' | 'action') {
  try {
    return workflowUses(readWorkflow(kind, text)).flatMap(uses => uses.kind === 'local' && !/\.ya?ml$/iu.test(uses.path) && !uses.path.split('/').includes('..') ? [uses.path] : [])
  } catch (error) {
    if (error instanceof YamlError) return []
    throw error
  }
}

// A repository's workflows and the actions of its own they use, in turn,
// MAX_FILES at most; why not, where they couldn't be listed.
export async function readActions(reading: ActionsReading): Promise<WorkflowsRead> {
  let listed
  try { listed = await reading.workflows() } catch (error) { return failureOf(error, 'listing its workflows') }
  const files: ActionsFile[] = []
  for (const path of listed.slice(0, MAX_FILES)) files.push({ path, kind: 'workflow', ...await readFile(reading, path) })
  const dirs = new Set<string>()
  for (let at = 0; at < files.length && files.length < MAX_FILES; at++) {
    const file = files[at]!
    for (const dir of 'text' in file ? ownActions(file.text, file.kind) : []) {
      if (dirs.has(dir)) continue
      dirs.add(dir)
      const named = dir === '' ? 'action' : `${dir}/action`
      let path = `${named}.yml`, read = await readFile(reading, path)
      if ('error' in read && read.error === 'github-not-found') {
        const yaml = await readFile(reading, `${named}.yaml`)
        if (!('error' in yaml && yaml.error === 'github-not-found')) { path = `${named}.yaml`; read = yaml }
      }
      files.push({ path, kind: 'action', ...read })
    }
  }
  return { files }
}

// The lines a repository's Actions read are told by, and the references
// they make to resolve. `lockfiles`, its lockfiles' packages' names by path.
export function actionsLines(repo: number, owner: string, read: WorkflowsRead, lockfiles: NonNullable<ScanOptions['lockfiles']>) {
  if ('error' in read) return { lines: [{ type: 'workflows', repo, ...read } as WorkflowsLine], refs: [] as ActionRef[] }
  const lines: (WorkflowsLine | WorkflowLine)[] = [{ type: 'workflows', repo, paths: read.files.filter(file => file.kind === 'workflow').map(file => file.path) }]
  const refs = new Map<string, ActionRef>()
  // The directories of its own actions that install its packages.
  const installers = new Set(read.files.flatMap(file => file.kind === 'action' && 'text' in file && actionInstalls(file.text) ? [file.path.replace(/\/?action\.ya?ml$/u, '')] : []))
  for (const file of read.files) {
    if (!('text' in file)) { lines.push({ type: 'workflow', repo, ...file }); continue }
    const at = { type: 'workflow', repo, path: file.path, kind: file.kind } as const
    try {
      const scan = scanWorkflow(file.kind, file.text, { owner, lockfiles, installers })
      lines.push({ ...at, ...scan })
      for (const uses of scan.uses) if (uses.kind === 'action' || uses.kind === 'workflow') refs.set(uses.key!, { key: uses.key!, owner, depth: 0 })
    } catch (error) {
      if (!(error instanceof YamlError)) throw error
      lines.push({ ...at, error: 'workflow-unreadable', detail: error.message.slice(0, 500) })
    }
  }
  return { lines, refs: [...refs.values()] }
}

export interface ActionsResolving {
  source: ActionsSource
  signal: AbortSignal
  tell(line: ActionLine): void
  memory: Lru<{ at: number; line: ActionLine }>
  store?: KeptStore<ActionLine> | undefined
}

// A reference's line: kept, within RISK_KEPT_MS, else resolved, and kept
// where it is a public repository's, as it is then the same whoever named
// it; why not, where it couldn't be.
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

// Resolves the references added (`add`), each once a scan, RESOLVERS at once,
// each told as it is, and those it names in turn, `source`'s answers kept
// for the scan; once more where another owner's workflow names one its own
// owner's did, as a repository missing is red then (risk resolve.js), its
// line the one told. `close` settles once all are told, or the scan stops.
export function resolvingActions(resolving: ActionsResolving) {
  const source = keptSource(resolving.source)
  const pending: Queue<ActionRef> = queue(resolving.signal)
  const latest = new Map<string, ActionRef>()
  let closed = false, waiting = 0
  const settle = () => { if (closed && waiting === 0) pending.close() }
  const add = (refs: ActionRef[]) => {
    for (const ref of refs) {
      const first = latest.get(ref.key)
      if (ref.depth > MAX_DEPTH || (first ? !ownOwners(first) || ownOwners(ref) : latest.size >= MAX_ACTIONS)) continue
      latest.set(ref.key, ref)
      waiting++
      pending.add(ref)
    }
  }
  const work = async () => {
    for (let ref = await pending.take(); ref !== undefined; ref = await pending.take()) {
      try {
        const line = await resolved(resolving, source, ref)
        if (line && latest.get(ref.key) === ref) {
          resolving.tell(line)
          const owner = 'repository' in line ? (line.repository?.fullName ?? line.repo).split('/')[0]! : ref.owner
          if ('uses' in line) add(line.uses.map(({ key }) => ({ key, owner, depth: ref.depth + 1 })))
        }
      } finally { waiting--; settle() }
    }
  }
  const workers = Array.from({ length: RESOLVERS }, work)
  return { add, async close() { closed = true; settle(); await Promise.all(workers) } }
}
