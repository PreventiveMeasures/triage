import { descriptionSections, locationLabel, stripExportMarker } from '@preventive/report'

const FIELDS = [
  ['impact', 'Impact'],
  ['evidence', 'Evidence'],
  ['reproduction', 'Reproduction'],
  ['recommendation', 'Recommendation'],
  ['confidenceReason', 'Confidence reason'],
  ['revalidateVerdict', 'Revalidation verdict'],
  ['revalidateRecommendation', 'Revalidation recommendation'],
]
const sectionKey = label => label.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, '')
const FIELD_IDS = new Map([...FIELDS.map(([id, label]) => [sectionKey(label), id]),
  ['reproductionsteps', 'reproduction'], ['recommendedfix', 'recommendation']])
// GitHub's issue body limit, which the server enforces before creating one.
const MAX_BODY = 65_536
// A GitHub link to a line or lines at a full commit hash: on a line of its
// own in an issue of that repository, GitHub draws the code it points at.
// The finding's source, at the revision the report read, then opens the
// issue as that snippet; at HEAD, at a short hash or without lines it
// stays `File: [path:lines](url)`. Evidence links never do: a list of
// snippets would bury the notes between them.
const PERMALINK_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/(?:[0-9a-f]{40}|[0-9a-f]{64})\/[^\s#]+#L\d+(?:-L\d+)?$/iu
// A section is its label over its text. Two read as GitHub alerts, the
// label kept inside: the impact, `[!CAUTION]` on a security finding (the
// one the issue's `security` label marks) and `[!IMPORTANT]` otherwise,
// and the recommendation, `[!TIP]`.
const quoted = text => text.split('\n').map(line => line ? `> ${line}` : '>').join('\n')
function sectionText({ id, label, parts }, finding) {
  const text = `**${label}:**\n${parts.join('\n\n')}`
  const alert = id === 'impact' ? (finding.isSecurity === true ? 'CAUTION' : 'IMPORTANT')
    : id === 'recommendation' ? 'TIP' : null
  return alert ? `> [!${alert}]\n${quoted(text)}` : text
}

// Keep optional narrative sections separate from the description, including
// formats that put labelled sections in the description instead of fields.
// The caller formats source links and evidence (format.js), so this module
// needs only @preventive/report: the card builds the GitHub form's body with
// it up front, and the lazily loaded managed issue dialog its draft. Only Impact
// starts selected unless `allSections`; `findingLink` ends the body, and
// sections toggled on later go above it.
export function createIssueDraft(finding, { sourceUrl, evidence = '', showRevalidation = true, findingLink, allSections = false } = {}) {
  const blocks = [], content = new Map()
  const add = (id, label, text) => {
    if (!text?.trim()) return
    const section = content.get(id) ?? { id, label, parts: [] }
    if (!section.parts.includes(text.trim())) section.parts.push(text.trim())
    content.set(id, section)
  }
  const location = locationLabel(finding)
  if (finding.file) blocks.push(PERMALINK_RE.test(sourceUrl ?? '') ? sourceUrl : `File: ${sourceUrl ? `[${location}](${sourceUrl})` : location}`)
  let current = null
  for (const section of descriptionSections(stripExportMarker(finding.description, finding))) {
    if (section.label !== null) {
      const key = sectionKey(section.label)
      current = ['description', 'details', 'summary'].includes(key) ? null
        : { id: FIELD_IDS.get(key) ?? key, label: section.label }
    }
    if (current) add(current.id, current.label, section.body)
    else blocks.push(section.label ? `**${section.label}:** ${section.body}` : section.body)
  }
  if (finding.confidence != null) blocks.push(`Confidence: ${finding.confidence}/10`)
  for (const [id, label] of FIELDS) {
    if (id.startsWith('revalidate') && !showRevalidation) { content.delete(id); continue }
    const text = id === 'evidence' ? evidence.replace(/^\*\*Evidence:\*\*\n/u, '')
      : stripExportMarker(finding[id], finding)
    add(id, label, text)
  }
  const ordered = [...FIELDS.map(([id]) => content.get(id)).filter(Boolean), ...[...content.values()].filter(s => !FIELDS.some(([id]) => id === s.id))]
  let draft = { body: blocks.join('\n\n'), sections: ordered.map(section => ({ id: section.id, label: section.label,
    text: sectionText(section, finding), selected: false, start: 0, end: 0 })), footer: null }
  // The link, then each section, only while the body stays within what GitHub
  // accepts; evidence alone can be far longer.
  let link = findingLink ? `Triage: ${findingLink}` : ''
  if (draft.body.length + 2 + link.length > MAX_BODY) link = ''
  for (const { id } of draft.sections) {
    const next = allSections || id === 'impact' ? toggleIssueDraftSection(draft, id, true) : draft
    if (next.body.length + (link ? link.length + 2 : 0) <= MAX_BODY) draft = next
  }
  if (link) {
    // Separated even from an empty body, so a section toggled on can go above it.
    const start = draft.body.length + 2
    draft = { ...draft, body: `${draft.body}\n\n${link}`, footer: { start, end: start + link.length } }
  }
  return draft
}

// Track the ranges we inserted rather than re-parsing the user's Markdown.
// Edits inside a section (including its heading or code) survive off/on toggles.
// A replacement across a section boundary becomes free text, so a subsequent
// toggle cannot delete part of the user's new description. The finding link
// is tracked the same way, and once released sections append after it.
export function editIssueDraft(draft, body) {
  const previous = draft.body
  if (body === previous) return draft
  let end = previous.length, nextEnd = body.length, start = 0
  while (start < end && start < nextEnd && previous[start] === body[start]) start++
  while (end > start && nextEnd > start && previous[end - 1] === body[nextEnd - 1]) { end--; nextEnd-- }
  const delta = body.length - previous.length
  // The range after the edit, or null when the edit crosses its boundary.
  const moved = ({ start: from, end: to }) => start >= from && end <= to ? { start: from, end: to + delta }
    : end <= from ? { start: from + delta, end: to + delta } : start >= to ? { start: from, end: to } : null
  const sections = draft.sections.map(section => {
    if (!section.selected) return section
    const range = moved(section)
    return range ? { ...section, ...range } : { ...section, text: previous.slice(section.start, section.end), selected: false, start: 0, end: 0 }
  })
  return { body, sections, footer: draft.footer ? moved(draft.footer) : null }
}

export function toggleIssueDraftSection(draft, id, selected) {
  const section = draft.sections.find(item => item.id === id)
  if (!section || section.selected === selected) return draft
  const footer = draft.footer ?? null
  if (selected) {
    // Insert above the finding link while a blank line still parts it from
    // the text above; otherwise append, as without a link.
    const at = footer && draft.body.slice(0, footer.start).endsWith('\n\n') ? footer.start - 2 : draft.body.length
    const head = draft.body.slice(0, at)
    const separator = !head || head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n'
    const start = at + separator.length
    const end = start + section.text.length
    const delta = end - at
    const shift = item => ({ ...item, start: item.start + delta, end: item.end + delta })
    const sections = draft.sections.map(item => item === section ? { ...item, selected, separator, start, end }
      : item.selected && item.start >= at ? shift(item) : item)
    return { body: head + separator + section.text + draft.body.slice(at), sections, footer: footer && footer.start >= at ? shift(footer) : footer }
  }
  // Remove only the section and its separating blank line, leaving surrounding
  // free text and the other sections untouched.
  const text = draft.body.slice(section.start, section.end)
  const separator = section.separator ?? ''
  const separatorStart = section.start - separator.length
  const ownsSeparator = draft.body.slice(separatorStart, section.start) === separator
    && !draft.sections.some(item => item !== section && item.selected && item.start < section.start && item.end > separatorStart)
  const start = ownsSeparator ? separatorStart : section.start
  const body = draft.body.slice(0, start) + draft.body.slice(section.end)
  const delta = start - section.end
  const shift = item => ({ ...item, start: item.start + delta, end: item.end + delta })
  const sections = draft.sections.map(item => item === section
    ? { ...item, text, selected, start: 0, end: 0 }
    : item.selected && item.start >= section.end ? shift(item) : item)
  return { body, sections, footer: footer && footer.start >= section.end ? shift(footer) : footer }
}
