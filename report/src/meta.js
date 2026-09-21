// Run-level meta — the fields at the top of a report describing the run
// that produced it. Both the report view (ui/view/ingest.js) and the
// OPFS-wide index (client/bundle-finding-index.js) project the header
// onto the findings, so every consumer reads run meta off a finding
// without asking whether the file was one run or a deduplicated dump.
export const META_FIELDS = ['type', 'model', 'think', 'effort', 'exportsMode']

// Each run-meta field the finding doesn't specify, filled in place from
// the report header. Per-field, not all-or-nothing: `deduplicate` stamps
// `model` per finding while the rest stay run-level, so a finding
// carrying only its own `model` still needs the header's `type`. Null
// counts as unspecified — a report is JSON, where `"type": null` can't be
// told from an omitted key. Source-marked reports opt out wholesale:
// each is one analyzer, and its report-level `type` is the product's
// category rather than a run descriptor.
export function inheritReportMeta(finding, data) {
  if (data.source) return
  for (const key of META_FIELDS) {
    if (finding[key] == null && data[key] != null) finding[key] = data[key]
  }
}

// `"repo": { "github": "owner/name" }` at the top of a native dump, the
// repository the run covered. NOT inherited onto findings the way
// META_FIELDS are: a finding's own `repo.github` names the upstream of
// the file IT sits in — a dependency's repo under `node_modules/` — so
// stamping the report's over it would mislabel every dependency finding.
//
// Takes the slug or a github.com URL, with or without scheme, `.git` or
// a trailing `/tree/main`, and normalises both to the slug. Anything
// else is null: a value the link builders would splice into a broken URL
// is worse than none.
const GITHUB_URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:[/?#].*)?$/iu
const SLUG_RE = /^[\w.-]+\/[\w.-]+$/u

// Is this value that slug already? Asked wherever a report hands over
// something that may be one: `repo.github` below, a Piolium preamble's
// `**Target:**`, a finding's repo on its way to a link.
export function isRepoSlug(s) {
  return SLUG_RE.test(s)
}

export function reportRepoGithub(data) {
  const raw = data?.repo?.github
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/\/+$/u, '')
  if (!trimmed) return null
  const url = GITHUB_URL_RE.exec(trimmed)
  const slug = (url ? `${url[1]}/${url[2]}` : trimmed).replace(/\.git$/u, '')
  return isRepoSlug(slug) ? slug : null
}

// `"directory": "packages/babel-core"` beside that `github` — where
// inside the repository the tree the report describes sits, the same
// field npm's `repository` object carries for a package in a monorepo
// (`{ "github": "babel/babel", "directory": "packages/babel-core" }`).
// The paths a report writes are relative to that tree, so a link is
// the repo, then this, then the path: `babel/babel` +
// `packages/babel-core` + `src/index.js`. Declared in both the places
// `repo` is — the report header and a finding's own — and read off
// whichever of the two answered for the repo, never mixed.
//
// Normalised to a bare relative path: no leading `./` or `/`, no
// trailing one, no repeated separators, and `''` — same as declaring
// none — for the repo root. `''` too for anything a link builder
// would splice into a broken URL, the rule `reportRepoGithub` follows
// above: a non-string, a `?` or `#` (either cuts the path short of the
// file, and swallows the `#L42` anchor a line link puts after it), or
// a `..` segment climbing out of the repository.
export function repoDirectory(repo) {
  const raw = typeof repo?.directory === 'string' ? repo.directory.trim() : ''
  const path = raw.replace(/^(?:\.\/)+/u, '').replaceAll(/^\/+|\/+$/gu, '').replaceAll(/\/{2,}/gu, '/')
  if (!path || path === '.') return ''
  if (/[?#]/u.test(path) || path.split('/').includes('..')) return ''
  return path
}
