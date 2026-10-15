import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

// A repository's directory, its files open, on the tabs reading none of them.
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/dom.js', { exports: { report: null } })
mock.module('../ui/view/scan-navigation.js', { exports: { canScanBundle: () => false, openScan() {} } })
mock.module('../ui/view/ingest.js', { exports: { bundleKind: () => null } })
mock.module('../ui/view/tooltip.js', { exports: { hideTooltip() {}, installShadowTooltipListener() {}, showTooltip() {} } })
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
mock.module('../ui/view/dialogs/npm-compare-advisories-dialog.js', { exports: { openNpmCompareAdvisoriesDialog() {} } })
mock.module('../ui/view/dialogs/why-dialog.js', { exports: { openWhyDialog() {} } })
mock.module('../ui/view/prism-highlight.js', { exports: { langForPath: () => null, langForTag: () => null, highlight: () => Promise.resolve(null) } })
mock.module('../ui/view/repository-code.js', { exports: {
  browsableRepositories: () => ({ status: 'ready', value: [] }), openRepositoryCodeTab() {}, repositoryCodeListing: () => '', repositoryCodeName: ({ repo }) => repo,
  repositoryCodePending: () => null, repositoryCodeRoute: () => null, repositoryRefs: () => ({ status: 'loading' }), navigateToRepositoryCode() {}, shownRevision: () => ({}),
} })
const { state } = await import('../client/state.ts')
const { renderBundlesList } = await import('../ui/view/render-bundle.js')
globalThis.document = { querySelector: () => null }

const entry = { name: 'org/repo', integrity: 'sha512-repository', repository: { repoId: 7, repo: 'org/repo', commit: 'a'.repeat(40), path: '' } }
beforeEach(() => {
  Object.assign(state, { serverMode: 'managed', localMode: false, currentView: 'bundles', bundles: [entry], selectedBundle: entry.integrity,
    bundleDetails: { integrity: entry.integrity, json: { sources: {} }, repository: entry.repository }, bundleSourceFile: null, triage: new Map() })
})

test('a directory open shows its Issues, Pull requests and Agents in managed mode, a bundle\'s Issues tab, which managed hides, not standing in for them', () => {
  for (const tab of ['issues', 'pulls', 'agents', 'history']) {
    state.bundleDetailsTab = tab
    const text = templateText(renderBundlesList([entry]))
    assert.equal(state.bundleDetailsTab, tab)
    assert.match(text, tab === 'history' ? /<repository-history /u : tab === 'agents' ? /<repository-agents /u : new RegExp(`<repository-issues [^>]*\\.kind=${tab}`, 'u'), tab)
    assert.match(text, /data-bundle-tab="issues"[^]*>Issues<[^]*data-bundle-tab="pulls"[^]*>Pull requests<[^]*data-bundle-tab="agents"[^]*>Agents</u)
  }
})
