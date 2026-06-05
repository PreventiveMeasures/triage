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

  it('drops a fragment that is not a plausible GitHub anchor', () => {
    // Encoded payload — `%` is not an anchor character, so the fragment
    // is stripped from the href rather than carried through.
    const enc = onlyLink('https://github.com/o/r/pull/9#%3Cscript%3E')
    assert.equal(enc.url, 'https://github.com/o/r/pull/9')
    assert.equal(enc.label, 'o/r#9')
    // A slash in the fragment is likewise rejected.
    assert.equal(onlyLink('https://github.com/o/r/issues/3#a/b').url, 'https://github.com/o/r/issues/3')
  })

  it('accepts mixed-case owner / repo (path case is preserved, host is not touched)', () => {
    const link = onlyLink('https://github.com/MyOrg/My.Repo/issues/7')
    assert.equal(link.label, 'MyOrg/My.Repo#7')
    assert.equal(link.url, 'https://github.com/MyOrg/My.Repo/issues/7')
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

  it('captures a ref cleanly out of bracket / quote / backtick wrappers', () => {
    // The stricter scanner stops at the wrapper chars, so the wrapped URL
    // validates instead of dragging the wrapper into the path. A trailing
    // backtick used to be percent-encoded into the path and broke this.
    assert.equal(onlyLink('`https://github.com/o/r/pull/9`').label, 'o/r#9')
    assert.equal(onlyLink('<https://github.com/o/r/issues/5>').label, 'o/r#5')
    assert.equal(onlyLink('"https://github.com/o/r/commit/abc1234"').label, 'o/r@abc1234')
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

// The scanner matches any http(s):// run, so these all reach the
// githubRefToken validator and exercise its host / scheme / port /
// credential / path guards directly (rather than being filtered out by a
// narrow scan pattern). A rejected candidate is preserved verbatim as
// plain text — see the lossless-passthrough case at the end.
describe('parseCommentRefs — strict rejections', () => {
  it('rejects non-github and look-alike hosts', () => {
    assert.ok(hasNoLink('https://gitlab.com/o/r/issues/1'))
    assert.ok(hasNoLink('https://github.com.evil.example/o/r/issues/1'))
    assert.ok(hasNoLink('https://notgithub.com/o/r/issues/1'))
    assert.ok(hasNoLink('https://www.github.com/o/r/issues/1'))
  })

  it('rejects credential-smuggling / userinfo authorities', () => {
    // Real host is evil.example — the `github.com` is just userinfo.
    assert.ok(hasNoLink('https://github.com@evil.example/o/r/issues/1'))
    // Host is github.com but a username is present — reject regardless.
    assert.ok(hasNoLink('https://user:pass@github.com/o/r/issues/1'))
  })

  it('rejects non-https schemes', () => {
    assert.ok(hasNoLink('http://github.com/o/r/issues/1'))
  })

  it('rejects an explicit port', () => {
    assert.ok(hasNoLink('https://github.com:8080/o/r/issues/1'))
  })

  it('leaves a non-github URL untouched, losslessly, as plain text', () => {
    assert.deepEqual(
      parseCommentRefs('see https://example.com/o/r/issues/1 here'),
      ['see https://example.com/o/r/issues/1 here'],
    )
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

  // Round-trip safeguard: anything `new URL` would rewrite is rejected,
  // because the scanned candidate then differs from its parsed form and
  // could otherwise "round up" into a passing ref the reader never typed.
  it('rejects URLs that new URL mutates (must match parsed form)', () => {
    // `..` / `.` that resolve to an otherwise-valid ref.
    assert.ok(hasNoLink('https://github.com/o/r/x/../issues/1'))
    assert.ok(hasNoLink('https://github.com/o/r/./issues/1'))
    // Default port :443 is stripped by new URL (u.port is '' for it), so
    // only the round-trip check catches this one.
    assert.ok(hasNoLink('https://github.com:443/o/r/issues/1'))
    // Scheme / host case is normalised to lower-case by new URL.
    assert.ok(hasNoLink('HTTPS://GitHub.COM/o/r/issues/1'))
    assert.ok(hasNoLink('https://GitHub.com/o/r/issues/1'))
    // Backslashes are rewritten to forward slashes by new URL (and the
    // scanner also excludes them) — doubly rejected.
    assert.ok(hasNoLink('https://github.com/o/r/issues\\1'))
  })

  it('rejects non-ASCII homoglyphs in owner / repo', () => {
    // U+017F (ſ → s) and U+212A (K → k) case-fold into [a-z] under /iu;
    // the validators are ASCII-explicit so they never produce a label
    // that impersonates `microsoft` / `Kernel`. (new URL also percent-
    // encodes these, so they are rejected on two independent grounds.)
    assert.ok(hasNoLink('https://github.com/microſoft/vscode/issues/1'))
    assert.ok(hasNoLink('https://github.com/torvalds/Kernel/pull/2'))
  })
})

describe('parseCommentRefs — performance (ReDoS guard)', () => {
  it('stays linear on a long trailing-punctuation run', () => {
    // A scanned URL run can end in a long run of `.,!?;:*` (all
    // URL-scan-legal). The trailing-punct trim must not backtrack
    // quadratically over it. Fixed: ~1ms; the old `/[…]+$/` regex took
    // ~9s at 100k and ~36s here. A 2s ceiling cleanly separates them.
    const payload = `https://x${'.'.repeat(200000)}a`
    const t = performance.now()
    const segs = parseCommentRefs(payload)
    const ms = performance.now() - t
    assert.ok(ms < 2000, `trim took ${ms.toFixed(0)}ms — possible ReDoS regression`)
    // Host is `x…a`, not github.com, so it stays plain text.
    assert.deepEqual(segs, [payload])
  })
})
