// `ui/view/format.js` — `parseCommentRefs` turns a free-text triage
// comment into a segment list (plain `string` runs interleaved with
// `{ url, label }` link tokens) so the comment renderer can linkify any
// pasted GitHub issue / PR / commit URL. This pins the STRICT validation:
// only canonical github.com issue / pull / commit URLs become links, and
// every component (owner / repo / number / sha / host / path) is checked.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// format.js → frontend-global.js throws at module load when the
// `@rray/frontend` slot isn't installed. Tests don't run the boot path
// that installs it, and parseCommentRefs never touches any of these
// symbols, so a bare stub is enough to let the import chain evaluate.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { parseCommentRefs } = await import('../ui/view/format.js')

// The single link token in a comment whose ONLY non-trivial segment is
// one URL. Asserts there's exactly one link and returns it.
function onlyLink(text) {
  const links = parseCommentRefs(text).filter((s) => typeof s !== 'string')
  assert.equal(links.length, 1, `expected exactly one link in: ${text}`)
  return links[0]
}

// True when no segment of `text` is a link token (everything stays text).
function hasNoLink(text) {
  return parseCommentRefs(text).every((s) => typeof s === 'string')
}

describe('parseCommentRefs — non-string / empty input', () => {
  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(parseCommentRefs(''), [])
    assert.deepEqual(parseCommentRefs(undefined), [])
    assert.deepEqual(parseCommentRefs(null), [])
    assert.deepEqual(parseCommentRefs(42), [])
  })

  it('returns plain prose as a single string segment', () => {
    assert.deepEqual(parseCommentRefs('just a note, no links here'), ['just a note, no links here'])
  })
})

describe('parseCommentRefs — valid issue / PR / commit URLs', () => {
  it('linkifies an issue URL with a GitHub-style short label', () => {
    const link = onlyLink('https://github.com/owner/repo/issues/123')
    assert.equal(link.label, 'owner/repo#123')
    assert.equal(link.url, 'https://github.com/owner/repo/issues/123')
  })

  it('linkifies a pull URL (also `#` short form)', () => {
    const link = onlyLink('https://github.com/owner/repo/pull/42')
    assert.equal(link.label, 'owner/repo#42')
    assert.equal(link.url, 'https://github.com/owner/repo/pull/42')
  })

  it('linkifies a commit URL with a 7-char short sha label', () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'
    const link = onlyLink(`https://github.com/owner/repo/commit/${sha}`)
    assert.equal(link.label, 'owner/repo@1234567')
    assert.equal(link.url, `https://github.com/owner/repo/commit/${sha}`)
  })

  it('accepts an abbreviated (7-char) commit sha', () => {
    const link = onlyLink('https://github.com/o/r/commit/abc1234')
    assert.equal(link.label, 'o/r@abc1234')
  })

  it('accepts owner / repo names with allowed punctuation', () => {
    const link = onlyLink('https://github.com/my-org/my.repo_name/issues/7')
    assert.equal(link.label, 'my-org/my.repo_name#7')
  })

  it('preserves a fragment anchor but drops a query string', () => {
    const link = onlyLink('https://github.com/o/r/pull/9#issuecomment-555')
    assert.equal(link.url, 'https://github.com/o/r/pull/9#issuecomment-555')
    const q = onlyLink('https://github.com/o/r/commit/abc1234?diff=split')
    assert.equal(q.url, 'https://github.com/o/r/commit/abc1234')
  })
})

describe('parseCommentRefs — embedding in prose', () => {
  it('splits surrounding text into plain segments around the link', () => {
    const segs = parseCommentRefs('see https://github.com/o/r/issues/5 for details')
    assert.equal(segs.length, 3)
    assert.equal(segs[0], 'see ')
    assert.equal(segs[1].label, 'o/r#5')
    assert.equal(segs[2], ' for details')
  })

  it('trims trailing prose punctuation off the URL', () => {
    const segs = parseCommentRefs('fixed in https://github.com/o/r/pull/42).')
    assert.equal(segs[1].label, 'o/r#42')
    assert.equal(segs[1].url, 'https://github.com/o/r/pull/42')
    assert.equal(segs.at(-1), ').')
  })

  it('linkifies multiple URLs in one comment', () => {
    const links = parseCommentRefs(
      'https://github.com/o/r/issues/1 and https://github.com/o/r/pull/2',
    ).filter((s) => typeof s !== 'string')
    assert.deepEqual(links.map((l) => l.label), ['o/r#1', 'o/r#2'])
  })

  it('keeps an invalid URL as text while linkifying a later valid one', () => {
    const segs = parseCommentRefs('https://github.com/o/r/tree/main vs https://github.com/o/r/pull/3')
    const links = segs.filter((s) => typeof s !== 'string')
    assert.equal(links.length, 1)
    assert.equal(links[0].label, 'o/r#3')
    assert.ok(segs.some((s) => typeof s === 'string' && s.includes('tree/main')))
  })
})

describe('parseCommentRefs — strict rejections', () => {
  it('rejects non-github and look-alike hosts', () => {
    assert.ok(hasNoLink('https://gitlab.com/o/r/issues/1'))
    assert.ok(hasNoLink('https://github.com.evil.example/o/r/issues/1'))
    assert.ok(hasNoLink('https://notgithub.com/o/r/issues/1'))
    assert.ok(hasNoLink('https://www.github.com/o/r/issues/1'))
  })

  it('rejects non-https schemes', () => {
    assert.ok(hasNoLink('http://github.com/o/r/issues/1'))
  })

  it('rejects an explicit port', () => {
    assert.ok(hasNoLink('https://github.com:8080/o/r/issues/1'))
  })

  it('rejects extra or missing path segments', () => {
    assert.ok(hasNoLink('https://github.com/o/r/pull/42/files'))
    assert.ok(hasNoLink('https://github.com/o/r/issues'))
    assert.ok(hasNoLink('https://github.com/o/r'))
  })

  it('rejects non issue / pull / commit kinds', () => {
    assert.ok(hasNoLink('https://github.com/o/r/tree/main'))
    assert.ok(hasNoLink('https://github.com/o/r/blob/main/x.js'))
    assert.ok(hasNoLink('https://github.com/o/r/pulls/1'))
    assert.ok(hasNoLink('https://github.com/o/r/commits/main'))
  })

  it('rejects malformed owners', () => {
    assert.ok(hasNoLink('https://github.com/-bad/r/issues/1'))
    assert.ok(hasNoLink('https://github.com/bad-/r/issues/1'))
    assert.ok(hasNoLink('https://github.com/a--b/r/issues/1'))
    assert.ok(hasNoLink(`https://github.com/${'a'.repeat(40)}/r/issues/1`))
  })

  it('rejects malformed issue / PR numbers', () => {
    assert.ok(hasNoLink('https://github.com/o/r/issues/0'))
    assert.ok(hasNoLink('https://github.com/o/r/issues/007'))
    assert.ok(hasNoLink('https://github.com/o/r/issues/12a'))
    assert.ok(hasNoLink('https://github.com/o/r/pull/12345678901'))
  })

  it('rejects malformed commit shas', () => {
    assert.ok(hasNoLink('https://github.com/o/r/commit/abc123'))
    assert.ok(hasNoLink('https://github.com/o/r/commit/xyz1234'))
    assert.ok(hasNoLink(`https://github.com/o/r/commit/${'a'.repeat(41)}`))
  })

  it('rejects path traversal that normalises away the segments', () => {
    assert.ok(hasNoLink('https://github.com/../../etc/issues/1'))
  })
})
