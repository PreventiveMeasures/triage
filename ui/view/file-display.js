import { LINKS_KIND, getKind } from '#client/index.js'
import { REPORT_BRANDS, REPORT_LOGOS } from './report-logos.js'
export { REPORT_LOGOS } from './report-logos.js'
import { SOURCE_LABELS } from '../../report/index.js'
import { LINKS_ICON_SVG } from './icons.js'

// Shared file-row affordances — the brand-marked "sticker" icons,
// the source-bucket detection, and the display-name transform that
// strips bucket-marker suffixes added by ingest. Used by the
// sidebar's file list and the action-row report chip in
// workspace-merged views.

const STICKER_BASE = '<path class="bg" d="M3 2h6l4 4v8H3z"/><path fill="rgba(0,0,0,.18)" d="M9 2v4h4Z"/>'

// Inline `<svg>` for the file-row icon. 14px to match the chrome's
// other icon buttons. Each bucket renders as a filled "sticker":
// the sheet body fills with a brand color, a translucent black
// triangle in the corner reads as a folded-over flap, and the mark
// sits centered in the foreground color. The default Reports bucket
// uses DeepView's own house mark (white on blue) — eye + iris rings
// + camera aperture surrounded by circuit ornaments — so
// analyzer-native dumps still get a recognizable sticker. Source
// buckets pull the upstream's official mark (Claude on salmon,
// OpenAI on white, Vercel on black). Bg / fg fills are themed via
// the `.brand-*` classes on the SVG root in sidebar.css; path
// coordinates have been baked through svgo so the brand glyphs land
// at their final positions without runtime transforms.
// One mark per producer, shared by file stickers and inset button logos.

export const FILE_ICONS = {
  ...Object.fromEntries(Object.entries(REPORT_BRANDS).map(([key, { className, mark }]) => [
    key, `<svg class="file-icon ${className}" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${STICKER_BASE}${mark}</svg>`,
  ])),
  [LINKS_KIND]: LINKS_ICON_SVG,
}

// The named buckets, by the `source` marker a report carries
// (report/src/labels.js SOURCE_LABELS names the same four). A report
// naming none — the analyzer's own dump — belongs to `default`.
const SOURCE_GROUPS = new Set(['claude-security', 'codex-security', 'deepsec', 'piolium'])

// Who PRODUCED a report in this bucket — the word to put beside its
// sticker when the sticker alone is the signal, as in the finding
// card's "Duplicates:" row (a mark with no text beside it says
// nothing to a reader who can't see it).
//
// The four named producers come straight from the report library so
// its word and this one can't drift. `default` is the exception, and
// it says DeepView rather than the sidebar's "Reports": that section
// header groups analyzer-native dumps without naming the pipeline,
// but here the question is literally "which analyzer", and DeepView
// is what the drop zone's supported-formats list calls its own.
export const PRODUCER_LABELS = {
  ...SOURCE_LABELS,
  'default': 'DeepView',
}

// Does this `source` marker name a producer we draw? Answers with the
// marker itself (a REPORT_LOGOS / PRODUCER_LABELS key) or null.
//
// Null covers both "DeepView's own" and "a marker nothing here draws":
// the surfaces that mark findings with their producer — the finding
// tabs' branded segment, the kanban card's corner, the workspace
// header's chips — are the ones where DeepView is the unmarked
// default, so they want one question answered ("is there a producer to
// show here?"), not two. `'default'` is excluded explicitly because a
// report CAN name it as its source, and that spelling of "mine" should
// read the same as naming nothing.
function brandOf(marker) {
  return marker !== 'default' && Object.hasOwn(REPORT_LOGOS, marker) ? marker : null
}

// The branded producer a FINDING carries. Its own `_source` marker
// decides it — ingest.js stamps that per finding, from the finding's
// own marker when it has one and its report's otherwise, so a
// re-imported export that mixed a product's rows with native runs
// answers per row.
export function findingBrand(f) {
  return brandOf(f._source ?? f.source)
}

// …and the distinct branded producers a LOADED VIEW carries, which is
// what the workspace header's chip strip names. Takes the report
// records (`state.reports`), not their findings, because the two
// halves answer for each other:
//
//   - Each report's OWN `source`, so a product whose pass found
//     nothing is still named. An empty report is a loaded report — the
//     header's file chip counts it in its "N reports" — and "the Codex
//     pass ran and came back clean" is a different thing to know than
//     "no Codex pass here", which is all the strip could say when this
//     read findings alone.
//   - Each finding's own marker, because a report does not have to be
//     of one product: a re-imported export can carry a product's rows
//     beside native ones, and `findingBrand` is what knows that.
//
// Ordered by the report library's own producer table, not by the order
// the reports were read in: the strip is the same chips whichever
// report the sidebar loaded first, and it matches the order the
// analyzer dropdown lists the same producers in. A key the table
// doesn't name still gets a chip (after the known ones,
// alphabetically) rather than being dropped — the same call
// `analyzerLabel` makes for an unrecognized marker.
export function loadedBrands(reports) {
  const found = new Set()
  for (const r of reports) {
    const declared = brandOf(r.source)
    if (declared !== null) found.add(declared)
    for (const f of r.groups.flat()) {
      const brand = findingBrand(f)
      if (brand !== null) found.add(brand)
    }
  }
  const order = Object.keys(SOURCE_LABELS)
  const rank = (k) => {
    const i = order.indexOf(k)
    return i === -1 ? order.length : i
  }
  return [...found].toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

// Resolve the bucket key (default / claude-security / codex-security
// / deepsec / piolium) for a given OPFS filename. The content's own
// answer decides it, cached on counts.js: DeepSec, Piolium and Claude
// Security all ship as `.md`, so an extension check alone can't tell
// them apart.
//
// A file that HAS been analyzed is filed by that answer and nothing
// else, `null` (no producer named) included — the `default` bucket,
// where an analyzer dump belongs. Falling through to the extension
// there is what put every re-imported export under Claude Security:
// the app writes its own export as a `.md` whatever the findings came
// from, so a native dump exported and dropped back in reads as
// source-less (rightly — the header names its RUN, not a product) and
// the `.md` guess overrode it. A codex report was mis-filed the same
// way, by an if-chain that never named its marker: the export of one
// is a `.md`, so it missed the `.codex` test under it.
//
// The extension is the answer only for a file nothing has looked at
// yet — a pre-existing OPFS entry on the first sidebar render, before
// the lazy fill reaches it — where a guess beats no bucket at all.
// `links` is in the answer set but not in `SOURCE_GROUPS`: it names a
// file that is not a report at all (see client/linked-findings.js), so
// it is its own bucket rather than a producer's. Nothing guesses it
// from an extension — a links file is a `.json` like any dump, and the
// content is the only thing that says otherwise — so an un-analyzed
// file falls through to the report guesses below and re-buckets itself
// the moment the lazy count fill reaches it.
export function groupOf(name) {
  const kind = getKind(name)
  if (kind === LINKS_KIND) return LINKS_KIND
  if (kind !== undefined) return SOURCE_GROUPS.has(kind) ? kind : 'default'
  const lower = name.toLowerCase()
  if (lower.endsWith('.codex')) return 'codex-security'
  if (lower.endsWith('.md')) return 'claude-security'
  return 'default'
}

// Is this OPFS entry a links file rather than a report? The question
// every surface that means "reports" has to ask now that the two share
// a directory — the delete dialog's triage impact, the workspace
// export's report list, the counts a report view leads with. Answered
// from the same cached kind `groupOf` reads, so a file nothing has
// analyzed yet reads as "not links" and corrects itself on the next
// render, exactly as its bucket does.
export function isLinksFile(name) {
  return getKind(name) === LINKS_KIND
}

// Filename-to-label transform for the bucket-marker suffixes ingest
// stamps on at drop time. `.codex` filenames are derived (e.g.
// `org__repo:scan-suffix.codex`) — un-sanitize the slashes and strip
// the suffix for the visible label so the sidebar reads as the
// original `org/repo:scan-suffix`. DeepSec drops keep their original
// `.md` extension and need no transform.
export function displayName(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.codex')) return name.slice(0, -'.codex'.length).replaceAll('__', '/')
  return name
}
