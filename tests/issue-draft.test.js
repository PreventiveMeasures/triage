import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
globalThis[Symbol.for('@rray/frontend')] ??= {}
const { createIssueDraft, editIssueDraft, toggleIssueDraftSection } = await import('../ui/view/dialogs/issue-draft.js')
const { evidenceMarkdown } = await import('../ui/view/format.js')
const draftFor = (finding, options = {}) => createIssueDraft(finding, { evidence: evidenceMarkdown(finding), ...options })

const finding = { description: 'An unchecked request reaches storage.', file: 'src/api.js', line: 12, confidence: 8,
  impact: 'Private data can be disclosed.', reproduction: 'Send an unauthenticated request.',
  evidence: [{ file: 'src/api.js', line: 12, observation: 'Missing ownership check.' }],
  recommendation: 'Check ownership before returning data.', confidenceReason: 'The route is reachable.' }

test('issue draft offers populated sections with only impact selected initially', () => {
  const draft = draftFor(finding, { sourceUrl: 'https://github.com/o/r/blob/HEAD/src/api.js#L12' })
  assert.deepEqual(draft.sections.map(({ label, selected }) => [label, selected]), [
    ['Impact', true], ['Evidence', false], ['Reproduction', false], ['Recommendation', false], ['Confidence reason', false],
  ])
  assert.match(draft.body, /File: \[src\/api.js:12\]\(https:\/\/github.com\/o\/r\/blob\/HEAD\/src\/api.js#L12\)/u)
  assert.match(draft.body, /An unchecked request reaches storage\./u)
  assert.match(draft.body, /Confidence: 8\/10/u)
  assert.match(draft.body, /\*\*Impact:\*\*\nPrivate data can be disclosed\./u)
  assert.doesNotMatch(draft.body, /Evidence|Reproduction|Recommendation|Confidence reason/u)
  assert.deepEqual(createIssueDraft({ description: 'Only prose.', impact: '  ', evidence: [] }).sections, [])
})

test('labelled report descriptions expose whole sections, including multiple paragraphs and code', () => {
  const draft = createIssueDraft({ description: 'Opening.\n\n**Impact:** First paragraph.\n\nSecond paragraph.\n\n**Reproduction steps:** Run this:\n\n```\n**Not a section:**\n\nexample\n```\n\n**Mitigation:** Restrict access.' })
  assert.deepEqual(draft.sections.map(s => s.id), ['impact', 'reproduction', 'mitigation'])
  assert.match(draft.body, /First paragraph\.\n\nSecond paragraph\./u)
  assert.doesNotMatch(draft.body, /Run this|Not a section|Restrict access/u)
  const withRepro = toggleIssueDraftSection(draft, 'reproduction', true)
  assert.match(withRepro.body, /Run this:\n\n```\n\*\*Not a section:\*\*\n\nexample\n```/u)
})

test('revalidation sections follow the active revalidation layer', () => {
  const f = { ...finding, revalidateVerdict: 'Still present.', revalidateRecommendation: 'Validate ownership.' }
  assert.deepEqual(createIssueDraft(f).sections.slice(-2).map(s => s.label), ['Revalidation verdict', 'Revalidation recommendation'])
  assert.ok(createIssueDraft(f, { showRevalidation: false }).sections.every(s => !s.id.startsWith('revalidate')))
})

test('toggling sections preserves edits to the description and section text across repeated toggles', () => {
  let draft = createIssueDraft(finding)
  draft = toggleIssueDraftSection(draft, 'reproduction', true)
  draft = editIssueDraft(draft, draft.body.replace('An unchecked request', 'Edited summary: a request'))
  draft = editIssueDraft(draft, draft.body.replace('Private data can be disclosed.', 'Only profile names are exposed.\n\n```\n**Reproduction:** example\n```'))
  draft = editIssueDraft(draft, draft.body.replace('Send an unauthenticated request.', '1. Sign out.\n2. Send the request.'))
  draft = toggleIssueDraftSection(draft, 'impact', false)
  assert.match(draft.body, /Edited summary/u)
  assert.match(draft.body, /1\. Sign out/u)
  assert.doesNotMatch(draft.body, /Only profile|example/u)
  draft = toggleIssueDraftSection(draft, 'reproduction', false)
  assert.doesNotMatch(draft.body, /Sign out/u)
  for (let i = 0; i < 3; i++) {
    draft = toggleIssueDraftSection(draft, 'impact', true)
    assert.match(draft.body, /Only profile names are exposed\.\n\n```\n\*\*Reproduction:\*\* example\n```/u)
    draft = toggleIssueDraftSection(draft, 'impact', false)
  }
  draft = toggleIssueDraftSection(draft, 'reproduction', true)
  assert.match(draft.body, /1\. Sign out\.\n2\. Send the request\./u)
  assert.match(draft.body, /Edited summary/u)
})

test('replacing the whole draft releases section ranges without deleting the new text on a later toggle', () => {
  let draft = toggleIssueDraftSection(draftFor(finding), 'evidence', true)
  draft = editIssueDraft(draft, 'My completely rewritten issue.')
  assert.ok(draft.sections.every(s => !s.selected))
  draft = toggleIssueDraftSection(draft, 'impact', true)
  draft = toggleIssueDraftSection(draft, 'impact', false)
  assert.equal(draft.body, 'My completely rewritten issue.')
})

test('inserting at section boundaries and deleting a section does not corrupt adjacent sections', () => {
  let draft = toggleIssueDraftSection(createIssueDraft(finding), 'recommendation', true)
  const impact = draft.sections.find(s => s.id === 'impact')
  draft = editIssueDraft(draft, draft.body.slice(0, impact.start) + 'Edited heading: ' + draft.body.slice(impact.start))
  const recommendation = draft.sections.find(s => s.id === 'recommendation')
  assert.equal(draft.body.slice(recommendation.start, recommendation.end), recommendation.text)
  draft = toggleIssueDraftSection(draft, 'impact', false)
  assert.match(draft.body, /Check ownership before returning data\./u)
  assert.doesNotMatch(draft.body, /Edited heading/u)
  draft = toggleIssueDraftSection(draft, 'impact', true)
  assert.match(draft.body, /Edited heading: \*\*Impact:\*\*/u)
})

test('toggling an appended section preserves trailing blank lines in an edited section', () => {
  let draft = createIssueDraft(finding)
  draft = editIssueDraft(draft, draft.body + '\n\n')
  const before = draft.body
  draft = toggleIssueDraftSection(draft, 'reproduction', true)
  draft = toggleIssueDraftSection(draft, 'reproduction', false)
  assert.equal(draft.body, before)
  draft = toggleIssueDraftSection(draft, 'impact', false)
  draft = toggleIssueDraftSection(draft, 'impact', true)
  assert.equal(draft.body, before)
})
