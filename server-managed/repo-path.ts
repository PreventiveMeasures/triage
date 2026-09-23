const MAX_TEAM_PATH = 500

// Canonicalize only equivalent Git paths: '/' separates components and empty
// or '.' components do not change the directory. Reject ambiguous input rather
// than deleting characters from directory names used for authorization.
// `{ ok:false }` makes the handler 400; `{ path:null }` means the whole repo.
export function normalizeTeamPath(raw: unknown): { ok: true; path: string | null } | { ok: false } {
  if (typeof raw !== 'string') return { ok: true, path: null }
  // Spaces and backslashes can be literal parts of Git directory names.
  // Neither trimming nor treating '\\' as a separator preserves that identity.
  if (/\p{Cc}/u.test(raw) || raw.includes('\\') || raw !== raw.trim()) return { ok: false }
  const segments: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' || seg !== seg.trim()) return { ok: false }
    segments.push(seg)
  }
  const path = segments.join('/')
  if (path.length > MAX_TEAM_PATH) return { ok: false }
  return { ok: true, path: path === '' ? null : path }
}
