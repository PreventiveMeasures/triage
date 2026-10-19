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

// Keep optional narrative sections separate from the description, including
// formats that put labelled sections in the description instead of fields.
// The caller formats source links and evidence in the main view bundle, keeping
// its formatting/client imports out of the lazy managed chunk. Only Impact
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
  if (finding.file) blocks.push(`File: ${sourceUrl ? `[${location}](${sourceUrl})` : location}`)
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
  let draft = { body: blocks.join('\n\n'), sections: ordered.map(({ id, label, parts }) => ({ id, label,
    text: `**${label}:**\n${parts.join('\n\n')}`, selected: false, start: 0, end: 0 })), footer: null }
  for (const { id } of draft.sections) if (allSections || id === 'impact') draft = toggleIssueDraftSection(draft, id, true)
  if (findingLink) {
    // Separated even from an empty body, so a section toggled on can go above it.
    const start = draft.body.length + 2, text = `Triage: ${findingLink}`
    draft = { ...draft, body: `${draft.body}\n\n${text}`, footer: { start, end: start + text.length } }
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
