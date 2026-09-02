import { fenceRanges, inFence, unescapeMd } from '../../common/md-structure.js'
import { html, nothing } from './frontend-global.js'
// Direct relative import, NOT `#client/index.js`: this module rides in
// the lazy `ui/graph.js` bundle, and the aggregator would drag `state`
// and the whole client layer in with it (see fileUrl's note below).
// `client/finding-link.js` is a leaf — its only import is
// `common/utf8.js` — so pulling it in costs the codec and nothing else.
import { parseFindingUrl } from '../../client/finding-link.js'

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

// ── Corrected severity ───────────────────────────────────────────────
// A finding may carry an application-specific `correctedSeverity` (plus a
// free-text `correctedSeverityReason`) emitted in the report data — a
// per-report re-rating of the analyzer's intrinsic `severity`. Unlike
// `severity` (which is hashed into the finding id, so it's identical for
// every occurrence of an id — see common/finding-id.js), the corrected
// value is PER-REPORT: the same finding id can carry a different corrected
// severity in different reports. When the same id is deduped across
// reports at ingest, each occurrence's effective severity is preserved on
// the survivor in `f._correctedByReport` (a { [reportName]: { severity,
// reason } } map) so the divergence stays visible; see ingest.js.
//
// These helpers are the SINGLE place every display / count / sort consumer
// resolves severity through, so the original-vs-corrected switch and the
// invalid-tier fallback are defined once. Severity used for IDENTITY
// (the id fingerprint, dedupe keys) must stay raw `f.severity` and never
// route through here. This module stays free of any `#client/...` import
// (it rides the lazy graph bundle — see fileUrl's note), so the switch
// MODE is passed in by callers (`state.severityMode`) rather than read
// from `state` here.

// A corrected value is honored only when it names a known tier; an
// unrecognised string (some importers don't validate severities) falls
// back to the intrinsic severity rather than sorting to rank 0 and
// rendering an uncolored badge.
function validCorrected(corrected) {
  return corrected != null && corrected in SEVERITY_ORDER ? corrected : null
}

// The finding's own effective severity — its corrected value when valid,
// else the intrinsic severity. The finding object always carries its own
// report's correction (it IS that report's finding), so no report key is
// needed here; cross-report divergence is surfaced via correctedVariants.
export function effectiveSeverity(f) {
  return validCorrected(f?.correctedSeverity) ?? f?.severity
}

// True when the finding carries a valid correction that actually changes
// the tier — the trigger for the dual badge / reason affordance.
export function hasSeverityCorrection(f) {
  const c = validCorrected(f?.correctedSeverity)
  return c != null && c !== f?.severity
}

// Switch-aware accessor: every display / count / sort site calls this with
// the current mode (`state.severityMode`) instead of reading `f.severity`.
// `'original'` shows the intrinsic value; anything else (default
// `'corrected'`) shows the effective value.
export function displayedSeverity(f, mode) {
  return mode === 'original' ? f?.severity : effectiveSeverity(f)
}

// Per-report effective-severity map for a deduped survivor, returned ONLY
// when the correction diverges across the reports the id appeared in
// (size > 1 distinct tiers). Drives the "varies across reports" hint and
// its tooltip. `null` when there's no map or no divergence.
export function correctedVariants(f) {
  const byReport = f?._correctedByReport
  if (!byReport) return null
  const tiers = new Set(Object.values(byReport).map((v) => v?.severity))
  return tiers.size > 1 ? byReport : null
}

// ── Revalidation ─────────────────────────────────────────────────────
// A second pass over a finding. A report stamps `revalidate` with what
// that pass concluded — `confirmed` (the finding stands), `partial`
// (part of it does), `refuted` (it doesn't), `unreachable` (nothing
// can get to the code it's in), `unknown` (the pass couldn't tell) —
// and carries its reasoning in `revalidateVerdict`, plus, for a
// refutation, what to do about it in `revalidateRecommendation`.
//
// The remaining value, `revalidation`, marks the row that IS the
// revalidation pass rather than one it judged. It carries no verdict of
// its own; what it gets instead is first place in its group (group.js
// sortTabs), because a reader opening a finding that was re-examined
// wants the re-examination, not whichever original row happened to
// outrank the others — and its own name in the run-meta line
// (formatRunMeta below), which is where a card says which run a row
// came from.
//
// Values are case-folded and trimmed: these arrive from JSON a report
// generator wrote, and an unrecognised one answers "no stamp" rather
// than leaking into a display.
// Every value the field can carry.
export const REVALIDATE_KINDS = ['revalidation', 'refuted', 'unreachable', 'confirmed', 'partial', 'unknown']
const REVALIDATE_SET = new Set(REVALIDATE_KINDS)

// ── The revalidation LAYER ───────────────────────────────────────────
// All of the above is a lens, and the toolbar's "App" switch takes it
// off. With the pass applied, the findings are about the running APP:
// what it can actually reach, re-rated by a second look. Without it
// they are about the CODE as written — every issue the analyzer found,
// including the ones the app happens not to expose today. Those are
// still real, and a reader auditing the source wants them back, so the
// whole layer comes off with one switch rather than a filter per
// consequence of it.
//
// Off, `revalidateKind` answers '' for every row, which is what takes
// the layer off everywhere at once: no stamp on the card, no promotion
// of the pass's row in a group, no verdict voiding a confidence, no
// outcome for the toolbar dropdown to offer (so the block falls back
// to the plain Confidence range), and nothing for the run-meta line to
// name. The two callers that must see the field WHATEVER the switch
// says — the pass that hides the pass's own rows, and the scan that
// decides whether to offer the switch at all — read `rawKind` through
// the two exports below it.
//
// The flag is module state, set once per render by render.js from
// `state.showRevalidation` (see configureDepsDir below for the same
// pattern and the reason: this module stays free of any `#client/...`
// import so it can ride the lazy graph bundle). It defaults to ON, so
// a consumer reaching a helper before the first render — the headless
// API, a deep link — sees the app view, which is the default anyway.
let revalidationOn = true

export function configureRevalidation(on) { revalidationOn = on !== false }

// Whether the layer is applied right now. For the display sites that
// read a `revalidate*` field directly rather than going through
// `revalidateKind` — the verdict and the pass's recommendation.
export function revalidationShown() { return revalidationOn }

function rawKind(f) {
  const v = typeof f?.revalidate === 'string' ? f.revalidate.trim().toLowerCase() : ''
  return REVALIDATE_SET.has(v) ? v : ''
}

// The row's revalidation outcome, case-folded, or '' when it carries
// none — which includes an unrecognised value, so a typo in a report
// can't reach a display or the filter dropdown, and every row once the
// layer is off.
export function revalidateKind(f) {
  return revalidationOn ? rawKind(f) : ''
}

// Does this row carry a revalidation stamp AT ALL — the raw field,
// read past the switch. Gates the switch itself (render.js): a set
// with nothing to reveal doesn't need the control, and one that has
// something must keep offering it after the layer is off, or there
// would be no way back.
export function hasRevalidateField(f) { return rawKind(f) !== '' }

// Is this row the pass itself — again raw, because taking the layer
// off means dropping exactly these rows (group.js), which can't be
// done through a reader that has already stopped seeing them.
export function isRevalidationRow(f) { return rawKind(f) === 'revalidation' }

// The verdict this row was stamped with, or null when it carries none
// — which includes the revalidation row itself, since `revalidation`
// names the pass and isn't a judgement on anything.
export function revalidateStamp(f) {
  const kind = revalidateKind(f)
  return kind && kind !== 'revalidation' ? kind : null
}

export function isRevalidation(f) {
  return revalidateKind(f) === 'revalidation'
}

// The verdicts that VOID a row's confidence for the range filter — the
// one place a verdict changes more than a display (see filters.js).
// Both say the finding isn't a finding: `refuted` that it doesn't
// hold, `unreachable` that nothing can get to the code it's in. A
// number attached to either is a claim the pass withdrew, so the
// filter reads it as 0 rather than letting it speak for the group.
const CONFIDENCE_VOIDING = new Set(['refuted', 'unreachable'])

export function voidsConfidence(f) {
  return CONFIDENCE_VOIDING.has(revalidateKind(f))
}

// What the toolbar dropdown offers, in the order it lists them —
// answers to "did the pass leave this standing", running from yes to
// no. Fewer options than the field has values:
//
//   * the `revalidation` row rides CONFIRMED — it is the pass itself,
//     re-examining a finding it did not knock down, which is the same
//     answer to that question;
//   * `partial` rides it too. A partial confirmation is a yes to
//     "does this still stand" — the pass narrowed the finding rather
//     than knocking it down — and an option of its own would slice
//     the standing findings in two for a distinction the reader wants
//     the STAMP for, not a filter. It keeps its own stamp on the card.
//   * `unknown` gets no option — a pass that couldn't tell hasn't
//     answered it at all, so there is nothing to filter to. Those rows
//     stay visible with no filter on, like every other row.
export const REVALIDATE_FILTERS = [
  { value: 'confirmed', label: 'Confirmed', kinds: ['confirmed', 'partial', 'revalidation'] },
  { value: 'unreachable', label: 'Unreachable', kinds: ['unreachable'] },
  { value: 'refuted', label: 'Refuted', kinds: ['refuted'] },
]

// The kinds one dropdown value covers, or null when the value names no
// option — filters.js reads that as "no filter" rather than hiding
// every finding behind a value it can't interpret.
export function revalidateFilterKinds(value) {
  return REVALIDATE_FILTERS.find((o) => o.value === value)?.kinds ?? null
}

// How finely Confirmed is drawn, once it has taken the partial rows
// in. The toolbar cycles a chip through these inside the Confirmed row
// (revalidate-filter.js), because "did this survive" and "how
// completely" are one question asked twice, not two filters — and the
// second only has an answer once the first is Confirmed.
export const PARTIAL_MODES = ['', 'exclude', 'only']

// The kinds an outcome selection ACTUALLY matches, with that switch
// applied. All three are the same shape as every other filter here —
// a list of kinds, matched existentially over the group — so the chip
// narrows what Confirmed reaches rather than subtracting from it:
//
//   ''         everything the pass left standing: the row that IS the
//              pass, the full confirmations, the partial ones;
//   'exclude'  the full confirmations only. NOT "everything but the
//              partials": a group is shown for carrying a `confirmed`
//              row, not for lacking a `partial` one, so the pass row
//              on its own no longer stands in for a verdict;
//   'only'     the partial ones.
//
// It bites only on an option that took the partial rows in —
// Confirmed — so a mode left set from an earlier selection can't
// silently narrow Refuted or Unreachable, and callers can pass it
// through without checking which option is up.
export function activeRevalidateKinds(value, partialMode) {
  const kinds = revalidateFilterKinds(value)
  if (!kinds?.includes('partial')) return kinds
  if (partialMode === 'only') return ['partial']
  if (partialMode === 'exclude') return ['confirmed']
  return kinds
}

// The options worth offering for a given set of present kinds: the
// toolbar hands this list to the dropdown, and drops the control
// entirely when it comes back empty — a report whose pass only ever
// answered `unknown` has nothing here to choose between.
export function reachableRevalidateFilters(kinds) {
  const present = new Set(kinds)
  return REVALIDATE_FILTERS.filter((o) => o.kinds.some((k) => present.has(k)))
}

// "Module" = third-party dependency. Recognised vendor-directory
// layouts, in detection precedence: `node_modules/` (npm/pnpm/yarn),
// `vendor/` (PHP Composer, Go modules), and the generic
// `dependencies/`. Several can occur side-by-side in the same project
// — and `dependencies/` (or `vendor/`) may itself be a regular source
// dir — so ONE active deps dir is chosen contextually: prefer
// `node_modules` when ANY loaded path has it, else `vendor`, else fall
// back to `dependencies`. Committing to the most specific present
// marker avoids misclassifying an ordinary source folder as
// third-party.
//
// `configureDepsDir(reports)` is called from render.js at the start
// of every render; the helpers below (isModule / stripPackagePrefix
// / packageOf via depsDirName) consult `depsDir` so reclassifying
// happens once per render, not per call. The matchers are cached on
// `depsDir` (rebuilt only when it changes) so the hot `isModule` path
// stays a single stateless `RegExp.test`.

// Segment matcher `(^|/)<dir>/` — `dir` must be a whole path segment,
// so `vendor/` matches `app/vendor/x` but not `my-vendor-lib/x`.
function depsSegRe(dir) { return new RegExp(`(^|/)${dir}/`, 'u') }
// Package-prefix matcher `<dir>/<pkg>/<rest>` where `<pkg>` is a bare
// name or an `@scope/name` pair; captures `<rest>` for stripping.
function depsStripRe(dir) { return new RegExp(`^(?:.*/)?${dir}/(?:@[^/]+/[^/]+|[^/]+)/(.*)$`, 'u') }

// Detection matchers for the two non-fallback markers, built once.
const NODE_MODULES_RE = depsSegRe('node_modules')
const VENDOR_RE = depsSegRe('vendor')

let depsDir = 'node_modules'
let moduleRe = depsSegRe(depsDir)
let stripRe = depsStripRe(depsDir)

function setDepsDir(dir) {
  if (dir === depsDir) return
  depsDir = dir
  moduleRe = depsSegRe(dir)
  stripRe = depsStripRe(dir)
}

export function configureDepsDir(reports) {
  let hasNodeModules = false
  let hasVendor = false
  // Returns true once `node_modules` is seen — the highest-precedence
  // marker, so scanning can stop the moment it appears.
  const note = (s) => {
    if (!hasNodeModules && NODE_MODULES_RE.test(s)) hasNodeModules = true
    if (!hasVendor && VENDOR_RE.test(s)) hasVendor = true
    return hasNodeModules
  }
  outer: for (const r of reports) {
    for (const g of r.groups ?? []) {
      for (const f of g) if (note(f.file)) break outer
    }
    if (r.tree) {
      for (const p of Object.keys(r.tree)) if (note(p)) break outer
    }
  }
  setDepsDir(hasNodeModules ? 'node_modules' : hasVendor ? 'vendor' : 'dependencies')
}

export function depsDirName() { return depsDir }

export function isModule(file) {
  return moduleRe.test(file)
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
// Uses the active `depsDir` (via the cached `stripRe`) so a
// `dependencies/` path is only stripped when that's what the
// project's vendor dir actually is.
export function stripPackagePrefix(file) {
  return file.match(stripRe)?.[1] ?? file
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
// fields (file path, title, description, impact, reproduction,
// recommendation, confidence reasoning, revalidation verdict + its
// stamp, discovery context) plus the per-finding `repo.github`
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
  // The pass's own words come out of the haystack with the layer: a
  // search shouldn't match text the card isn't showing.
  const reval = revalidationOn ? [revalidateStamp(f), f.revalidateVerdict, f.revalidateRecommendation] : []
  return [f.file, f.title, f.description, f.impact, f.reproduction, evidenceMarkdown(f), f.recommendation, f.confidenceReason, ...reval, f.discoveredIn, f.repo?.github].filter(Boolean).join('\n').toLowerCase()
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
//
// The revalidation row names itself right after the mode it ran in
// (`security · revalidate · opus 5 · …`): the run that produced it is
// that mode's revalidation pass, and the meta line is where this card
// says which run a row came from. Only that row — a verdict row was
// produced by the pass but is not it, and stamping every judged
// finding here would say nothing the rail's stamp doesn't already.
export function formatRunMeta(f) {
  return [f.type, isRevalidation(f) ? 'revalidate' : '', prettyModel(f.model), f.effort, f.exportsMode]
    .filter(Boolean).join(' · ')
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

// A bare package reference — `name@1.2.3` or `@scope/name@1.2.3` —
// names a DEPENDENCY, not a path inside any repository (piolium `Key
// code` lines cite vulnerable packages this way). The shape is strict:
// the only allowed slash is the scope separator, so a real path with an
// `@` in a segment (`src/@types/x.d.ts`) never matches.
const PKG_REF_RE = /^(?:@[\w.-]+\/)?[\w.-]+@[^/\s@]+$/u
export function isPkgRef(file) {
  return PKG_REF_RE.test(file || '')
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
// A package-reference "file" links to nothing — blob-linking
// `.../blob/HEAD/name@1.2.3` under either repo would 404.
export function fileUrl(file, githubRepo, repoFallback) {
  if (isPkgRef(file)) return null
  if (githubRepo) return `https://github.com/${githubRepo}/blob/HEAD/${stripPackagePrefix(file)}`
  if (isModule(file)) return null
  const base = repoBaseUrl(repoFallback)
  if (!base) return null
  return `${base}/blob/HEAD/${file}`
}

// File-level link for a finding's path — the file headers the list /
// grouped views stack their cards under. Same target as the finding's
// own `findingUrl` minus the line anchor, so a header and the line
// links under it resolve to one revision of one file rather than two.
// Plain text (no `<a>`) when there's nothing to link against.
export function fileLink(f, repoFallback) {
  const file = f?.file ?? ''
  const url = findingUrl(f, repoFallback)
  if (!url) return file
  return html`<a href=${stripLineAnchor(url)} target="_blank" rel="noopener">${file}</a>`
}

// Drop a trailing `#L42` / `#L10-L20` anchor: a file-level link wants
// the file, not the line one finding in it sits on. Any other fragment
// is left alone — it isn't ours to interpret.
function stripLineAnchor(url) {
  return url.replace(/#L\d+(?:-L?\d+)?$/u, '')
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

// Source URL for ONE finding's location — every finding-level file /
// line link routes through here so they all resolve the same target.
//
// A markdown import carries the report's OWN link in `f.location` (the
// `[file:lines](url)` ref of `## Evidence` / `## Location`): an exact
// ref, usually pinned to the commit the report was produced from, with
// the line anchor already on it. That beats the `fileUrl()`
// reconstruction, which can only pin `HEAD` — a different revision, and
// a 404 once the path moves — and which yields nothing at all for the
// claude-security reports that name no repository. Non-http `location`
// values (parse-piolium's `piolium:<id>` placeholder) fall through to
// the reconstruction, as do JSON findings, which carry no `location`.
// Returns null when neither source yields a URL.
export function findingUrl(f, repoFallback) {
  if (!f) return null
  if (isHttpUrl(f.location)) return f.location
  const url = fileUrl(f.file, f.repo?.github, repoFallback)
  if (!url) return null
  const lineNum = parseInt(f.line, 10)
  return Number.isFinite(lineNum) ? `${url}#L${lineNum}` : url
}

// Reports hard-wrap their markdown, so a paragraph arrives carrying the
// line breaks the author's editor happened to put in. Markdown reads
// those as SOFT breaks — they reflow — and honouring them literally
// renders a column of ragged short lines inside a card that is wider
// than the source was. `flowText` joins each paragraph back into one
// run, leaving the blank lines between paragraphs alone.
//
// A paragraph is left EXACTLY as written when any of its lines opens
// something block-level — an indented (code) line, a list marker, a
// fence, a quote, a heading, a table row. Those are the constructs
// whose line breaks carry meaning (a piolium PoC snippet, a list of
// affected files), and `.desc` / `.section-body` keep `pre-wrap` so
// they still render as the report wrote them. (The fence alternatives
// are belt-and-braces: `flowText` carves every FENCED block out before
// a line reaches here, so a fence line no longer arrives on this path.)
const BLOCK_LINE_RE = /^(?:\s+\S|[-*+] |\d+[.)] |>|#{1,6} |\||`{3}|~{3})/u

function flowParagraphs(text) {
  // The capturing split keeps the blank-line runs, so paragraph
  // spacing survives the rejoin untouched.
  return text.split(/(\n{2,})/u).map((chunk) => {
    if (/^\n+$/u.test(chunk)) return chunk
    const lines = chunk.split('\n')
    if (lines.some((l) => BLOCK_LINE_RE.test(l))) return chunk
    return lines.map((l) => l.trim()).filter(Boolean).join(' ')
  }).join('')
}

// One run of prose beside a fenced block. The newlines on a side a
// fence abuts are peeled off and re-attached around the reflow: that
// break is what puts the fence on its own line, and `flowParagraphs`
// — which drops the empty line its split leaves at either edge —
// would otherwise weld the prose onto the fence.
function flowRun(run, keepLead, keepTail) {
  const lead = keepLead ? /^\n*/u.exec(run)[0] : ''
  const body = run.slice(lead.length)
  const tail = keepTail ? /\n*$/u.exec(body)[0] : ''
  return lead + flowParagraphs(body.slice(0, body.length - tail.length)) + tail
}

// Fenced code is exempt from all of the above: its line breaks are the
// snippet. Paragraph reflow can't be trusted to leave one alone on its
// own — a block carrying a BLANK line (a PoC with a gap between setup
// and trigger) splits into paragraphs, and the halves that hold no
// fence line read as ordinary hard-wrapped prose and get folded into
// one line. So the fenced ranges come out first (the same reading the
// parsers use — common/md-structure.js) and only the prose between
// them is reflowed, which also means prose sharing a paragraph with a
// snippet now flows instead of being pinned by it.
export function flowText(text) {
  if (!text) return text
  const ranges = fenceRanges(text)
  if (ranges.length === 0) return flowParagraphs(text)
  const out = []
  let last = 0
  for (const [start, end] of ranges) {
    if (start > last) out.push(flowRun(text.slice(last, start), last > 0, true))
    out.push(text.slice(start, end))
    last = end
  }
  if (last < text.length) out.push(flowRun(text.slice(last), true, false))
  return out.join('')
}

// Split a description body into the sections the report wrote it in.
// A paragraph that OPENS with a `**Label:**` prefix is one: that is how
// every parser emits its narrative fields — parse-piolium's `**Root
// Cause:**` / `**Severity note:**` / `**Note:**` and friends (any label
// the source report carried), parse-md's `**Impact:**` /
// `**Reproduction:**` — so keying off the emitted markup, rather than
// matching label words, picks up whatever a report names its sections.
// The card gives each a small-caps header + body block instead of one
// bold run buried in the prose (render-finding.js sectionTemplate).
//
// Everything else is prose: consecutive unlabelled paragraphs stay in
// ONE block so their blank-line spacing survives. A label with nothing
// after it keeps its header and gets an empty body. Returns
// `[{ label, body }]` in document order, `label` null for prose.
const SECTION_LABEL_RE = /^\*\*([^*\n]+):\*\*[ \t]*/u

// Paragraph split — blank lines, but only the ones OUTSIDE a fenced
// code block. A snippet may carry blank lines of its own, and cutting
// there would tear the block in two: the opening fence would end up in
// one section and the closing one in the next, so neither half renders
// as code and both show their bare fence markers.
function paragraphs(text) {
  const ranges = fenceRanges(text)
  if (ranges.length === 0) return text.split(/\n{2,}/u)
  const parts = []
  let last = 0
  for (const m of text.matchAll(/\n{2,}/gu)) {
    if (inFence(ranges, m.index)) continue
    parts.push(text.slice(last, m.index))
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return parts
}

export function descriptionSections(body) {
  const sections = []
  for (const para of paragraphs(body || '')) {
    if (!para.trim()) continue
    const m = SECTION_LABEL_RE.exec(para)
    if (m) {
      sections.push({ label: m[1].trim(), body: para.slice(m[0].length).trim() })
      continue
    }
    const open = sections.at(-1)
    if (open && open.label === null) open.body += `\n\n${para}`
    else sections.push({ label: null, body: para })
  }
  return sections
}

// ── Fenced code blocks ───────────────────────────────────────────────
// Reports embed snippets — a piolium PoC, the vulnerable lines a
// claude-security finding quotes — as fenced blocks, and the parsers
// carry them into the description verbatim. Split a body into the
// prose runs and the fenced blocks between them, so the card can draw
// each block as a real `<pre>` instead of leaving the fence markers to
// print as literal text with the inline pass chipping up whatever
// quotes and backticks the snippet happened to contain.
//
// Prose runs come back as plain strings and blocks as `{ lang, code }`
// — the same string-or-token shape parseCommentRefs returns. `code` is
// the content between the fences, verbatim. `lang` is the info
// string's first word, case-folded (```TS and ```ts are one language)
// and '' when the fence named none or named something that isn't a
// language tag: a bare word is a language, while the filename or
// `{highlight: 1-3}` attribute block other renderers accept there is
// not, and stamping one onto the block's label would print noise.
//
// The newlines BETWEEN a block and the prose around it are dropped
// with the fences. They exist to put the fence on its own line, and
// the block is a `<pre>` that carries its own margins — while the
// prose around it renders into a `white-space: pre-wrap` box, which
// would print each of those newlines as a blank line above and below
// every block.
//
// Text with no fence in it comes back as a single-element array
// holding it unchanged, so the caller can take a plain-text fast path.
// Pairing is `fenceRanges`' (common/md-structure.js), the same reading
// the parsers use — so what a parser treated as code is what the card
// draws as code, an unclosed fence running to end of input included.
const FENCE_LINE_RE = /^( *)(`{3,}|~{3,})(.*)$/u
const LANG_TAG_RE = /^[a-z0-9+#._-]{1,20}$/u

// Up to `n` leading spaces off a line — the shed markdown gives a
// fenced block's content, which is "up to" rather than "exactly"
// because a line may start left of its own fence (a blank-ish line
// padded with fewer spaces) and there is nothing there to remove.
function shedIndent(line, n) {
  let i = 0
  while (i < n && line[i] === ' ') i++
  return line.slice(i)
}

function fencedBlock(raw) {
  const lines = raw.split('\n')
  // `fenceRanges` only ever opens a range on a fence line, so the
  // match is there; the `?.` keeps this readable rather than resting
  // the whole function on that.
  const open = FENCE_LINE_RE.exec(lines[0])
  const marker = (open?.[2] ?? '```').slice(0, 3)
  const tag = (open?.[3] ?? '').trim().split(/\s+/u)[0].toLowerCase()
  // The last line is the CLOSING fence unless the block dangles at end
  // of input — and a dangling one can still end on a fence line of the
  // other marker (a ``` inside a ~~~ block is content), so the marker
  // has to match for the line to be chrome rather than code.
  const close = lines.length > 1 ? FENCE_LINE_RE.exec(lines.at(-1)) : null
  const closed = Boolean(close?.[2].startsWith(marker))
  // A block written under a list item is indented to that item's text,
  // and that indentation belongs to the LIST, not to the snippet:
  // markdown sheds the opening fence's indent from every line of the
  // content, and so must we. Kept as written otherwise the `<pre>`
  // prints the whole snippet shifted right, its own relative
  // indentation buried under the step number's, and copying a line out
  // of it pastes the list's whitespace along with the code.
  const indent = open?.[1].length ?? 0
  const body = lines.slice(1, closed ? -1 : undefined)
  return {
    lang: LANG_TAG_RE.test(tag) ? tag : '',
    code: (indent > 0 ? body.map((l) => shedIndent(l, indent)) : body).join('\n'),
  }
}

export function codeBlockSegments(text) {
  const ranges = fenceRanges(text || '')
  if (ranges.length === 0) return [text]
  const segments = []
  let last = 0
  const pushProse = (raw, afterBlock) => {
    const prose = (afterBlock ? raw.replace(/^\n+/u, '') : raw).replace(/\n+$/u, '')
    if (prose) segments.push(prose)
  }
  for (const [start, end] of ranges) {
    if (start > last) pushProse(text.slice(last, start), last > 0)
    segments.push(fencedBlock(text.slice(start, end)))
    last = end
  }
  if (last < text.length) pushProse(text.slice(last), true)
  return segments
}

// ── Lists ────────────────────────────────────────────────────────────────
// Reproduction steps, affected-file rundowns, a recommendation's
// alternatives — the narrative fields arrive as markdown lists as
// often as prose. They used to render as their own source text: the
// `.` after the number sitting in the run of prose, every item hanging
// at the left margin, a wrapped item indistinguishable from the next
// one. So the lists come out here and the card draws them as lists.
//
// `listSegments` splits a body into list blocks and the runs between
// them, and each item's content comes back with the marker and the
// item's indentation shed — which makes it a small markdown body of
// its own, rendered by the same pass that rendered the whole. That
// recursion is what gets a nested list, a wrapped step, or a fenced
// snippet under a step (the shape that started all this) drawn INSIDE
// its item rather than after the list.
//
// Text with no list in it comes back as a single-element array holding
// it unchanged, the same fast path codeBlockSegments offers.
const LIST_ITEM_RE = /^( *)(?:[-*+]|(\d{1,9})[.)]) +(?=\S)/u
// `* * *` and `- - -` are horizontal rules, not one-item lists.
const HRULE_RE = /^ {0,3}([-*_])(?: *\1){2,} *$/u

function leadingSpaces(line) { return /^ */u.exec(line)[0].length }

// Trailing blank lines belong to the gap after an item, not to it.
function trimTrailingBlank(lines) {
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  return lines.slice(0, end).join('\n')
}

export function listSegments(text) {
  const src = typeof text === 'string' ? text : ''
  if (!src) return [text]
  const ranges = fenceRanges(src)
  const lines = src.split('\n')
  // Line → byte offset, so a candidate marker can be checked against
  // the fenced ranges: a `- ` or `1. ` inside a snippet is code.
  const offsets = []
  let at = 0
  for (const line of lines) { offsets.push(at); at += line.length + 1 }
  const startsItem = (i) => !inFence(ranges, offsets[i])
    && !HRULE_RE.test(lines[i])
    && LIST_ITEM_RE.test(lines[i])

  const out = []
  let proseFrom = 0
  let i = 0
  const pushProse = (until) => {
    const run = lines.slice(proseFrom, until).join('\n').replace(/^\n+/u, '').replace(/\n+$/u, '')
    if (run.trim()) out.push(run)
  }

  while (i < lines.length) {
    if (!startsItem(i)) { i++; continue }
    pushProse(i)
    const first = LIST_ITEM_RE.exec(lines[i])
    const ordered = Boolean(first[2])
    const items = []
    // The open item: the column its continuation lines sit at, and the
    // content collected so far with that column shed.
    let item = null
    let afterBlank = false
    while (i < lines.length) {
      const line = lines[i]
      // Inside a fence nothing is structural — not a blank line, not a
      // marker, not a dedent. The snippet is the item's content.
      if (!inFence(ranges, offsets[i])) {
        if (!line.trim()) { item.lines.push(''); afterBlank = true; i++; continue }
        const indent = leadingSpaces(line)
        const marker = HRULE_RE.test(line) ? null : LIST_ITEM_RE.exec(line)
        // A marker indented AT LEAST to the open item's text is a
        // nested list inside it; one to the left of that is the next
        // item of this list — unless it switches between bullets and
        // numbers, which starts a list of its own.
        if (marker && (!item || indent < item.column)) {
          if (Boolean(marker[2]) !== ordered) break
          if (item) items.push(trimTrailingBlank(item.lines))
          item = { column: marker[0].length, lines: [line.slice(marker[0].length)] }
          afterBlank = false
          i++
          continue
        }
        // Back at the margin after a blank line: the list is over. Without
        // the blank it's a wrapped item, which markdown reads as part of
        // the item however far left the report wrapped it to.
        if (indent < item.column && afterBlank) break
      }
      item.lines.push(shedIndent(line, item.column))
      afterBlank = false
      i++
    }
    if (item) items.push(trimTrailingBlank(item.lines))
    // The first number is the one that counts — markdown numbers the
    // rest in sequence from it, so a rundown that opens at `10.` keeps
    // its place in the sequence and one that opens at `1.` needs no
    // start at all.
    out.push({ ordered, start: ordered ? Number(first[2]) : null, items })
    proseFrom = i
  }
  if (out.length === 0) return [text]
  pushProse(lines.length)
  return out
}

// ── Source snippet ───────────────────────────────────────────────────
// A window of `radius` lines either side of `line`, for the preview
// that opens beside a finding's code links (render-finding.js
// codePreviewTemplate; focus-code.js fetches the file itself).
//
// Comes back with the number the window STARTS at, because a snippet
// without its line numbers is a snippet the reader can't place against
// the `file:42` they clicked it from. Both ends clamp to the file, so
// a finding on line 2 doesn't open on a gutter counting from -2, and
// one on the last line still gets its leading context. A file shorter
// than the window is returned whole.
//
// No line to centre on — an import with no line number, a report that
// only named the file — opens at the top instead, which is the most
// useful thing to show of a file nothing points into.
export function snippetWindow(content, line, radius = 4) {
  // `''.split('\n')` is `['']`, not `[]` — an empty file would come
  // back as one blank line and draw a preview with nothing in it.
  const lines = typeof content === 'string' && content !== '' ? content.split('\n') : []
  if (lines.length === 0) return { text: '', startLine: 1, lines: [] }
  const centre = Number.isFinite(line) && line >= 1 ? Math.min(line, lines.length) : null
  const start = centre === null ? 1 : Math.max(1, centre - radius)
  const end = centre === null ? Math.min(lines.length, radius * 2 + 1) : Math.min(lines.length, centre + radius)
  const window = lines.slice(start - 1, end)
  return { text: window.join('\n'), startLine: start, lines: window }
}

// ── Finding title ────────────────────────────────────────────────────
// What the finding is CALLED. A report may name it outright in a
// `title` field; the formats that have no such field put it in the
// description's first line instead (every markdown import does — the
// finding's heading becomes that line at parse), and JSON findings
// usually carry a one-paragraph description that stands in for one.
// So: the field when it's there, the first line otherwise.
//
// Single source for every surface that shows a finding by name — the
// card's bold heading, the table row, the kanban / focus-queue card,
// the pre-filled GitHub issue title, the markdown export — so a
// report's own title is what the reader sees in all of them or in
// none. The export marker comes off first: it's chrome the exports
// pipeline injects into the prose, not part of what the finding is
// called.
export function firstLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

export function findingTitle(f) {
  const own = typeof f?.title === 'string' ? f.title.trim() : ''
  return own || firstLine(stripExportMarker(f?.description, f))
}

// Title + body for the card's typographic layout: a bold heading over
// a muted body block.
//
// With a `title` field the split is already made — the whole
// description is body. The one adjustment is a description whose first
// line REPEATS the title (a report carrying the heading in both
// places): printing it as the heading and again as the body's opening
// line reads as a stutter, so an exact repeat is dropped.
//
// Without one, the description's first line is the title — but only
// when there's a non-empty body under it. A single-line description
// stays whole as a plain `.desc`, so JSON findings whose description
// is one paragraph aren't jarringly bolded; and a description that
// OPENS on a fence keeps its first line, since lifting that line out
// would leave the code block unopened and render its code as prose
// under a `` ```ts `` heading.
//
// The title is prose like any other and goes through the inline pass
// where it's drawn (render-finding.js): report titles name the
// offending symbol in backticks (`` SQL injection in `getUser()` ``),
// and the one line the reader takes in first is the worst place to
// print raw markdown.
export function splitDescription(f) {
  const text = stripExportMarker(f?.description, f) || ''
  const own = typeof f?.title === 'string' ? f.title.trim() : ''
  if (own) {
    const body = text.trim()
    const nl = body.indexOf('\n')
    const first = (nl < 0 ? body : body.slice(0, nl)).trim()
    if (first !== own) return { title: own, body }
    return { title: own, body: nl < 0 ? '' : body.slice(nl + 1).replace(/^\s+/u, '') }
  }
  if (!text) return { title: '', body: '' }
  const nl = text.indexOf('\n')
  if (nl < 0) return { title: '', body: text }
  // A first segment that isn't a string is a block starting at index 0
  // — see codeBlockSegments.
  if (typeof codeBlockSegments(text)[0] !== 'string') return { title: '', body: text }
  const body = text.slice(nl + 1).replace(/^\s+/u, '')
  if (!body) return { title: '', body: text }
  return { title: text.slice(0, nl).trim(), body }
}

// The description with the finding's name in front of it — the shape a
// format WITHOUT a `title` field writes it in, since there the name IS
// the first line. For the surfaces that show one text blob per finding
// rather than a heading over a body (the bundle views' issue rows,
// code-rail results and source-panel descriptions): they leaned on the
// description opening with the name, and a title-bearing finding would
// otherwise read there with no name at all. A finding that carries no
// `title` gets its description back untouched.
export function titledDescription(f) {
  const own = typeof f?.title === 'string' ? f.title.trim() : ''
  if (!own) return stripExportMarker(f?.description, f) || ''
  const { body } = splitDescription(f)
  return body ? `${own}\n\n${body}` : own
}

// Source URL for one `## Evidence` row. The row's own link when the
// report gave one; otherwise the same `HEAD` reconstruction findingUrl
// falls back to, from the row's file / line under the finding's repo —
// so a row citing a path with no link is still reachable.
export function evidenceUrl(row, f, repoFallback) {
  return findingUrl({ file: row?.file, line: row?.line, location: row?.url, repo: f?.repo }, repoFallback)
}

// `file:line` — the shape every location display uses, with the line
// dropped when there isn't a finite one ('?' on the imports that carry
// no line numbers). Takes a finding or an evidence row: both carry
// `file` / `line`, and both print the location the same way. The raw
// `line` goes through, so a range (`10-20`) survives whole.
export function locationLabel(x) {
  return Number.isFinite(parseInt(x?.line, 10)) ? `${x.file}:${x.line}` : (x?.file ?? '')
}

// The row's note. `text` is what parse-md.js writes (the lines a
// markdown report left under the reference); `observation` is the name
// a JSON report may use for the same thing. A row carrying BOTH is not
// a shape any producer here emits, but it costs nothing to read: the
// observation leads and the text follows under it, rather than one
// silently winning. Non-string values are ignored — this reads
// whatever JSON an importer hands us.
//
// Single source for both the card's `.evidence-note` and the markdown
// the text surfaces rebuild, so a row reads the same everywhere and
// the search haystack (which goes through evidenceMarkdown) matches on
// an observation the same as on a text.
export function evidenceNote(row) {
  const str = (v) => (typeof v === 'string' ? v : '')
  return `${str(row?.observation)}\n${str(row?.text)}`.trim()
}

// The evidence rows as a numbered markdown list, no heading — each
// text surface gives them the heading its own document wants. Note
// lines are indented under their row marker, the way the report wrote
// them, so markdown reads them as part of the item. `spaced` puts a
// blank line between rows, which markdown reads as a loose list: the
// handoff wants that (its rows carry prose and it is a document in its
// own right), the compact `**Evidence:**` block below does not.
function evidenceRows(f, { spaced = false } = {}) {
  const rows = Array.isArray(f?.evidence) ? f.evidence : []
  if (rows.length === 0) return ''
  return rows.map((row, i) => {
    const label = locationLabel(row)
    const lines = [`${i + 1}. ${row.url ? `[${label}](${row.url})` : label}`]
    const note = evidenceNote(row)
    if (note) for (const noteLine of note.split('\n')) lines.push(`   ${noteLine}`)
    return lines.join('\n')
  }).join(spaced ? '\n\n' : '\n')
}

// The evidence list as one labelled block — the shape it arrived in.
// The structured rows (not the description) carry it after parse, so
// the text surfaces that want it inline reassemble it from here: the
// markdown export, the pre-filled GitHub issue body, and the search
// haystack. Empty string for a finding without rows, so callers can
// `if (block)` rather than special-case the format.
export function evidenceMarkdown(f) {
  const rows = evidenceRows(f)
  return rows ? `**Evidence:**\n${rows}` : ''
}

// One inline markdown link — `[label](url)` — as it appears INSIDE a
// finding description: parse-md.js carries the `## Evidence` list into
// the body verbatim, links included, so the renderer needs the pair
// back to build an `<a>` (see renderHighlighted in render-finding.js).
// Returns null unless the target is a well-formed http(s) URL, so a
// `javascript:` / `data:` href — or a stray `[…](…)` in prose — stays
// plain text rather than becoming a clickable footgun.
export function markdownLinkToken(raw) {
  const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(raw)
  if (!m || !isHttpUrl(m[2])) return null
  // The label is a name the report escaped for markdown (`a/b/\_x\_y`);
  // the href is left as written.
  return { label: unescapeMd(m[1].trim()) || m[2], url: m[2] }
}

// Returns a "line N" template (linkified when a source URL is
// available) or `nothing` when the finding's line isn't a finite
// integer — codex / claude-security imports don't carry line numbers
// and stub them as '?', and rendering a bare "line ?" adds noise
// without information. Callers suppress the wrapping `<span
// class="line-num">` when this returns `nothing`.
export function lineLink(f, repoFallback) {
  const lineNum = parseInt(f?.line, 10)
  if (!Number.isFinite(lineNum)) return nothing
  const url = findingUrl(f, repoFallback)
  const text = `line ${lineNum}`
  if (!url) return text
  return html`<a href=${url} target="_blank" rel="noopener">${text}</a>`
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

// The narrative fields the document carries below the description, as
// `[heading, field]`, IN CARD ORDER — the sequence the card's tab body
// reads them in, so the document tells the same story in the same
// order. A field the finding doesn't carry is skipped, not headed.
const HANDOFF_SECTIONS = [
  ['Impact', 'impact'],
  ['Reproduction', 'reproduction'],
  ['Recommendation', 'recommendation'],
  ['Confidence reason', 'confidenceReason'],
  ['Revalidation verdict', 'revalidateVerdict'],
  ['Revalidation recommendation', 'revalidateRecommendation'],
]

// The finding as a markdown DOCUMENT — what the copy button puts on
// the clipboard and what the Claude handoff sends. It used to be a
// stack of `Label: value` lines, which read as a form even though most
// of its values are markdown prose: a description's own paragraphs and
// fenced blocks ran on from a `Description:` prefix, and the evidence
// list arrived mid-form under a bold label. Everything below is pasted
// somewhere that renders markdown, so it is markdown.
//
// The shape: a few `Key: value` lines of metadata (the facts that
// aren't prose), then the finding's name as an H1, its description,
// its evidence, and one H1 section per HANDOFF_SECTIONS field. Blocks
// join with a blank line, and every one of them is omitted when the
// finding doesn't carry it.
//
// `repo` is resolved by the caller (group.findingRepo) so this stays a
// pure formatter with no `#client/...` dependency (see fileUrl's note
// on keeping this module out of the client aggregator's import chain).
export function handoffBlock(f, repo) {
  const meta = []
  if (repo) meta.push(`Repo: ${repo}`)
  // One `Location:` line rather than the old File / Line pair — it is
  // one fact, and `file:line` is the form every other surface prints
  // it in and every editor takes back.
  const location = locationLabel(f)
  if (location) meta.push(`Location: ${location}`)
  if (f?.confidence !== undefined && f?.confidence !== null) meta.push(`Confidence: ${f.confidence}/10`)
  const revalidate = revalidateKind(f)
  if (revalidate) meta.push(`Revalidation: ${revalidate}`)

  const blocks = []
  if (meta.length > 0) blocks.push(meta.join('\n'))
  const { title, body } = splitDescription(f)
  if (title) blocks.push(`# ${title}`)
  if (body) blocks.push(body.trim())
  const evidence = evidenceRows(f, { spaced: true })
  if (evidence) blocks.push(`# Evidence\n\n${evidence}`)
  for (const [heading, field] of HANDOFF_SECTIONS) {
    // The pass's sections travel with the layer, like everything else
    // it draws: a card showing the code view copies the code view.
    if (!revalidationOn && field.startsWith('revalidate')) continue
    const value = stripExportMarker(f?.[field], f)?.trim()
    if (value) blocks.push(`# ${heading}\n\n${value}`)
  }
  return blocks.join('\n\n')
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

// ── Reference linkification for comments ─────────────────────────────
//
// Free-text triage comments routinely paste a URL — a GitHub issue / PR /
// commit ("fixed in https://github.com/owner/repo/pull/42"), or one of
// this app's own per-finding deep links ("duplicate of
// https://triage.space/#finding=…"). `parseCommentRefs` splits a comment
// into a flat list of segments — plain `string` runs interleaved with
// `{ url, label }` link tokens — so the renderer can wrap only the
// validated refs in an `<a>` and leave the rest as text. Returning data
// (not markup) keeps the strict-validation logic pure and unit-testable,
// and sits this beside the other github URL builders.
//
// "Strict" = every URL component is checked against GitHub's own naming
// rules before a link is emitted. A bad owner, an over-long repo, a
// non-hex commit, a look-alike host, or an extra path segment all fall
// through to plain text, so we never render a link that 404s or points
// somewhere off github.com. Recognised canonical shapes are
// `https://github.com/<owner>/<repo>/(issues|pull|commit)/<id>` plus the
// two GitHub Security Advisory forms — the global
// `https://github.com/advisories/GHSA-xxxx-xxxx-xxxx` and the in-repo
// `https://github.com/<owner>/<repo>/security/advisories/GHSA-…`. Bare
// `#123` / `owner/repo#123` shorthand needs a repo context the comment
// doesn't carry, so it's intentionally left alone.

// These validators spell out both ASCII cases (`a-zA-Z`) instead of using
// the `i` flag on purpose: under `/iu`, Unicode case-folding pulls a few
// non-ASCII homoglyphs into `[a-z]` (U+017F ſ → s, U+212A K → k), which
// could render a label that impersonates a different owner/repo. Staying
// ASCII-explicit keeps the validators robust on their own, not merely
// because the round-trip guard happens to reject those bytes upstream.

// GitHub login (user / org): alphanumeric or single hyphens, no leading
// or trailing hyphen, no consecutive hyphens. Length (≤39) is checked
// separately so the pattern stays readable.
const GH_OWNER_RE = /^[a-zA-Z\d](?:-?[a-zA-Z\d])*$/u
// Repo name: chars from [A-Za-z0-9._-]; `.` / `..` are reserved. Length
// (≤100) and the reserved names are checked alongside the pattern.
const GH_REPO_RE = /^[a-zA-Z\d._-]+$/u
// Issue / PR number: positive, no leading zero, capped at 10 digits so a
// long digit run in prose can't masquerade as an issue reference.
const GH_NUM_RE = /^[1-9]\d{0,9}$/u
// Commit SHA: abbreviated (7) through full (40) hex, either case.
const GH_SHA_RE = /^[a-fA-F\d]{7,40}$/u
// On-page fragment anchor (the URL "hash"), including its leading `#`:
// word characters + hyphens, matching GitHub's own anchor ids
// (`#issuecomment-123`, `#discussion_r…`, `#diff-<hex>R10`, `#L42`).
const GH_ANCHOR_RE = /^#[\w-]+$/u
// GHSA (GitHub Security Advisory) id — the literal `GHSA-` prefix plus
// three hyphen-separated groups of four base32 characters
// (`GHSA-xxxx-xxxx-xxxx`). GitHub always renders the suffix lower-case, so
// pinning that canonical casing keeps the round-trip guard satisfied and
// the emitted label faithful to what GitHub itself shows.
const GH_GHSA_RE = /^GHSA(?:-[0-9a-z]{4}){3}$/u

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
  // Break the path into its non-empty segments (a single trailing slash is
  // tolerated). `..`/`.` traversal can't reach here — the round-trip guard
  // above rejects any path the parser had to normalise.
  const parts = u.pathname.split('/')
  if (parts.at(-1) === '') parts.pop()

  // GitHub Security Advisories take two shapes that don't fit the
  // /<owner>/<repo>/<kind>/<id> mould handled further down:
  //   * global  — /advisories/GHSA-xxxx-xxxx-xxxx (no repo context)
  //   * in-repo — /<owner>/<repo>/security/advisories/GHSA-xxxx-xxxx-xxxx
  // A GHSA id is a globally-unique identifier, so both forms label as the
  // bare id; the owning repo (when present) stays in the href. The in-repo
  // owner/repo are still validated so a slug that could never be a real
  // GitHub path falls through to plain text rather than linkifying.
  if (parts.length === 3 && parts[1] === 'advisories') {
    const id = parts[2]
    if (!GH_GHSA_RE.test(id)) return null
    return { url: `https://github.com/advisories/${id}`, label: id }
  }
  if (parts.length === 6 && parts[3] === 'security' && parts[4] === 'advisories') {
    const [, owner, repo, , , id] = parts
    if (!isValidOwner(owner) || !isValidRepo(repo)) return null
    if (!GH_GHSA_RE.test(id)) return null
    return { url: `https://github.com/${owner}/${repo}/security/advisories/${id}`, label: id }
  }

  // Otherwise the path must be exactly /<owner>/<repo>/<kind>/<id>. Any
  // deeper path (`/pull/42/files`) is rejected so we only linkify the
  // precise thing we can name.
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

// Short id shown in a self-link's label. Findings carry a uuid in the
// overwhelming majority of cases (the analyzer's, or the one
// `common/finding-id.js` derives), and abbreviating it to its first
// group mirrors how the commit label abbreviates a sha. The codex
// importer's finding-URL ids have no meaningful prefix to show, so they
// fall back to the bare word.
//
// Lower-case-only and ASCII-explicit for the same reason the github
// validators are: under `/iu` Unicode case-folding pulls non-ASCII
// homoglyphs into the class, and every id this app mints is lower-case
// hex anyway.
const FINDING_UUID_RE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u

// Validate one candidate URL string as a per-finding deep link into THIS
// instance and, on success, return its `{ url, label, self }` token.
// `parseFindingUrl` (client/finding-link.js) owns the strictness — same
// host + scheme, no credentials, canonical round-trip, a fragment that
// parses as a finding ref.
//
// The href is FRAGMENT-ONLY (`#finding=…`), which is the whole point of
// the `self` flag: a finding id resolves against the reader's own local
// reports, so the link has to stay on this page. A relative fragment
// does that with no rewriting, and clicking it fires the `hashchange`
// the boot handler in `ui/view.js` already listens for. (Repeat clicks
// work because that handler strips the fragment once it has acted, so
// the next click is always a real change.)
function selfRefToken(candidate) {
  const found = parseFindingUrl(candidate)
  if (!found) return null
  const label = FINDING_UUID_RE.test(found.id) ? `finding ${found.id.slice(0, 8)}` : 'finding'
  return { url: `#${found.fragment}`, label, self: true }
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
//
// Implemented as a Set + end-scan rather than a `/[…]+$/` regex on
// purpose: several of these characters are also URL-scan-legal, so a
// candidate can end in a long run of them, and the anchored greedy
// regex backtracks quadratically over such a run (a ReDoS vector on
// attacker-controlled comment text). The end-scan is linear.
const TRAILING_PUNCT = new Set([')', '.', ',', '!', '?', ';', ':', "'", '"', '*', ']', '}', '>'])

function trimTrailingPunct(s) {
  let end = s.length
  while (end > 0 && TRAILING_PUNCT.has(s[end - 1])) end--
  return end === s.length ? s : s.slice(0, end)
}

// Split `text` into the segment list described above: alternating plain
// `string` runs and validated link tokens — `{ url, label }` for an
// external github ref, `{ url, label, self: true }` for a fragment-only
// link into this instance. A comment with no recognised URL (the common
// case) comes back as a single `[text]` entry; empty / non-string input
// yields `[]`.
export function parseCommentRefs(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const segments = []
  let lastIndex = 0
  URL_SCAN_RE.lastIndex = 0
  let m
  while ((m = URL_SCAN_RE.exec(text)) !== null) {
    const trimmed = trimTrailingPunct(m[0])
    // GitHub first, then our own deep links. The two can't both match —
    // one requires host `github.com`, the other the host this app is
    // being served from.
    const token = trimmed ? (githubRefToken(trimmed) ?? selfRefToken(trimmed)) : null
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
