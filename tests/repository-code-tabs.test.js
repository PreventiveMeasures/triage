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
const { activityPicker } = await import('../ui/view/repository-activity.js')
globalThis.document = { querySelector: () => null }

const entry = { name: 'org/repo', integrity: 'sha512-repository', repository: { repoId: 7, repo: 'org/repo', commit: 'a'.repeat(40), path: '' } }
beforeEach(() => {
  Object.assign(state, { serverMode: 'managed', localMode: false, currentView: 'bundles', bundles: [entry], selectedBundle: entry.integrity,
    bundleDetails: { integrity: entry.integrity, json: { sources: {} }, repository: entry.repository }, bundleSourceFile: null, triage: new Map() })
})

test('a directory open shows its commits, issues, pull requests, agents and pulse in managed mode as one Activity tab, opening on the view last shown, a bundle\'s Issues tab not standing in', () => {
  for (const tab of ['history', 'issues', 'pulls', 'pulse', 'agents']) {
    state.bundleDetailsTab = tab
    const text = templateText(renderBundlesList([entry]))
    assert.equal(state.bundleDetailsTab, tab)
    assert.match(text, ['history', 'agents', 'pulse'].includes(tab) ? new RegExp(`<repository-${tab} `, 'u') : new RegExp(`<repository-issues [^>]*\\.kind=${tab}`, 'u'), tab)
    assert.match(text, new RegExp(`>Treemap<[^]*>Code<[^]*>Search<[^]*data-bundle-tab="${tab}" aria-selected=true [^>]*>Activity<`, 'u'), tab)
    assert.doesNotMatch(text, />(?:History|Issues|Pull requests|Agents|Pulse)<\/button>/u, 'no tab of their own')
  }
  // Another tab open, Activity opens on the view last shown.
  state.bundleDetailsTab = 'code'
  assert.match(templateText(renderBundlesList([entry])), /data-bundle-tab="agents" aria-selected=false [^>]*>Activity</u)
})

test('Activity\'s picker: an icon each, its name to read, no tooltip, opening each view as its tab does, the one shown pressed', () => {
  const text = templateText(activityPicker('pulls'))
  assert.deepEqual([...text.matchAll(/data-bundle-tab=(\w+) aria-label=([^>]+?) aria-pressed=(\w+)>/gu)].map(match => match.slice(1)),
    [['history', 'Commits', 'false'], ['issues', 'Issues', 'false'], ['pulls', 'Pull requests', 'true'], ['agents', 'Agents', 'false'], ['pulse', 'Pulse', 'false']])
  assert.equal(text.split('<svg ').length - 1, 5)
  assert.doesNotMatch(text, /tooltip|title=/u)
})
