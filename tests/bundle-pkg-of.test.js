// `ui/view/bundle-pkg-of.js` — the package classifier the bundle
// Graph / treemap / size-distribution / compare views bucket source
// paths with. Pure string logic, no Lit / DOM / `state`, so the test
// imports it straight.
//
// The behavior under test: dependency paths bucket by package name
// (scopes + pnpm's nested `node_modules` handled), and own (first-
// party) source buckets either by top-level directory or into the
// single `__own__` group depending on `splitOwnDirs`. The Graph tab's
// "Split dirs" toggle is the only caller that flips it off; everyone
// else keeps the default split.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { bundlePkgOf, ownSourceSplittable } = await import('../ui/view/bundle-pkg-of.js')

describe('bundlePkgOf', () => {
  it('buckets node_modules files by package name', () => {
    assert.equal(bundlePkgOf('node_modules/foo/index.js'), 'foo')
    assert.equal(bundlePkgOf('dist/node_modules/foo/index.js'), 'foo')
  })

  it('keeps the scope on scoped packages', () => {
    assert.equal(bundlePkgOf('node_modules/@scope/pkg/x.js'), '@scope/pkg')
  })

  it('buckets dependencies/ files (no node_modules) by package name', () => {
    assert.equal(bundlePkgOf('dependencies/bar/a.js'), 'bar')
    assert.equal(bundlePkgOf('dependencies/@s/p/a.js'), '@s/p')
  })

  it('walks past pnpm\'s synthetic .pnpm dir to the real package', () => {
    assert.equal(
      bundlePkgOf('node_modules/.pnpm/foo@1.2.3/node_modules/foo/index.js'),
      'foo',
    )
    assert.equal(
      bundlePkgOf('node_modules/.pnpm/@s+p@1.0.0/node_modules/@s/p/i.js'),
      '@s/p',
    )
  })

  describe('own (first-party) source', () => {
    it('splits by top-level directory by default', () => {
      assert.equal(bundlePkgOf('src/foo/a.js'), 'src')
      assert.equal(bundlePkgOf('lib/x.js'), 'lib')
      assert.equal(bundlePkgOf('playground/demo.js'), 'playground')
    })

    it('splits by top-level directory when splitOwnDirs is true', () => {
      assert.equal(bundlePkgOf('src/foo/a.js', { splitOwnDirs: true }), 'src')
    })

    it('collapses into one __own__ group when splitOwnDirs is false', () => {
      assert.equal(bundlePkgOf('src/foo/a.js', { splitOwnDirs: false }), '__own__')
      assert.equal(bundlePkgOf('lib/x.js', { splitOwnDirs: false }), '__own__')
    })

    it('returns __own__ for repo-root files regardless of the flag', () => {
      assert.equal(bundlePkgOf('index.js'), '__own__')
      assert.equal(bundlePkgOf('index.js', { splitOwnDirs: false }), '__own__')
    })

    it('still resolves dependency packages when splitOwnDirs is false', () => {
      assert.equal(bundlePkgOf('node_modules/foo/x.js', { splitOwnDirs: false }), 'foo')
      assert.equal(bundlePkgOf('src/node_modules/foo/x.js', { splitOwnDirs: false }), 'foo')
    })
  })
})

describe('ownSourceSplittable', () => {
  it('is false for an empty file set', () => {
    assert.equal(ownSourceSplittable([]), false)
  })

  it('is false when every file is a dependency', () => {
    assert.equal(ownSourceSplittable(['node_modules/foo/a.js', 'dependencies/bar/b.js']), false)
  })

  it('is false when all own source sits in one top-level dir', () => {
    assert.equal(ownSourceSplittable(['src/a.js', 'src/b/c.js']), false)
    // Dependencies alongside a single own dir don't make it splittable.
    assert.equal(ownSourceSplittable(['src/a.js', 'node_modules/foo/i.js']), false)
  })

  it('is false when all own source is repo-root files (one __own__ bucket)', () => {
    assert.equal(ownSourceSplittable(['index.js', 'main.js']), false)
  })

  it('is true when own source spans multiple top-level dirs', () => {
    assert.equal(ownSourceSplittable(['src/a.js', 'lib/b.js']), true)
    assert.equal(ownSourceSplittable(['node_modules/foo/i.js', 'src/a.js', 'app/b.js']), true)
  })

  it('is true when a top-level dir coexists with repo-root files', () => {
    // split → { src, __own__ }: the root file separates from src.
    assert.equal(ownSourceSplittable(['src/a.js', 'index.js']), true)
  })
})
