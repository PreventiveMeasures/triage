import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { createBundleMetadata, parseBundleMetadata } from '../ui/view/bundle-metadata.js'

// Keep the real modal and bundle source rendering without unrelated page
// navigation, tooltip listeners, or asynchronous syntax highlighting.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
mock.module('../ui/view/scan-navigation.js', { namedExports: { canScanBundle: () => false, openScan() {} } })
mock.module('../ui/view/ingest.js', { namedExports: { bundleKind: () => null } })
mock.module('../ui/view/tooltip.js', { namedExports: { hideTooltip() {}, showTooltip() {} } })
mock.module('../ui/view/prism-highlight.js', { namedExports: { langForPath: () => null, langForTag: () => null, highlight: () => Promise.resolve(null) } })
const { state } = await import('../client/state.ts')
const { renderBundleSourceModal, renderBundlesList } = await import('../ui/view/render-bundle.js')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, index) => text + renderText(value.values[index])).join('')
  return typeof value === 'string' ? value : ''
}

beforeEach(() => {
  state.currentView = 'findings'
  state.bundleDetailsTab = 'overview'
  state.bundleSourceFile = 'src/main.js'
  state.bundleSourceFindingIdx = null
  state.bundleDetails = null
})

test('the source popup shows loading through a cold open and metadata upgrade, then displays the file', () => {
  for (const details of [null, { metadataOnly: true }]) {
    state.bundleDetails = details
    const markup = renderText(renderBundleSourceModal())
    assert.match(markup, /aria-busy=true/u)
    assert.match(markup, /role="status">Loading source…/u)
    assert.match(markup, /src\/main\.js/u, 'keep the requested path visible while loading')
    assert.match(markup, /aria-label="Close source viewer"/u)
    assert.doesNotMatch(markup, /Source content not bundled|Failed to load source/u)
  }
  state.bundleDetails = { kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent: ['export const ready = true'] } }
  const markup = renderText(renderBundleSourceModal())
  assert.match(markup, /aria-busy=false/u)
  assert.match(markup, /export const ready = true/u)
  assert.doesNotMatch(markup, /Loading source|Source content not bundled/u)
})

test('only a loaded bundle without the file content shows the missing-source message', () => {
  for (const sourcesContent of [[], [null]]) {
    state.bundleDetails = { kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent } }
    const markup = renderText(renderBundleSourceModal())
    assert.match(markup, /Source content not bundled/u)
    assert.match(markup, /aria-busy=false/u)
    assert.doesNotMatch(markup, /Loading source/u)
  }
})

test('bundle read failures and failed source upgrades end loading with a distinct error', () => {
  for (const details of [{ error: 'Could not read bundle' }, { metadataOnly: true, sourceError: 'Could not fetch sources' }]) {
    state.bundleDetails = details
    const markup = renderText(renderBundleSourceModal())
    assert.match(markup, /role="status">Failed to load source:/u)
    assert.ok(markup.includes(details.error || details.sourceError))
    assert.match(markup, /aria-busy=false/u)
    assert.doesNotMatch(markup, /Loading source|Source content not bundled/u)
  }
})

test('closing during loading keeps the popup closed after sources arrive', () => {
  state.bundleSourceFile = null
  assert.equal(renderText(renderBundleSourceModal()), '')
  state.bundleDetails = { kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent: ['ready'] } }
  assert.equal(renderText(renderBundleSourceModal()), '')
})

test('bundle Overview displays origin links from full contents and cached managed metadata', async () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-origin' }
  const commit = '0123456789abcdef'.repeat(3).slice(0, 40)
  const full = { integrity: entry.integrity, kind: 'stasis', size: 123, bundle: new Bundle({
    repo: { github: 'org/repo', commit }, package: { npm: { name: '@org/app', version: '1.2.3' } },
  }) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const [details, managedId] of [[full, undefined], [cached, 'managed-bundle']]) {
    state.bundleDetails = details
    const markup = renderText(renderBundlesList([{ ...entry, managedId }]))
    assert.match(markup, /<dt>GitHub<\/dt><dd class="bundle-origin-row">\s*<a class="bundle-origin-link" href=https:\/\/github\.com\/org\/repo/u)
    assert.match(markup, /<dt>npm<\/dt><dd class="bundle-origin-row">\s*<a class="bundle-origin-link" href=https:\/\/www\.npmjs\.com\/package\/@org\/app\/v\/1\.2\.3/u)
    const githubRow = markup.match(/<dt>GitHub<\/dt><dd class="bundle-origin-row">(.*?)<\/dd>/su)[1]
    assert.ok(githubRow.includes(`href=https://github.com/org/repo/commit/${commit}`))
    assert.match(githubRow, /<span>0123456<\/span>/u)
    assert.match(githubRow, /class="bundle-origin-link bundle-commit-link"/u)
    assert.doesNotMatch(markup, /<dt>Commit<\/dt>/u)
    assert.match(markup, /target="_blank" rel="noopener noreferrer"/u)
  }
  for (const details of [null, { ...full, integrity: 'previous' }, { ...full, error: 'broken' }, { ...full, bundle: new Bundle() }]) {
    state.bundleDetails = details
    assert.doesNotMatch(renderText(renderBundlesList([entry])), /<dt>GitHub<\/dt>|<dt>npm<\/dt>/u)
  }
})
