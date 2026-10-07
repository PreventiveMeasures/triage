// Filename-to-label transform for the bucket-marker suffixes ingest
// stamps on at drop time. `.codex` filenames are derived (e.g.
// `org__repo:scan-suffix.codex`) — un-sanitize the slashes and strip
// the suffix for the visible label so the sidebar reads as the
// original `org/repo:scan-suffix`. DeepSec drops keep their original
// `.md` extension and need no transform.
export function displayName(name) {
  const lower = name.toLowerCase()
  // New names keep spaces; older imports also encoded spaces and separators.
  if (lower.endsWith('.generic-md')) {
    const stem = name.slice(0, -'.generic-md'.length)
    try { return decodeURIComponent(stem) } catch { return stem }
  }
  if (lower.endsWith('.codex')) return name.slice(0, -'.codex'.length).replaceAll('__', '/')
  return name
}
