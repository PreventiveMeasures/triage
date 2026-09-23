const MAX_TEAM_PATH = 500

// Normalise an optional team-repo subpath into a clean RELATIVE path inside the
// repo: trim, drop control chars, fold both separators, drop empty + '.'
// segments, and REJECT any '..' segment so the subpath can't escape the repo
// subtree once the (later) data plane reads from it. `{ ok:false }` = traversal
// (the handler 400s); `{ path:null }` = the whole repo. Result is '/'-joined and
// length-capped.
export function normalizeTeamPath(raw: unknown): { ok: true; path: string | null } | { ok: false } {
  if (typeof raw !== 'string') return { ok: true, path: null }
  let cleaned = ''
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    cleaned += ch
  }
  const segments: string[] = []
  for (const seg of cleaned.replaceAll('\\', '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return { ok: false }
    segments.push(seg)
  }
  const path = segments.join('/').slice(0, MAX_TEAM_PATH)
  return { ok: true, path: path === '' ? null : path }
}

