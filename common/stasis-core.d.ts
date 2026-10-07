// Type declarations for `@exodus/stasis-core`, for the TypeScript consumers in
// this repository (server-managed/). The published package ships no types, so
// they are declared here — hand-written and deliberately partial: only the
// surface a TS file imports is declared.

declare module '@exodus/stasis-core/bundle-util' {
  // The `repo` a parsed package.json's `repository` names, by the rule Stasis
  // builds record a dependency's by; undefined where it names no GitHub one.
  export function packageRepo(json: unknown, rel?: string): { github: string, directory?: string } | undefined
}
