// `ui/view/format.js` — the finding-body text shapers.
// `descriptionSections` splits a description into the sections the
// report wrote it in, so the card can give each a header instead of
// rendering one long run of prose with bold labels buried in it;
// `flowText` rejoins the soft line breaks inside a paragraph;
// `codeBlockSegments` lifts the fenced snippets out of a body so the
// card can draw each as a `<pre>` instead of printing its fences; and
// `listSegments` lifts the markdown lists out so it can draw those as
// `<ol>` / `<ul>`. All of them read fences the way
// common/md-structure.js does, so a snippet is never reflowed, split
// across sections, cut into list items, or chipped up by the inline
// `` `code` `` / `"quote"` pass.
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

const { codeBlockSegments, descriptionSections, evidenceMarkdown, evidenceNote, findingTitle, flowText, handoffBlock, lineRange, lineRangeLabel, listSegments, snippetWindow, splitDescription, titledDescription } = await import('../ui/view/format.js')

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

// A snippet's blank lines belong to the snippet: splitting there would
// leave the opening fence in one section and the closing one in the
// next, and neither half would render as code.
describe('descriptionSections — fenced code', () => {
  it('keeps a block carrying a blank line in one section', () => {
    const body = '**PoC:** run it\n```sh\nsetup\n\ntrigger\n```'
    assert.deepEqual(descriptionSections(body), [
      { label: 'PoC', body: 'run it\n```sh\nsetup\n\ntrigger\n```' },
    ])
  })

  it('does not read a label inside a fence as a section', () => {
    const body = 'Prose.\n\n```md\n**Impact:** sample output\n\n**Note:** more\n```'
    assert.deepEqual(descriptionSections(body), [{ label: null, body }])
  })

  it('still splits on the blank lines after a block closes', () => {
    const body = '```sh\nsetup\n\ntrigger\n```\n\n**Impact:** boom'
    assert.deepEqual(descriptionSections(body).map((s) => s.label), [null, 'Impact'])
  })

  it('runs an unclosed fence to the end of the body', () => {
    const body = 'Lead.\n\n```sh\nsetup\n\n**Impact:** part of the snippet'
    assert.deepEqual(descriptionSections(body).map((s) => s.label), [null])
  })
})

// flowText reflows the prose AROUND a fence and never the code inside
// it — including a block whose own blank line used to split it into
// paragraphs that no longer looked block-level.
describe('flowText — fenced code', () => {
  it('leaves a block carrying a blank line alone', () => {
    const text = '```js\nconst a = 1\n\nconst b = 2\n```'
    assert.equal(flowText(text), text)
  })

  it('flows the prose around a block', () => {
    assert.equal(
      flowText('Some wrapped\nprose.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nMore wrapped\ntext.'),
      'Some wrapped prose.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nMore wrapped text.',
    )
  })

  it('keeps the break that puts a tight fence on its own line', () => {
    assert.equal(flowText('Run\nthis:\n```sh\nnpm test\n```'), 'Run this:\n```sh\nnpm test\n```')
    assert.equal(flowText('```sh\nnpm test\n```\nas root.'), '```sh\nnpm test\n```\nas root.')
  })

  it('leaves an unclosed fence and everything under it alone', () => {
    const text = 'Lead:\n\n```sh\nnpm test\n\nnpm run lint'
    assert.equal(flowText(text), text)
  })
})

// The renderer's input: prose runs as plain strings, fenced blocks as
// { lang, code } tokens (render-finding.js codeBlockTemplate).
describe('codeBlockSegments', () => {
  it('returns unfenced text unchanged, in one segment', () => {
    assert.deepEqual(codeBlockSegments('just prose'), ['just prose'])
    assert.deepEqual(codeBlockSegments(''), [''])
  })

  it('reads the language tag off the opening fence', () => {
    assert.deepEqual(codeBlockSegments('```ts\nconst a: number = 1\n```'), [
      { lang: 'ts', code: 'const a: number = 1' },
    ])
  })

  it('takes an empty block', () => {
    assert.deepEqual(codeBlockSegments('```ts\n```'), [{ lang: 'ts', code: '' }])
  })

  it('case-folds the tag and keeps only its first word', () => {
    assert.deepEqual(codeBlockSegments('```TS title="a b"\nx\n```'), [{ lang: 'ts', code: 'x' }])
  })

  it('drops an info string that is not a language tag', () => {
    assert.deepEqual(codeBlockSegments('```{highlight: 1-3}\nx\n```'), [{ lang: '', code: 'x' }])
    assert.deepEqual(codeBlockSegments('```\nx\n```'), [{ lang: '', code: 'x' }])
  })

  it('takes tilde fences', () => {
    assert.deepEqual(codeBlockSegments('~~~python\np = 1\n~~~'), [{ lang: 'python', code: 'p = 1' }])
  })

  it('keeps a fence of the other marker as content', () => {
    assert.deepEqual(codeBlockSegments('~~~\ncode\n```'), [{ lang: '', code: 'code\n```' }])
  })

  it('keeps the blank lines inside a block', () => {
    assert.deepEqual(codeBlockSegments('```sh\nsetup\n\ntrigger\n```'), [
      { lang: 'sh', code: 'setup\n\ntrigger' },
    ])
  })

  it('drops the newlines that separate a block from its prose', () => {
    assert.deepEqual(codeBlockSegments('Look:\n\n```js\nx()\n```\n\nDone.'), [
      'Look:', { lang: 'js', code: 'x()' }, 'Done.',
    ])
    assert.deepEqual(codeBlockSegments('Look:\n```js\nx()\n```\nDone.'), [
      'Look:', { lang: 'js', code: 'x()' }, 'Done.',
    ])
  })

  it('takes several blocks, with nothing between them', () => {
    assert.deepEqual(codeBlockSegments('```a\n1\n```\n\n```b\n2\n```'), [
      { lang: 'a', code: '1' }, { lang: 'b', code: '2' },
    ])
  })

  it('runs an unclosed fence to the end of the input', () => {
    assert.deepEqual(codeBlockSegments('Lead.\n```ts\nconst a = 1'), [
      'Lead.', { lang: 'ts', code: 'const a = 1' },
    ])
  })

  it('passes empty input through', () => {
    assert.deepEqual(codeBlockSegments(undefined), [undefined])
    assert.deepEqual(codeBlockSegments(null), [null])
  })
})

// A snippet written under a numbered step is INDENTED, to the column
// of the step's text — that indentation is the list's, not the code's.
// Two things follow, and both used to be wrong: the fence has to be
// recognized where the item puts it (a step past the ninth, or a
// nested bullet, pushes it past the three spaces a top-level fence is
// allowed), and the block's content has to shed it, or the snippet
// renders shifted right inside its `<pre>` with the step number's
// whitespace baked into every line the reader copies out.
describe('codeBlockSegments — a block inside a list item', () => {
  it('sheds the item indentation from the code', () => {
    assert.deepEqual(
      codeBlockSegments('1. Foo\n2. Bar.\n   ```js\n   http.request({}, cb)\n   ```\n3. Buz'),
      ['1. Foo\n2. Bar.', { lang: 'js', code: 'http.request({}, cb)' }, '3. Buz'],
    )
  })

  it("keeps the code's OWN relative indentation", () => {
    assert.deepEqual(
      codeBlockSegments('1. Step\n   ```js\n   if (a) {\n     b()\n   }\n   ```'),
      ['1. Step', { lang: 'js', code: 'if (a) {\n  b()\n}' }],
    )
  })

  // Three spaces is all a TOP-LEVEL fence gets, so the item's own
  // column has to be tracked: `10.` puts its text at four, and a
  // nested bullet further still.
  it('finds a fence past the third column when the list put it there', () => {
    assert.deepEqual(
      codeBlockSegments('10. Bar.\n    ```js\n    x()\n    ```\n11. Buz'),
      ['10. Bar.', { lang: 'js', code: 'x()' }, '11. Buz'],
    )
    assert.deepEqual(
      codeBlockSegments('1. Outer\n   - Inner\n     ```js\n     deep()\n     ```\n2. Next'),
      ['1. Outer\n   - Inner', { lang: 'js', code: 'deep()' }, '2. Next'],
    )
  })

  it('takes a bullet item, and a dangling fence inside one', () => {
    assert.deepEqual(
      codeBlockSegments('- Bar.\n  ```js\n  const a = 1\n  ```'),
      ['- Bar.', { lang: 'js', code: 'const a = 1' }],
    )
    assert.deepEqual(
      codeBlockSegments('1. Step\n   ```js\n   oops()'),
      ['1. Step', { lang: 'js', code: 'oops()' }],
    )
  })

  // The reason the item's column is tracked rather than the limit
  // simply widened: past it, a block is INDENTED CODE inside the item
  // and its ``` lines are content — markdown's own reading, and the
  // one the parsers have always given a four-space block at top level.
  it('leaves an over-indented block as the indented code it is', () => {
    const inItem = '1. Step\n\n       ```\n       literal\n       ```\n'
    assert.deepEqual(codeBlockSegments(inItem), [inItem])
    const topLevel = 'Text:\n\n    ```\n    literal\n    ```\n'
    assert.deepEqual(codeBlockSegments(topLevel), [topLevel])
  })

  it('stops allowing the wider indent once the list is over', () => {
    const text = '1. Step\n\nBack at top level.\n\n    ```\n    literal\n    ```\n'
    assert.deepEqual(codeBlockSegments(text), [text])
  })

  it('still requires the closing fence to match the opening marker', () => {
    assert.deepEqual(
      codeBlockSegments('1. Step\n   ```js\n   ~~~\n   x()\n   ```'),
      ['1. Step', { lang: 'js', code: '~~~\nx()' }],
    )
  })
})

// Reproduction steps and affected-file rundowns arrive as markdown
// lists, and used to render as their own source text — the marker in
// the run of prose, every item flat against the left margin, a
// wrapped step reading as the next one. listSegments cuts them out so
// the card can draw a list as a list. Each item comes back with its
// marker and indentation shed, which makes it a small markdown body
// the same pass can render: that is what puts a nested list, a
// paragraph, or a fenced snippet INSIDE its item.
describe('listSegments', () => {
  it('passes text with no list through untouched, in one segment', () => {
    assert.deepEqual(listSegments('Just prose.\n\nMore of it.'), ['Just prose.\n\nMore of it.'])
    assert.deepEqual(listSegments(''), [''])
    assert.deepEqual(listSegments(undefined), [undefined])
    assert.deepEqual(listSegments(null), [null])
  })

  it('cuts a list out of the prose around it', () => {
    assert.deepEqual(listSegments('Steps:\n\n1. One\n2. Two\n\nThat is all.'), [
      'Steps:',
      { ordered: true, start: 1, items: ['One', 'Two'] },
      'That is all.',
    ])
  })

  it('reads bullets, and the paren marker', () => {
    assert.deepEqual(listSegments('- a\n* b\n+ c'), [
      { ordered: false, start: null, items: ['a', 'b', 'c'] },
    ])
    assert.deepEqual(listSegments('1) One\n2) Two'), [
      { ordered: true, start: 1, items: ['One', 'Two'] },
    ])
  })

  // Markdown numbers from the first marker and ignores the rest, so
  // this is the one number the card needs.
  it('keeps the number the list starts at', () => {
    assert.deepEqual(listSegments('10. Ten\n11. Eleven'), [
      { ordered: true, start: 10, items: ['Ten', 'Eleven'] },
    ])
  })

  it('keeps a blank line between items in the same list', () => {
    assert.deepEqual(listSegments('1. One\n\n2. Two'), [
      { ordered: true, start: 1, items: ['One', 'Two'] },
    ])
  })

  it('keeps a wrapped item whole, at either indent', () => {
    assert.deepEqual(listSegments('1. A step the report\n   wrapped.\n2. Next.'), [
      { ordered: true, start: 1, items: ['A step the report\nwrapped.', 'Next.'] },
    ])
    // Lazily continued at the margin — markdown reads it as the item's
    // too, however far left the report wrapped it.
    assert.deepEqual(listSegments('1. One\ncontinued here\n2. Two'), [
      { ordered: true, start: 1, items: ['One\ncontinued here', 'Two'] },
    ])
  })

  it('leaves a nested list inside its item, to be rendered there', () => {
    assert.deepEqual(listSegments('1. Outer\n   - Inner a\n   - Inner b\n2. Next'), [
      { ordered: true, start: 1, items: ['Outer\n- Inner a\n- Inner b', 'Next'] },
    ])
  })

  it('leaves a fenced snippet inside its item, dedented with it', () => {
    assert.deepEqual(listSegments('1. Foo\n2. Bar.\n   ```js\n   http.request({}, cb)\n   ```\n3. Buz'), [
      { ordered: true, start: 1, items: ['Foo', 'Bar.\n```js\nhttp.request({}, cb)\n```', 'Buz'] },
    ])
  })

  it('starts a new list when the marker switches kind', () => {
    assert.deepEqual(listSegments('- a\n- b\n1. c\n2. d'), [
      { ordered: false, start: null, items: ['a', 'b'] },
      { ordered: true, start: 1, items: ['c', 'd'] },
    ])
  })

  it('reads no list where markdown reads none', () => {
    // A marker inside a snippet is code.
    const fenced = '```sh\n- not an item\n1. also not\n```'
    assert.deepEqual(listSegments(fenced), [fenced])
    // `* * *` is a horizontal rule.
    const rule = 'Before\n\n* * *\n\nAfter'
    assert.deepEqual(listSegments(rule), [rule])
  })

  it('ends the list at a paragraph back on the margin', () => {
    assert.deepEqual(listSegments('- a\n- b\n\nAnd then some prose.'), [
      { ordered: false, start: null, items: ['a', 'b'] },
      'And then some prose.',
    ])
  })
})

// A report may name the finding outright in a `title` field. The
// formats that don't have one put the name in the description's first
// line, so that's the fallback — and the split that follows has to
// know which of the two it's looking at.
describe('findingTitle', () => {
  it('prefers the finding\'s own title field', () => {
    assert.equal(
      findingTitle({ title: 'Shell injection', description: 'Something else entirely\n\nBody.' }),
      'Shell injection',
    )
  })

  it('trims the title field', () => {
    assert.equal(findingTitle({ title: '  Shell injection \n' }), 'Shell injection')
  })

  it('falls back to the description first line', () => {
    assert.equal(findingTitle({ description: 'Shell injection\n\nBody.' }), 'Shell injection')
    assert.equal(findingTitle({ description: '\n\n  Leading blanks skipped\nrest' }), 'Leading blanks skipped')
  })

  it('falls back when the title is empty, blank, or not a string', () => {
    for (const title of ['', '   ', null, undefined, 42, { toString: () => 'x' }, ['t']]) {
      assert.equal(findingTitle({ title, description: 'From the body' }), 'From the body', String(title))
    }
  })

  it('is empty when the finding carries neither', () => {
    assert.equal(findingTitle({}), '')
    assert.equal(findingTitle({ description: '' }), '')
    assert.equal(findingTitle(undefined), '')
  })
})

describe('splitDescription — with a title field', () => {
  it('keeps the whole description as body', () => {
    assert.deepEqual(
      splitDescription({ title: 'Shell injection', description: 'First line of prose.\n\nSecond paragraph.' }),
      { title: 'Shell injection', body: 'First line of prose.\n\nSecond paragraph.' },
    )
  })

  it('drops a first line that just repeats the title', () => {
    assert.deepEqual(
      splitDescription({ title: 'Shell injection', description: 'Shell injection\n\nThe worker pool …' }),
      { title: 'Shell injection', body: 'The worker pool …' },
    )
  })

  it('keeps a first line that merely starts with the title', () => {
    const description = 'Shell injection is reachable from the worker pool.\n\nMore.'
    assert.deepEqual(
      splitDescription({ title: 'Shell injection', description }),
      { title: 'Shell injection', body: description },
    )
  })

  it('takes a title with no description at all', () => {
    assert.deepEqual(splitDescription({ title: 'Shell injection' }), { title: 'Shell injection', body: '' })
    assert.deepEqual(
      splitDescription({ title: 'Shell injection', description: 'Shell injection' }),
      { title: 'Shell injection', body: '' },
    )
  })
})

describe('splitDescription — without a title field', () => {
  it('lifts the first line when there is a body under it', () => {
    assert.deepEqual(
      splitDescription({ description: 'Shell injection\n\nThe worker pool …' }),
      { title: 'Shell injection', body: 'The worker pool …' },
    )
  })

  it('leaves a single-line description whole', () => {
    assert.deepEqual(
      splitDescription({ description: 'One paragraph, no title.' }),
      { title: '', body: 'One paragraph, no title.' },
    )
  })

  it('leaves a description that opens on a fence whole', () => {
    const description = '```ts\nconst a = 1\n```\n\nProse under it.'
    assert.deepEqual(splitDescription({ description }), { title: '', body: description })
  })

  it('takes an empty finding', () => {
    assert.deepEqual(splitDescription({}), { title: '', body: '' })
    assert.deepEqual(splitDescription(undefined), { title: '', body: '' })
  })
})

// The compact surfaces show one text blob per finding rather than a
// heading over a body, so they need the name folded back in.
describe('titledDescription', () => {
  it('returns the description untouched when there is no title field', () => {
    const description = 'Shell injection\n\nThe worker pool …'
    assert.equal(titledDescription({ description }), description)
    assert.equal(titledDescription({}), '')
  })

  it('puts the title in front of the body', () => {
    assert.equal(
      titledDescription({ title: 'Shell injection', description: 'The worker pool …' }),
      'Shell injection\n\nThe worker pool …',
    )
  })

  it('does not repeat a title the description already opens with', () => {
    assert.equal(
      titledDescription({ title: 'Shell injection', description: 'Shell injection\n\nThe worker pool …' }),
      'Shell injection\n\nThe worker pool …',
    )
  })

  it('is just the title when there is no description', () => {
    assert.equal(titledDescription({ title: 'Shell injection' }), 'Shell injection')
  })
})

// An evidence row's note arrives as `text` from the markdown parser and
// may arrive as `observation` from a JSON report. Both are read.
describe('evidenceNote', () => {
  it('takes either field on its own', () => {
    assert.equal(evidenceNote({ text: 'A note.' }), 'A note.')
    assert.equal(evidenceNote({ observation: 'An observation.' }), 'An observation.')
  })

  it('puts the observation over the text when a row carries both', () => {
    assert.equal(
      evidenceNote({ observation: 'An observation.', text: 'A note.' }),
      'An observation.\nA note.',
    )
  })

  it('trims the pair, so one blank field leaves no stray line', () => {
    assert.equal(evidenceNote({ observation: '  ', text: 'A note.' }), 'A note.')
    assert.equal(evidenceNote({ observation: 'An observation.', text: '\n  ' }), 'An observation.')
  })

  it('keeps the newlines inside a multi-line field', () => {
    assert.equal(
      evidenceNote({ observation: 'Line one.\nLine two.', text: 'And the note.' }),
      'Line one.\nLine two.\nAnd the note.',
    )
  })

  it('is empty for a row with neither, and ignores non-strings', () => {
    assert.equal(evidenceNote({}), '')
    assert.equal(evidenceNote(undefined), '')
    assert.equal(evidenceNote({ text: 42, observation: { note: 'x' } }), '')
    assert.equal(evidenceNote({ text: ['a'], observation: 'Kept.' }), 'Kept.')
  })
})

// The text surfaces (markdown export, issue body, handoff, search
// haystack) all rebuild the list from here, so an observation has to
// reach them the same way a text does.
describe('evidenceMarkdown', () => {
  it('indents the note under its row marker', () => {
    assert.equal(
      evidenceMarkdown({ evidence: [{ file: 'src/a.ts', line: '10', observation: 'Tainted here.' }] }),
      '**Evidence:**\n1. src/a.ts:10\n   Tainted here.',
    )
  })

  it('carries both fields of a row that has them', () => {
    assert.equal(
      evidenceMarkdown({ evidence: [{ file: 'src/a.ts', line: '10', observation: 'Obs.', text: 'Note.' }] }),
      '**Evidence:**\n1. src/a.ts:10\n   Obs.\n   Note.',
    )
  })

  it('links a row that carried a url, and numbers the rows', () => {
    assert.equal(
      evidenceMarkdown({ evidence: [
        { file: 'src/a.ts', line: '10', url: 'https://example.test/a.ts#L10' },
        { file: 'src/b.ts', line: '?' },
      ] }),
      '**Evidence:**\n1. [src/a.ts:10](https://example.test/a.ts#L10)\n2. src/b.ts',
    )
  })

  it('is empty for a finding with no rows', () => {
    assert.equal(evidenceMarkdown({}), '')
    assert.equal(evidenceMarkdown({ evidence: [] }), '')
    assert.equal(evidenceMarkdown(undefined), '')
  })
})

// What the copy button puts on the clipboard and the Claude handoff
// sends: the finding as a markdown DOCUMENT, not a stack of
// `Label: value` lines. Everything it lands in renders markdown, and
// most of what it carries — the description, every narrative field —
// already IS markdown.
describe('handoffBlock', () => {
  const reported = {
    file: 'node_modules/@vercel/otel/dist/node/index.js',
    line: 23,
    title: 'title',
    description: 'text text\n\ntext\n\ntext',
    confidence: 8,
    evidence: [
      { file: 'file.js', line: 1, text: 'text' },
      { file: 'file2.js', line: 2, text: 'text' },
    ],
  }

  it('writes the whole finding as markdown', () => {
    assert.equal(handoffBlock(reported, null), [
      'Location: node_modules/@vercel/otel/dist/node/index.js:23',
      'Confidence: 8/10',
      '',
      '# title',
      '',
      'text text',
      '',
      'text',
      '',
      'text',
      '',
      '# Evidence',
      '',
      '1. file.js:1',
      '   text',
      '',
      '2. file2.js:2',
      '   text',
    ].join('\n'))
  })

  it('opens with the facts that are not prose', () => {
    const meta = handoffBlock({ ...reported, revalidate: 'refuted' }, 'owner/repo').split('\n\n')[0]
    assert.equal(meta, [
      'Repo: owner/repo',
      'Location: node_modules/@vercel/otel/dist/node/index.js:23',
      'Confidence: 8/10',
      'Revalidation: refuted',
    ].join('\n'))
  })

  it('drops the line from the location when there is not a finite one', () => {
    assert.match(handoffBlock({ file: 'src/a.ts', line: '?' }, null), /^Location: src\/a\.ts$/u)
    assert.match(handoffBlock({ file: 'src/a.ts', line: '10-20' }, null), /^Location: src\/a\.ts:10-20$/u)
  })

  it('gives every narrative field its own section, in the card order', () => {
    const md = handoffBlock({
      ...reported,
      impact: 'i', reproduction: 'r', recommendation: 'rec',
      confidenceReason: 'cr', revalidateVerdict: 'rv', revalidateRecommendation: 'rr',
    }, null)
    assert.deepEqual([...md.matchAll(/^# (.+)$/gmu)].map((m) => m[1]), [
      'title', 'Evidence', 'Impact', 'Reproduction', 'Recommendation',
      'Confidence reason', 'Revalidation verdict', 'Revalidation recommendation',
    ])
    for (const [heading, value] of [['Impact', 'i'], ['Reproduction', 'r'], ['Recommendation', 'rec'],
      ['Confidence reason', 'cr'], ['Revalidation verdict', 'rv'], ['Revalidation recommendation', 'rr']]) {
      assert.ok(md.includes(`# ${heading}\n\n${value}`), heading)
    }
  })

  it('omits every block the finding does not carry', () => {
    assert.equal(handoffBlock({ file: 'src/a.ts' }, null), 'Location: src/a.ts')
    assert.equal(handoffBlock({ description: 'Just prose.' }, null), 'Just prose.')
    assert.equal(handoffBlock({}, null), '')
    assert.equal(handoffBlock(undefined, null), '')
  })

  it('keeps a description whose first line is the title from repeating it', () => {
    const md = handoffBlock({ title: 'A title', description: 'A title\n\nThe body.' }, null)
    assert.equal(md, '# A title\n\nThe body.')
  })

  it('links an evidence row that carried a url, and spaces the rows', () => {
    const md = handoffBlock({
      evidence: [
        { file: 'a.js', line: 1, url: 'https://x.test/a.js#L1', observation: 'obs' },
        { file: 'b.js', line: 2 },
      ],
    }, null)
    assert.equal(md, [
      '# Evidence',
      '',
      '1. [a.js:1](https://x.test/a.js#L1)',
      '   obs',
      '',
      '2. b.js:2',
    ].join('\n'))
  })

  // The inline `**Evidence:**` block the export / issue body / search
  // haystack use is the same rows, tight — splitting the row builder
  // out for the handoff must not have loosened it.
  it('leaves the inline evidence block tight', () => {
    const f = { evidence: [{ file: 'a.js', line: 1, text: 'n' }, { file: 'b.js', line: 2 }] }
    assert.equal(evidenceMarkdown(f), '**Evidence:**\n1. a.js:1\n   n\n2. b.js:2')
  })
})

// The window a source preview opens on — a few lines either side of
// the one a link named (render-finding.js draws them, focus-code.js
// fetches the file). It comes back with the number it STARTS at,
// because a snippet the reader can't line up against the `file:42`
// they opened it from is a snippet they have to take on trust.
describe('snippetWindow', () => {
  const file = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

  it('centres on the line, and says where it starts', () => {
    const { lines, startLine } = snippetWindow(file, 10)
    assert.equal(startLine, 6)
    assert.deepEqual(lines, ['line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 13', 'line 14'])
  })

  it('clamps at the top without counting below line 1', () => {
    const { lines, startLine } = snippetWindow(file, 2)
    assert.equal(startLine, 1)
    assert.equal(lines[0], 'line 1')
    assert.equal(lines.at(-1), 'line 6')
  })

  it('keeps the leading context at the bottom of the file', () => {
    const { lines, startLine } = snippetWindow(file, 20)
    assert.equal(startLine, 16)
    assert.equal(lines.at(-1), 'line 20')
  })

  // A line past the end is a report pointing at a file that has moved
  // on; show the end of the file rather than an empty window.
  it('clamps a line past the end onto the last one', () => {
    const { lines, startLine } = snippetWindow(file, 999)
    assert.equal(startLine, 16)
    assert.equal(lines.at(-1), 'line 20')
  })

  // No line to centre on — an import with no line number, or a report
  // that only named the file.
  it('opens at the top when nothing points into the file', () => {
    for (const line of [null, undefined, NaN, 0, -3]) {
      const { lines, startLine } = snippetWindow(file, line)
      assert.equal(startLine, 1, String(line))
      assert.equal(lines.length, 9, String(line))
      assert.equal(lines[0], 'line 1', String(line))
    }
  })

  it('returns a short file whole', () => {
    const short = 'a\nb'
    assert.deepEqual(snippetWindow(short, 1), { text: 'a\nb', startLine: 1, lines: ['a', 'b'] })
  })

  it('takes a radius', () => {
    const { lines, startLine } = snippetWindow(file, 10, 1)
    assert.equal(startLine, 9)
    assert.deepEqual(lines, ['line 9', 'line 10', 'line 11'])
  })

  it('answers empty for nothing to window', () => {
    for (const bad of ['', undefined, null, 42]) {
      assert.deepEqual(snippetWindow(bad, 3), { text: '', startLine: 1, lines: [] })
    }
  })
})

// A finding's `line` is not always one line: reports cite spans, and
// md-structure.js's parseCodeRef keeps them whole (`60-90` stays
// `60-90`) so the location displays print what was written. Everything
// that DRAWS the code reads them through here, because a span shown
// with only its opening line marked hides what was being pointed at.
describe('lineRange', () => {
  it('reads a single line, however it arrives', () => {
    assert.deepEqual(lineRange(42), { start: 42, end: 42 })
    assert.deepEqual(lineRange('42'), { start: 42, end: 42 })
    assert.deepEqual(lineRange('  42 '), { start: 42, end: 42 })
  })

  it('reads a span', () => {
    assert.deepEqual(lineRange('20-30'), { start: 20, end: 30 })
    assert.deepEqual(lineRange('20 - 30'), { start: 20, end: 30 })
  })

  // A report being sloppy about a real span, not a report meaning
  // nothing.
  it('sorts reversed ends rather than refusing them', () => {
    assert.deepEqual(lineRange('30-20'), { start: 20, end: 30 })
  })

  it('answers null for anything that is not a line', () => {
    for (const bad of ['', '?', 'abc', '0', '-5', '20-', '-20', '1-2-3', null, undefined, NaN, 0, -3, {}]) {
      assert.equal(lineRange(bad), null, String(bad))
    }
  })

  it('prints a range the way a location does', () => {
    assert.equal(lineRangeLabel(lineRange('42')), '42')
    assert.equal(lineRangeLabel(lineRange('20-30')), '20-30')
    // Normalised from the parse, so a sloppy field reads as it meant.
    assert.equal(lineRangeLabel(lineRange('30 - 20')), '20-30')
    assert.equal(lineRangeLabel(null), '')
  })
})

describe('snippetWindow — ranges', () => {
  const file = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')

  it('keeps the WHOLE range, with context either side', () => {
    const { lines, startLine } = snippetWindow(file, lineRange('20-30'))
    assert.equal(startLine, 16)
    assert.equal(lines.at(-1), 'line 34')
    // Every cited line is in the window — the radius is context around
    // the citation, not a budget the citation has to fit inside.
    assert.equal(lines.length, 19)
  })

  it('takes a range as a bare number, or as the string a report wrote', () => {
    const fromString = snippetWindow(file, lineRange('20'))
    assert.deepEqual(snippetWindow(file, 20), fromString)
    assert.deepEqual(snippetWindow(file, { start: 20, end: 20 }), fromString)
  })

  it('clamps a range that runs past the end of the file', () => {
    const { lines, startLine } = snippetWindow(file, lineRange('38-99'))
    assert.equal(startLine, 34)
    assert.equal(lines.at(-1), 'line 40')
  })

  it('clamps a range that starts before the file does', () => {
    const { lines, startLine } = snippetWindow(file, lineRange('1-3'))
    assert.equal(startLine, 1)
    assert.equal(lines.at(-1), 'line 7')
  })
})
