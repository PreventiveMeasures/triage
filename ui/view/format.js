import { dependencyDirectory } from '../../client/dependency-paths.js'
import { SEVERITIES, SEVERITY_ORDER, correctedVariants, descriptionSections, displayedSeverity, effectiveSeverity, evidenceNote, fenceRanges, findingDisplayName, findingTitle, hasSeverityCorrection, inFence, isHttpUrl, locationLabel, prettyModel, repoDirectory, reportRepoGithub, revalidateKindOf, runMetaLine, splitDescription, stripExportMarker, titledDescription, unescapeMd } from '@preventive/report'
import { html, nothing } from 'lit'
// Direct relative imports, NOT `#client/index.js`: this module rides in the
// lazy `ui/graph.js` bundle, and the aggregator would drag `state` and the
// whole client layer in with it. Callers pass in whatever state they read.
import { parseFindingUrl } from '../../client/finding-link.js'
import { formatBytes as formatByteSize } from '../scan/metrics.js'
import { NOT_REVALIDATED_FILTER, REVALIDATE_FILTERS, hasRevalidateStamp } from '../../common/finding-filters.js'
import { ignoresOwnRepo } from '../../common/finding-repo.js'
import { asCommit, repoCommit, sameRepoSlug } from '../../common/repo-commit.js'
import { codeSpan } from './code-span.js'
export { NOT_REVALIDATED_FILTER, PARTIAL_MODES, REVALIDATE_FILTERS, revalidateFilterKinds, revalidateFilterOption } from '../../common/finding-filters.js'
// The finding readers shared with the report library's markdown writer,
// re-exported so the viewer keeps one import; `isHttpUrl` is the one
// http(s) gate every `<a>` in the viewer goes through.
export { SEVERITIES, SEVERITY_ORDER, correctedVariants, descriptionSections, displayedSeverity, effectiveSeverity, evidenceNote, findingDisplayName, findingTitle, hasSeverityCorrection, isHttpUrl, locationLabel, prettyModel, splitDescription, stripExportMarker, titledDescription }

// ── Revalidation layer ───────────────────────────────────────────────
// A second pass stamps `revalidate` with its verdict — `confirmed`,
// `partial`, `refuted`, `unreachable`, `unknown` — or `revalidation` on the
// row that IS the pass (sorted first in its group, named in the run-meta
// line). Values are case-folded; an unrecognised one reads as no stamp.
//
// The toolbar's "App" switch takes the whole layer off: `revalidateKind`
// then answers '' for every row, so no stamp, no pass-row promotion, no
// voided confidence, no outcome filter. Callers that must see the raw field
// whatever the switch says (hiding the pass's rows, offering the switch,
// the export header) use `revalidateKindOf` / the exports below it.
//
// Module state set once per render by render.js; defaults to ON so a
// helper reached before the first render (headless API, deep link) sees
// the default app view.
let revalidationOn = true

// Upstream findings describe the dependency itself, so app-specific verdicts
// stay hidden there without changing the reader's saved App switch setting.
export function configureRevalidation(on, upstreamOnly = false) {
  revalidationOn = on !== false && !upstreamOnly
}

// For display sites reading a `revalidate*` field directly.
export function revalidationShown() { return revalidationOn }

export function revalidateKind(f) {
  return revalidationOn ? revalidateKindOf(f) : ''
}

// Whether the row carries a stamp at all, past the switch: the markdown
// export keeps naming the layer after it is switched off.
export function hasRevalidateField(f) { return revalidateKindOf(f) !== '' }

// Whether the "App" switch is offered: only where the pass JUDGED
// something. A set whose every stamp is `revalidation` has nothing to hand
// back when the layer comes off, only the pass's rows to lose. Read raw,
// over the reports' own groups, so the answer doesn't follow the switch.
export function canDropRevalidation(reports) {
  return reports.some((r) => (r.groups ?? []).some((g) => g.some(hasRevalidateStamp)))
}

// The verdict, or null — `revalidation` names the pass, not a verdict.
export function revalidateStamp(f) {
  const kind = revalidateKind(f)
  return kind && kind !== 'revalidation' ? kind : null
}

export function isRevalidation(f) {
  return revalidateKind(f) === 'revalidation'
}

// `refuted` and `unreachable` rule a finding out; a confidence attached to
// one is a claim the pass withdrew, so the range reads it as 0 (filters.js).
const RULED_OUT = new Set(['refuted', 'unreachable'])

export function isRuledOut(f) {
  return RULED_OUT.has(revalidateKind(f))
}

// The outcome options worth offering for the kinds present; the toolbar
// drops the control when this is empty. `unrevalidated`: whether the
// underlying findings are on screen and some row carries no outcome at all
// (render.js) — then Not revalidated joins them, but only beside a pass
// that stamped something, since with no stamp on screen every row is
// "not revalidated" and the option would filter nothing.
export function reachableRevalidateFilters(kinds, unrevalidated = false) {
  const present = new Set(kinds)
  present.delete('')
  const options = REVALIDATE_FILTERS.filter((o) => o.kinds.some((k) => present.has(k)))
  return unrevalidated && present.size > 0 ? [...options, NOT_REVALIDATED_FILTER] : options
}

// ── Dependency directory ─────────────────────────────────────────────
// "Module" = third-party dependency. ONE deps dir is active, chosen from
// the whole loaded set (`dependencyDirectory`: `node_modules` if any path
// has it, else `vendor`, else `dependencies`), since `vendor/` or
// `dependencies/` may be ordinary source dirs elsewhere. render.js calls
// configureDepsDir each render; the matchers are rebuilt only when the dir
// changes so the hot `isModule` stays a single `RegExp.test`.

// `dir` as a whole path segment: `vendor/` matches `app/vendor/x`, not
// `my-vendor-lib/x`.
function depsSegRe(dir) { return new RegExp(`(^|/)${dir}/`, 'u') }
// `<dir>/<pkg or @scope/pkg>/<rest>`, capturing `<rest>`; greedy, so the
// innermost package of a nested layout.
function depsStripRe(dir) { return new RegExp(`^(?:.*/)?${dir}/(?:@[^/]+/[^/]+|[^/]+)/(.*)$`, 'u') }

const NODE_MODULES_RE = depsSegRe('node_modules')
const VENDOR_RE = depsSegRe('vendor')

let depsDir = 'node_modules'
let moduleRe = depsSegRe(depsDir)
let stripRe = depsStripRe(depsDir)

// Whether `now` holds what `kept` did, item by item. The per-render
// configure calls below key on report identity: an ingested report's paths
// and stamps never change, so only a different set can answer differently.
const sameItems = (kept, now) => kept?.length === now.length && kept.every((x, i) => x === now[i])

let depsDirReports = null
export function configureDepsDir(reports) {
  if (sameItems(depsDirReports, reports)) return
  depsDirReports = [...reports]
  const dir = dependencyDirectory(reports)
  if (dir === depsDir) return
  depsDir = dir
  moduleRe = depsSegRe(dir)
  stripRe = depsStripRe(dir)
}

export function depsDirName() { return depsDir }

export function isModule(file) {
  return moduleRe.test(file)
}

// Findings whose `isUpstream` was derived here (and so may be revised),
// as opposed to ones that arrived carrying it.
const derivedUpstream = new WeakSet()

// Stamp `isUpstream: true` on each source-layer finding (`isApp === false`)
// in the deps dir; others are left without the field, which reads as "not
// upstream". Not done at ingest because the dir is chosen from the WHOLE
// set, which grows as a workspace ingests report by report (rendering in
// between): a later report can move the dir, so derived flags are
// re-derived every render (after configureDepsDir). Returns whether any
// flag changed.
export function stampUpstreamFindings(reports) {
  let changed = false
  for (const r of reports ?? []) {
    for (const g of r.groups ?? []) {
      for (const f of g) {
        if (f.isApp !== false) continue
        const derived = derivedUpstream.has(f)
        if ('isUpstream' in f && !derived) continue
        if (isModule(f.file)) {
          if (f.isUpstream !== true) changed = true
          f.isUpstream = true
          derivedUpstream.add(f)
        } else if (derived) {
          changed = true
          delete f.isUpstream
          derivedUpstream.delete(f)
        }
      }
    }
  }
  return changed
}

// Whether a path is inside somebody else's source by ANY marker, for
// deciding whether it can resolve against a repo at all (missing one links
// into a repo that lacks the file). `dependencies` counts only when it is
// the active deps dir — too ordinary a folder name otherwise.
function hasDependencyMarker(file) {
  const s = typeof file === 'string' ? file : ''
  return NODE_MODULES_RE.test(s) || VENDOR_RE.test(s) || moduleRe.test(s)
}

// The installed package a path belongs to: everything up to and including
// the LAST `node_modules/(@owner/)?name` (the innermost, under nested or
// pnpm layouts), or null. The whole prefix is the identity: two installs of
// `lodash` are two copies.
const NODE_PKG_ROOT_RE = /^(.*(?:^|\/)node_modules\/(?:@[^/]+\/[^/]+|[^/]+))(?:\/|$)/u

function nodePackageRoot(file) {
  return NODE_PKG_ROOT_RE.exec(typeof file === 'string' ? file : '')?.[1] ?? null
}

// A `package` stamp (`{ npm: { name, version } }`) as one key,
// `npm:name@version` (version empty where none), or null.
function packageStampKey(stamp) {
  if (stamp === null || typeof stamp !== 'object') return null
  for (const [ecosystem, pkg] of Object.entries(stamp)) {
    if (typeof pkg?.name === 'string' && pkg.name !== '') return `${ecosystem}:${pkg.name}@${typeof pkg.version === 'string' ? pkg.version : ''}`
  }
  return null
}

// The dependencies whose upstream the loaded set knows AT A COMMIT, by
// install (`nodePackageRoot`) and by stamped package@version: each mapped
// to the `repo` of a loaded finding there (a dependency finding's `repo`
// is its package's upstream). A `repo` without a commit would link HEAD, a
// version the install need not hold, so it doesn't count; nor does one the
// app ignores (common/finding-repo.js). Disagreeing findings leave the key
// unknown (null). An install path is one report's (another report's
// `node_modules/axios` may be another version), so installs are keyed per
// report and keep the package their finding named; a package@version is
// the same in any report. Called from render.js each render, beside
// configureDepsDir, for evidenceUrl rule 4.
let dependencyRepoKeys = null
let dependencyRepos = { byRoot: new Map(), byPackage: new Map() }
const reportKeyOf = (f) => `${f?._managedReportId ?? ''}\0${f?._reportName ?? ''}`
const installKey = (f, root) => `${reportKeyOf(f)}\0${root}`
const repoSlugOf = (target) => reportRepoGithub({ repo: { github: target.id } }) ?? target.id
// Two `repo`s as one, or null where they name different places. A short
// hash and the full one it abbreviates are one commit; the longer is kept.
function agreeingRepo(known, repo) {
  if (known === null) return null
  const now = repoTarget(repo), was = repoTarget(known)
  const [a, b] = [was.commit.toLowerCase(), now.commit.toLowerCase()]
  if (!sameRepoSlug(repoSlugOf(was), repoSlugOf(now)) || was.prefix !== now.prefix || !(a.startsWith(b) || b.startsWith(a))) return null
  return b.length > a.length ? repo : known
}
export function configureDependencyRepos(reports) {
  const list = Array.isArray(reports) ? reports : []
  const keys = list.flatMap((r) => [r, r?.groups])
  if (sameItems(dependencyRepoKeys, keys)) return
  dependencyRepoKeys = keys
  const byPackage = new Map(), byRoot = new Map()
  const note = (map, key, repo) => map.set(key, map.has(key) ? agreeingRepo(map.get(key), repo) : repo)
  for (const r of list) {
    for (const g of r?.groups ?? []) {
      for (const f of g) {
        if (!f || f._repoIgnored || ignoresOwnRepo(f, f._repoFallback)) continue
        const target = repoTarget(f.repo)
        if (!target.id || !target.commit) continue
        const root = nodePackageRoot(f.file)
        const pkg = packageStampKey(f.package)
        if (root !== null) {
          const key = installKey(f, root)
          const known = byRoot.get(key)
          const repo = known === undefined ? f.repo : known && known.pkg === pkg ? agreeingRepo(known.repo, f.repo) : null
          byRoot.set(key, repo && { repo, pkg })
        }
        if (pkg !== null && !pkg.endsWith('@')) note(byPackage, pkg, f.repo)
      }
    }
  }
  dependencyRepos = { byRoot, byPackage }
}

// Sizes as everywhere else (`ui/scan/metrics.js`); null for a missing
// value so callers can drop the chip.
export function formatBytes(n) {
  return Number.isFinite(n) ? formatByteSize(n) : null
}

// Strip the longest common DIRECTORY prefix of `paths`, as the analyzer
// normalises them: whole segments only, and never ending in a `@scope` or
// `node_modules` segment, which name the package each file belongs to
// (`node_modules/foo/{a,b}.js` keeps its prefix). Returns `{ prefix,
// stripped }`, `prefix` ending in `/` or empty.
export function stripCommonPathPrefix(paths) {
  if (paths.length <= 1) return { prefix: '', stripped: [...paths] }
  const split = paths.map((p) => p.split('/'))
  const minLen = Math.min(...split.map((s) => s.length))
  let prefixLen = 0
  while (prefixLen < minLen - 1 && split.every((s) => s[prefixLen] === split[0][prefixLen])) prefixLen++
  if (prefixLen > 0 && split[0][prefixLen - 1].startsWith('@')) prefixLen--
  if (prefixLen > 0 && split[0][prefixLen - 1] === 'node_modules') prefixLen--
  if (prefixLen === 0) return { prefix: '', stripped: [...paths] }
  return { prefix: `${split[0].slice(0, prefixLen).join('/')}/`, stripped: split.map((s) => s.slice(prefixLen).join('/')) }
}

// `<deps-dir>/<pkg>/lib/foo.js` → `lib/foo.js`, rooted at the package's
// repo, under the active deps dir only.
function stripPackagePrefix(file) {
  return file.match(stripRe)?.[1] ?? file
}

// Searchable text for `state.filterInclude`: the user-visible fields plus
// the per-finding `repo.github` slug (so a search can match an upstream
// repo). Triage comments and fixes live in `state.triage`, which this
// module can't import, so filters.js matches those itself. Kept per
// finding and layer state: asked of every finding on every keystroke.
const findingTexts = { on: new WeakMap(), off: new WeakMap() }
export function findingText(f) {
  const kept = revalidationOn ? findingTexts.on : findingTexts.off
  let text = kept.get(f)
  if (text === undefined) {
    // The pass's words leave the haystack with the layer.
    const reval = revalidationOn ? [revalidateStamp(f), f.revalidateVerdict, f.revalidateRecommendation] : []
    text = [f.file, f.title, f.description, f.impact, f.reproduction, evidenceMarkdown(f), f.recommendation, f.confidenceReason, ...reval, f.discoveredIn, f.repo?.github].filter(Boolean).join('\n').toLowerCase()
    kept.set(f, text)
  }
  return text
}

// A finding filled in since its text was kept (managed-details.js).
export function forgetFindingText(f) {
  findingTexts.on.delete(f)
  findingTexts.off.delete(f)
}

// The run-meta line under the layer's state (the pass's row names itself
// only while it is on), led by the finding's category where it has one.
export function formatRunMeta(f) {
  const category = typeof f?.category === 'string' ? f.category.trim() : ''
  return [category, runMetaLine(f, revalidationOn)].filter(Boolean).join(' · ')
}

// The longest prefix every string shares, or '' (the print title of a
// multi-report batch).
export function commonPrefix(strings) {
  if (strings.length === 0) return ''
  let prefix = strings[0]
  for (let i = 1; i < strings.length; i++) {
    while (prefix && !strings[i].startsWith(prefix)) prefix = prefix.slice(0, -1)
    if (!prefix) return ''
  }
  return prefix
}

// A github.com URL as its bare `user/repo` slug (the form `repo.github`
// carries), so typed URLs and analyzer slugs label and key the same; any
// other input as given.
export function prettyRepoLabel(s) {
  if (!s) return ''
  const m = s.match(/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?(?:[/?#]|$)/iu)
  return m ? m[1] : s
}

// A typed repo — full URL, `github.com/user/repo`, or a bare `user/repo`
// slug (anything else is treated as one) — as a base URL with no trailing
// slash.
function repoBaseUrl(s) {
  if (!s) return null
  const trimmed = s.trim().replace(/\/$/u, '')
  if (!trimmed) return null
  if (/^https?:\/\//iu.test(trimmed)) return trimmed
  if (/^github\.com\//iu.test(trimmed)) return `https://${trimmed}`
  return `https://github.com/${trimmed}`
}

// A bare package reference — `name@1.2.3`, `@scope/name@1.2.3` — names a
// dependency, not a path. The only slash allowed is the scope's, so
// `src/@types/x.d.ts` never matches.
const PKG_REF_RE = /^(?:@[\w.-]+\/)?[\w.-]+@[^/\s@]+$/u
export function isPkgRef(file) {
  return PKG_REF_RE.test(file || '')
}

// A repository as the link builders take it: a slug or typed URL, or a
// report's `{ github, directory, commit }` stamp, whose `directory` (where
// in the repo the report's tree sits) becomes the path prefix — only ever
// for the repo it was declared beside.
function repoTarget(repo) {
  if (repo == null || typeof repo === 'string') return { id: repo ?? '', prefix: '', commit: '' }
  const dir = repoDirectory(repo)
  return { id: typeof repo.github === 'string' ? repo.github : '', prefix: dir ? `${dir}/` : '', commit: repoCommit(repo) }
}

// Blob URL for a file. The finding's own `repo` (a dependency's upstream,
// read down to its slug) wins over `repoFallback`, the report's resolved
// repo (group.js findingRepoTarget; callers OR in `state.repoUrl`). A
// package reference links nowhere. The revision is the one the report
// read, so line anchors survive branch moves:
//   1. the finding's own `repo.commit`, for its own repo;
//   2. the report's commit, for the report's repo (also when the
//      finding's repo names the same slug);
//   3. `auditedCommit` (older piolium / markdown reports), for the
//      report's repo or own source, never a dependency's upstream;
//   4. HEAD.
// Never `commitHash`: that is where the bug was introduced.
export function fileUrl(file, repo, repoFallback, auditedCommit = '') {
  if (isPkgRef(file)) return null
  const own = repoTarget(repo)
  const fallback = repoTarget(repoFallback)
  const audited = asCommit(auditedCommit)
  if (own.id) {
    const slug = reportRepoGithub({ repo: { github: own.id } })
    const base = repoBaseUrl(slug ?? own.id)
    const sameRepo = sameRepoSlug(slug, reportRepoGithub({ repo: { github: fallback.id } }))
    const ref = own.commit || (sameRepo ? fallback.commit : '')
      || (sameRepo || !hasDependencyMarker(file) ? audited : '') || 'HEAD'
    return `${base}/blob/${ref}/${own.prefix}${stripPackagePrefix(file)}`
  }
  if (isModule(file)) return null
  const base = repoBaseUrl(fallback.id)
  if (!base) return null
  return `${base}/blob/${fallback.commit || audited || 'HEAD'}/${fallback.prefix}${file}`
}

// The file header link over a finding's cards: the finding's own link
// minus its line anchor, so header and lines name one revision. Plain text
// with nothing to link.
export function fileLink(f, repoFallback) {
  const file = f?.file ?? ''
  const url = findingUrl(f, repoFallback)
  if (!url) return file
  return html`<a href=${stripLineAnchor(url)} target="_blank" rel="noopener">${file}</a>`
}

// Only our own `#L42` / `#L10-L20` anchors; any other fragment isn't ours.
function stripLineAnchor(url) {
  return url.replace(GH_LINE_ANCHOR_RE, '')
}

function lineAnchor({ start, end }) {
  return end > start ? `#L${start}-L${end}` : `#L${start}`
}

// Source URL for one finding's location; every finding-level link goes
// through here. A markdown import's own `f.location` link (pinned, anchored)
// beats the reconstruction, which needs a repo; non-http locations
// (piolium's `piolium:<id>`) fall through to it. Null with neither.
export function findingUrl(f, repoFallback) {
  if (!f) return null
  if (isHttpUrl(f.location)) return f.location
  const url = fileUrl(f.file, f.repo, repoFallback, f.auditedCommit)
  if (!url) return null
  const range = lineRange(f.line)
  if (range) return `${url}${lineAnchor(range)}`
  const lineNum = parseInt(f.line, 10)
  return Number.isFinite(lineNum) ? `${url}#L${lineNum}` : url
}

// A GitHub blob / tree / blame URL as `owner/repo/path/to/file.ts:20-30`:
// origin, ref and anchor taken off (the link still carries the ref). Empty
// for anything else.
const GH_BLOB_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/(?:blob|tree|blame)\/[^/\s]+\/(\S+)$/u
const GH_LINE_ANCHOR_RE = /#L(\d+)(?:-L?(\d+))?$/u

export function githubRefLabel(url) {
  const m = typeof url === 'string' ? GH_BLOB_RE.exec(url) : null
  if (!m) return ''
  const anchor = GH_LINE_ANCHOR_RE.exec(m[2])
  if (!anchor) return `${m[1]}/${m[2]}`
  return `${m[1]}/${m[2].slice(0, anchor.index)}:${anchor[2] ? `${anchor[1]}-${anchor[2]}` : anchor[1]}`
}

// `text` cut at its fenced `ranges`: [prose, fence, prose, …, prose], the
// prose runs '' where a fence sits at either end.
function fenceSplit(text, ranges) {
  const parts = []
  let last = 0
  for (const [start, end] of ranges) {
    parts.push(text.slice(last, start), text.slice(start, end))
    last = end
  }
  parts.push(text.slice(last))
  return parts
}

// ── Reflow ───────────────────────────────────────────────────────────
// Reports hard-wrap their markdown; those soft breaks reflow in markdown,
// and kept literally they render as ragged short lines in a wider card. So
// each paragraph is joined into one run — unless any of its lines opens a
// block (indented code, list, fence, quote, heading, table row, rule),
// whose breaks carry meaning and which `.desc` renders `pre-wrap`.
const BLOCK_LINE_RE = /^(?:\s+\S|[-*+] |\d+[.)] |>|#{1,6}(?:[ \t]|$)|\||`{3}|~{3})/u

function flowParagraphs(text) {
  // The capturing split keeps the blank-line runs as they are.
  return text.split(/(\n{2,})/u).map((chunk) => {
    if (/^\n+$/u.test(chunk)) return chunk
    const lines = chunk.split('\n')
    if (lines.some((l) => BLOCK_LINE_RE.test(l) || HRULE_RE.test(l))) return chunk
    return lines.map((l) => l.trim()).filter(Boolean).join(' ')
  }).join('')
}

// Prose beside a fence: the newlines on a side a fence abuts are kept
// around the reflow, or the prose would weld onto the fence.
function flowRun(run, keepLead, keepTail) {
  const lead = keepLead ? /^\n*/u.exec(run)[0] : ''
  const body = run.slice(lead.length)
  const tail = keepTail ? /\n*$/u.exec(body)[0] : ''
  return lead + flowParagraphs(body.slice(0, body.length - tail.length)) + tail
}

// Fenced code is never reflowed: a snippet with a blank line in it would
// split into paragraphs that read as prose. So the fences (as the parsers
// read them, fenceRanges) come out first and only the prose between is
// flowed. CRLF (GitHub's web editor) is read as `\n`.
export function flowText(raw) {
  if (!raw) return raw
  const text = raw.replaceAll('\r\n', '\n')
  const ranges = fenceRanges(text)
  if (ranges.length === 0) return flowParagraphs(text)
  const parts = fenceSplit(text, ranges)
  return parts.map((part, i) => (i % 2 || !part ? part : flowRun(part, i > 0, i < parts.length - 1))).join('')
}

// ── Fenced code blocks ───────────────────────────────────────────────
// `codeBlockSegments` splits a body into prose strings and `{ lang, code }`
// blocks, so the card draws each fence as a `<pre>`. Pairing is
// fenceRanges' (an unclosed fence runs to the end), so what a parser read
// as code is drawn as code. `code` is verbatim; `lang` is the info string's
// first word, case-folded, '' unless it is a plain language tag (not a
// filename or `{highlight: …}`). The newlines between a block and its
// prose go with the fences: the prose renders `pre-wrap`, and they would
// print as blank lines around every block. Text with no fence comes back
// as `[text]`.
const FENCE_LINE_RE = /^( *)(`{3,}|~{3,})(.*)$/u
const LANG_TAG_RE = /^[a-z0-9+#._-]{1,20}$/u

// Up to `n` leading spaces off a line (a line may start left of its fence).
function shedIndent(line, n) {
  let i = 0
  while (i < n && line[i] === ' ') i++
  return line.slice(i)
}

function fencedBlock(raw) {
  const lines = raw.split('\n')
  const open = FENCE_LINE_RE.exec(lines[0])
  const marker = (open?.[2] ?? '```').slice(0, 3)
  const tag = (open?.[3] ?? '').trim().split(/\s+/u)[0].toLowerCase()
  // The last line is chrome only when it closes with the opening marker:
  // a block dangling at the end can end on a fence of the other kind.
  const close = lines.length > 1 ? FENCE_LINE_RE.exec(lines.at(-1)) : null
  const closed = Boolean(close?.[2].startsWith(marker))
  // A fence under a list item is indented to the item; markdown sheds the
  // opening fence's indent from every content line, and so do we.
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
  return fenceSplit(text, ranges).flatMap((part, i) => {
    if (i % 2) return [fencedBlock(part)]
    const prose = (i > 0 ? part.replace(/^\n+/u, '') : part).replace(/\n+$/u, '')
    return prose ? [prose] : []
  })
}

// ── Lists ────────────────────────────────────────────────────────────
// `listSegments` splits a body into prose runs and `{ ordered, start,
// items }` lists. Each item's content has its marker and indent shed, a
// markdown body of its own that the renderer recurses into — which draws
// a nested list, a wrapped step or a fenced snippet INSIDE its item. Text
// with no list comes back as `[text]`.
const LIST_ITEM_RE = /^( *)(?:[-*+]|(\d{1,9})[.)]) +(?=\S)/u
// `* * *` and `- - -` are rules, not one-item lists.
const HRULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u

function leadingSpaces(line) { return /^ */u.exec(line)[0].length }

// `src`'s lines, and whether line `i` sits in a fenced block (fenceRanges).
function fencedLines(src) {
  const ranges = fenceRanges(src)
  const lines = src.split('\n')
  const offsets = []
  let at = 0
  for (const line of lines) { offsets.push(at); at += line.length + 1 }
  return { lines, inCode: (i) => inFence(ranges, offsets[i]) }
}

export function listSegments(text) {
  const src = typeof text === 'string' ? text : ''
  if (!src) return [text]
  const { lines, inCode } = fencedLines(src)
  // A marker inside a fenced snippet is code.
  const startsItem = (i) => !inCode(i)
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
    // The open item: the column its continuation lines sit at, and its
    // content so far with that column shed.
    let item = null
    let afterBlank = false
    while (i < lines.length) {
      const line = lines[i]
      // Inside a fence nothing is structural: the snippet is item content.
      if (!inCode(i)) {
        if (!line.trim()) { item.lines.push(''); afterBlank = true; i++; continue }
        const indent = leadingSpaces(line)
        const marker = HRULE_RE.test(line) ? null : LIST_ITEM_RE.exec(line)
        // A marker at or past the item's text column nests inside it; one
        // left of it is this list's next item — unless it switches between
        // bullets and numbers, which starts another list.
        if (marker && (!item || indent < item.column)) {
          if (Boolean(marker[2]) !== ordered) break
          if (item) items.push(trimBlankLines(item.lines))
          item = { column: marker[0].length, lines: [line.slice(marker[0].length)] }
          afterBlank = false
          i++
          continue
        }
        // Back at the margin after a blank line, the list is over; without
        // one it's a lazily wrapped item — unless the line is a heading, a
        // rule or a quote, which no item wraps onto.
        if (indent < item.column && (afterBlank || HEADING_RE.test(line) || HRULE_RE.test(line) || QUOTE_LINE_RE.test(line))) break
      }
      item.lines.push(shedIndent(line, item.column))
      afterBlank = false
      i++
    }
    if (item) items.push(trimBlankLines(item.lines))
    // Markdown numbers on from the first number, so only it is kept.
    out.push({ ordered, start: ordered ? Number(first[2]) : null, items })
    proseFrom = i
  }
  if (out.length === 0) return [text]
  pushProse(lines.length)
  return out
}

// ── Headings and rules ───────────────────────────────────────────────
// A paragraph splits around its ATX headings (`{ level, text }`, closing
// hashes dropped) and rules (`{ rule: true }`); setext headings stay text,
// so a `---` right under prose is its underline, not a rule (a `***`,
// `___` or `- - -` can't be one). Without either, `[text]`.
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/u
const SETEXT_UNDERLINE_RE = /^ {0,3}-+[ \t]*$/u

export function lineBlockSegments(text) {
  const lines = text.split('\n')
  const out = []
  let from = 0
  // Lines of spaces beside a heading or rule are no part of the prose.
  const pushProse = (until) => {
    const run = lines.slice(from, until).join('\n').replaceAll(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/gu, '')
    if (run.trim()) out.push(run)
  }
  lines.forEach((line, i) => {
    const heading = HEADING_RE.exec(line)
    const rule = HRULE_RE.test(line) && (i === from || !lines[i - 1].trim() || !SETEXT_UNDERLINE_RE.test(line))
    if (!heading && !rule) return
    pushProse(i)
    out.push(heading ? { level: heading[1].length, text: heading[2] } : { rule: true })
    from = i + 1
  })
  if (out.length === 0) return [text]
  pushProse(lines.length)
  return out
}

// ── Block quotes and alerts ──────────────────────────────────────────
// `quoteSegments` splits prose into runs and `{ quote: true, alert, body }`
// quotes; `body` has its markers shed, a markdown body the renderer
// recurses into. A line is the quote's when it opens on `>` (up to three
// spaces in), or lazily continues the paragraph the quote left open — not
// a heading, rule, fence or list item, not after a blank line, and not
// inside a fence the quote opened. `alert` is GitHub's `[!NOTE]` / `TIP` /
// `IMPORTANT` / `WARNING` / `CAUTION` on the first line alone (any case,
// dropped from `body`), lowercased; null for plain quotes and for a marker
// with nothing under it. `alerts: false` reads every quote as plain
// (GitHub draws alerts only at the top level). A `>` line inside an outer
// fence is code; fences inside the quote are the quote's. Prose runs come
// back as written, so joined with `\n` in place of each quote they are the
// text again. Without a quote, `[text]`.
const QUOTE_LINE_RE = /^ {0,3}>/u
const QUOTE_MARKER_RE = /^ {0,3}> ?/u
const ALERT_MARKER_RE = /^[ \t]*\[!(note|tip|important|warning|caution)\][ \t]*$/iu
const FENCE_START_RE = /^ {0,3}(?:`{3}|~{3})/u
// The `>`s and list markers leading a quoted line's text; one starred
// group with nothing after it to fail, so it never backtracks.
const NESTED_MARKERS_RE = /^(?: {0,3}> ?| *(?:[-*+]|\d{1,9}[.)])(?: +|$))*/u

// How many quotes / list items deep the renderer draws (render-finding.js
// markdownBody) and unquotedText sheds; past it the rest stays text, so a
// line of thousands of `>`s costs a few passes, not that deep a recursion.
export const NESTING_DEPTH = 16

const isLeafBlock = (line) => HEADING_RE.test(line) || HRULE_RE.test(line) || FENCE_START_RE.test(line)

// The fence the quote leaves open after `line` ('' for none), read a line
// at a time (a ``` inside a ~~~ or ```` block is content) — all the
// laziness rule needs; the body gets the full reading when rendered.
function fenceAfter(open, line) {
  const fence = FENCE_LINE_RE.exec(line)
  if (!fence) return open
  if (!open) return fence[2][0] === '`' && fence[3].includes('`') ? '' : fence[2]
  return fence[2][0] === open[0] && fence[2].length >= open.length && !fence[3].trim() ? '' : open
}

function trimBlankLines(lines) {
  let from = 0
  let to = lines.length
  while (from < to && !lines[from].trim()) from++
  while (to > from && !lines[to - 1].trim()) to--
  return lines.slice(from, to).join('\n')
}

export function quoteSegments(text, { alerts = true } = {}) {
  const src = typeof text === 'string' ? text : ''
  if (!/^ {0,3}>/mu.test(src)) return [text]
  const { lines, inCode } = fencedLines(src)
  const quoted = (i) => QUOTE_LINE_RE.test(lines[i]) && !inCode(i)

  const out = []
  let proseFrom = 0
  let i = 0
  while (i < lines.length) {
    if (!quoted(i)) { i++; continue }
    if (i > proseFrom) out.push(lines.slice(proseFrom, i).join('\n'))
    const body = []
    let fence = ''
    // Whether the last quoted line left a paragraph a lazy line can go on.
    let paragraph = false
    for (; i < lines.length; i++) {
      const line = lines[i]
      if (quoted(i)) {
        const content = line.replace(QUOTE_MARKER_RE, '')
        const wasCode = fence !== ''
        fence = fenceAfter(fence, content)
        const own = content.replace(NESTED_MARKERS_RE, '')
        paragraph = !wasCode && !fence && own.trim() !== '' && !isLeafBlock(own)
        body.push(content)
      } else if (paragraph && line.trim() && !isLeafBlock(line) && !LIST_ITEM_RE.test(line)) {
        body.push(line)
      } else {
        break
      }
    }
    const marker = alerts ? ALERT_MARKER_RE.exec(body[0]) : null
    const under = marker ? trimBlankLines(body.slice(1)) : ''
    out.push({ quote: true, alert: under ? marker[1].toLowerCase() : null, body: under || trimBlankLines(body) })
    proseFrom = i
  }
  if (proseFrom < lines.length) out.push(lines.slice(proseFrom).join('\n'))
  return out
}

// The text with quote markers (and alert marker lines) shed, for compact
// one-line surfaces.
export function unquotedText(text, depth = NESTING_DEPTH) {
  if (depth <= 0) return text
  return quoteSegments(text).map((seg) => (typeof seg === 'string' ? seg : unquotedText(seg.body, depth - 1))).join('\n')
}

// ── Line ranges ──────────────────────────────────────────────────────
// A finding's `line` may be a span (`20-30`, kept whole by the parsers).
// `{ start, end }` (`end === start` for one line), or null for none;
// reversed ends are sorted rather than refused.
const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/u

export function lineRange(line) {
  if (typeof line === 'number') {
    return Number.isFinite(line) && line >= 1 ? { start: Math.floor(line), end: Math.floor(line) } : null
  }
  const m = LINE_RANGE_RE.exec(String(line ?? '').trim())
  if (!m) return null
  const a = parseInt(m[1], 10)
  const b = m[2] === undefined ? a : parseInt(m[2], 10)
  if (!Number.isFinite(a) || a < 1 || !Number.isFinite(b) || b < 1) return null
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

// `42` or `20-30`, from the parse (a sloppy `30 - 20` reads as its span).
export function lineRangeLabel(range) {
  if (!range) return ''
  return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`
}

// ── Source snippet ───────────────────────────────────────────────────
// `at` as a range: a range object, a number, or a report's `20-30`.
function asRange(at) {
  if (at && typeof at === 'object') {
    const from = lineRange(at.start)
    if (!from) return null
    const to = lineRange(at.end) ?? from
    return { start: from.start, end: Math.max(from.start, to.end) }
  }
  return lineRange(at)
}

// The lines to preview around a cited place (render-finding.js
// codeSnippetTemplate): the WHOLE range plus `radius` lines either side
// (the preview scrolls rather than cropping a long span), clamped to the
// file, with the line the window starts at. A range past the end clamps
// onto the last line; nothing to centre on opens at the top.
export function snippetWindow(content, at, radius = 4) {
  // `''.split('\n')` is `['']`: an empty file would preview one blank line.
  const lines = typeof content === 'string' && content !== '' ? content.split('\n') : []
  if (lines.length === 0) return { text: '', startLine: 1, lines: [] }
  const range = asRange(at)
  const cited = range && {
    start: Math.min(range.start, lines.length),
    end: Math.min(range.end, lines.length),
  }
  const start = cited ? Math.max(1, cited.start - radius) : 1
  const end = cited
    ? Math.min(lines.length, cited.end + radius)
    : Math.min(lines.length, radius * 2 + 1)
  const window = lines.slice(start - 1, end)
  return { text: window.join('\n'), startLine: start, lines: window }
}

// Source URL for one `## Evidence` row. Rows wander between the app and
// its dependencies, and a row resolved against the wrong repo is a
// confident 404 or an unrelated file, so a repo has to earn the row:
//   0. the row's own URL, if the report wrote one;
//   1. the first row restating the finding's location: the finding's own
//      link (its `location` included) at its own lines, else its repo or
//      the report's, whatever markers its path carries;
//   2. the row's own `repo` stamp (written on a dependency row, with its
//      `package`, where they aren't the finding's), at its commit or HEAD;
//   3. a row in the finding's own package (its `package` stamp, else its
//      install), against the finding's repo — that package's upstream;
//   4. a row in a package whose upstream a loaded finding names at a commit
//      (configureDependencyRepos): of that package@version, or in that
//      install of the finding's own report where the row names no other;
//   5. a dependency row whose package the finding's bundle records
//      (`shipped(row)` → `{ file, repo }`, focus-code.js
//      bundleDependencyRepo);
//   6. own source: the finding's repo when the finding is own source too,
//      else the report's.
// Anything else in somebody else's source links nowhere: knowing a file
// is SOME dependency's doesn't say which repo to ask.
export function evidenceUrl(row, f, repoFallback, index, shipped = null) {
  if (isHttpUrl(row?.url)) return row.url
  const file = row?.file
  if (typeof file !== 'string' || file === '') return null
  const main = f?.file ?? ''
  const repo = f?.repo?.github
  const auditedCommit = f?.auditedCommit
  const at = (fields) => findingUrl({ file, line: row?.line, ...fields }, repoFallback)

  if (index === 0 && file === main) {
    const sameLines = String(row?.line ?? '').trim() === String(f?.line ?? '').trim()
    return sameLines ? findingUrl(f, repoFallback) : at({ repo: f.repo, auditedCommit })
  }
  if (repoTarget(row?.repo).id) return at({ repo: row.repo })

  const pkg = nodePackageRoot(file)
  const rowPackage = packageStampKey(row?.package)
  const ownPackage = rowPackage === null ? pkg !== null && pkg === nodePackageRoot(main) : rowPackage === packageStampKey(f?.package)
  if (repo && ownPackage) return at({ repo: f.repo, auditedCommit })

  const install = pkg === null ? null : dependencyRepos.byRoot.get(installKey(f, pkg))
  const known = (rowPackage === null ? null : dependencyRepos.byPackage.get(rowPackage))
    ?? (install && (rowPackage === null || install.pkg === rowPackage) ? install.repo : null)
  if (known) return at({ repo: known })

  if (hasDependencyMarker(file)) {
    const inBundle = shipped?.(row)
    return inBundle ? at({ file: inBundle.file, repo: inBundle.repo }) : null
  }
  return repo && !hasDependencyMarker(main) ? at({ repo: f.repo, auditedCommit }) : at({ auditedCommit })
}

// The evidence rows as a numbered markdown list, no heading; note lines
// indented under their row. `spaced` makes it a loose list (the handoff
// document). `link(row, i)` names each row's target (by default the URL
// the report wrote); `lineLinks` also links the line references in a note
// (linkLineRefs) and code-spans a row that links nowhere, or GitHub would
// read the `@scope` of a dependency path as a mention.
function evidenceRows(f, { spaced = false, link = row => row.url, lineLinks = false } = {}) {
  const rows = Array.isArray(f?.evidence) ? f.evidence : []
  if (rows.length === 0) return ''
  return rows.map((row, i) => {
    const label = locationLabel(row)
    const url = link(row, i)
    const lines = [`${i + 1}. ${url ? `[${label}](${url})` : lineLinks ? codeSpan(label) : label}`]
    const note = lineLinks ? linkLineRefs(evidenceNote(row), url) : evidenceNote(row)
    if (note) for (const noteLine of note.split('\n')) lines.push(`   ${noteLine}`)
    return lines.join('\n')
  }).join(spaced ? '\n\n' : '\n')
}

// The evidence as one `**Evidence:**` block, '' without rows: for the
// markdown export, the GitHub issue body and the search haystack. With
// `repoFallback` every row (and line reference) links as the card's do,
// for the issue body read on GitHub; without, only links the report wrote,
// so the haystack holds no URLs it didn't. `shipped` is evidenceUrl's.
export function evidenceMarkdown(f, { repoFallback, shipped = null } = {}) {
  const linked = repoFallback !== undefined
  const link = linked ? (row, i) => evidenceUrl(row, f, repoFallback, i, shipped) : undefined
  const rows = evidenceRows(f, { link, lineLinks: linked })
  return rows ? `**Evidence:**\n${rows}` : ''
}

// A note's `(line 40)`, `(lines 40-50)`, `(L40)`, `(L40-L50)` as a link to
// those lines of the row's GitHub blob link. Fenced blocks and the inline
// constructs keptRanges finds are left as written.
const LINE_REF_RE = /\(\s*(?:lines?|L)\s*(\d+)(?:\s*(?:-|–|—|to)\s*L?(\d+))?\s*\)/giu
function linkLineRefs(note, url) {
  if (!note || !url || !GH_BLOB_RE.test(url) || !/\(\s*(?:lines?|L)\s*\d/iu.test(note)) return note
  const file = stripLineAnchor(url)
  const link = (prose) => {
    const kept = keptRanges(prose)
    return prose.replaceAll(LINE_REF_RE, (match, from, to, at) => {
      const range = inFence(kept, at) ? null : lineRange(to ? `${from}-${to}` : from)
      return range ? `([${match.slice(1, -1).trim()}](${file}${lineAnchor(range)}))` : match
    })
  }
  return fenceSplit(note, fenceRanges(note)).map((part, i) => (i % 2 ? part : link(part))).join('')
}

// The inline markdown a line reference is no part of, as sorted disjoint
// [start, end) ranges: code spans (a backtick run closed by the next run of
// its length), link text with its target (`[…](…)`, `[…][ref]`), autolinks
// and bare URLs. The note is untrusted, so the pass is linear: every "next
// `]`" is read off an index built once, never by rescanning.
function keptRanges(text) {
  const kept = []
  const runs = [...text.matchAll(/`+/gu)].map((m) => [m.index, m.index + m[0].length])
  const closer = []
  const lastOfLength = new Map()
  for (let r = runs.length - 1; r >= 0; r--) {
    const length = runs[r][1] - runs[r][0]
    closer[r] = lastOfLength.get(length)
    lastOfLength.set(length, r)
  }
  for (let r = 0; r < runs.length; r++) {
    if (closer[r] === undefined) continue
    kept.push([runs[r][0], runs[closer[r]][1]])
    r = closer[r]
  }
  const nextOf = (ch) => {
    const at = Array.from({ length: text.length + 1 }, () => Infinity)
    for (let i = text.length - 1; i >= 0; i--) at[i] = text[i] === ch ? i : at[i + 1]
    return at
  }
  const [newline, bracket, paren, angle] = ['\n', ']', ')', '>'].map(nextOf)
  const spans = kept.length
  let span = 0
  for (let i = 0; i < text.length; i++) {
    while (span < spans && kept[span][1] <= i) span++
    if (span < spans && kept[span][0] <= i) { i = kept[span][1] - 1; continue }
    let end = -1
    if (text[i] === '[' && bracket[i + 1] < newline[i]) {
      end = bracket[i + 1] + 1
      const tail = text[end] === '(' ? paren[end] : text[end] === '[' ? bracket[end + 1] : Infinity
      if (tail < newline[end]) end = tail + 1
    } else if (text[i] === '<' && angle[i + 1] < newline[i]) {
      end = angle[i + 1] + 1
    } else if ((text[i] === 'h' || text[i] === 'H') && /^https?:\/\//iu.test(text.slice(i, i + 8)) && !/\w/u.test(text[i - 1] ?? '')) {
      end = i
      while (end < text.length && !/\s/u.test(text[end])) end++
    }
    if (end > i) {
      kept.push([i, end])
      i = end - 1
    }
  }
  kept.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [from, to] of kept) {
    const last = merged.at(-1)
    if (last && from < last[1]) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  return merged
}

// An inline `[label](url)` from a description (render-finding.js
// renderHighlighted) as `{ label, url }`, or null unless the target is a
// well-formed http(s) URL — a `javascript:` href stays text. The label is
// unescaped; the href is left as written.
export function markdownLinkToken(raw) {
  const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(raw)
  if (!m || !isHttpUrl(m[2])) return null
  return { label: unescapeMd(m[1].trim()) || m[2], url: m[2] }
}

// "line N", linked when there is a URL; `nothing` for a non-numeric line
// (codex / claude-security stub it as '?').
export function lineLink(f, repoFallback) {
  const lineNum = parseInt(f?.line, 10)
  if (!Number.isFinite(lineNum)) return nothing
  const url = findingUrl(f, repoFallback)
  const text = `line ${lineNum}`
  if (!url) return text
  return html`<a href=${url} target="_blank" rel="noopener">${text}</a>`
}

// A codex import's commit on GitHub; `githubRepo` is a URL or a slug.
export function commitUrl(githubRepo, hash) {
  if (!githubRepo || !hash) return null
  const base = /^https?:/iu.test(githubRepo)
    ? githubRepo.replace(/\/$/u, '')
    : `https://github.com/${githubRepo}`
  return `${base}/commit/${hash}`
}

// The narrative fields below the description, in card order.
const HANDOFF_SECTIONS = [
  ['Impact', 'impact'],
  ['Reproduction', 'reproduction'],
  ['Recommendation', 'recommendation'],
  ['Confidence reason', 'confidenceReason'],
  ['Revalidation verdict', 'revalidateVerdict'],
  ['Revalidation recommendation', 'revalidateRecommendation'],
]

// The finding as a markdown document (the copy button, the Claude
// handoff): `Key: value` metadata lines, the name as an H1, the
// description, the evidence, then an H1 per HANDOFF_SECTIONS field, each
// block omitted when absent. `repo` is resolved by the caller
// (group.findingRepo).
export function handoffBlock(f, repo) {
  const meta = []
  if (repo) meta.push(`Repo: ${repo}`)
  const location = locationLabel(f)
  if (location) meta.push(`Location: ${location}`)
  if (f?.confidence != null) meta.push(`Confidence: ${f.confidence}/10`)
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
    // The pass's sections travel with the layer.
    if (!revalidationOn && field.startsWith('revalidate')) continue
    const value = stripExportMarker(f?.[field], f)?.trim()
    if (value) blocks.push(`# ${heading}\n\n${value}`)
  }
  return blocks.join('\n\n')
}

// GitHub "new issue" URL with a pre-filled title + body, or null when
// `repo` (slug or URL) isn't on github.com, so the caller hides the button.
export function githubIssueUrl(repo, { title, body, labels = [] } = {}) {
  const base = repoBaseUrl(repo)
  if (!base) return null
  try { if (new URL(base).host.toLowerCase() !== 'github.com') return null } catch { return null }
  const params = new URLSearchParams()
  if (title) params.set('title', title)
  if (body) params.set('body', body)
  if (labels.length > 0) params.set('labels', labels.join(','))
  const qs = params.toString()
  return qs ? `${base}/issues/new?${qs}` : `${base}/issues/new`
}

// ── Comment references ───────────────────────────────────────────────
// `parseCommentRefs` splits a triage comment into plain strings and link
// tokens: `{ url, label }` for a strictly validated GitHub issue / PR /
// commit / security advisory URL, `{ url, label, self: true }` for a deep
// link to a finding in this instance. Anything that fails validation (bad
// owner, look-alike host, extra path segment, …) stays text, so no link
// 404s or leaves github.com. Bare `#123` needs a repo context and is left
// alone.
//
// The validators spell out ASCII cases instead of `/iu`: Unicode
// case-folding would pull homoglyphs (U+017F ſ, U+212A K) into `[a-z]`.

// Login: alphanumerics and single inner hyphens (≤39, checked apart).
const GH_OWNER_RE = /^[a-zA-Z\d](?:-?[a-zA-Z\d])*$/u
// Repo: [A-Za-z0-9._-], not `.` / `..` (≤100, checked apart).
const GH_REPO_RE = /^[a-zA-Z\d._-]+$/u
// Issue / PR number: no leading zero, ≤10 digits.
const GH_NUM_RE = /^[1-9]\d{0,9}$/u
const GH_SHA_RE = /^[a-fA-F\d]{7,40}$/u
// A kept fragment: GitHub's own anchor ids (`#issuecomment-123`, `#L42`).
const GH_ANCHOR_RE = /^#[\w-]+$/u
// GHSA id, lower-case as GitHub renders it (and as the round-trip needs).
const GH_GHSA_RE = /^GHSA(?:-[0-9a-z]{4}){3}$/u

function isValidOwner(s) { return s.length <= 39 && GH_OWNER_RE.test(s) }
function isValidRepo(s) { return s.length <= 100 && s !== '.' && s !== '..' && GH_REPO_RE.test(s) }

function githubRefToken(candidate) {
  let u
  try { u = new URL(candidate) } catch { return null }
  // Only a candidate already in canonical form: `new URL` rewrites its
  // input (resolves `..`, lower-cases the host, punycodes IDN homographs,
  // `\` → `/`, strips tabs), which could round a look-alike up into a
  // passing ref.
  if (u.href !== candidate) return null
  // https, exact host, no credentials or port (`github.com@evil`).
  if (u.protocol !== 'https:') return null
  if (u.hostname.toLowerCase() !== 'github.com') return null
  if (u.port || u.username || u.password) return null
  const parts = u.pathname.split('/')
  if (parts.at(-1) === '') parts.pop()

  // Advisories label as the bare (globally unique) GHSA id: the global
  // `/advisories/<id>` and the in-repo `/<owner>/<repo>/security/advisories/<id>`.
  if (parts.length === 3 && parts[1] === 'advisories') {
    const id = parts[2]
    return GH_GHSA_RE.test(id) ? { url: `https://github.com/advisories/${id}`, label: id } : null
  }
  if (parts.length === 6 && parts[3] === 'security' && parts[4] === 'advisories') {
    const [, owner, repo, , , id] = parts
    if (!isValidOwner(owner) || !isValidRepo(repo) || !GH_GHSA_RE.test(id)) return null
    return { url: `https://github.com/${owner}/${repo}/security/advisories/${id}`, label: id }
  }

  // Exactly /<owner>/<repo>/<kind>/<id>: `/pull/42/files` is not linked.
  if (parts.length !== 5) return null
  const [, owner, repo, kind, id] = parts
  if (!isValidOwner(owner) || !isValidRepo(repo)) return null
  const ref = kind === 'commit' ? GH_SHA_RE.test(id) && `@${id.slice(0, 7)}`
    : (kind === 'issues' || kind === 'pull') && GH_NUM_RE.test(id) && `#${id}`
  if (!ref) return null
  // Rebuilt from the validated parts, query dropped; a fragment kept only
  // when it is a plausible GitHub anchor.
  const hash = GH_ANCHOR_RE.test(u.hash) ? u.hash : ''
  return { url: `https://github.com/${owner}/${repo}/${kind}/${id}${hash}`, label: `${owner}/${repo}${ref}` }
}

// Finding ids are uuids in nearly every case (the analyzer's, or
// finding-id.js's); lower-case ASCII only, as above.
const FINDING_UUID_RE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u

// The short id the Links view, the "Duplicates:" row and self-link labels
// all show: a uuid's first group, or the first eight characters of a Codex
// id, else null.
export function shortFindingId(id) {
  if (typeof id !== 'string') return null
  const display = displayFindingId(id)
  return display !== id || FINDING_UUID_RE.test(id) ? display.slice(0, 8) : null
}

// Codex imports use a URL as their canonical id, but our links resolve locally.
// Omit that URL prefix in labels/tooltips; preserve the original id for lookups.
export function displayFindingId(id) {
  const value = String(id)
  const prefix = 'https://chatgpt.com/codex/cloud/security/findings/'
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

// A deep link to a finding in this instance (strictness is
// client/finding-link.js parseFindingUrl's). Local navigation is by
// fragment; managed keeps the destination path.
function selfRefToken(candidate, managed) {
  const found = parseFindingUrl(candidate, { managed })
  if (!found) return null
  const short = shortFindingId(found.id)
  return { url: managed ? found.path : `#${found.fragment}`, label: short ? `finding ${short}` : 'finding', self: true }
}

// An `http(s)://` run, stopped at whitespace and the characters that wrap
// a URL in prose or markdown (`<> " ' \` ( ) { } [ ] | \ ^`). `:` and `@`
// stay in, so credential / port look-alikes reach the validator.
const URL_SCAN_RE = /https?:\/\/[^\s<>"'`(){}[\]|\\^]+/giu
// Sentence punctuation trimmed off a candidate's end; none can be in a
// valid ref. An end-scan, not a `/[…]+$/` regex, which backtracks
// quadratically over a long run (ReDoS on untrusted comment text).
const TRAILING_PUNCT = new Set([')', '.', ',', '!', '?', ';', ':', "'", '"', '*', ']', '}', '>'])

function trimTrailingPunct(s) {
  let end = s.length
  while (end > 0 && TRAILING_PUNCT.has(s[end - 1])) end--
  return end === s.length ? s : s.slice(0, end)
}

// A comment without refs comes back as `[text]`; empty or non-string, `[]`.
export function parseCommentRefs(text, { managed = false } = {}) {
  if (typeof text !== 'string' || text.length === 0) return []
  const segments = []
  let lastIndex = 0
  URL_SCAN_RE.lastIndex = 0
  let m
  while ((m = URL_SCAN_RE.exec(text)) !== null) {
    const trimmed = trimTrailingPunct(m[0])
    const token = trimmed ? (githubRefToken(trimmed) ?? selfRefToken(trimmed, managed)) : null
    if (!token) continue
    if (m.index > lastIndex) segments.push(text.slice(lastIndex, m.index))
    segments.push(token)
    lastIndex = m.index + trimmed.length
    URL_SCAN_RE.lastIndex = lastIndex
  }
  if (lastIndex < text.length) segments.push(text.slice(lastIndex))
  return segments
}
