// A repository's GitHub Actions, as a repository risk scan reads them
// (repository-risk.ts): its workflows (.github/workflows/*.yml and .yaml) at
// the commit read, and the actions of its own they use (`./path`,
// `$/path`), each read for what it calls for by its own text (risk
// scanWorkflow), npx held to its lockfiles' packages; and each action and
// reusable workflow of another repository they name, resolved once a scan
// (risk resolveAction), what it names in turn too, MAX_DEPTH deep and
// MAX_ACTIONS in all. A repository's files are kept by the commit they were
// read at (repository-risk-read.ts), where none failed for a while
// (lastingRead); a reference of a public repository resolved, by its key,
// in the instance's memory and the source's `actions` for RISK_KEPT_MS: one
// of a private repository is resolved with the admin's own access, and what
// it tells is for them alone.
import { ActionsScanError, type ActionsSource, type ResolvedAction, type ScanOptions, type WorkflowScan, keptSource, resolveAction, scanWorkflow,
  usesOfKey } from '../risk/index.js'
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

// What reading a repository's Actions asks of it: its workflows' paths, and
// a file's text, at the commit read.
export interface ActionsReading {
  workflows(): Promise<string[]>
  file(path: string): Promise<string>
}

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
    return scanWorkflow(kind, text).uses.flatMap(uses => uses.kind === 'local' && !/\.ya?ml$/iu.test(uses.path) && !uses.path.split('/').includes('..') ? [uses.path] : [])
  } catch (error) {
    if (error instanceof ActionsScanError) return []
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
  for (const file of read.files) {
    if (!('text' in file)) { lines.push({ type: 'workflow', repo, ...file }); continue }
    const at = { type: 'workflow', repo, path: file.path, kind: file.kind } as const
    try {
      const scan = scanWorkflow(file.kind, file.text, { owner, lockfiles })
      lines.push({ ...at, ...scan })
      for (const uses of scan.uses) if (uses.kind === 'action' || uses.kind === 'workflow') refs.set(uses.key!, { key: uses.key!, owner, depth: 0 })
    } catch (error) {
      if (!(error instanceof ActionsScanError)) throw error
      lines.push({ ...at, error: error.code, detail: error.message.slice(0, 500) })
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

export interface ActionsResolver {
  // References to resolve, each once a scan.
  add(refs: ActionRef[]): void
  // Once all added, and all they name, are told, or the scan stops.
  close(): Promise<void>
}

// Resolves the references added, RESOLVERS at once, each told as it is,
// and those it names in turn, `source`'s answers kept for the scan.
export function resolvingActions(resolving: ActionsResolving): ActionsResolver {
  const source = keptSource(resolving.source)
  const pending: Queue<ActionRef> = queue(resolving.signal)
  const seen = new Set<string>()
  let closed = false, waiting = 0
  const settle = () => { if (closed && waiting === 0) pending.close() }
  const add = (refs: ActionRef[]) => {
    for (const ref of refs) {
      if (seen.has(ref.key) || seen.size >= MAX_ACTIONS || ref.depth > MAX_DEPTH) continue
      seen.add(ref.key)
      waiting++
      pending.add(ref)
    }
  }
  const work = async () => {
    for (let ref = await pending.take(); ref !== undefined; ref = await pending.take()) {
      try {
        const line = await resolved(resolving, source, ref)
        if (line) {
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
