// Type declarations for `@exodus/stasis`, for the TypeScript consumers in this
// repository (server-managed/). The published package ships no types, so they
// are declared here — hand-written and deliberately partial: only the surface a
// TS file imports is declared.

declare module '@exodus/stasis/audit-corrections' {
  // Is `rel` (relative to the module dir) evidence that `name@version`'s real
  // code is present? Manifests never are, nor verified stubs within their range.
  export function isEvidenceFile(name: string, version: string, rel: string, ecosystem?: string): boolean
}
