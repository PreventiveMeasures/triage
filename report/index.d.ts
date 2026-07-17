// Type declarations for `report/index.js`, for the TypeScript consumers in
// this repository (server-managed/). Hand-written so the JS source stays
// untouched — the `client/triage.d.ts` / `common/utf8.d.ts` pattern — and
// deliberately partial: only the surface a TS file imports is declared here.
// Not part of the published @preventive/report package (see `files` in
// report/package.json).

// Recognise, flatten, and give every finding an id — the whole read path in
// one call. `findings` are the parser's own objects; null when nothing
// recognises the text.
export function loadFindings(content: string): Promise<{ format: string, data: unknown, findings: unknown[] } | null>
