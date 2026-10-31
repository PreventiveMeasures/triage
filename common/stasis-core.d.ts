// Type declarations for `@exodus/stasis-core`, for the TypeScript consumers in
// this repository (server-managed/). The published package ships no types, so
// they are declared here — hand-written and deliberately partial: only the
// surface a TS file imports is declared.

declare module '@exodus/stasis-core/bundle-util' {
  // The `repo` a parsed package.json's `repository` names, by the rule Stasis
  // builds record a dependency's by; undefined where it names no GitHub one.
  export function packageRepo(json: unknown, rel?: string): { github: string, directory?: string } | undefined
}

declare module '@exodus/stasis-core/util' {
  // The file Stasis records for an import a package disables, never on disk.
  export const EMPTY_MODULE_PATH: string
  // A module's ecosystem: the one it records, else npm's under node_modules.
  export function dependencyEcosystem(dir: string, ecosystem: string | undefined): string | undefined
  export function hasNodeModulesSegment(path: string): boolean
  // A stat record's format, `stat:*`, which is no file.
  export function isStatFormat(format: string | undefined): boolean
  // A module's file's path in the bundle: `rel` under `dir`, `dir` itself for ''.
  export function moduleFileKey(dir: string, rel: string): string
}
