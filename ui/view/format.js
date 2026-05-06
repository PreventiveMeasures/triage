import { state } from './state.js'

// Severity ranking — higher = more severe. The ladder splits into
// two stacks: vulnerabilities on top (critical → low) and bug-class
// findings below (high_bug → bug), with informational at the bottom.
// DeepSec maps HIGH_BUG to high_bug and plain BUG to bug; the other
// formats only use the vuln tiers + informational. Adding a new
// tier here is the canonical place — every other hardcoded severity
// list (counts initializers, stats chips, chip CSS, etc.) keys off
// SEVERITIES below.
export const SEVERITY_ORDER = {
  critical: 6, high: 5, medium: 4, low: 3,
  high_bug: 2, bug: 1, informational: 0,
}
// Highest-to-lowest iteration order. Used by statItems / colorCounts
// builders and per-file count computations. The bug tiers sit between
// low and informational so a graph node with only bugs still gets a
// recognizable color hint without competing with vuln tiers in the
// summary slots.
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']
export const NODE_MODULES_RE = /(^|\/)node_modules\//

export function esc(str) {
  const el = document.createElement('span')
  el.textContent = str
  return el.innerHTML
}

export function isModule(file) { return NODE_MODULES_RE.test(file) }

// Strip the `node_modules/<pkg>/` prefix so the path is rooted at the
// package's repo root — `node_modules/lodash/lib/foo.js` → `lib/foo.js`,
// `node_modules/@org/pkg/sub/x.js` → `sub/x.js`. Greedy `.*\/` runs to
// the LAST `/node_modules/` so nested layouts strip the innermost
// package, matching the package-name extraction at export time.
export function stripPackagePrefix(file) {
  return file.match(/^(?:.*\/)?node_modules\/(?:@[^/]+\/[^/]+|[^/]+)\/(.*)$/u)?.[1] ?? file
}

// Strip `[export: <name>]` markers from prose when they match the
// finding's own `exportName`. Isolate-mode injects these markers into
// every finding/CRITICAL line of a merged per-file response so the
// merge stays traceable to individual exports (see src/isolate.js),
// but once post-process has lifted the name out into `f.exportName`
// the inline marker just duplicates metadata already on the finding.
// Markers whose name does NOT match `f.exportName` are left alone —
// they're still useful context (e.g. "this export affects <other>").
export function stripExportMarker(text, exportName) {
  if (!exportName || !text) return text
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return text.replaceAll(new RegExp(`\\[export:\\s*${escaped}\\]\\s*`, 'gu'), '')
}

export function findingText(f) {
  return [f.file, f.description, f.recommendation, f.confidenceReason, f.discoveredIn].filter(Boolean).join('\n').toLowerCase()
}

export function prettyModel(model) {
  if (!model) return model
  return model.replace(/^[^/]+\//u, '').replace(/^claude-/, '').replaceAll('-', ' ')
}

// Walk a list of strings and shrink the candidate prefix until every
// string starts with it. Returns '' when no shared prefix exists. Used
// for the print button's title heuristic when multiple reports are
// loaded — gives the saved PDF a name that still reads as "this batch"
// (`security-` / `2026-04-` / etc.) without having to manually pick.
export function commonPrefix(strings) {
  if (strings.length === 0) return ''
  let prefix = strings[0]
  for (let i = 1; i < strings.length; i++) {
    while (prefix && !strings[i].startsWith(prefix)) prefix = prefix.slice(0, -1)
    if (!prefix) return ''
  }
  return prefix
}

// `githubRepo` (the per-finding `repo.github` value, e.g. `lodash/lodash`)
// wins over the user-typed repo URL when available — it points at the
// actual upstream of a node_modules dependency rather than at the project
// repo, which doesn't carry node_modules sources. Falls back to the
// user-typed repoUrl for own-source files (and when no per-finding repo
// is known).
export function fileUrl(file, githubRepo) {
  if (githubRepo) return `https://github.com/${githubRepo}/blob/HEAD/${stripPackagePrefix(file)}`
  if (!state.repoUrl || isModule(file)) return null
  const base = state.repoUrl.replace(/\/$/u, '')
  return `${base}/blob/HEAD/${file}`
}

export function fileLink(file, githubRepo) {
  const url = fileUrl(file, githubRepo)
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(file)}</a>` : esc(file)
}

// Returns "line N" (linkified when a fileUrl is available) or '' when
// `line` isn't a finite integer — codex / claude-security imports
// don't carry line numbers and stub them as '?', and rendering a bare
// "line ?" adds noise without information. Callers suppress the
// wrapping `<span class="line-num">` when this returns ''.
export function lineLink(file, line, githubRepo) {
  const lineNum = parseInt(line, 10)
  if (!Number.isFinite(lineNum)) return ''
  const url = fileUrl(file, githubRepo)
  const text = `line ${lineNum}`
  if (!url) return text
  return `<a href="${esc(url)}#L${lineNum}" target="_blank" rel="noopener">${text}</a>`
}
