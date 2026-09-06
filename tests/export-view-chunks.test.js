// `ui/view/export-view-chunks.js` — the cuts the export preview makes
// through a Markdown document so it can lay out and colour one chunk
// at a time. Every line must land in exactly one chunk, and a cut must
// never split what Prism needs whole: a fenced block, a setext heading,
// a table's header from its delimiter. Within that, cuts fall at
// paragraph ends; a table's body may be cut as long as `tableLead` can
// hand the chunk its header back.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CHUNK_MAX, CHUNK_TARGET, chunkLines, escapeHtml, tableLead } from '../ui/view/export-view-chunks.js'

// A document of `count` lines, each one made by `line(i)`.
function doc(count, line) {
  const lines = Array.from({ length: count }, (_, i) => line(i))
  return { lines, text: lines.join('\n') }
}

// Every line exactly once, in order, and no empty chunk.
function assertCovers(chunks, n) {
  assert.ok(chunks.length > 0)
  assert.equal(chunks[0][0], 0)
  assert.equal(chunks.at(-1)[1], n)
  for (let i = 0; i < chunks.length; i++) {
    const [start, end] = chunks[i]
    assert.ok(end > start, `chunk ${i} is empty`)
    if (i > 0) assert.equal(start, chunks[i - 1][1], `gap or overlap before chunk ${i}`)
  }
}

describe('chunkLines', () => {
  it('returns nothing for an empty document and one chunk for a short one', () => {
    assert.deepEqual(chunkLines([], ''), [])
    const { lines, text } = doc(12, (i) => `line ${i}`)
    assert.deepEqual(chunkLines(lines, text), [[0, 12]])
  })

  it('cuts prose at blank lines once a chunk has reached its target', () => {
    // Paragraphs of 7 lines followed by a blank line.
    const { lines, text } = doc(2000, (i) => (i % 8 === 7 ? '' : `word ${i}`))
    const chunks = chunkLines(lines, text)
    assertCovers(chunks, lines.length)
    assert.ok(chunks.length > 5)
    for (let i = 1; i < chunks.length; i++) {
      const [start] = chunks[i]
      assert.equal(lines[start - 1], '', `chunk starting at ${start} does not follow a blank line`)
      assert.ok(start - chunks[i - 1][0] >= CHUNK_TARGET, `chunk ${i - 1} is shorter than the target`)
    }
  })

  it('prefers to open a chunk on a heading', () => {
    // Sections of 100 lines, each opened by an ATX heading, no blank lines.
    const { lines, text } = doc(1000, (i) => (i % 100 === 0 ? `## Section ${i / 100}` : `text ${i}`))
    const chunks = chunkLines(lines, text)
    assertCovers(chunks, lines.length)
    for (const [start] of chunks.slice(1)) assert.match(lines[start], /^## /u)
  })

  it('never cuts inside a fenced block, even a long one', () => {
    const { lines, text } = doc(3000, (i) => {
      if (i === 100) return '```js'
      if (i === 2100) return '```'
      return i % 10 === 9 ? '' : `code or prose ${i}`
    })
    const chunks = chunkLines(lines, text)
    assertCovers(chunks, lines.length)
    for (const [start] of chunks.slice(1)) {
      assert.ok(start <= 100 || start > 2100, `cut at ${start} lands inside the fence`)
    }
    // The fence is one chunk's worth of content however long it is.
    assert.ok(chunks.some(([start, end]) => start <= 100 && end > 2100))
  })

  it('may open a chunk on the fence itself', () => {
    // One long paragraph, then a blank line and a fence: the opener is
    // the first paragraph end past the target, and nothing spans the
    // cut before it.
    const { lines, text } = doc(1000, (i) => {
      if (i === 199) return ''
      if (i === 200) return '```'
      if (i === 400) return '```'
      return i % 10 === 9 && i > 400 ? '' : `text ${i}`
    })
    const chunks = chunkLines(lines, text)
    assertCovers(chunks, lines.length)
    assert.equal(chunks[1][0], 200)
  })

  it('never cuts between a table header row and its delimiter', () => {
    // Prose to just short of the target, then a table whose header
    // lands exactly on the first line a cut may fall on.
    const { lines, text } = doc(CHUNK_TARGET + 40, (i) => {
      if (i < CHUNK_TARGET - 1) return `intro ${i}`
      if (i === CHUNK_TARGET - 1) return ''
      if (i === CHUNK_TARGET) return '| a | b |'
      if (i === CHUNK_TARGET + 1) return '| --- | --- |'
      return `| ${i} | row |`
    })
    const chunks = chunkLines(lines, text, { target: CHUNK_TARGET, max: CHUNK_TARGET + 1 })
    assertCovers(chunks, lines.length)
    for (const [start] of chunks.slice(1)) assert.notEqual(start, CHUNK_TARGET + 1, 'cut between header and delimiter')
    // The header row itself, following a blank line, is a fine start.
    assert.equal(chunks[1][0], CHUNK_TARGET)
  })

  it('cuts a long table between body rows, no further apart than the maximum', () => {
    const { lines, text } = doc(3000, (i) => {
      if (i < 20) return i % 5 === 4 ? '' : `intro ${i}`
      if (i === 20) return '| # | Severity | Title |'
      if (i === 21) return '| --- | --- | --- |'
      if (i < 2720) return `| ${i} | High | Finding ${i} |`
      return i % 6 === 5 ? '' : `outro ${i}`
    })
    const chunks = chunkLines(lines, text)
    assertCovers(chunks, lines.length)
    for (const [start, end] of chunks) assert.ok(end - start <= CHUNK_MAX, `chunk [${start}, ${end}) is longer than the maximum`)
    const inBody = chunks.filter(([start]) => start > 21 && start < 2720)
    assert.ok(inBody.length >= 3, 'a 2700-row table should be several chunks')
    // Each chunk cut out of the body gets the table's header back.
    for (const [start] of inBody) assert.deepEqual(tableLead(lines, start), [20, 22])
  })

  it('never cuts between a line and its setext underline', () => {
    const { lines, text } = doc(1000, (i) => {
      if (i % 200 === 150) return 'A heading written the old way'
      if (i % 200 === 151) return '---'
      return i % 7 === 6 ? '' : `text ${i}`
    })
    const chunks = chunkLines(lines, text)
    assertCovers(chunks, lines.length)
    for (const [start] of chunks.slice(1)) assert.notEqual(lines[start], '---')
  })

  it('takes any safe cut once a chunk has run past the maximum', () => {
    // No blank lines and no headings anywhere: only the maximum can end a chunk.
    const { lines, text } = doc(5 * CHUNK_MAX, (i) => `dense ${i}`)
    const chunks = chunkLines(lines, text)
    assertCovers(chunks, lines.length)
    for (const [start, end] of chunks) assert.ok(end - start <= CHUNK_MAX)
  })

  it('honours custom sizes', () => {
    const { lines, text } = doc(100, (i) => (i % 4 === 3 ? '' : `l ${i}`))
    const chunks = chunkLines(lines, text, { target: 10, max: 20 })
    assertCovers(chunks, lines.length)
    for (const [start, end] of chunks) assert.ok(end - start <= 20)
    assert.ok(chunks.length >= 5)
  })
})

describe('tableLead', () => {
  const lines = [
    'prose',
    '| not | a table |',
    '| h1 | h2 |',
    '| --- | --- |',
    '| r1 | x |',
    '| r2 | y |',
    '| --- | --- |',
    '| r3 | z |',
    '',
    '| lone | row |',
    '| another | row |',
  ]

  it('names the header row and delimiter for a chunk starting in a table body', () => {
    assert.deepEqual(tableLead(lines, 4), [2, 4])
    assert.deepEqual(tableLead(lines, 5), [2, 4])
    // A row of dashes inside the body is a body row, not a new table:
    // Prism's table begins at the FIRST row-then-delimiter pair.
    assert.deepEqual(tableLead(lines, 7), [2, 4])
  })

  it('is null where no table spans the cut', () => {
    assert.equal(tableLead(lines, 0), null)
    assert.equal(tableLead(lines, 1), null)
    // The header row, and a row that opens a run of rows.
    assert.equal(tableLead(lines, 2), null)
    assert.equal(tableLead(lines, 9), null)
    // Rows with no delimiter anywhere above them are prose to Prism.
    assert.equal(tableLead(lines, 10), null)
  })
})

describe('escapeHtml', () => {
  it('escapes the three characters the parser reads', () => {
    assert.equal(escapeHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d')
    assert.equal(escapeHtml('plain "quoted" text'), 'plain "quoted" text')
  })
})
