// Hand-written against index.js; a change to either belongs with the other.
import type { CacheStore } from '@preventive/upstream/npm.js'

// How severe a stamp or a finding is, the most first: `critical` red, `high`
// a warning's orange, `moderate` yellow, `low`, and a `notice`.
export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'notice'

// The severities, the most severe first.
export const SEVERITIES: readonly Severity[]

// How old a version must be to be trusted unless said: two weeks, in ms.
export const DEFAULT_MINIMUM_RELEASE_AGE: number

// npm has no such package or version (`package-not-found`,
// `version-not-found`), a tarball unpacks past risk's bounds
// (`package-too-large`), npm asked to be asked later (`upstream-busy`, a 429,
// for a caller to wait on and ask again), or npm couldn't be asked
// (`upstream-unavailable`), answered past them (`upstream-too-large`) or
// answered what can't be read (`upstream-invalid`). `message` tells which
// request and why.
export class NpmRiskError extends Error {
  code: string
}

export interface AssessNpmOptions {
  // The version to compare with; true for the one of the package's versions
  // most likely free of what an attack injects, as risk picks it by npm's
  // document (risk/npm/old-version.js), none where none is below it; without
  // one, everything of the version is new.
  oldVersion?: string | true | null
  // Compare all files with an empty package, for an initial dependency review.
  fromEmpty?: boolean
  // Younger than this, in ms, a version is `too-new`; 0 for none, as a
  // caller's own scopes take. Two weeks unless given.
  minimumReleaseAge?: number
  // Whether the package is flagged as few download it (`popularity`); false
  // for none, as a caller's own scopes take, its downloads then not asked.
  // True unless given.
  popularity?: boolean
  // Where what is read is kept, by type (risk/npm/registry.js and assess.js
  // name each): `npm/tarballs`, `risk/npm/versions`, `risk/npm/packages`,
  // `risk/npm/old-versions`, `risk/npm/public`, `risk/npm/downloads`,
  // `risk/npm/advisories` and `risk/npm/assessments`.
  cache?: CacheStore | false
  // Asks for a package's whole document in risk's stead, as the managed
  // server does within its bounds: null where npm has none for this asker.
  // `authorized` whether it may be asked with the caller's npm token: the
  // package assessed, not its dependencies.
  packument?: (name: string, options: { authorized: boolean; signal: AbortSignal | undefined }) => Promise<Record<string, unknown> | null>
  // Reads a version's tarball, gzipped, in place of upstream's getTarball, as
  // the managed server does within its bounds: `version` the one assessed or
  // `oldVersion`, that one only where its files could change what is found.
  // What it throws is thrown as it is.
  tarball?: (name: string, version: string, options: { signal: AbortSignal | undefined }) => Promise<Uint8Array>
  now?: number
  signal?: AbortSignal
  // Whether npm's downloads are asked for: the package's popularity, and its
  // new dependencies' tiers and ages. True unless given.
  downloads?: boolean
  // Whether its new dependencies' tiers and ages are asked for, a request or
  // two of npm each, where `downloads` is. True unless given.
  dependencies?: boolean
  // Whether npm's advisories of the version are asked for, an advisory of
  // malware naming it a `malware` finding, as its package taken down by npm
  // is. True unless given.
  advisories?: boolean
  // Whether OSV's records of malware in the version are asked for too, where
  // `advisories` are: false for a private package, whose name OSV is never
  // to be sent. True unless given.
  osv?: boolean
  // Whether a package is the caller's own, as its own scopes take: a new
  // dependency on one is told no tier nor age, nor is npm asked of it. None
  // unless given.
  owned?: (name: string) => boolean | Promise<boolean>
}

// What calls for a look, by `id`, with what it found beside.
export interface Finding {
  id: string
  severity: Severity
  [found: string]: unknown
}

// A stamp on a file, as a list of files tags it.
export interface Stamp {
  name: string
  severity: Severity
}

export interface FileRisk {
  stamps: Stamp[]
  readability: Record<string, unknown>
  runsCode: Record<string, number[]> | null
  exfiltration: Record<string, number[]> | null
  hosts: Record<string, number> | null
}

export interface DependencyRisk {
  key: string
  name: string
  kind: 'peer' | 'optional' | null
  range?: string
  from?: string
  to?: string
  opens: string | null
  flags: { check: string; label: string; tooltip: string }[]
  tier?: number | null
  level?: string
  // Its last whole month's downloads, by what its tier goes by: none where
  // npm counts none of them.
  month?: { total: number; from: string }
  // Whether npm counts none of its downloads, as of a package published
  // the day before; unpopular all the same.
  uncounted?: true
  created?: string
  gap?: number
  // For one nothing imports, the version its spec installs (registry.js
  // npmPublicFacts): its package's latest beside it, when it was published,
  // whether it has install scripts, and whether that was since the version
  // compared with (`new`).
  installs?: { version: string; latest: string | null; published: string | null; scripts: boolean; new: boolean }
  // Where its package was looked up and npm has none of it for anyone.
  missing?: true
}

// A version's risk as one number (risk/npm/score.js): what its findings call
// for (`raised`, each it counts), each by its severity, malware all of it,
// lowered by its exposure (`lowered`): how long it has been out (`days`)
// among how many download its package (`tier`, its rank, null past the last
// or where unknown), `by` the share taken off. Its `level` is named as the
// findings' severities are: from 75 critical, 50 high, 25 moderate, else low.
export interface RiskScore {
  score: number
  level: 'critical' | 'high' | 'moderate' | 'low'
  raised: { id: string; severity: Severity }[]
  lowered?: { days: number; tier: number | null; by: number }
}

export interface NpmAssessment {
  name: string
  version: string
  // The version compared with, as given or as risk picked it; null for none.
  oldVersion: string | null
  published: string | null
  // A version npm removed, as it removes every one it finds malware in, told
  // of by its `malware` finding alone, with no files nor dependencies.
  removed?: true
  findings: Finding[]
  files: Record<string, FileRisk>
  // Against `oldVersion`, each it holds too, flagged against none (`held`).
  dependencies: { added: DependencyRisk[]; changed: DependencyRisk[]; held?: DependencyRisk[] }
  score: RiskScore
}

export function assessNpm(name: string, version: string, options?: AssessNpmOptions): Promise<NpmAssessment>

// Readies, at once, the downloads assessNpm asks of each of these packages
// that can be, kept in `cache` as it keeps them, so that their assessments
// ask npm none: those kept within a week, and unscoped ones, asked of npm 128
// at a time. `ready` is told each once its downloads are kept; the rest (scoped
// ones, which npm answers only one by one) are left for npmReadyDownload.
// npm asking to be asked later is thrown as an NpmRiskError
// (`upstream-busy`), those readied by then told.
// A cache that reads and writes many at once too (`readMany`, `writeMany`)
// is read once and written once a lookup.
export function npmReadyDownloads(names: string[], ready: (name: string) => void, options: { cache: CacheStore & {
  readMany?(type: string, keys: string[]): Promise<Map<string, unknown>>
  writeMany?(type: string, entries: [key: string, value: unknown][]): Promise<void>
}; signal?: AbortSignal; now?: number }): Promise<void>

// Readies the downloads assessNpm asks of a package, asked of npm on their
// own where they aren't kept; npm asking to be asked later thrown as an
// NpmRiskError (`upstream-busy`).
export function npmReadyDownload(name: string, options: { cache: CacheStore; signal?: AbortSignal; now?: number }): Promise<void>

// Whether an advisory is of malware rather than a vulnerability: OSV's of a
// malicious package (`MAL-…`), or one such a record names (its `aliases`),
// CWE-506, embedded malicious code, whatever its title, or a title naming
// malware.
export function npmMalwareAdvisory(advisory: { id?: string | undefined; aliases?: readonly string[] | undefined; cwe?: readonly string[] | undefined; title?: string | undefined }): boolean

export function npmFileRisk(path: string, text: string | null, bytes?: number, script?: boolean): unknown

// Why a workflow, an action or a reference couldn't be read (actions/):
// `code` `workflow-unreadable`, `message` telling why, its YAML's line among
// it.
export class ActionsScanError extends Error {
  code: string
}

// A finding of a repository's Actions, its `line` the file's, counting from
// 1, and of a resolved reference's own code, the `file` it is in.
export interface ActionsFinding extends Finding {
  line?: number | null
  file?: string
}

// What a `uses:` names (actions/uses.js readUses), an action's or a reusable
// workflow's by its `key` as a scan tells it.
export type ActionUses = { kind: 'action' | 'workflow'; uses: string; repo: string; path: string; ref: string; pin: 'sha' | 'short-sha' | 'ref' | 'expression'; comment: string | null; key?: string; line?: number | null }
export type Uses = ActionUses
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
// A reference by its key, as a scan names it; null for none.
export function usesOfKey(key: string): ActionUses | null

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

// A reference resolved: `repository` as GitHub has it now (null for none),
// `commit` its ref's, `at` what its ref is (null for none), `tags` those on
// the commit, `latest` the repository's latest release, `using` an action's
// runtime, `file` the one read, and `uses` the references it makes in turn.
export interface ResolvedAction extends Pick<ActionUses, 'kind' | 'repo' | 'path' | 'ref' | 'pin'> {
  key: string
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

export function resolveAction(uses: ActionUses, source: ActionsSource, options?: { owner?: string | null }): Promise<ResolvedAction>
// `source` with what it answers kept, each by what it was asked, while held.
export function keptSource(source: ActionsSource): ActionsSource
