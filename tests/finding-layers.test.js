// The two layer flags every finding carries in memory, and nothing yet
// reads for a decision: `isApp` and `isUpstream`.
//
// They answer two independent questions about one finding. `isApp` —
// is this the app as it runs, or the source underneath? — is a fact
// about the producer, settled where each path builds its findings (ui
// ingest.js, ui links-preview.js, client/bundle-finding-index.js) from
// the one rule here. `isUpstream` narrows the source half: someone
// else's code, shipped in. That one waits for the deps dir, which is
// chosen from the whole loaded set, so it is stamped per render right
// after `configureDepsDir` rather than at ingest.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isAppFinding } from '../report/index.js'

// format.js → frontend-global.js throws at module load when the
// `@rray/frontend` slot isn't installed. Tests don't run the boot path
// that installs it, and nothing here touches those symbols, so a bare
// stub is enough to let the import chain evaluate.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { configureDepsDir, stampUpstreamFindings } = await import('../ui/view/format.js')

// The `source` argument is the producer the callers resolve first,
// against the report's own marker; the revalidation half is read off
// the finding through the same trimming, case-folding reader the rest
// of the app uses.
describe('isAppFinding', () => {
  it('counts another product’s finding as app-layer', () => {
    for (const s of ['claude-security', 'codex-security', 'deepsec', 'piolium']) {
      assert.equal(isAppFinding({ source: s }), true, s)
    }
  })

  it('counts DeepView’s own findings as source-layer, its revalidation row aside', () => {
    assert.equal(isAppFinding({}), false)
    assert.equal(isAppFinding({ source: null }), false)
    assert.equal(isAppFinding({ source: 'deepview' }), false, 'an unknown marker is not one of the four')
    assert.equal(isAppFinding({ revalidate: 'confirmed' }), false, 'a verdict judges a finding, it is not the pass')
    assert.equal(isAppFinding({ revalidate: 'revalidation' }), true)
    // Read as the app reads it — which is as the data spells it: the
    // field is an enumeration, and a value that drifted is no stamp
    // (report/src/finding.js revalidateKindOf).
    assert.equal(isAppFinding({ revalidate: ' Revalidation ' }), false)
  })

  it('takes the resolved producer over the finding’s own field', () => {
    // The report's marker, for a finding that carries none — what
    // ingest hands over as `_source`.
    assert.equal(isAppFinding({}, 'claude-security'), true)
    assert.equal(isAppFinding({ source: 'codex-security' }, null), false)
  })
})

const report = (...findings) => [{ groups: findings.map((f) => [f]) }]

describe('stampUpstreamFindings', () => {
  it('marks source-layer findings in the deps tree, and only those', () => {
    const dep = { isApp: false, file: 'node_modules/lodash/index.js' }
    const own = { isApp: false, file: 'src/a.js' }
    const appDep = { isApp: true, file: 'node_modules/lodash/index.js' }
    const appOwn = { isApp: true, file: 'src/a.js' }
    const reports = report(dep, own, appDep, appOwn)
    configureDepsDir(reports)
    stampUpstreamFindings(reports)
    assert.equal(dep.isUpstream, true)
    // Absent rather than `false`: nothing carries the flag but upstream code.
    for (const f of [own, appDep, appOwn]) assert.equal('isUpstream' in f, false, f.file)
  })

  it('leaves an answer the finding arrived with alone', () => {
    const claimsOwn = { isApp: false, file: 'node_modules/lodash/index.js', isUpstream: false }
    const claimsUpstream = { isApp: false, file: 'src/a.js', isUpstream: true }
    const reports = report(claimsOwn, claimsUpstream)
    configureDepsDir(reports)
    stampUpstreamFindings(reports)
    assert.equal(claimsOwn.isUpstream, false)
    assert.equal(claimsUpstream.isUpstream, true)
  })

  it('reads the deps dir the loaded set settled on, not the default', () => {
    // No `node_modules` anywhere, so `vendor` is the marker — the case
    // stamping at ingest would get wrong, having not yet weighed the
    // report's own paths.
    const vendored = { isApp: false, file: 'app/vendor/pkg/main.go' }
    const reports = report(vendored, { isApp: false, file: 'app/main.go' })
    configureDepsDir(reports)
    stampUpstreamFindings(reports)
    assert.equal(vendored.isUpstream, true)
  })

  it('revises its own answer when a later report moves the deps dir', () => {
    // A workspace ingests its reports one at a time and renders between
    // them, so the first report is stamped under the marker the set had
    // then. `dependencies/` is the fallback, and it stops counting the
    // moment a report brings a real one.
    const fallback = { isApp: false, file: 'dependencies/pkg/index.js' }
    const first = report(fallback)
    configureDepsDir(first)
    stampUpstreamFindings(first)
    assert.equal(fallback.isUpstream, true, 'upstream while `dependencies` is the marker')

    const both = [...first, ...report({ isApp: false, file: 'node_modules/x/i.js' })]
    configureDepsDir(both)
    stampUpstreamFindings(both)
    assert.equal('isUpstream' in fallback, false, 'the dir moved out from under it')

    // And back again, should the set that picked `node_modules` go away.
    configureDepsDir(first)
    stampUpstreamFindings(first)
    assert.equal(fallback.isUpstream, true)
  })

  it('is idempotent, and survives a report with no groups', () => {
    const dep = { isApp: false, file: 'node_modules/x/i.js' }
    const reports = [...report(dep), {}]
    configureDepsDir(reports)
    stampUpstreamFindings(reports)
    stampUpstreamFindings(reports)
    assert.equal(dep.isUpstream, true)
    assert.doesNotThrow(() => stampUpstreamFindings())
  })
})
