// Hand-written against index.js; a change to either belongs with the other.
import type { Severity } from '../risk/index.js'

// Why a workflow, an action or a reference couldn't be read: `code`
// `workflow-unreadable`, `message` telling why, its YAML's line among it.
export class ActionsScanError extends Error {
  code: string
}

// What calls for a look, by `id`, with what it found beside: `line`, the
// file's, counting from 1, and for a resolved reference's own code, the
// `file` it is in.
export interface ActionsFinding {
  id: string
  severity: Severity
  line?: number | null
  file?: string
  [found: string]: unknown
}

// What a `uses:` names (uses.js readUses).
export type Uses =
  | { kind: 'action' | 'workflow'; uses: string; repo: string; path: string; ref: string; pin: 'sha' | 'short-sha' | 'ref' | 'expression'; comment: string | null; line?: number | null }
  | { kind: 'local'; uses: string; path: string; self?: true; line?: number | null }
  | { kind: 'docker'; uses: string; image: string; tag: string | null; digest: string | null; line?: number | null }
  | { kind: 'invalid'; uses: string; line?: number | null }

export interface ScanOptions {
  // Whose repository the workflow is: a `uses:` of the same owner's, as of
  // GitHub's own, is graded yellow unpinned, any other's orange.
  owner?: string | null
  // The repository's lockfiles, each by its path and the names of the
  // packages it locks: npx is told to run the project's own where one at or
  // above the directory its step runs in locks it, once an install ran
  // before it.
  lockfiles?: { path: string; names: ReadonlySet<string> }[]
  // Another repository's action, run in a workspace it can't tell.
  external?: boolean
}

export interface WorkflowScan {
  triggers: string[]
  // An action's runtime (`runs.using`), null for a workflow.
  using: string | null
  uses: Uses[]
  findings: ActionsFinding[]
}

export function scanWorkflow(kind: 'workflow' | 'action', text: string, options?: ScanOptions): WorkflowScan
export function readWorkflow(kind: 'workflow' | 'action', text: string): unknown
export function workflowFindings(read: unknown, options?: ScanOptions): ActionsFinding[]
export function workflowUses(read: unknown): Uses[]
export function dockerfileFindings(text: string): ActionsFinding[]

export function readUses(text: string, options?: { job?: boolean; comment?: string | null }): Uses
// The key a reference is resolved once by, and the reference of one.
export function usesKey(uses: { repo: string; path: string; ref: string; pin?: string; comment?: string | null }): string
export function usesOfKey(key: string): Extract<Uses, { kind: 'action' | 'workflow' }> | null
export function ownerKind(repo: string, owner: string | null): 'github' | 'own' | 'third-party'

// What a reference is resolved with: GitHub, as the asker can read it.
export interface ActionsSource {
  // The repository as GitHub has it now, by the name asked: its name now,
  // where it was renamed or transferred, the repository it forks, null for
  // none; null where GitHub has none for the asker.
  repo(name: string): Promise<{ fullName: string; defaultBranch: string; fork?: string | null; archived?: boolean; private?: boolean } | null>
  // Every tag, each with its commit; null where it has too many to list.
  tags(name: string): Promise<{ tag: string; oid: string }[] | null>
  // A tag's commit, or a branch's head; null where it has none of the name.
  tag(name: string, tag: string): Promise<string | null>
  branch(name: string, branch: string): Promise<string | null>
  // Its branches, as many as listed, and whether that is all of them.
  branches(name: string): Promise<{ branches: { branch: string; oid: string }[]; complete: boolean }>
  // Whether `sha` is `base` (a branch, or a commit) or in its history; null
  // where GitHub has no such commit.
  contains(name: string, base: string, sha: string): Promise<boolean | null>
  // A file's text at a commit; null where it has none at the path.
  file(name: string, path: string, commit: string): Promise<string | null>
}

export interface ResolvedAction {
  key: string
  kind: 'action' | 'workflow'
  repo: string
  path: string
  ref: string
  pin: 'sha' | 'short-sha' | 'ref' | 'expression'
  owner: 'github' | 'own' | 'third-party'
  repository: { fullName: string; fork: string | null; archived: boolean; private: boolean } | null
  commit: string | null
  at: 'sha' | 'tag' | 'branch' | null
  tags: string[]
  latest: string | null
  using: string | null
  file: string | null
  findings: ActionsFinding[]
  uses: { key: string; line: number | null; file: string | null }[]
}

export function resolveAction(uses: Extract<Uses, { kind: 'action' | 'workflow' }>, source: ActionsSource, options?: { owner?: string | null }): Promise<ResolvedAction>
// `source` with what it answers kept, each by what it was asked, while held.
export function keptSource(source: ActionsSource): ActionsSource
