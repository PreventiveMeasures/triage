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
mock.module('../ui/view/repository-compare.js', { exports: { repositoryCompareSource: () => null } })
mock.module('../ui/view/activity-load.js', { exports: { withRepositoryActivity: template => template() } })
mock.module('../ui/view/repository-code.js', { exports: {
  browsableRepositories: () => ({ status: 'ready', value: [] }), openRepositoryCodeTab() {}, repositoryCodeListing: () => '', repositoryCodeName: ({ repo }) => repo,
  repositoryCodePending: () => null, repositoryCodeRoute: () => null, repositoryFullName: ({ repo }) => repo, repositoryRefs: () => ({ status: 'loading' }), navigateToRepositoryCode() {}, shownRevision: () => ({}),
} })
const { state } = await import('../client/state.ts')
const { renderBundlesList, renderRepositoryCodeOpening } = await import('../ui/view/render-bundle.js')
const { activityPicker } = await import('../ui/view/repository-activity.js')
globalThis.document = { querySelector: () => null }

const entry = { name: 'org/repo', integrity: 'sha512-repository', repository: { repoId: 7, repo: 'org/repo', commit: 'a'.repeat(40), path: '' } }
beforeEach(() => {
  Object.assign(state, { serverMode: 'managed', localMode: false, currentView: 'bundles', bundles: [entry], selectedBundle: entry.integrity,
    bundleDetails: { integrity: entry.integrity, json: { sources: {} }, repository: entry.repository }, bundleSourceFile: null, triage: new Map() })
})

test('a directory open shows its commits, issues, pull requests, agents, pulse and replay in managed mode as one Activity tab, opening on the view last shown, a bundle\'s Issues tab not standing in', () => {
  for (const tab of ['commits', 'issues', 'pulls', 'pulse', 'replay', 'agents']) {
    state.bundleDetailsTab = tab
    const text = templateText(renderBundlesList([entry]))
    assert.equal(state.bundleDetailsTab, tab)
    assert.match(text, ['commits', 'agents', 'pulse', 'replay'].includes(tab) ? new RegExp(`<repository-${tab === 'commits' ? 'history' : tab} `, 'u') : new RegExp(`<repository-issues [^>]*\\.kind=${tab}`, 'u'), tab)
    assert.match(text, new RegExp(`>Treemap<[^]*>Code<[^]*>Search<[^]*data-bundle-tab="${tab}" aria-selected=true [^>]*>Activity<`, 'u'), tab)
    assert.doesNotMatch(text, />(?:History|Issues|Pull requests|Agents|Pulse|Replay)<\/button>/u, 'no tab of their own')
  }
  // Another tab open, Activity opens on the view last shown.
  state.bundleDetailsTab = 'code'
  assert.match(templateText(renderBundlesList([entry])), /data-bundle-tab="agents" aria-selected=false [^>]*>Activity</u)
})

test('Activity\'s picker: an icon each, Replay\'s a play button, its name to read, no tooltip, opening each view as its tab does, the one shown pressed', () => {
  const text = templateText(activityPicker('pulls'))
  assert.deepEqual([...text.matchAll(/data-bundle-tab=(\w+) aria-label=([^>]+?) aria-pressed=(\w+)>/gu)].map(match => match.slice(1)),
    [['commits', 'Commits', 'false'], ['issues', 'Issues', 'false'], ['pulls', 'Pull requests', 'true'], ['agents', 'Agents', 'false'], ['pulse', 'Pulse', 'false'],
      ['replay', 'Replay', 'false']])
  assert.equal(text.split('<svg ').length - 1, 6)
  assert.match(text, /data-bundle-tab=replay [^>]*><svg [^>]*><path d="M5 3\.25v9\.5L12\.75 8z"\/><\/svg>/u, 'a play button\'s triangle')
  assert.doesNotMatch(text, /tooltip|title=/u)
})

test('a directory too large to open, or opening, draws its Treemap from its files\' sizes as its tree lists them; its Code, and any other failure, say why', () => {
  const tooLarge = { repoId: 7, repo: 'org/repo', commit: 'a'.repeat(40), path: 'vendor', revision: null, error: 'This directory is too large to open here.', code: 'directory-too-large' }
  let text = templateText(renderRepositoryCodeOpening({ ...tooLarge, tab: 'treemap' }))
  assert.match(text, /<repository-treemap \.repository=\[object Object\]><\/repository-treemap>/u)
  assert.doesNotMatch(text, /Couldn't open/u)
  text = templateText(renderRepositoryCodeOpening({ ...tooLarge, tab: 'code' }))
  assert.match(text, /<p role="alert">Couldn't open org\/repo at aaaaaaa: This directory is too large to open here\.<\/p>/u)
  assert.doesNotMatch(text, /<repository-treemap/u)
  text = templateText(renderRepositoryCodeOpening({ ...tooLarge, tab: 'treemap', error: 'GitHub couldn’t be reached.', code: 'github-unreachable' }))
  assert.match(text, /<p role="alert">Couldn't open org\/repo at aaaaaaa: GitHub couldn’t be reached\.<\/p>/u)
  assert.doesNotMatch(text, /<repository-treemap/u)
  // Still opening, its Treemap draws them at its commit meanwhile; at none
  // known yet, or on another tab, it says it opens.
  const opening = { ...tooLarge, error: null, code: null }
  assert.match(templateText(renderRepositoryCodeOpening({ ...opening, tab: 'treemap' })), /<repository-treemap /u)
  for (const shown of [{ ...opening, tab: 'treemap', commit: null }, { ...opening, tab: 'code' }]) {
    text = templateText(renderRepositoryCodeOpening(shown))
    assert.match(text, /role="status">Opening org\/repo(?: at aaaaaaa)?…/u, shown.tab)
    assert.doesNotMatch(text, /<repository-treemap/u, shown.tab)
  }
})
