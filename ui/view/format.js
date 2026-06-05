import { html, nothing } from './frontend-global.js'

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
  const has = (s) => /(^|\/)node_modules\//u.test(s)
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
    ? /(^|\/)node_modules\//u.test(file)
    : /(^|\/)dependencies\//u.test(file)
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

// Strip the longest common DIRECTORY prefix shared by every path
// in `paths`. Mirrors `stripCommonPrefix` in src/paths.js so the
// UI matches what the analyzer-side normalisation produces:
//
//   * Segment-level (only whole directory segments are stripped).
//   * Caps the prefix so it never ends in a `@scope` segment or
//     a `node_modules` segment — those identify the package each
//     listed file belongs to and should stay visible in the
//     stripped output. So
//     `node_modules/foo/{a,b}.js` strips to `node_modules/foo/{a,b}.js`
//     (prefix '') rather than to `{a,b}.js`.
//
// Returns `{ prefix, stripped }`. `prefix` ends with `/` (or is
// empty); `stripped` is a parallel array. With ≤1 path the result
// is a no-op pass-through.
export function stripCommonPathPrefix(paths) {
  if (paths.length <= 1) return { prefix: '', stripped: [...paths] }
  const split = paths.map((p) => p.split('/'))
  const minLen = Math.min(...split.map((s) => s.length))
  let prefixLen = 0
  for (let i = 0; i < minLen - 1; i++) {
    if (split.every((s) => s[i] === split[0][i])) prefixLen = i + 1
    else break
  }
  // Back off the prefix when its last segment is part of the
  // package's identity (scope `@org` or the `node_modules` marker).
  if (prefixLen > 0 && split[0][prefixLen - 1].startsWith('@')) prefixLen--
  if (prefixLen > 0 && split[0][prefixLen - 1] === 'node_modules') prefixLen--
  if (prefixLen === 0) return { prefix: '', stripped: [...paths] }
  const prefix = `${split[0].slice(0, prefixLen).join('/')}/`
  const stripped = split.map((s) => s.slice(prefixLen).join('/'))
  return { prefix, stripped }
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
// finding's own `exportName` or `methodName`. Isolate-mode injects
// these markers into every finding/CRITICAL line of a merged per-file
// response so the merge stays traceable to individual exports (see
// src/isolate.js), but once post-process has lifted the name out into
// `f.exportName` / `f.methodName` the inline marker just duplicates
// metadata already on the finding. Markers whose name does NOT match
// either field are left alone — they're still useful context (e.g.
// "this export affects <other>").
//
// Also strips a leading `` (`<name>`): `` or `(<name>): `` prefix from
// the text when the parenthesised name matches one of the fields —
// same rationale, the parenthesised lead-in is auto-injected and
// duplicates the field already on the finding.
//
// In isolate mode (`f.exportsMode === 'isolate'`) ALSO strip a leading
// `[export: <any>] ` or `(<any>): [export: <any>] ` prefix regardless
// of whether the bracketed name matches the finding — both are
// auto-injected by isolate-mode merging and the name there can be a
// sibling export that doesn't match this finding's own field. This
// pass runs BEFORE the per-name passes so the global `[export: name]`
// strip can't decapitate the prefix and leave the `(...): ` lead-in
// stranded.
export function stripExportMarker(text, f) {
  if (!text) return text
  let result = text
  if (f?.exportsMode === 'isolate') {
    // Parens content may include one level of nested `()` (e.g.
    // `` (first branch of `bar()`) ``). `[^()]|\([^()]*\)` allows
    // either a non-paren char or a balanced inner pair; deeper
    // nesting is rare in auto-injected prefixes and refuses to match
    // (leaves the prose intact rather than over-stripping).
    result = result.replace(/^\((?:[^()]|\([^()]*\))*\): \[export:\s*\w+\] /u, '')
    result = result.replace(/^\[export:\s*\w+\] /u, '')
  }
  const names = [f?.exportName, f?.methodName].filter(Boolean)
  for (const name of names) {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    result = result.replaceAll(new RegExp(`\\[export:\\s*${escaped}\\]\\s*`, 'gu'), '')
  }
  for (const name of names) {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    result = result.replace(new RegExp(`^\\(\`?${escaped}\`?\\): `, 'u'), '')
  }
  return result
}

// User-visible label for a finding's export/method location. When a
// finding carries both `exportName` and `methodName` and they differ,
// the label joins them as `exportName.methodName` (a class export with
// a specific method). Matching values collapse to one. Returns '' when
// neither is set.
export function findingDisplayName(f) {
  const e = f?.exportName
  const m = f?.methodName
  if (e && m && e !== m) return `${e}.${m}`
  return e || m || ''
}

// Searchable text for `state.filterInclude`. Joins the user-visible
// fields (file path, description, recommendation, confidence
// reasoning, discovery context) plus the per-finding `repo.github`
// slug — the latter so the search field can match findings by their
// upstream repo (`lodash/lodash`), useful when a merged report mixes
// findings from many node_modules dependencies.
//
// The per-finding triage annotations (`comment` and `fix`) are NOT in
// this base set — they live in `state.triage`, keyed off the finding,
// and folding them in would force `findingText` to import `state`. But
// this module stays free of any `#client/...` import so it can ride
// the lazy graph bundle (see the `fileUrl` note below), so filters.js
// matches the comment and fix fields itself; see matchesFilters there.
export function findingText(f) {
  return [f.file, f.description, f.recommendation, f.confidenceReason, f.discoveredIn, f.repo?.github].filter(Boolean).join('\n').toLowerCase()
}

export function prettyModel(model) {
  if (!model) return model
  return model.replace(/^[^/]+\//u, '').replace(/^claude-/u, '').replaceAll('-', ' ')
}

// One-line per-finding run-meta string — analyzer type, model
// (prettified), reasoning effort, exports mode — joined by ` · `
// with absent fields elided. The same shape repeats across the
// finding-card body, the table row's secondary line, and the
// flat-group / bundle-source meta rows; consolidating here keeps
// the field list, separator, and prettyModel application from
// drifting across call sites.
export function formatRunMeta(f) {
  return [f.type, prettyModel(f.model), f.effort, f.exportsMode].filter(Boolean).join(' · ')
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
// repo, which doesn't carry node_modules sources. `repoFallback` is the
// resolved per-finding URL (stamped at ingest as `_repoFallback`); the
// caller is responsible for OR-ing in `state.repoUrl` when it wants the
// post-ingest single-file-mode URL changes to flow through. Keeping the
// state read at the call site is what lets this module stay free of any
// `#client/...` import — `view/format.js` is in the dependency chain of
// the lazy `ui/graph.js` bundle (via `SEVERITIES` / `formatBytes`), and
// pulling in `state` would drag the whole client aggregator with it.
export function fileUrl(file, githubRepo, repoFallback) {
  if (githubRepo) return `https://github.com/${githubRepo}/blob/HEAD/${stripPackagePrefix(file)}`
  if (isModule(file)) return null
  const base = repoBaseUrl(repoFallback)
  if (!base) return null
  return `${base}/blob/HEAD/${file}`
}

export function fileLink(file, githubRepo, repoFallback) {
  const url = fileUrl(file, githubRepo, repoFallback)
  return url ? html`<a href=${url} target="_blank" rel="noopener">${file}</a>` : file
}

// Returns true only for parseable http:// / https:// URLs. User-
// provided fix values can be plain text ("internal ticket #42",
// "see Slack"), and other schemes (file://, javascript:, data:)
// are either useless or a security footgun — gate the rendered
// `<a>` on this check so non-URL text renders as plain text.
export function isHttpUrl(s) {
  if (typeof s !== 'string' || s.length === 0) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
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
  const base = /^https?:/iu.test(githubRepo)
    ? githubRepo.replace(/\/$/u, '')
    : `https://github.com/${githubRepo}`
  return `${base}/commit/${hash}`
}

// Labeled `Repo / File / Line / Description / Confidence` block for a
// finding `f`. Shared by the copy button, the Claude handoff, and the
// GitHub-issue body so the three actions carry identical text. `repo`
// is resolved by the caller (group.findingRepo) so this stays a pure
// formatter with no `#client/...` dependency (see fileUrl's note on
// keeping this module out of the client aggregator's import chain).
export function handoffBlock(f, repo) {
  const lines = []
  if (repo) lines.push(`Repo: ${repo}`)
  if (f.file) lines.push(`File: ${f.file}`)
  if (f.line !== undefined && f.line !== null && f.line !== '') lines.push(`Line: ${f.line}`)
  if (f.description) lines.push(`Description: ${f.description}`)
  if (f.confidence !== undefined && f.confidence !== null) lines.push(`Confidence: ${f.confidence}/10`)
  return lines.join('\n')
}

// GitHub "new issue" URL with a pre-filled title + body, or null when
// `repo` doesn't resolve to a github.com base. Issues only exist on
// github.com, so a gitlab / bitbucket / self-hosted base (a full URL
// the user typed) can't take this link — returning null there lets the
// caller hide the button rather than render a dead link. `repo` is the
// same slug-or-URL the handoff block's `Repo:` line carries.
export function githubIssueUrl(repo, { title, body } = {}) {
  const base = repoBaseUrl(repo)
  if (!base) return null
  let host
  try { host = new URL(base).host.toLowerCase() } catch { return null }
  if (host !== 'github.com') return null
  const params = new URLSearchParams()
  if (title) params.set('title', title)
  if (body) params.set('body', body)
  const qs = params.toString()
  return qs ? `${base}/issues/new?${qs}` : `${base}/issues/new`
}

// ── GitHub reference linkification for comments ──────────────────────
//
// Free-text triage comments routinely paste a GitHub issue / PR / commit
// URL ("fixed in https://github.com/owner/repo/pull/42"). `parseCommentRefs`
// splits a comment into a flat list of segments — plain `string` runs
// interleaved with `{ url, label }` link tokens — so the renderer can
// wrap only the validated refs in an `<a>` and leave the rest as text.
// Returning data (not markup) keeps the strict-validation logic pure and
// unit-testable, and sits this beside the other github URL builders.
//
// "Strict" = every URL component is checked against GitHub's own naming
// rules before a link is emitted. A bad owner, an over-long repo, a
// non-hex commit, a look-alike host, or an extra path segment all fall
// through to plain text, so we never render a link that 404s or points
// somewhere off github.com. Only canonical
// `https://github.com/<owner>/<repo>/(issues|pull|commit)/<id>` URLs are
// recognised — bare `#123` / `owner/repo#123` shorthand needs a repo
// context the comment doesn't carry, so it's intentionally left alone.

// GitHub login (user / org): alphanumeric or single hyphens, no leading
// or trailing hyphen, no consecutive hyphens. Length (≤39) is checked
// separately so the pattern stays readable.
const GH_OWNER_RE = /^[a-z\d](?:-?[a-z\d])*$/iu
// Repo name: chars from [A-Za-z0-9._-]; `.` / `..` are reserved. Length
// (≤100) and the reserved names are checked alongside the pattern.
const GH_REPO_RE = /^[a-z\d._-]+$/iu
// Issue / PR number: positive, no leading zero, capped at 10 digits so a
// long digit run in prose can't masquerade as an issue reference.
const GH_NUM_RE = /^[1-9]\d{0,9}$/u
// Commit SHA: abbreviated (7) through full (40) hex, either case.
const GH_SHA_RE = /^[\da-f]{7,40}$/iu
// On-page fragment anchor (the URL "hash"), including its leading `#`:
// word characters + hyphens, matching GitHub's own anchor ids
// (`#issuecomment-123`, `#discussion_r…`, `#diff-<hex>R10`, `#L42`).
const GH_ANCHOR_RE = /^#[\w-]+$/u

function isValidOwner(s) { return s.length <= 39 && GH_OWNER_RE.test(s) }
function isValidRepo(s) { return s.length <= 100 && s !== '.' && s !== '..' && GH_REPO_RE.test(s) }

// Validate one candidate URL string and, on success, return its
// `{ url, label }` link token — a canonical href plus a GitHub-style
// short label (`owner/repo#123` for issues / PRs, `owner/repo@sha` for
// commits). Returns null for anything that isn't a strict issue / PR /
// commit URL on github.com.
function githubRefToken(candidate) {
  let u
  try { u = new URL(candidate) } catch { return null }
  // Anti-mutation safeguard: only accept a candidate that is ALREADY in
  // its canonical parsed form. `new URL` silently rewrites its input —
  // resolving `..`/`.` path segments, lower-casing scheme + host,
  // dropping a default `:443`, punycoding IDN homographs (`gіthub.com`),
  // turning `\` into `/`, stripping tabs/newlines — any of which can let
  // a non-canonical or look-alike string "round up" into a passing ref.
  // If the re-serialised URL differs from what we scanned, it wasn't
  // canonical, so reject it rather than linkify a target the reader
  // never actually typed. Every legitimate ref round-trips unchanged.
  if (u.href !== candidate) return null
  // https only, exact host, no embedded credentials or explicit port —
  // anything else is either insecure or a look-alike (`github.com@evil`,
  // `github.com:8080`) that shouldn't be presented as a github link.
  if (u.protocol !== 'https:') return null
  if (u.hostname.toLowerCase() !== 'github.com') return null
  if (u.port || u.username || u.password) return null
  // Path must be exactly /<owner>/<repo>/<kind>/<id>. `..`/`.` traversal
  // can't reach here — the round-trip guard above rejects any path the
  // parser had to normalise. A single trailing slash is tolerated; any
  // deeper path (`/pull/42/files`) is rejected so we only linkify the
  // precise thing we can name.
  const parts = u.pathname.split('/')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length !== 5) return null
  const [, owner, repo, kind, id] = parts
  if (!isValidOwner(owner) || !isValidRepo(repo)) return null
  let label
  if (kind === 'issues' || kind === 'pull') {
    if (!GH_NUM_RE.test(id)) return null
    label = `${owner}/${repo}#${id}`
  } else if (kind === 'commit') {
    if (!GH_SHA_RE.test(id)) return null
    label = `${owner}/${repo}@${id.slice(0, 7)}`
  } else {
    return null
  }
  // Canonical href: rebuilt from the validated components (query string
  // always dropped). A fragment is preserved only when it's a plausible
  // GitHub on-page anchor — `#issuecomment-123`, `#discussion_r…`,
  // `#diff-<hex>`, `#L42`, etc.: word characters and hyphens. Anything
  // else (encoded payloads, slashes, dots) is dropped rather than carried
  // through, so the fragment can't smuggle junk into the href.
  const hash = GH_ANCHOR_RE.test(u.hash) ? u.hash : ''
  const href = `https://github.com/${owner}/${repo}/${kind}/${id}${hash}`
  return { url: href, label }
}

// Candidate-URL scanner: an `http(s)://` run of URL-legal characters.
// Stricter than a blanket `\S+` — it stops at whitespace AND at the
// wrapper / "unwise" characters (`<> " ' \` ( ) { } [ ] | \ ^`) that bound
// a URL inside prose or markdown, so a ref wrapped in `<…>`, `"…"`,
// \`…\`, `(…)` or `{…}` is captured cleanly without dragging the wrapper
// in. (A trailing backtick in particular used to be percent-encoded into
// the path by `new URL` and break validation.) `:` and `@` stay inside
// the class so credential / port look-alikes still reach githubRefToken,
// which remains the authoritative gate for scheme / host / port / creds.
const URL_SCAN_RE = /https?:\/\/[^\s<>"'`(){}[\]|\\^]+/giu
// Trailing prose punctuation trimmed off a candidate before validation,
// so a URL closing a sentence (`…/pull/42).`) or wrapped in markdown
// emphasis (`*…/pull/42*`) still resolves. None of these characters can
// appear in a valid owner / repo / number / sha, so trimming never
// corrupts an otherwise-valid reference.
const GH_TRAILING_PUNCT_RE = /[).,!?;:'"*\]}>]+$/u

// Split `text` into the segment list described above: alternating plain
// `string` runs and validated `{ url, label }` link tokens. A comment
// with no recognised github URL (the common case) comes back as a single
// `[text]` entry; empty / non-string input yields `[]`.
export function parseCommentRefs(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const segments = []
  let lastIndex = 0
  URL_SCAN_RE.lastIndex = 0
  let m
  while ((m = URL_SCAN_RE.exec(text)) !== null) {
    const trimmed = m[0].replace(GH_TRAILING_PUNCT_RE, '')
    const token = trimmed ? githubRefToken(trimmed) : null
    if (token) {
      if (m.index > lastIndex) segments.push(text.slice(lastIndex, m.index))
      segments.push(token)
      lastIndex = m.index + trimmed.length
      URL_SCAN_RE.lastIndex = lastIndex
    }
    // A non-match leaves the run as text; the loop resumes after it
    // (URL_SCAN_RE.lastIndex already points past the full run).
  }
  if (lastIndex < text.length) segments.push(text.slice(lastIndex))
  return segments
}
