// Type declarations for `client/triage.js`. Hand-written so the JS
// source stays untouched while triage-sync.ts pulls a typed surface.
// Mirrors the `common/utf8.d.ts` pattern. When `triage.js` itself is
// converted to TypeScript this file goes away.

export function saveTriage(): Promise<void>
export function reloadTriageFromStorage(): Promise<void>
export const loadPromise: Promise<void>
