// One finding as markdown — its heading, the facts that aren't prose as
// a labelled list, then the narrative in the order a reader needs it.
// The document (write-md.js) hands in the heading text and the depth to
// write at; everything about WHAT a finding carries is read here, off
// the parser's own object, through finding.js.
//
// Nothing a finding carries is dropped for being unfamiliar to the
// viewer. The fields the markdown importers preserve for exactly this
// purpose — a report's status and branch, an audit's PoC state and its
// own commit — land on the list beside the ones every card shows, and
// each narrative field gets a section of its own rather than a bold
// label buried in a paragraph.
//
// A dedup group — one finding reported several times, across reports
// or by several runs — is one heading with a case under it per member,
// so the reader meets the finding once and its reports as its cases.

import { correctedVariants, descriptionSections, displayedSeverity, effectiveSeverity, evidenceNote, findingDisplayName, findingTitle, hasSeverityCorrection, locationLabel, revalidateKindOf, runMetaLine, splitDescription, stripExportMarker } from './finding.js'
import { COLOR_LABELS, TRIAGE_LABELS, severityLabel } from './labels.js'
import { autolink, code, heading, indentUnder, isHttpUrl, joinBlocks, link, plural, prose } from './md-text.js'

// A heading has to fit on a line. A JSON finding whose whole
// description is one paragraph is NAMED by that paragraph — the row
// cell shows it in full, a heading can't — so past this it is cut, and
// the body then carries the whole line (see descriptionBlocks).
const HEADING_MAX = 120

export function findingHeading(f) {
  const title = findingTitle(f) || locationLabel(f) || 'Untitled finding'
  return title.length > HEADING_MAX ? `${title.slice(0, HEADING_MAX - 1).trimEnd()}…` : title
}

// A repository as a link — a github.com slug points at github.com, a
// URL at itself, anything else stays the text it is.
export function repoRef(repo) {
  const s = String(repo ?? '').trim()
  if (isHttpUrl(s)) return autolink(s)
  return /^[\w.-]+\/[\w.-]+$/u.test(s) ? link(s, `https://github.com/${s}`) : s
}

// The narrative fields beyond the description, as `[heading, field,
// pass]` in the order a reader needs them: what it means, how to
// trigger it, how to fix it, then the analyzer's and the pass's remarks
// about it — the order the card reads them in. The pass's two travel
// with the revalidation layer (ctx.revalidation).
const NARRATIVE = [
  ['Impact', 'impact', false],
  ['Reproduction', 'reproduction', false],
  ['Recommendation', 'recommendation', false],
  ['Confidence reasoning', 'confidenceReason', false],
  ['Revalidation verdict', 'revalidateVerdict', true],
  ['Revalidation recommendation', 'revalidateRecommendation', true],
]

// The plain facts a report may attach, `[label, field]`, printed as
// written. Strings and numbers only — a report's own structures (an
// object) have no line to print on.
const PLAIN_FIELDS = [
  ['Status', 'status'], ['Branch', 'branch'], ['Created', 'dateCreated'],
  ['Detected', 'detectedAt'], ['Committed', 'committedAt'],
  ['PoC', 'pocStatus'], ['Variant of', 'parent'], ['Rule', 'slug'],
  ['Priority', 'priority'],
]
// …and the ones that are paths or hashes, set in code.
const CODE_FIELDS = [['Detailed report', 'reportPath'], ['Audited commit', 'auditedCommit']]

function plainValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  return typeof v === 'string' ? v.trim() : ''
}

// The severity as the reader's lens shows it, with the other value of
// a corrected finding beside it — the document has no toggle, so both
// are always on the page — and the per-report divergence a workspace
// merge can carry.
function severityText(f, ctx) {
  const original = ctx.severityMode === 'original'
  let text = severityLabel(displayedSeverity(f, ctx.severityMode))
  if (hasSeverityCorrection(f)) {
    text += original
      ? ` — corrected to ${severityLabel(effectiveSeverity(f))}`
      : ` — corrected from ${severityLabel(f.severity)}`
  }
  const variants = correctedVariants(f)
  if (variants) {
    const list = Object.entries(variants).map(([r, v]) => `${r || 'this report'}: ${severityLabel(v?.severity)}`)
    text += ` (varies across reports — ${list.join('; ')})`
  }
  if (f.critical === true) text += ' · flagged critical by the analyzer'
  return text
}

function locationText(f, ctx) {
  const label = locationLabel(f)
  if (!label) return ''
  const url = ctx.hooks.location(f)
  const ref = isHttpUrl(url) ? link(code(label), url) : code(label)
  const name = findingDisplayName(f)
  return name ? `${ref} · ${code(name)}` : ref
}

// What the reader did with the finding: its triage bucket (or the
// per-report ignore), its colour mark, its flag — one line.
function triageText(a) {
  if (!a) return ''
  const parts = []
  const bucket = TRIAGE_LABELS[a.triage] ?? (a.ignored ? TRIAGE_LABELS.ignored : '')
  if (bucket) parts.push(bucket)
  if (a.color) parts.push(`${COLOR_LABELS[a.color] ?? a.color} mark`)
  if (a.flagged === true) parts.push('Flagged')
  return parts.join(' · ')
}

function commitText(f, ctx) {
  const hash = plainValue(f.commitHash)
  if (!hash) return ''
  const url = ctx.hooks.commit(f)
  return isHttpUrl(url) ? link(code(hash.slice(0, 7)), url) : code(hash)
}

// The labelled list under a finding's heading — every fact that isn't
// prose, in the order the card's rail and line row read them, then the
// provenance the report attached. A line is written only when its fact
// is there.
function metaList(f, ctx, annotation) {
  const rows = []
  const add = (label, value) => { if (value) rows.push(`- **${label}:** ${value}`) }
  add('Location', locationText(f, ctx))
  add('Severity', severityText(f, ctx))
  if (f.confidence !== undefined && f.confidence !== null) add('Confidence', `${f.confidence}/10`)
  if (ctx.showRunMeta) add('Analyzer', runMetaLine(f, ctx.revalidation))
  const kind = ctx.revalidation ? revalidateKindOf(f) : ''
  if (kind) add('Revalidation', kind === 'revalidation' ? 'the revalidation pass itself' : kind)
  add('Triage', triageText(annotation))
  if (annotation?.fix) add('Fix', autolink(String(annotation.fix).trim()))
  if (ctx.showReport) add('Report', code(ctx.hooks.report(f) ?? ''))
  const repo = plainValue(f.repo?.github)
  if (repo && repo !== ctx.repo) add('Repository', repoRef(repo))
  add('Introduced in', commitText(f, ctx))
  const found = plainValue(f.discoveredIn)
  if (found && found !== String(f.file ?? '').trim()) add('Found while analyzing', code(found))
  const npm = f.package?.npm
  const pkg = plainValue(npm?.name)
  if (pkg) add('Package', code(plainValue(npm.version) ? `${pkg}@${plainValue(npm.version)}` : pkg))
  for (const [label, field] of PLAIN_FIELDS) add(label, plainValue(f[field]))
  for (const [label, field] of CODE_FIELDS) add(label, code(plainValue(f[field])))
  return rows.join('\n')
}

function section(depth, label, text) {
  const body = prose(text)
  return body ? `${heading(depth, label)}\n\n${body}` : heading(depth, label)
}

// The `## Evidence` rows as a loose numbered list: the reference (linked
// where the caller can link it), and the report's note about it as its
// own paragraph under the reference — loose, because a note that shared
// the reference's line would be reflowed onto it.
function evidenceList(f, ctx) {
  const rows = Array.isArray(f.evidence) ? f.evidence : []
  return rows.map((row, i) => {
    const marker = `${i + 1}. `
    const label = locationLabel(row)
    const url = ctx.hooks.evidence(row, f, i)
    let ref = ''
    if (label) ref = isHttpUrl(url) ? link(code(label), url) : code(label)
    else if (isHttpUrl(url)) ref = autolink(url)
    const note = prose(evidenceNote(row))
    const head = marker + (ref || '(no reference)')
    return note ? `${head}\n\n${indentUnder(marker, note)}` : head
  }).join('\n\n')
}

// The description's lead, its evidence, then the labelled sections the
// report wrote — the order a claude-security report writes them in,
// and the one the card reads them in. A `**Label:**` paragraph becomes
// a section with a heading, the same treatment the finding's own
// impact / reproduction fields get, so a report that wrote those as
// fields and one that wrote them into its prose read identically.
function descriptionBlocks(f, ctx, depth) {
  const split = splitDescription(f)
  // Line endings first: the paragraph split below reads blank lines,
  // and a `\r\n\r\n` a JSON report wrote is not one to it.
  const body = split.body.replaceAll(/\r\n?/gu, '\n')
  // A one-line description IS the heading; printing it again under the
  // heading is a stutter. A cut heading keeps it — the body is then the
  // only place the whole line appears.
  const title = findingTitle(f)
  const stutter = !split.title && body.trim() === title && findingHeading(f) === title
  const sections = descriptionSections(stutter ? '' : body)
  const firstLabel = sections.findIndex((s) => s.label !== null)
  const lead = firstLabel === -1 ? sections : sections.slice(0, firstLabel)
  const rest = firstLabel === -1 ? [] : sections.slice(firstLabel)
  const blocks = lead.map((s) => prose(s.body))
  const evidence = evidenceList(f, ctx)
  if (evidence) blocks.push(`${heading(depth, 'Evidence')}\n\n${evidence}`)
  for (const s of rest) blocks.push(s.label === null ? prose(s.body) : section(depth, s.label, s.body))
  return blocks
}

// Everything under one case's heading: the facts, the description, the
// narrative sections, and the reader's comment last — it is about the
// finding rather than part of it.
function caseBlocks(f, ctx, depth) {
  const annotation = ctx.hooks.annotation(f)
  const blocks = [metaList(f, ctx, annotation), ...descriptionBlocks(f, ctx, depth)]
  for (const [label, field, pass] of NARRATIVE) {
    if (pass && !ctx.revalidation) continue
    const raw = f[field]
    const value = typeof raw === 'string' ? stripExportMarker(raw, f) : ''
    if (value.trim()) blocks.push(section(depth, label, value))
  }
  if (hasSeverityCorrection(f) && plainValue(f.correctedSeverityReason)) {
    blocks.push(section(depth, 'Severity correction', f.correctedSeverityReason))
  }
  const comment = plainValue(annotation?.comment)
  if (comment) blocks.push(section(depth, 'Comment', comment))
  return blocks
}

// One group under its heading. A single case writes straight under it;
// several get a heading each — numbered, located — with the group's
// sections one level down from there. A case that names itself
// differently from the group says so under its own heading.
export function groupSection(group, ctx, { headingText, depth }) {
  const blocks = [heading(depth, headingText)]
  if (group.length === 1) return joinBlocks([...blocks, ...caseBlocks(group[0], ctx, depth + 1)])
  const reports = [...new Set(group.map((f) => ctx.hooks.report(f)).filter(Boolean))]
  const from = reports.length > 1 ? ` — reported in ${reports.map((r) => code(r)).join(', ')}` : ''
  blocks.push(`${plural(group.length, 'case')} of this finding${from}.`)
  const groupTitle = findingTitle(group[0])
  group.forEach((f, i) => {
    const loc = locationLabel(f)
    blocks.push(heading(depth + 1, `Case ${i + 1} of ${group.length}${loc ? ` — ${code(loc)}` : ''}`))
    const own = findingTitle(f)
    if (own && own !== groupTitle) blocks.push(own)
    blocks.push(...caseBlocks(f, ctx, depth + 2))
  })
  return joinBlocks(blocks)
}
