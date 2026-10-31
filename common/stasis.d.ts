// Type declarations for `@exodus/stasis`, for the TypeScript consumers in this
// repository (server-managed/). The published package ships no types, so they
// are declared here — hand-written and deliberately partial: only the surface a
// TS file imports is declared.

declare module '@exodus/stasis/audit-corrections' {
  // Is `rel` (relative to the module dir) evidence that `name@version`'s real
  // code is present? Manifests never are, nor verified stubs within their range.
  export function isEvidenceFile(name: string, version: string, rel: string, ecosystem?: string): boolean
}

// Only what server-managed/bundle-validation.ts reads of it; see Stasis's src/validate.js.
declare module '@exodus/stasis/validate' {
  export interface ValidationPlan { own: { path: string }[]; packages: { ecosystem: string; name: string; version: string }[] }
  export function validationPlan(bundle: unknown): ValidationPlan
  export type RepositoryEntry = { data: Uint8Array } | { sha: string } | { symlink: string } | { submodule: true }
  export interface Locked { locks(ecosystem: string): boolean }
  export type Fetch = (ecosystem: string, name: string, version: string, integrity?: string) => Promise<Map<string, Uint8Array>>
  export interface BundleValidation { validatedAt: number; status: string; own: { checked: boolean } }
  export function validateBundle(plan: ValidationPlan, own: object, options?: { fetch?: Fetch; locked?: Locked | null; deadline?: number }): Promise<BundleValidation>
  export interface Repository { getRepoFile(options: { path: string; ref?: string }): Promise<string> }
  export function followingMoves(client: object, github: string): Repository
  export function historyOf(repository: Repository, commit: string): Promise<object | null>
  export function repositoryFiles(repository: Repository, where: { github: string; commit: string; directory?: string }): Promise<Map<string, RepositoryEntry>>
  export function repositoryLockfiles(options: { directory?: string; ecosystems: Set<string>; list: (dir: string) => Promise<string[]>; read: (path: string) => Promise<string> })
    : Promise<{ path: string; text: string }[]>
  export function lockedBy(lockfiles: object[]): Locked
  export const FETCHED: ReadonlySet<string>
  export const fetchPackage: Fetch
  export class ValidateError extends Error { code: string }
}
