// A repository's GitHub Actions, as a repository risk scan reads them
// (repository-risk.ts): its workflows (.github/workflows/*.yml and .yaml) at
// the commit read, and the actions of its own they use (`./path`,
// `$/path`), each read for what it calls for by its own text (actions-scan
// scanWorkflow), npx held to its lockfiles' packages; and each action and
// reusable workflow of another repository they name, resolved once a scan
// (actions-scan resolveAction), what it names in turn too, MAX_DEPTH deep
// and MAX_ACTIONS in all. A repository's files are kept by the commit they
// were read at (repository-risk-read.ts), where none failed for a while
// (lastingRead); a reference resolved, by its key and whose workflow named
// it, in the instance's memory for RISK_KEPT_MS, and, of a public
// repository alone, in the source's `actions`.
import { ActionsScanError, type ActionsSource, type ResolvedAction, type Uses, keptSource, readWorkflow, resolveAction, scanWorkflow, usesKey, usesOfKey,
  workflowUses } from '../actions-scan/index.js'
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
export const MAX_ACTIONS = 1000
const MAX_DEPTH = 4
const RESOLVERS = 4

// A workflow listed, by its path and blob.
export interface ListedWorkflow { path: string; sha: string }
// A file of a repository's Actions read: a workflow, or an action of its
// own, its text or why it couldn't be had.
export type ActionsFile = { path: string; kind: 'workflow' | 'action' } & ({ text: string } | RiskFailure)
export type WorkflowsRead = { files: ActionsFile[] } | RiskFailure

// What a scan tells of them: a repository's workflows' paths, each file's
// findings and references, or why not, and each reference resolved, or why
// not, by its key and the owner of the workflow that named it first.
export type WorkflowsLine = { type: 'workflows'; repo: number } & ({ paths: string[] } | RiskFailure)
export type WorkflowLine = { type: 'workflow'; repo: number; path: string; kind: 'workflow' | 'action' }
  & ({ triggers: string[]; using: string | null; uses: Uses[]; findings: unknown[] } | RiskFailure)
export type ActionLine = { type: 'action'; key: string; owner: string | null; depth: number } & (Omit<ResolvedAction, 'key' | 'owner'> & { ownerKind: string } | RiskFailure)

// A reference to resolve: its key, the owner of the workflow naming it, and
// how deep it is named.
export interface ActionRef { key: string; owner: string | null; depth: number }

// What reading a repository's Actions asks of it: its workflows listed, and
// a file's text, at the commit read.
export interface ActionsReading {
  workflows(): Promise<ListedWorkflow[]>
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
    return workflowUses(readWorkflow(kind, text)).flatMap(uses => uses.kind === 'local' && !/\.ya?ml$/iu.test(uses.path) && !uses.path.split('/').includes('..') ? [uses.path] : [])
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
  for (const { path } of listed.slice(0, MAX_FILES)) files.push({ path, kind: 'workflow', ...await readFile(reading, path) })
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
export function actionsLines(repo: number, owner: string, read: WorkflowsRead, lockfiles: { path: string; names: ReadonlySet<string> }[]) {
  if ('error' in read) return { lines: [{ type: 'workflows', repo, ...read } as WorkflowsLine], refs: [] as ActionRef[] }
  const lines: (WorkflowsLine | WorkflowLine)[] = [{ type: 'workflows', repo, paths: read.files.filter(file => file.kind === 'workflow').map(file => file.path) }]
  const refs = new Map<string, ActionRef>()
  for (const file of read.files) {
    const at = { type: 'workflow', repo, path: file.path, kind: file.kind } as const
    if (!('text' in file)) { lines.push({ ...at, error: file.error, ...file.detail === undefined ? {} : { detail: file.detail } }); continue }
    try {
      const scan = scanWorkflow(file.kind, file.text, { owner, lockfiles })
      lines.push({ ...at, ...scan })
      for (const uses of scan.uses) if (uses.kind === 'action' || uses.kind === 'workflow') refs.set(usesKey(uses), { key: usesKey(uses), owner, depth: 0 })
    } catch (error) {
      if (!(error instanceof ActionsScanError)) throw error
      lines.push({ ...at, error: error.code, detail: error.message.slice(0, 500) })
    }
  }
  return { lines, refs: [...refs.values()] }
}

// A reference resolved as a line.
function lineOf(ref: ActionRef, found: ResolvedAction): ActionLine {
  const { key: _key, owner: ownerKind, ...rest } = found
  return { type: 'action', key: ref.key, owner: ref.owner, depth: ref.depth, ownerKind, ...rest }
}

export interface ActionsResolving {
  source: ActionsSource
  signal: AbortSignal
  tell(line: ActionLine): void
  memory: Lru<{ at: number; line: ActionLine }>
  store?: KeptStore<ActionLine> | undefined
}

// A reference's line: kept, within RISK_KEPT_MS, else resolved and kept, of
// a public repository in `store` too; why not, where it couldn't be.
async function resolved(resolving: ActionsResolving, source: ActionsSource, ref: ActionRef): Promise<ActionLine | null> {
  const key = `${ref.owner ?? ''}\0${ref.key}`
  const stored = resolving.memory.get(key) ? null : await resolving.store?.read(key)
  const hit = resolving.memory.get(key) ?? (stored ? { at: stored.at, line: stored.value } : undefined)
  if (hit && Date.now() - hit.at < RISK_KEPT_MS) return { ...hit.line, depth: ref.depth }
  const uses = usesOfKey(ref.key)
  if (!uses) return { type: 'action', key: ref.key, owner: ref.owner, depth: ref.depth, error: 'invalid-uses' }
  let line: ActionLine
  try { line = lineOf(ref, await resolveAction(uses, source, { owner: ref.owner })) } catch (error) {
    return resolving.signal.aborted ? null : { type: 'action', key: ref.key, owner: ref.owner, depth: ref.depth, ...failureOf(error) }
  }
  const at = Date.now()
  resolving.memory.set(key, { at, line })
  if ('repository' in line && line.repository?.private === false) await resolving.store?.write(key, line, at)
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
      const key = `${ref.owner ?? ''}\0${ref.key}`
      if (seen.has(key) || seen.size >= MAX_ACTIONS || ref.depth > MAX_DEPTH) continue
      seen.add(key)
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
