import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeBlocks } from '../common/line-diff.js'
import { buildSearchMatcher } from '../ui/view/bundle-search-scan.js'
import { SEARCH_MAX_FILES, SEARCH_MAX_FILE_HITS, fileHits, searchCompareFiles } from '../ui/view/bundle-compare-search.js'

const matcher = query => buildSearchMatcher(query, false, false)
const lines = hits => hits.map(({ side, line, sign }) => `${sign ?? '?'}${side}${line}`)

test('an added file is searched in its new text, a removed one in its old, an unchanged one as it is', () => {
  assert.deepEqual(lines(fileHits('', 'a fetch\nb\nfetch c\n', matcher('fetch'), null)), ['+b0', '+b2'])
  assert.deepEqual(lines(fileHits('x\nFETCH\n', '', matcher('fetch'), null)), ['−a1'])
  assert.deepEqual(lines(fileHits('fetch\n', 'fetch\n', matcher('fetch'), null)), [' b0'])
})

test('a changed file lists its new lines added or unchanged, and the old lines it dropped, in the order its diff shows them', () => {
  const before = 'keep fetch\nold fetch\nsame\ntail fetch\n'
  const after = 'keep fetch\nnew fetch\nsame\ntail fetch\nmore fetch\n'
  const hits = fileHits(before, after, matcher('fetch'), changeBlocks(before, after))
  assert.deepEqual(lines(hits), [' b0', '−a1', '+b1', ' b3', '+b4'], 'a removed line sits before the lines added in its block; the unchanged old ones are not listed twice')
  assert.deepEqual(hits[2].ranges, [[4, 9]])
  assert.equal(hits[1].text, 'old fetch')
})

test('a changed file whose diff is not known yet lists its new lines unsigned', () => {
  assert.deepEqual(lines(fileHits('a\nfetch old\n', 'a\nfetch new\n', matcher('fetch'), null)), ['?b1'])
})

test('the search lists files in the order given, skips ones that aren\'t text, and asks for a diff only where a side matches', () => {
  const asked = []
  const blocksOf = (path, before, after) => { asked.push(path); return changeBlocks(before, after) }
  const found = searchCompareFiles([
    { path: 'b.js', before: 'x\n', after: 'x fetch\n' },
    { path: 'logo.png', before: new Uint8Array(1), after: new Uint8Array(2) },
    { path: 'a.js', before: 'one\n', after: 'two\n' },
    { path: 'gone.js', before: 'fetch()\n', after: '' },
    { path: 'old.js', before: 'drop fetch\nkeep\n', after: 'keep\n' },
  ], matcher('fetch'), blocksOf)
  assert.deepEqual(found.files.map(file => [file.path, lines(file.hits)]), [['b.js', ['+b0']], ['gone.js', ['−a0']], ['old.js', ['−a0']]])
  assert.equal(found.hits, 3)
  assert.equal(found.truncated, false)
  assert.deepEqual(asked, ['b.js', 'old.js'], 'a.js matches on neither side, so it is not diffed')
})

test('the search lists up to its caps of lines a file and of files', () => {
  const many = Array.from({ length: SEARCH_MAX_FILE_HITS + 5 }, () => 'fetch').join('\n')
  const files = Array.from({ length: SEARCH_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.js`, before: '', after: many }))
  const found = searchCompareFiles(files, matcher('fetch'), () => null)
  assert.equal(found.files.length, SEARCH_MAX_FILES)
  assert.equal(found.files[0].hits.length, SEARCH_MAX_FILE_HITS)
  assert.equal(found.hits, SEARCH_MAX_FILES * SEARCH_MAX_FILE_HITS)
  assert.equal(found.truncated, true)
})

test('a file\'s hits are collected no further than listed: the first lines in its diff\'s order, removed ones among them', () => {
  const calls = []
  const counting = { ranges(line) { calls.push(line); return line.includes('x') ? [[0, 1]] : [] } }
  const many = Array.from({ length: 10_000 }, () => 'x').join('\n')
  assert.equal(fileHits('', many, counting, null).length, SEARCH_MAX_FILE_HITS)
  assert.equal(calls.length, SEARCH_MAX_FILE_HITS, 'no line read past the last listed')
  // Removed lines past many unchanged matches are still found, in order.
  const before = `${Array.from({ length: 30 }, (_, i) => `x keep ${i}`).join('\n')}\nx gone\n`
  const after = `${Array.from({ length: 30 }, (_, i) => `x keep ${i}`).join('\n')}\n`
  const hits = fileHits(before, after, matcher('x'), changeBlocks(before, after))
  assert.equal(hits.length, SEARCH_MAX_FILE_HITS)
  assert.deepEqual(lines(hits).slice(0, 2), [' b0', ' b1'])
  assert.deepEqual(lines(fileHits(before, after, matcher('gone'), changeBlocks(before, after))), ['−a30'])
})

test('a changed file\'s lines are told changed or not from its blocks, not by indexing each line they change', t => {
  const run = word => Array.from({ length: 200_000 }, (_, i) => `${word} ${i}`).join('\n')
  const after = `keep fetch\n${run('new')}\n`, before = `keep fetch\n${run('old')}\n`
  // One block replacing 200,000 lines with as many.
  const blocks = [{ a0: 1, a1: 200_001, b0: 1, b1: 200_001 }]
  const set = t.mock.method(Map.prototype, 'set')
  let kept, removed
  try {
    kept = lines(fileHits(before, after, matcher('fetch'), blocks))
    removed = lines(fileHits(before, after, matcher('old 7'), blocks)).slice(0, 2)
  } finally {
    set.mock.restore()
  }
  assert.deepEqual(kept, [' b0'])
  assert.deepEqual(removed, ['−a8', '−a71'])
  assert.ok(set.mock.callCount() < 100, `${set.mock.callCount()} lines indexed`)
})

test('a changed block\'s hits list as its diff\'s layout draws them: unified, the removed over the added; split, row by row', () => {
  const before = `keep\n${Array.from({ length: 25 }, (_, i) => `x old ${i}`).join('\n')}\n`
  const after = `keep\n${Array.from({ length: 25 }, (_, i) => `x new ${i}`).join('\n')}\n`
  const blocks = changeBlocks(before, after)
  const unified = lines(fileHits(before, after, matcher('x'), blocks))
  assert.equal(unified.length, SEARCH_MAX_FILE_HITS)
  assert.ok(unified.every(hit => hit.startsWith('−')), 'the first 20 rows unified are removed lines')
  assert.deepEqual(lines(fileHits(before, after, matcher('x'), blocks, { split: true })).slice(0, 4), ['−a1', '+b1', '−a2', '+b2'])
})

test('split, a block\'s hits list in the rows the view aligns: a new line before an edited pair comes first', () => {
  const before = 'keep\nx old value\n'
  const after = 'keep\nx brand new line\nx old value edited\n'
  const blocks = changeBlocks(before, after)
  assert.deepEqual(lines(fileHits(before, after, matcher('x'), blocks, { split: true })), ['+b1', '−a1', '+b2'],
    'the removed line pairs with the edited one, a row below the new one')
})

test('a changed file its diff finds no change in, as whitespace changes hidden leave a re-indented one, isn\'t listed', () => {
  const found = searchCompareFiles([
    { path: 'spaced.js', before: '  fetch()\n', after: '    fetch()\n' },
    { path: 'edited.js', before: 'fetch(1)\n', after: 'fetch(2)\n' },
  ], matcher('fetch'), (path, before, after) => (path === 'spaced.js' ? [] : changeBlocks(before, after)))
  assert.deepEqual(found.files.map(file => file.path), ['edited.js'])
})
