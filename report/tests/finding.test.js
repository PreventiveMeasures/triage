// `report/finding.js` — the finding readers shared by the viewer and
// the markdown writer (write-md.js). The text shapers (title / body split,
// description sections, evidence notes) are pinned through the
// viewer's re-exports in tests/description-sections.test.js; this
// suite covers the two readers that take the layer switch as an
// argument, and the severity readers, at the library boundary.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { REVALIDATE_KINDS, SEVERITIES, SEVERITY_ORDER, correctedVariants, displayedSeverity, effectiveSeverity, hasSeverityCorrection, prettyModel, revalidateKindOf, runMetaLine, splitDescription } from '../finding.js'

describe('revalidateKindOf', () => {
  it('reads the stamp as the data has it, case-folded and trimmed', () => {
    for (const kind of REVALIDATE_KINDS) {
      assert.equal(revalidateKindOf({ revalidate: kind }), kind)
      assert.equal(revalidateKindOf({ revalidate: ` ${kind.toUpperCase()} ` }), kind)
    }
  })

  it('answers nothing for an unrecognised or missing value', () => {
    for (const bad of ['maybe', '', 42, null, undefined]) assert.equal(revalidateKindOf({ revalidate: bad }), '')
    assert.equal(revalidateKindOf(undefined), '')
  })
})

describe('runMetaLine', () => {
  const pass = { type: 'security', model: 'anthropic/claude-opus-5', effort: 'max', exportsMode: 'list', revalidate: 'revalidation' }

  it('joins the run fields, the pass naming itself after the mode', () => {
    assert.equal(runMetaLine(pass), 'security · revalidate · opus 5 · max · list')
    assert.equal(runMetaLine({ ...pass, revalidate: 'confirmed' }), 'security · opus 5 · max · list', 'a judged row is not the pass')
  })

  it('drops the pass\'s name with the layer', () => {
    assert.equal(runMetaLine(pass, false), 'security · opus 5 · max · list')
  })

  it('elides what is missing', () => {
    assert.equal(runMetaLine({ model: 'gpt-5.5' }), 'gpt 5.5')
    assert.equal(runMetaLine({}), '')
    assert.equal(runMetaLine(undefined), '')
  })

  it('prettifies the model the way the header does', () => {
    assert.equal(prettyModel('anthropic/claude-opus-4-7'), 'opus 4 7')
    assert.equal(prettyModel(undefined), undefined)
  })
})

describe('severity readers', () => {
  it('rank the ladder from critical down to informational', () => {
    assert.deepEqual([...SEVERITIES].toSorted((a, b) => SEVERITY_ORDER[b] - SEVERITY_ORDER[a]), SEVERITIES)
  })

  it('honour a correction only when it names a known tier that differs', () => {
    const f = { severity: 'medium', correctedSeverity: 'high' }
    assert.equal(effectiveSeverity(f), 'high')
    assert.equal(displayedSeverity(f, 'original'), 'medium')
    assert.equal(displayedSeverity(f, 'corrected'), 'high')
    assert.ok(hasSeverityCorrection(f))
    assert.equal(effectiveSeverity({ severity: 'medium', correctedSeverity: 'severe' }), 'medium')
    assert.ok(!hasSeverityCorrection({ severity: 'medium', correctedSeverity: 'medium' }))
  })

  it('report a divergence across reports only when there is one', () => {
    assert.equal(correctedVariants({ _correctedByReport: { a: { severity: 'high' }, b: { severity: 'high' } } }), null)
    assert.ok(correctedVariants({ _correctedByReport: { a: { severity: 'high' }, b: { severity: 'low' } } }))
  })
})

describe('splitDescription — a fence at the top', () => {
  it('keeps a description that opens on a fence whole, via the parsers\' own fence reader', () => {
    const description = '```ts\nconst a = 1\n```\n\nProse under it.'
    assert.deepEqual(splitDescription({ description }), { title: '', body: description })
    assert.deepEqual(splitDescription({ description: 'Title\n\n```ts\nx\n```' }), { title: 'Title', body: '```ts\nx\n```' })
  })
})
