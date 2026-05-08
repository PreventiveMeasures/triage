import { html, nothing } from 'lit'
import { state } from '../../client/state.js'

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
// "Module" = third-party dependency. The canonical layout is
// `node_modules/`; some build systems (Rust crates, etc.) vendor
// under `dependencies/` instead. Both can occur side-by-side in the
// same project — `dependencies/` may be a regular source dir when
// `node_modules/` is also present — so the active deps dir is
// chosen contextually: prefer `node_modules` when ANY path in the
// loaded reports has it, fall back to `dependencies` otherwise.
//
// `configureDepsDir(reports)` is called from render.js at the start
// of every render; the helpers below (isModule / stripPackagePrefix
// / packageOf via depsDirName) consult `depsDir` so reclassifying
// happens once per render, not per call.
let depsDir = 'node_modules'

export function configureDepsDir(reports) {
  const has = (s) => /(^|\/)node_modules\//.test(s)
  let hasNodeModules = false
  outer: for (const r of reports) {
    for (const g of r.groups ?? []) {
      for (const f of g) if (has(f.file)) { hasNodeModules = true; break outer }
    }
    if (r.tree) {
      for (const p of Object.keys(r.tree)) if (has(p)) { hasNodeModules = true; break outer }
    }
  }
  depsDir = hasNodeModules ? 'node_modules' : 'dependencies'
}

export function depsDirName() { return depsDir }

export function isModule(file) {
  return depsDir === 'node_modules'
    ? /(^|\/)node_modules\//.test(file)
    : /(^|\/)dependencies\//.test(file)
}

// File size formatter — bytes with thousand-separators and a `B`
// suffix (`12,345 B`). Used by the file table/list and the graph's
// selection card / tooltip when treeData entries carry a `size`.
// Returns null for missing values so callers can suppress the chip
// rather than render a placeholder.
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  return `${n.toLocaleString()} B`
}

// Strip the `<deps-dir>/<pkg>/` prefix so the path is rooted at the
// package's repo root — `node_modules/lodash/lib/foo.js` → `lib/foo.js`,
// `dependencies/@org/pkg/sub/x.js` → `sub/x.js`. Greedy `.*\/` runs to
// the LAST `/<deps-dir>/` so nested layouts strip the innermost
// package, matching the package-name extraction at export time.
// Uses the active `depsDir` so a `dependencies/` path is only
// stripped when that's what the project's vendor dir actually is.
export function stripPackagePrefix(file) {
  const re = depsDir === 'node_modules'
    ? /^(?:.*\/)?node_modules\/(?:@[^/]+\/[^/]+|[^/]+)\/(.*)$/u
    : /^(?:.*\/)?dependencies\/(?:@[^/]+\/[^/]+|[^/]+)\/(.*)$/u
  return file.match(re)?.[1] ?? file
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

// Searchable text for `state.filterInclude`. Joins the user-visible
// fields (file path, description, recommendation, confidence
// reasoning, discovery context) plus the per-finding `repo.github`
// slug — the latter so the search field can match findings by their
// upstream repo (`lodash/lodash`), useful when a merged report mixes
// findings from many node_modules dependencies.
export function findingText(f) {
  return [f.file, f.description, f.recommendation, f.confidenceReason, f.discoveredIn, f.repo?.github].filter(Boolean).join('\n').toLowerCase()
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

// Normalize a user-typed repo identifier into a base URL with no
// trailing slash. Accepts three input shapes so the user doesn't
// have to remember which one we want:
//   * full URL — `https://github.com/user/repo`
//   * host-prefixed slug without scheme — `github.com/user/repo`
//   * bare slug — `user/repo`
// Anything else falls through to the slug branch (treated as a path
// under github.com); a malformed input there just produces a broken
// link, which is the user's signal to fix what they typed.
function repoBaseUrl(s) {
  if (!s) return null
  const trimmed = s.trim().replace(/\/$/u, '')
  if (!trimmed) return null
  if (/^https?:\/\//iu.test(trimmed)) return trimmed
  if (/^github\.com\//iu.test(trimmed)) return `https://${trimmed}`
  return `https://github.com/${trimmed}`
}

// `githubRepo` (the per-finding `repo.github` value, e.g. `lodash/lodash`)
// wins over the user-typed repo URL when available — it points at the
// actual upstream of a node_modules dependency rather than at the project
// repo, which doesn't carry node_modules sources. Falls back to
// `repoFallback` (the per-report URL stamped on each finding at ingest)
// when given, or `state.repoUrl` (the active single-file mode setting)
// otherwise. Workspace mode passes per-finding fallbacks because each
// report carries its own github setting; single-file mode leaves
// `repoFallback` undefined and the global URL drives the chip.
export function fileUrl(file, githubRepo, repoFallback) {
  if (githubRepo) return `https://github.com/${githubRepo}/blob/HEAD/${stripPackagePrefix(file)}`
  if (isModule(file)) return null
  const base = repoBaseUrl(repoFallback ?? state.repoUrl)
  if (!base) return null
  return `${base}/blob/HEAD/${file}`
}

export function fileLink(file, githubRepo, repoFallback) {
  const url = fileUrl(file, githubRepo, repoFallback)
  return url ? html`<a href=${url} target="_blank" rel="noopener">${file}</a>` : file
}

// Returns a "line N" template (linkified when a fileUrl is available)
// or `nothing` when `line` isn't a finite integer — codex /
// claude-security imports don't carry line numbers and stub them as
// '?', and rendering a bare "line ?" adds noise without information.
// Callers suppress the wrapping `<span class="line-num">` when this
// returns `nothing`.
export function lineLink(file, line, githubRepo, repoFallback) {
  const lineNum = parseInt(line, 10)
  if (!Number.isFinite(lineNum)) return nothing
  const url = fileUrl(file, githubRepo, repoFallback)
  const text = `line ${lineNum}`
  if (!url) return text
  return html`<a href=${`${url}#L${lineNum}`} target="_blank" rel="noopener">${text}</a>`
}

// Commit URL builder + link renderer. Used by codex imports which
// carry a commit_hash column; the link points at the upstream
// commit on GitHub. Returns plain text (no <a>) when we don't know
// a repo to link against, so callers don't have to special-case the
// missing-repo path.
export function commitUrl(githubRepo, hash) {
  if (!githubRepo || !hash) return null
  // repo.github could already be a full URL (some imports do that)
  // or a `user/repo` slug. Detect by leading scheme; otherwise
  // treat as a slug under github.com.
  const base = /^https?:/i.test(githubRepo)
    ? githubRepo.replace(/\/$/u, '')
    : `https://github.com/${githubRepo}`
  return `${base}/commit/${hash}`
}
export function commitLink(githubRepo, hash) {
  if (!hash) return nothing
  // Short SHA for display (first 7 chars, GitHub's default abbrev).
  // Full hash on hover via the title attribute.
  const short = hash.slice(0, 7)
  const url = commitUrl(githubRepo, hash)
  if (!url) return html`<span title=${hash}>${short}</span>`
  return html`<a href=${url} target="_blank" rel="noopener" title=${hash}>${short}</a>`
}
