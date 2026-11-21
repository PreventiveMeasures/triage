// The focus panel's and previews' bundle sources (focus-code.js bundleSource),
// kept for the bundles read last, and those shown however many.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'

const state = { bundles: [], focusCodeTick: 0 }
const loads = []
mock.module('../client/index.js', { exports: { state, isManagedUiMode: () => false, bundleFilePath: () => null, bundlesForFileHash: () => [], readBundleIndex: () => Promise.resolve(null) } })
mock.module('../ui/view/client-managed.js', { exports: { fetchReportSources: () => Promise.resolve(null), readReportSources: () => null } })
mock.module('../ui/view/group.js', { exports: { activeTabFor: group => group } })
mock.module('../ui/view/bundle-load.js', { exports: { buildBundleDetails: integrity => { loads.push(integrity); return Promise.resolve({ integrity, kind: 'sourcemaps' }) } } })
mock.module('../ui/view/bundle-metadata.js', { exports: { parseBundleMetadata: () => null } })
mock.module('../ui/view/bundle-sources.js', { exports: { bundleFilesAsMap: () => new Map(), bundlePackageDirs: () => [], bundlePackageRepos: () => new Map(),
  bundleSourcesAsMap: details => new Map([['app.js', `code of ${details.integrity}`]]) } })
mock.module('../common/bundle-source-links.js', { exports: { bundleSourceImports: () => new Map(), sourceLinkResolver: () => () => null } })
mock.module('../ui/view/prism-highlight.js', { exports: { langForPath: () => null, highlight: () => Promise.resolve(null) } })
mock.module('../ui/view/render.js', { exports: { render: () => {} } })
mock.module('../ui/view/dom.js', { exports: { report: { querySelector: () => null, querySelectorAll: () => [] } } })
mock.module('../ui/view/reveal-cited.js', { exports: { revealCitedLines: () => {} } })
const { bundleSource } = await import('../ui/view/focus-code.js')

const bundles = count => Array.from({ length: count }, (_, at) => `sha512-bundle-${at}`)
// A render's pass of reads: each bundle's file, as its preview reads it.
const pass = integrities => integrities.map(integrity => bundleSource(integrity, 'app.js'))
const settle = async () => { for (let at = 0; at < 5; at++) await setImmediate() }

test('bundles every preview shows are kept, however many, a repaint reading none of them again; one no longer shown let go past the bound', async () => {
  const shown = bundles(7)
  state.bundles = shown.map(integrity => ({ integrity, name: integrity }))
  const six = shown.slice(0, 6)
  assert.ok(pass(six).every(source => source.loading), 'each asked once')
  await settle()
  for (let repaint = 0; repaint < 3; repaint++) {
    assert.deepEqual(pass(six).map(source => source?.content), six.map(integrity => `code of ${integrity}`), 'all shown, as many as they are')
    await settle()
  }
  assert.equal(loads.length, 6, 'none read again')
  // Another opened alone: those no longer shown let go, past the bound.
  assert.ok(pass([shown[6]])[0].loading)
  await settle()
  assert.equal(pass([shown[6]])[0].content, `code of ${shown[6]}`)
  await settle()
  assert.equal(pass([shown[0]])[0].loading, true, 'the least recently read, let go, read again once shown')
  await settle()
  assert.equal(loads.length, 8)
  assert.equal(pass([shown[5]])[0].content, `code of ${shown[5]}`, 'one read more recently, kept')
})
