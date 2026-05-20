// Type declarations for `common/ignored-key.js`. Hand-written so
// `tsc --noEmit` can resolve the helpers from `.ts` callers
// (`client/sync/triage-sync.ts`) without `allowJs`.

export function makeIgnoredKey(reportName: string, id: string): string
export function splitIgnoredKey(key: string): { reportName: string, id: string } | null
