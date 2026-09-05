// Run-level meta — the fields the analyzer emits at the top of each
// report describing the run that produced it. The report view
// (ui/view/ingest.js) and the OPFS-wide finding index
// (client/bundle-finding-index.js) both project the header onto the
// findings so every consumer (header combo tags, the analyzer/model
// dropdown, the per-finding meta line, the bundle source panel) reads
// run meta off the finding without branching on whether the file came
// from a single analyzer run or a deduplicated dump.
export const META_FIELDS = ['type', 'model', 'think', 'effort', 'exportsMode']

// Fill in each run-meta field the finding doesn't specify from the
// report header. Per-field, not all-or-nothing: the deduplicate command
// stamps `model` on individual findings (one per source run) while the
// remaining fields stay run-level in the header, so a finding carrying
// only its own `model` still needs the header's `type` — without it the
// analyzer reads as `null` / "(none)" everywhere despite the header
// naming one. A finding's own value always wins; the header only fills
// gaps.
//
// A field counts as unspecified when it is absent OR null: a report is
// JSON, which has no `undefined`, so an exporter writing `"type": null`
// to mean "not set" is indistinguishable from one omitting the key.
//
// Source-marked reports (deepsec / codex-security / claude-security) opt
// out wholesale — their report-level `type` is a whole-file category
// label, not a per-finding analyzer descriptor, and they carry no
// analyzer run meta to hand down.
//
// Mutates `finding` in place. Callers pass either a fresh copy (ingest's
// `filled`) or a finding the index hasn't handed to anything yet.
export function inheritReportMeta(finding, data) {
  if (data.source) return
  for (const key of META_FIELDS) {
    if (finding[key] == null && data[key] != null) finding[key] = data[key]
  }
}

// The report-level repo declaration — `"repo": { "github": "owner/name" }`
// at the top of a native dump, naming the repository the run covered.
//
// NOT inherited onto findings the way META_FIELDS are: the per-finding
// `repo.github` names the upstream of the file THAT finding sits in —
// a dependency's own repo for anything under `node_modules/` — so
// stamping the report's repo over it would mislabel every dependency
// finding and point its file links at paths the project repo doesn't
// carry. It stays a statement the report makes about itself, which
// consumers rank ABOVE whatever the findings happen to agree on.
//
// Accepts the canonical `owner/name` slug or a github.com URL (some
// exporters write the full URL, with or without scheme, `.git`, or a
// trailing `/tree/main`), normalising both to the slug: the form
// `fileUrl` interpolates, `<repo-chip>` labels, and the Repositories
// view buckets under alongside analyzer-stamped values.
//
// Returns null for anything else — missing, non-string, a non-GitHub
// URL, a bare owner. A value the link builders would splice into a
// broken URL is worse than no repo at all.
const GITHUB_URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:[/?#].*)?$/iu
const SLUG_RE = /^[\w.-]+\/[\w.-]+$/u

export function reportRepoGithub(data) {
  const raw = data?.repo?.github
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/\/+$/u, '')
  if (!trimmed) return null
  const url = GITHUB_URL_RE.exec(trimmed)
  const slug = (url ? `${url[1]}/${url[2]}` : trimmed).replace(/\.git$/u, '')
  return SLUG_RE.test(slug) ? slug : null
}
