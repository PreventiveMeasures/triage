// `client/bundle-hash-index.js` — `bundleFilePath`, which answers
// "does this bundle carry this path, and under what key" from the
// file→hash map a bundle records when it is parsed.
//
// It exists so a caller deciding whether to offer a source preview
// (render-finding.js codePreview) can ask synchronously, without
// parsing and decompressing a bundle to find out. What is pinned here
// is that it is CONSERVATIVE: an exact hit, a suffix hit only when
// exactly one file could be meant, and null everywhere else — the
// alternative is a mark that opens onto the wrong file's code, which
// is worse than no mark at all.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

const { bundleFilePath, dropBundleFromHashIndex, recordBundleFileHashes } =
  await import('../client/bundle-hash-index.js')

const INTEGRITY = 'sha512-aaa'

function record(files) {
  recordBundleFileHashes(INTEGRITY, new Map(files.map((f, i) => [f, `hash-${i}`])))
}

describe('bundleFilePath', () => {
  beforeEach(() => { dropBundleFromHashIndex(INTEGRITY) })

  it('takes a path the bundle names outright', () => {
    record(['src/app/server.ts', 'src/index.ts'])
    assert.equal(bundleFilePath(INTEGRITY, 'src/app/server.ts'), 'src/app/server.ts')
    assert.equal(bundleFilePath(INTEGRITY, 'src/index.ts'), 'src/index.ts')
  })

  // A report written from a different root than the bundle's — the
  // common case for a monorepo package, or a bundle rooted at `dist/`.
  it('takes a suffix on a segment boundary', () => {
    record(['packages/api/src/server.ts', 'packages/api/src/index.ts'])
    assert.equal(bundleFilePath(INTEGRITY, 'src/server.ts'), 'packages/api/src/server.ts')
    assert.equal(bundleFilePath(INTEGRITY, 'server.ts'), 'packages/api/src/server.ts')
  })

  // The boundary is what stops `er.ts` matching `server.ts`.
  it('does not match mid-segment', () => {
    record(['packages/api/src/server.ts'])
    assert.equal(bundleFilePath(INTEGRITY, 'erver.ts'), null)
    assert.equal(bundleFilePath(INTEGRITY, 'rc/server.ts'), null)
  })

  // Two files could be meant, so neither is: opening the wrong
  // `index.js` is worse than offering nothing.
  it('refuses an ambiguous suffix rather than guessing', () => {
    record(['packages/api/index.js', 'packages/web/index.js'])
    assert.equal(bundleFilePath(INTEGRITY, 'index.js'), null)
    // …but an exact hit still wins over the ambiguity.
    record(['packages/api/index.js', 'packages/web/index.js', 'index.js'])
    assert.equal(bundleFilePath(INTEGRITY, 'index.js'), 'index.js')
  })

  it('answers null for a bundle or a path it knows nothing about', () => {
    record(['src/a.ts'])
    assert.equal(bundleFilePath(INTEGRITY, 'src/b.ts'), null)
    assert.equal(bundleFilePath('sha512-nope', 'src/a.ts'), null)
    for (const bad of ['', undefined, null, 42, {}]) {
      assert.equal(bundleFilePath(INTEGRITY, bad), null, String(bad))
    }
  })

  it('forgets a bundle that has been dropped', () => {
    record(['src/a.ts'])
    assert.equal(bundleFilePath(INTEGRITY, 'src/a.ts'), 'src/a.ts')
    dropBundleFromHashIndex(INTEGRITY)
    assert.equal(bundleFilePath(INTEGRITY, 'src/a.ts'), null)
  })
})
