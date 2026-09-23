const MAX_TEAM_PATH = 500

// Normalise an optional team-repo subpath into a clean RELATIVE path inside the
// repo: trim, reject control chars, fold both separators, drop empty + '.'
// segments, and REJECT any '..' segment so the subpath can't escape the repo
// subtree once the (later) data plane reads from it. `{ ok:false }` = traversal,
// invalid characters, or an oversized normalized path (the handler 400s).
// `{ path:null }` = the whole repo. Never truncate authorization paths.
export function normalizeTeamPath(raw: unknown): { ok: true; path: string | null } | { ok: false } {
  if (typeof raw !== 'string') return { ok: true, path: null }
  // Validate before trimming: deleting even an edge tab/newline can merge
  // distinct Git paths into the same authorization scope.
  if (/\p{Cc}/u.test(raw)) return { ok: false }
  const segments: string[] = []
  for (const seg of raw.trim().replaceAll('\\', '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return { ok: false }
    segments.push(seg)
  }
  const path = segments.join('/')
  if (path.length > MAX_TEAM_PATH) return { ok: false }
  return { ok: true, path: path === '' ? null : path }
}
