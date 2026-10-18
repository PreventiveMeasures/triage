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

// GitHub Actions (actions/), a workflow GitHub can't run thrown as
// @preventive/lockfile's YamlError. A finding of a workflow's, its `line` from 1; of a reference's own code,
// with the `file` it is in.
export interface ActionsFinding extends Finding {
  line?: number | null
  file?: string
}

// What a `uses:` names: an action's or a reusable workflow's, by its `key`,
// or the repository's own.
export type ActionUses = { kind: 'action' | 'workflow'; uses: string; repo: string; path: string; ref: string; pin: 'sha' | 'short-sha' | 'ref' | 'expression'; comment: string | null; key?: string; line?: number | null }
export type Uses = ActionUses | { kind: 'local'; uses: string; path: string; self?: true; line?: number | null }

export interface ScanOptions {
  // Whose repository it is, as an unpinned `uses:` of its owner's is yellow.
  owner?: string | null
  // Its lockfiles' paths and the packages each locks, as npx runs those.
  lockfiles?: { path: string; names: ReadonlySet<string> }[]
  // Another repository's action, run in a workspace it can't tell.
  external?: boolean
  // Where the repository's own actions install its packages, by their
  // directories (actionInstalls), null for anywhere; else each counts as
  // one that installs them anywhere.
  installers?: ReadonlyMap<string, readonly (string | null)[]> | null
}

export interface WorkflowScan {
  uses: Uses[]
  findings: ActionsFinding[]
}

export function scanWorkflow(kind: 'workflow' | 'action', text: string, options?: ScanOptions): WorkflowScan
// A workflow or an action's metadata read, a Docker action's Dockerfile's
// path from its directory among it.
export function readWorkflow(kind: 'workflow' | 'action', text: string): { dockerfile: { path: string } | null }
export function actionInstalls(text: string, installers: NonNullable<ScanOptions['installers']>): (string | null)[]
// A Dockerfile's findings, each on its line.
export function dockerfileFindings(text: string): ActionsFinding[]
export function workflowUses(read: unknown): Uses[]
// A reference by its key, as a scan names it; null for none.
export function usesOfKey(key: string): ActionUses | null

// GitHub as the asker can read it; null for none.
export interface ActionsSource {
  // Its name now, where it moved, and the repository it forks.
  repo(name: string): Promise<{ fullName: string; defaultBranch: string; fork?: string | null; archived?: boolean; private?: boolean } | null>
  // Every tag's commit; null where it has too many to list.
  tags(name: string): Promise<{ tag: string; oid: string }[] | null>
  tag(name: string, tag: string): Promise<string | null>
  branch(name: string, branch: string): Promise<string | null>
  // Its branches, and whether those are all.
  branches(name: string): Promise<{ branches: { branch: string; oid: string }[]; complete: boolean }>
  // Whether `sha` is `base` or in its history; null for no such commit. Of two
  // commits, it holds for good.
  contains(name: string, base: string, sha: string): Promise<boolean | null>
  file(name: string, path: string, commit: string): Promise<string | null>
}

// A reference resolved: its repository as GitHub has it now, its ref's
// commit, what the ref is, the tags on the commit, and the references it
// makes in turn; null for none.
export interface ResolvedAction extends Pick<ActionUses, 'kind' | 'repo' | 'path' | 'ref'> {
  key: string
  repository: { fullName: string; private: boolean } | null
  commit: string | null
  at: 'sha' | 'tag' | 'branch' | null
  tags: string[]
  findings: ActionsFinding[]
  uses: { key: string; line: number | null; file: string | null }[]
}

export function resolveAction(uses: ActionUses, source: ActionsSource, options?: { owner?: string | null }): Promise<ResolvedAction>
export function keptSource(source: ActionsSource): ActionsSource
