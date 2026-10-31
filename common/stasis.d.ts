// Type declarations for `@exodus/stasis`, for the TypeScript consumers in this
// repository (server-managed/). The published package ships no types, so they
// are declared here — hand-written and deliberately partial: only the surface a
// TS file imports is declared.

declare module '@exodus/stasis/audit-corrections' {
  // Is `rel` (relative to the module dir) evidence that `name@version`'s real
  // code is present? Manifests never are, nor verified stubs within their range.
  export function isEvidenceFile(name: string, version: string, rel: string, ecosystem?: string): boolean
}

declare module '@exodus/stasis/validate' {
  // A file the bundle holds, as validation checks it: its path in the bundle,
  // and its module's directory and its path there.
  export interface PlannedFile { path: string; dir: string; rel: string }
  export interface ValidationPlan {
    files: number
    own: PlannedFile[]
    packages: { ecosystem: string; name: string; version: string; files: PlannedFile[] }[]
    patches: Map<string, string>
  }
  // A parsed bundle's files: its own code, each package version's, and the patches it holds.
  export function validationPlan(bundle: unknown): ValidationPlan

  // An entry of the repository's tree at a path: a file by its bytes or git's
  // blob id, a symlink, or a submodule.
  export type RepositoryEntry = { data: Uint8Array } | { sha: string } | { symlink: string } | { submodule: true }
  // The ref of the repository that has the commit read in its history.
  export type HistoryRef = { branch: string } | { tag: string }
  export interface OwnRead {
    entries: Map<string, RepositoryEntry>
    cut: boolean
    repository: string
    commit: string
    directory: string
    ref?: HistoryRef
    movedFrom?: string
  }
  // How lockfiles lock the bundle's versions (lockedBy), opaque here.
  export interface Locked { lockfiles: string[]; locks(ecosystem: string): boolean }

  export type Fetch = (ecosystem: string, name: string, version: string, integrity?: string) => Promise<Map<string, Uint8Array>>
  export type OwnChecked = { checked: true; repository: string; commit: string; directory: string; ref?: HistoryRef; movedFrom?: string; cut?: true }
    | { checked: false; reason: string; patches?: number }
  export interface Problem { path: string; kind: 'differs' | 'unexpected' | 'unverified'; of: string; reason?: string }
  export interface PackageTold {
    ecosystem: string; name: string; version: string; files: number; status: 'valid' | 'invalid' | 'unverified'
    reason?: string; at?: string; directory?: string
    patch?: { hash?: string; path?: string; from?: 'bundle' | 'repository' | 'local'; verified?: boolean; error?: string; applied?: boolean }
  }
  export interface BundleValidation {
    validatedAt: number
    status: 'valid' | 'invalid' | 'incomplete'
    own: OwnChecked
    lockfiles: string[] | null
    counts: Record<'files' | 'own' | 'dependencies' | 'matched' | 'eol' | 'differs' | 'unexpected' | 'unverified' | 'skipped' | 'packages' | 'validPackages'
      | 'lockFailures' | 'misplaced', number>
    problems: Problem[]
    moreProblems: number
    packages: PackageTold[]
  }
  // The bundle `plan` validated: its own code against `own`, or not (`reason`),
  // each dependency fetched with `fetch` and held to `locked`, null for no lockfile.
  export function validateBundle(plan: ValidationPlan, own: OwnRead | { reason: string },
    options?: { fetch?: Fetch; locked?: Locked | null; deadline?: number; now?: () => number }): Promise<BundleValidation>

  // A repository's reads (upstream's GitHub client), followed where GitHub answers it has moved.
  export interface Repository {
    name(): string
    getRepoFile(options: { path: string; ref?: string }): Promise<string>
  }
  export function followingMoves(client: object, github: string): Repository
  // The ref of `repository` that has `commit` in its history, null for none.
  export function historyOf(repository: Repository, commit: string): Promise<HistoryRef | null>
  // A directory's files of the repository at `commit`, by their paths from its root.
  export function repositoryFiles(repository: Repository, where: { github: string; commit: string; directory?: string }): Promise<Map<string, RepositoryEntry>>
  // The repository's lockfiles that install `directory`, as lockedBy takes them.
  export function repositoryLockfiles(options: { directory?: string; ecosystems: Set<string>; list: (dir: string) => Promise<string[]>; read: (path: string) => Promise<string> })
    : Promise<{ path: string; text: string }[]>
  export interface LockfileRead {
    path: string; text: string; from?: 'repository' | 'local'; read?: (path: string) => Promise<string>
    tree?: (dir: string) => Promise<Map<string, Uint8Array>>; patches?: string[]; root?: string
  }
  export function lockedBy(lockfiles: LockfileRead[]): Locked
  // Ecosystems upstream fetches a version of by its name and version alone.
  export const FETCHED: ReadonlySet<string>
  export const fetchPackage: Fetch
  // A bundle validation refuses to read (no lockfile locking its packages, two
  // package managers' or one it can't read), by its `code`.
  export class ValidateError extends Error { code: string }
}
