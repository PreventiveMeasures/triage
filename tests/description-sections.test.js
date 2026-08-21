// `ui/view/format.js` — the finding-body text shapers.
// `descriptionSections` splits a description into the sections the
// report wrote it in, so the card can give each a header instead of
// rendering one long run of prose with bold labels buried in it;
// `flowText` rejoins the soft line breaks inside a paragraph.
//
// The split keys off the MARKUP the parsers emit — a paragraph opening
// with `**Label:**` — not off a list of known label words: parse-piolium
// forwards whatever labels its source report carried (`**Root Cause:**`,
// `**Severity note:**`, `**Note:**`, …) and parse-md adds its own
// (`**Impact:**`, `**Reproduction:**`).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// format.js → frontend-global.js throws at module load when the
// `@rray/frontend` slot isn't installed. Tests don't run the boot path
// that installs it, and descriptionSections never touches any of these
// symbols, so a bare stub is enough to let the import chain evaluate.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { descriptionSections, flowText } = await import('../ui/view/format.js')

describe('descriptionSections — empty input', () => {
  it('returns nothing for empty / missing bodies', () => {
    assert.deepEqual(descriptionSections(''), [])
    assert.deepEqual(descriptionSections('   \n\n  '), [])
    assert.deepEqual(descriptionSections(undefined), [])
    assert.deepEqual(descriptionSections(null), [])
  })
})

describe('descriptionSections — labelled paragraphs', () => {
  it('splits a labelled paragraph into label + body', () => {
    assert.deepEqual(
      descriptionSections('**Impact:** Remote code execution.'),
      [{ label: 'Impact', body: 'Remote code execution.' }],
    )
  })

  it('takes whatever label the report used', () => {
    const body = [
      '**Root Cause:** Unfiltered merge.',
      '',
      '**Severity note:** Downgraded, the path needs auth.',
      '',
      '**Note:** Also reported upstream.',
    ].join('\n')
    assert.deepEqual(descriptionSections(body).map((s) => s.label), ['Root Cause', 'Severity note', 'Note'])
  })

  it('keeps the label paragraph\'s continuation lines as its body', () => {
    const body = '**Impact:** First line.\nSecond line of the same paragraph.'
    assert.deepEqual(descriptionSections(body), [
      { label: 'Impact', body: 'First line.\nSecond line of the same paragraph.' },
    ])
  })

  it('keeps a label whose value sits on the next line', () => {
    assert.deepEqual(
      descriptionSections('**Evidence:**\n1. src/a.ts:10'),
      [{ label: 'Evidence', body: '1. src/a.ts:10' }],
    )
  })

  it('keeps a label with nothing after it, body empty', () => {
    assert.deepEqual(descriptionSections('**PoC:**'), [{ label: 'PoC', body: '' }])
  })

  it('only opens a section at the START of a paragraph', () => {
    const body = 'Prose that mentions **Impact:** mid-sentence.'
    assert.deepEqual(descriptionSections(body), [{ label: null, body }])
  })

  it('needs the colon inside the bold run', () => {
    const body = '**Important** — not a label.'
    assert.deepEqual(descriptionSections(body), [{ label: null, body }])
  })
})

describe('descriptionSections — prose', () => {
  it('groups consecutive unlabelled paragraphs into one block', () => {
    const body = 'First paragraph.\n\nSecond paragraph.'
    assert.deepEqual(descriptionSections(body), [{ label: null, body }])
  })

  it('keeps document order across prose and labels', () => {
    const body = [
      'The loader trusts input.',
      '',
      '**Impact:** RCE.',
      '',
      'A trailing note that carries no label.',
      '',
      '**Reproduction:** Load the config.',
    ].join('\n')
    assert.deepEqual(descriptionSections(body), [
      { label: null, body: 'The loader trusts input.' },
      { label: 'Impact', body: 'RCE.' },
      { label: null, body: 'A trailing note that carries no label.' },
      { label: 'Reproduction', body: 'Load the config.' },
    ])
  })

  it('does not merge prose blocks across a label between them', () => {
    const body = 'Lead.\n\n**Impact:** RCE.\n\nTail.'
    assert.equal(descriptionSections(body).filter((s) => s.label === null).length, 2)
  })

  it('collapses a run of blank lines to one paragraph break', () => {
    assert.deepEqual(
      descriptionSections('First.\n\n\n\nSecond.'),
      [{ label: null, body: 'First.\n\nSecond.' }],
    )
  })
})

// Reports hard-wrap their markdown; `flowText` rejoins those soft
// breaks so a paragraph fills the card's width, while leaving anything
// block-level (a snippet, a list) exactly as the report wrote it.
describe('flowText', () => {
  it('joins the soft line breaks of a paragraph', () => {
    assert.equal(
      flowText('The worker pool forwards user-controlled\narguments straight into a shell.'),
      'The worker pool forwards user-controlled arguments straight into a shell.',
    )
  })

  it('keeps blank lines between paragraphs', () => {
    assert.equal(flowText('First\nparagraph.\n\nSecond\nparagraph.'), 'First paragraph.\n\nSecond paragraph.')
  })

  it('preserves a run of blank lines verbatim', () => {
    assert.equal(flowText('A\n\n\nB'), 'A\n\n\nB')
  })

  it('leaves a fenced snippet alone', () => {
    const text = '```js\nconst a = 1\nconst b = 2\n```'
    assert.equal(flowText(text), text)
  })

  it('leaves a list alone', () => {
    const text = '- src/a.ts\n- src/b.ts'
    assert.equal(flowText(text), text)
    const numbered = '1. src/a.ts\n2. src/b.ts'
    assert.equal(flowText(numbered), numbered)
  })

  it('leaves an indented (code) line alone', () => {
    const text = 'Run:\n    npm test'
    assert.equal(flowText(text), text)
  })

  it('leaves quotes, headings and table rows alone', () => {
    for (const text of ['Cited:\n> a quote', 'Lead\n# Heading', 'x\n| a | b |']) {
      assert.equal(flowText(text), text, text)
    }
  })

  it('flows only the paragraphs that qualify, per paragraph', () => {
    assert.equal(
      flowText('Some wrapped\nprose.\n\n- a list item\n- another'),
      'Some wrapped prose.\n\n- a list item\n- another',
    )
  })

  it('passes empty input straight through', () => {
    assert.equal(flowText(''), '')
    assert.equal(flowText(undefined), undefined)
  })
})
