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
// its formatting/client imports out of the lazy managed chunk.
export function createIssueDraft(finding, { sourceUrl, evidence = '', showRevalidation = true } = {}) {
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
    text: `**${label}:**\n${parts.join('\n\n')}`, selected: false, start: 0, end: 0 })) }
  if (content.has('impact')) draft = toggleIssueDraftSection(draft, 'impact', true)
  return draft
}

// Track the ranges we inserted rather than re-parsing the user's Markdown.
// Edits inside a section (including its heading or code) survive off/on toggles.
// A replacement across a section boundary becomes free text, so a subsequent
// toggle cannot delete part of the user's new description.
export function editIssueDraft(draft, body) {
  const previous = draft.body
  if (body === previous) return draft
  let end = previous.length, nextEnd = body.length, start = 0
  while (start < end && start < nextEnd && previous[start] === body[start]) start++
  while (end > start && nextEnd > start && previous[end - 1] === body[nextEnd - 1]) { end--; nextEnd-- }
  const delta = body.length - previous.length
  const sections = draft.sections.map(section => {
    if (!section.selected) return section
    if (start >= section.start && end <= section.end) return { ...section, end: section.end + delta }
    if (end <= section.start) return { ...section, start: section.start + delta, end: section.end + delta }
    if (start >= section.end) return section
    return { ...section, text: previous.slice(section.start, section.end), selected: false, start: 0, end: 0 }
  })
  return { body, sections }
}

export function toggleIssueDraftSection(draft, id, selected) {
  const section = draft.sections.find(item => item.id === id)
  if (!section || section.selected === selected) return draft
  if (selected) {
    const separator = !draft.body || draft.body.endsWith('\n\n') ? '' : draft.body.endsWith('\n') ? '\n' : '\n\n'
    const body = draft.body + separator + section.text, start = draft.body.length + separator.length
    return { body, sections: draft.sections.map(item => item === section ? { ...item, selected, separator, start, end: body.length } : item) }
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
  return { body, sections: draft.sections.map(item => item === section
    ? { ...item, text, selected, start: 0, end: 0 }
    : item.selected && item.start >= section.end ? { ...item, start: item.start + delta, end: item.end + delta } : item) }
}
