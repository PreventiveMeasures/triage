// `ui/view/bundle-pkg-of.js` — the package classifier the bundle
// Graph / treemap / size-distribution / compare views bucket source
// paths with. Pure string logic, no Lit / DOM / `state`, so the test
// imports it straight.
//
// The behavior under test: dependency paths bucket by package name
// (scopes + pnpm's nested `node_modules` handled), own (first-party)
// source uses the single `__own__` identity, and a supplied stasis
// `packageDir` keeps workspace packages (PHP `vendor/<vendor>/<pkg>`,
// monorepo `packages/<name>`) separate from their shared parent dir.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { bundlePkgOf, ownSourceFirst, pkgLabel } = await import('../ui/view/bundle-pkg-of.js')

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

  it('classifies every ordinary source directory and root file as own source', () => {
    for (const path of ['src/foo/a.js', 'lib/x.js', 'playground/demo.js', 'index.js']) {
      assert.equal(bundlePkgOf(path), '__own__')
    }
    assert.equal(bundlePkgOf('src/node_modules/foo/x.js'), 'foo')
  })

  describe('stasis packageDir (workspace packages)', () => {
    it('buckets a vendored package by its package dir', () => {
      // PHP `vendor/<vendor>/<pkg>` — the heuristic alone would
      // treat these as own source without their recorded package dirs.
      assert.equal(
        bundlePkgOf('vendor/aws/aws-sdk-php/src/S3/S3Client.php', { packageDir: 'vendor/aws/aws-sdk-php' }),
        'vendor/aws/aws-sdk-php',
      )
      assert.equal(
        bundlePkgOf('vendor/aws/aws-crt-php/src/AWS.php', { packageDir: 'vendor/aws/aws-crt-php' }),
        'vendor/aws/aws-crt-php',
      )
    })

    it('keeps a vendored package apart from an npm package of the same name', () => {
      // One bundle can carry both — a Rust program with a JS client — and
      // the bucket is what sizes, edges and colors are grouped by.
      const npm = bundlePkgOf('node_modules/log/index.js', { packageDir: 'node_modules/log' })
      const cargo = bundlePkgOf('vendor/log/src/lib.rs', { packageDir: 'vendor/log' })
      assert.equal(npm, 'log')
      assert.equal(cargo, 'vendor/log')
      assert.notEqual(npm, cargo)
    })

    it('keeps sibling workspace packages under a shared parent separate', () => {
      const a = bundlePkgOf('packages/a/index.js', { packageDir: 'packages/a' })
      const b = bundlePkgOf('packages/b/index.js', { packageDir: 'packages/b' })
      assert.equal(a, 'packages/a')
      assert.equal(b, 'packages/b')
      assert.notEqual(a, b)
    })

    it('uses the recorded node_modules directory for the package name', () => {
      assert.equal(
        bundlePkgOf('node_modules/foo/index.js', { packageDir: 'node_modules/foo' }),
        'foo',
      )
      assert.equal(
        bundlePkgOf('a/node_modules/@s/p/i.js', { packageDir: 'a/node_modules/@s/p' }),
        '@s/p',
      )
      assert.equal(
        bundlePkgOf('dependencies/filename.js', { packageDir: 'node_modules/.pnpm/@s+p@1.0.0/node_modules/@s/p' }),
        '@s/p',
      )
      assert.equal(
        bundlePkgOf('node_modules/outer/node_modules/inner/index.js', { packageDir: 'node_modules/outer/node_modules/inner' }),
        'inner',
      )
    })

    it('keeps dependency-named source folders in their recorded owning module', () => {
      const path = 'subdir/dependencies/filename.js'
      assert.equal(bundlePkgOf(path, { packageDir: '.' }), '__own__')
      assert.equal(bundlePkgOf(path, { packageDir: 'subdir' }), 'subdir')
      assert.equal(bundlePkgOf('dependencies/filename.js', { packageDir: 'packages/app' }), 'packages/app')
      // Without metadata, the legacy dependency-directory heuristic still applies.
      assert.equal(bundlePkgOf(path), 'filename.js')
    })

    it('treats the `.` root module as own source', () => {
      assert.equal(bundlePkgOf('index.js', { packageDir: '.' }), '__own__')
      assert.equal(bundlePkgOf('src/foo/a.js', { packageDir: '.' }), '__own__')
    })
  })
})

describe('ownSourceFirst', () => {
  it('moves dependencies below own source, keeping each group in its given order', () => {
    const paths = ['node_modules/a/x.js', 'lib/z.js', 'dependencies/b/y.js', 'app.js', 'node_modules/.pnpm/c@1/node_modules/c/i.js']
    assert.deepEqual(ownSourceFirst(paths), ['lib/z.js', 'app.js', 'node_modules/a/x.js', 'dependencies/b/y.js', 'node_modules/.pnpm/c@1/node_modules/c/i.js'])
  })

  it('classifies by recorded package dirs when given', () => {
    const packageDirs = new Map([['vendor/log/lib.rs', 'vendor/log'], ['src/dependencies/own.js', '.'], ['src/main.rs', '.']])
    assert.deepEqual(ownSourceFirst(['vendor/log/lib.rs', 'src/dependencies/own.js', 'src/main.rs'], packageDirs),
      ['src/dependencies/own.js', 'src/main.rs', 'vendor/log/lib.rs'])
  })
})

describe('pkgLabel', () => {
  it('spells out own source', () => {
    assert.equal(pkgLabel('__own__'), 'Own source')
  })

  it('names a `cargo vendor` crate by the crate, not by `vendor/<crate>`', () => {
    assert.equal(pkgLabel('vendor/console_log'), 'console_log')
    assert.equal(pkgLabel('vendor/solana-program'), 'solana-program')
    // A second version of a crate is vendored beside the first under a
    // versioned dir, and is shown as that dir.
    assert.equal(pkgLabel('vendor/syn-1.0.109'), 'syn-1.0.109')
  })

  it('names a Composer package and a Go module as their ecosystems do', () => {
    assert.equal(pkgLabel('vendor/aws/aws-sdk-php'), 'aws/aws-sdk-php')
    assert.equal(pkgLabel('vendor/github.com/pkg/errors'), 'github.com/pkg/errors')
    // A nested vendor dir names the innermost package.
    assert.equal(pkgLabel('app/vendor/x/vendor/y'), 'y')
  })

  it('takes `vendor` only as a whole segment with a package under it', () => {
    assert.equal(pkgLabel('crates/vendor-tools'), 'crates/vendor-tools')
    assert.equal(pkgLabel('vendor'), 'vendor')
  })

  it('passes anything but a package key through, as the graph asks with none focused', () => {
    assert.equal(pkgLabel(null), null)
    assert.equal(pkgLabel(undefined), undefined)
  })

  it('leaves npm names, scoped ones included, and workspace dirs as they are', () => {
    assert.equal(pkgLabel('log'), 'log')
    assert.equal(pkgLabel('@scope/pkg'), '@scope/pkg')
    assert.equal(pkgLabel('packages/common'), 'packages/common')
  })
})
