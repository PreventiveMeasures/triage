import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
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

test('all sections can start selected, in order, above the finding link on the bottom line', () => {
  const link = 'https://triage.test/team/t/r/finding'
  let draft = draftFor(finding, { allSections: true, findingLink: link })
  assert.ok(draft.sections.every(s => s.selected))
  assert.match(draft.body, /Confidence: 8\/10\n\n\*\*Impact:\*\*[^]*\*\*Evidence:\*\*[^]*\*\*Reproduction:\*\*[^]*\*\*Recommendation:\*\*[^]*\*\*Confidence reason:\*\*\nThe route is reachable\.\n\nTriage: https:\/\/triage\.test\/team\/t\/r\/finding$/u)
  draft = toggleIssueDraftSection(draft, 'reproduction', false)
  draft = editIssueDraft(draft, draft.body.replace('Check ownership', 'Verify ownership'))
  draft = toggleIssueDraftSection(draft, 'reproduction', true)
  assert.match(draft.body, /Verify ownership[^]*\n\n\*\*Reproduction:\*\*\nSend an unauthenticated request\.\n\nTriage: https:\/\/triage\.test\/team\/t\/r\/finding$/u)
  for (const { id } of draft.sections) draft = toggleIssueDraftSection(draft, id, false)
  assert.match(draft.body, /Confidence: 8\/10\n\nTriage: https:\/\/triage\.test\/team\/t\/r\/finding$/u)
  assert.equal(draft.body.slice(draft.footer.start, draft.footer.end), `Triage: ${link}`)
})

test('sections that would take the body past GitHub\'s limit start unselected', () => {
  const link = 'https://triage.test/f'
  const evidence = `**Evidence:**\n${'1. A location.\n'.repeat(5000)}`
  const draft = draftFor(finding, { evidence, allSections: true, findingLink: link })
  assert.deepEqual(draft.sections.filter(s => !s.selected).map(s => s.id), ['evidence'])
  assert.ok(draft.body.length <= 65_536)
  assert.match(draft.body, /\*\*Confidence reason:\*\*\nThe route is reachable\.\n\nTriage: https:\/\/triage\.test\/f$/u)
  const description = 'x'.repeat(65_530)
  assert.deepEqual(createIssueDraft({ description, impact: 'Impact' }, { allSections: true, findingLink: link }),
    { body: description, sections: [{ id: 'impact', label: 'Impact', text: '**Impact:**\nImpact', selected: false, start: 0, end: 0 }], footer: null })
})

test('the finding link ends a draft without other text and is released by edits across it', () => {
  let draft = createIssueDraft({ reproduction: 'Steps' }, { findingLink: 'https://triage.test/f' })
  assert.equal(draft.body, '\n\nTriage: https://triage.test/f')
  draft = toggleIssueDraftSection(draft, 'reproduction', true)
  assert.equal(draft.body, '**Reproduction:**\nSteps\n\nTriage: https://triage.test/f')
  draft = toggleIssueDraftSection(draft, 'reproduction', false)
  assert.equal(draft.body, '\n\nTriage: https://triage.test/f')
  // Typing into the link keeps it tracked; joining it to the text above leaves later sections after it.
  draft = createIssueDraft({ description: 'Opening.', impact: 'Impact text', reproduction: 'Steps' }, { findingLink: 'https://triage.test/f' })
  draft = editIssueDraft(draft, draft.body.replace('Triage: ', 'Triage finding: '))
  draft = toggleIssueDraftSection(draft, 'reproduction', true)
  assert.match(draft.body, /Steps\n\nTriage finding: https:\/\/triage\.test\/f$/u)
  draft = toggleIssueDraftSection(draft, 'reproduction', false)
  draft = editIssueDraft(draft, draft.body.replace('Impact text\n\nTriage', 'Impact text Triage'))
  draft = toggleIssueDraftSection(draft, 'reproduction', true)
  assert.equal(draft.body, 'Opening.\n\n**Impact:**\nImpact text Triage finding: https://triage.test/f\n\n**Reproduction:**\nSteps')
  draft = editIssueDraft(draft, 'Rewritten.')
  assert.equal(draft.footer, null)
  draft = toggleIssueDraftSection(draft, 'impact', true)
  assert.equal(draft.body, 'Rewritten.\n\n**Impact:**\nImpact text')
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
