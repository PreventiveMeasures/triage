// `report/src/finding.js` — the finding readers shared by the viewer and
// the markdown writer (write-md.js). The text shapers (title / body split,
// description sections, evidence notes) are pinned through the
// viewer's re-exports in tests/description-sections.test.js; this
// suite covers the two readers that take the layer switch as an
// argument, and the severity readers, at the library boundary.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { REVALIDATE_KINDS, SEVERITIES, SEVERITY_ORDER, correctedVariants, displayedSeverity, effectiveSeverity, hasSeverityCorrection, prettyModel, revalidateKindOf, runMetaLine, splitDescription, stripExportMarker } from '../index.js'

describe('revalidateKindOf', () => {
  it('reads the stamp as the data has it', () => {
    for (const kind of REVALIDATE_KINDS) assert.equal(revalidateKindOf({ revalidate: kind }), kind)
  })

  it('answers nothing for an unrecognised or missing value', () => {
    for (const bad of ['maybe', '', 42, null, undefined]) assert.equal(revalidateKindOf({ revalidate: bad }), '')
    assert.equal(revalidateKindOf(undefined), '')
  })

  // The field is one of those words, spelt as they are spelt — a
  // spelling that drifted is a document's problem, and the document's
  // reader is where it is folded back (parse-deepview-md.test.js). A
  // reader this side of that boundary takes the analyzer at its word.
  it('does not case-fold a value that is not one of them', () => {
    for (const drifted of [' refuted', 'Refuted', 'REFUTED', 'refuted ']) {
      assert.equal(revalidateKindOf({ revalidate: drifted }), '', JSON.stringify(drifted))
    }
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

// The markers the exports pipeline injects into a finding's prose, and
// the order the two strips run in. Nothing covered this before, which
// is how a pass that merged them — checking each name's prefix before
// the other name's marker came off — got as far as review.
describe('stripExportMarker', () => {
  const f = { exportName: 'Foo', methodName: 'bar' }

  it('takes a marker off, for either name', () => {
    assert.equal(stripExportMarker('[export: Foo] Finding text', f), 'Finding text')
    assert.equal(stripExportMarker('[export: bar] Finding text', f), 'Finding text')
    assert.equal(stripExportMarker('text with [export: bar] inside', f), 'text with inside')
  })

  it('takes a `(name): ` prefix off, backticked or not', () => {
    assert.equal(stripExportMarker('(Foo): Finding text', f), 'Finding text')
    assert.equal(stripExportMarker('(`Foo`): Finding text', f), 'Finding text')
    assert.equal(stripExportMarker('(bar): Finding text', f), 'Finding text')
  })

  // The ordering: a prefix can sit BEHIND a marker naming the OTHER
  // name, and the prefix strip only looks at the front of the text. So
  // every marker comes off before any prefix is looked for.
  it('reaches a prefix behind the other name\'s marker', () => {
    assert.equal(stripExportMarker('[export: bar] (Foo): Finding text', f), 'Finding text')
    assert.equal(stripExportMarker('[export: Foo] (bar): Finding text', f), 'Finding text')
    assert.equal(stripExportMarker('[export: bar] (`Foo`): Finding text', f), 'Finding text')
  })

  // Isolate mode injects a marker naming a sibling export, which is
  // not this finding's name at all — those come off by shape.
  it('takes isolate mode\'s own prefixes off whatever they name', () => {
    const iso = { ...f, exportsMode: 'isolate' }
    assert.equal(stripExportMarker('[export: other] Finding text', iso), 'Finding text')
    assert.equal(stripExportMarker('(Other): [export: other] Finding text', iso), 'Finding text')
    assert.equal(stripExportMarker('[export: other] Finding text', f), '[export: other] Finding text', 'and only in that mode')
  })

  it('leaves prose that carries neither', () => {
    assert.equal(stripExportMarker('Finding text', f), 'Finding text')
    assert.equal(stripExportMarker('', f), '')
    assert.equal(stripExportMarker(undefined, f), undefined)
  })
})
