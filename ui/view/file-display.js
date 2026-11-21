import { LINKS_KIND, getKind } from '#client/index.js'
import { REPORT_FILE_ICONS, REPORT_LOGOS } from './report-logos.js'
export { REPORT_LOGOS } from './report-logos.js'
import { SOURCE_LABELS } from '@preventive/report'
import { LINKS_ICON_SVG } from './icons.js'

// Shared file-row affordances: the producers' sticker icons, the source
// bucket of a report, and its display name.

// The file-row stickers, one mark per producer (DeepView's own for the
// default bucket, the upstream's official mark for a source bucket), their
// fills themed by the `.brand-*` classes in sidebar.css.
export const FILE_ICONS = {
  ...REPORT_FILE_ICONS,
  [LINKS_KIND]: LINKS_ICON_SVG,
}

// The named buckets, by the `source` marker a report carries
// (@preventive/report SOURCE_LABELS). The analyzer's own dump is `default`.
const SOURCE_GROUPS = new Set(Object.keys(SOURCE_LABELS))

// Who PRODUCED a report in a bucket, the word beside a sticker where the
// sticker alone is the signal (the finding card's "Duplicates:" row): the
// report library's names, and DeepView for `default`, as the drop zone's
// supported-formats list calls it.
export const PRODUCER_LABELS = {
  ...SOURCE_LABELS,
  'default': 'DeepView',
}

// The branded producer a FINDING carries — its own `_source` marker
// (ingest stamps it per finding) where it names one we draw — else null,
// for DeepView's own and for markers nothing here draws alike: the surfaces
// marking findings (the tab strip's branded segment, the kanban card's
// corner) leave DeepView unmarked. A report CAN name `default` as its
// source, and that should read the same as naming nothing.
export function findingBrand(f) {
  const marker = f._source ?? f.source
  return marker !== 'default' && Object.hasOwn(REPORT_LOGOS, marker) ? marker : null
}

// The bucket (default / claude-security / codex-security / deepsec /
// piolium / links) of an OPFS filename. The content's answer, cached on
// counts.js, decides it — DeepSec, Piolium and Claude Security all ship
// as `.md`, and the app's own export of any report is a `.md` too — `null`
// (no producer named) filing it under `default`. The extension guesses only
// for a file nothing has looked at yet, and never `links` (a links file is
// a `.json` like any dump): it re-buckets once the lazy count fill reaches it.
export function groupOf(name) {
  return reportGroup(name, getKind(name))
}

// Managed catalogs supply their own analyzer metadata. Do not consult the
// local filename cache: another report can have the same name there.
export function reportGroup(name, kind) {
  if (kind === LINKS_KIND) return LINKS_KIND
  if (kind !== undefined) return SOURCE_GROUPS.has(kind) ? kind : 'default'
  const lower = name.toLowerCase()
  if (lower.endsWith('.generic-md')) return 'markdown-generic'
  if (lower.endsWith('.codex')) return 'codex-security'
  if (lower.endsWith('.md')) return 'claude-security'
  return 'default'
}

// Whether an OPFS entry is a links file rather than a report — what every
// surface meaning "reports" asks of the shared directory. From the cached
// kind `groupOf` reads, so an unanalyzed file reads as a report until the
// next render.
export function isLinksFile(name) {
  return getKind(name) === LINKS_KIND
}

export { displayName } from '../../common/report-display-name.js'
