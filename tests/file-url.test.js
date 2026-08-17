// `ui/view/format.js` — `fileUrl` / `isPkgRef`. Pins the
// package-reference guard: a piolium `Key code` citing `name@1.2.3` (or
// `@scope/name@1.2.3`) is a dependency reference, not a repo path, and
// must not blob-link under the finding's repo — while real paths keep
// their links, including paths with an `@` inside a segment.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// format.js → frontend-global.js throws at module load when the
// `@rray/frontend` slot isn't installed. Tests don't run the boot path
// that installs it, and fileUrl never touches any of these symbols, so
// a bare stub is enough to let the import chain evaluate.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { fileUrl, isPkgRef } = await import('../ui/view/format.js')

describe('isPkgRef', () => {
  it('matches bare and scoped package references', () => {
    assert.equal(isPkgRef('lodash@4.17.21'), true)
    assert.equal(isPkgRef('@org/name@1.2.3'), true)
  })

  it('does not match real paths', () => {
    assert.equal(isPkgRef('src/a.js'), false)
    assert.equal(isPkgRef('src/@types/x.d.ts'), false)
    assert.equal(isPkgRef('long path/sub dir/file.js'), false)
    assert.equal(isPkgRef('unknown'), false)
  })
})

describe('fileUrl — package references', () => {
  it('never blob-links a package reference, under either repo source', () => {
    assert.equal(fileUrl('lodash@4.17.21', 'acme/widgets', ''), null)
    assert.equal(fileUrl('@org/name@1.2.3', 'acme/widgets', ''), null)
    assert.equal(fileUrl('lodash@4.17.21', '', 'https://github.com/acme/widgets'), null)
  })

  it('still links real paths', () => {
    assert.equal(
      fileUrl('src/a.js', 'acme/widgets', ''),
      'https://github.com/acme/widgets/blob/HEAD/src/a.js',
    )
  })
})
