import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import './_polyfills.js'

const { state } = await import('../client/state.ts')
const { clearMergedGroups, drawnTabs, getMergedGroups } = await import('../ui/view/group.js')
const { configureRevalidation } = await import('../ui/view/format.js')
const { applyFilters, clearFilterOverride, cloneFilterFields, hasSecurityContrast, resetFilters, setFilterOverride } = await import('../ui/view/filters.js')
const { activeFilterDescriptions } = await import('../ui/view/export-summary.js')
const { deleteFile, ensureBundleFindingsIndexed, ensureLinkedFindingsIndexed, reportRowsForFindingIds, saveFile, subscribeToBundleFindingIndex, subscribeToLinkedFindings } = await import('../client/index.js')
const { setCount } = await import('../client/counts.js')
const { LINKS_KIND } = await import('../client/linked-findings.js')
const { clearManagedWorkspace, setManagedWorkspace } = await import('../client/managed/workspace.js')
const finding = (id, extra = {}) => ({ id, file: 'src/app.js', severity: 'high', confidence: 9, ...extra })

beforeEach(() => {
  state.reports = []
  state.workspaceMerges = []
  state.currentWorkspace = null
  state.showRevalidation = true
  state.revalidationDetailed = false
  state.upstreamOnly = false
  state.serverMode = 'e2e'
  state.localMode = false
  state.triage = new Map()
  configureRevalidation(true)
  resetFilters()
  clearMergedGroups()
})
afterEach(() => { clearFilterOverride(); state.reports = []; resetFilters() })

for (const serverMode of ['e2e', 'managed']) {
  test(`${serverMode}: hidden security siblings classify the whole row in every App/code lens`, () => {
    state.serverMode = serverMode
    state.currentWorkspace = 'workspace'
    state.reports = [{ fileName: 'r.json', groups: [
      [finding('pass', { isApp: true, revalidate: 'revalidation', type: 'correctness' }),
        finding('hidden-security', { isApp: false, security: true, revalidate: 'refuted' }),
        finding('source', { isApp: false, isUpstream: true, security: false })],
      [finding('nonsecurity', { type: 'correctness', isApp: false, isUpstream: true })],
    ] }]
    for (const [app, detailed, upstream] of [[true, false, false], [true, true, false], [false, false, false], [true, false, true]]) {
      state.showRevalidation = app
      state.revalidationDetailed = detailed
      state.upstreamOnly = upstream
      configureRevalidation(app, upstream)
      const groups = getMergedGroups()
      assert.equal(groups.length, 2)
      assert.equal(hasSecurityContrast(groups), true)
      if (app && !upstream) assert.equal(drawnTabs(groups[0]).some(f => f.id === 'hidden-security'), false, 'security evidence stays hidden in App mode')
      assert.equal(groups[0].every(f => f.isSecurity), true)
      state.filterSecurity = 'with'
      assert.deepEqual(applyFilters(groups), [groups[0]])
      state.filterSecurity = 'without'
      assert.deepEqual(applyFilters(groups), [groups[1]])
      state.filterSecurity = ''
      assert.deepEqual(applyFilters(groups), groups)
    }
  })
}

test('the toggle is applicable only when both security and non-security rows exist', () => {
  const positive = [finding('yes', { isSecurity: true }), finding('sibling', { isSecurity: false })]
  const negative = [finding('no', { isSecurity: false })]
  assert.equal(hasSecurityContrast([]), false)
  assert.equal(hasSecurityContrast([positive]), false)
  assert.equal(hasSecurityContrast([negative]), false)
  assert.equal(hasSecurityContrast([positive, negative]), true)
  state.filterSecurity = 'without'
  assert.deepEqual(applyFilters([positive, negative]), [negative], 'negative selection is the whole-row complement')
})

test('security filter participates in export overrides and reset', () => {
  const groups = [[finding('yes', { isSecurity: true })], [finding('no', { isSecurity: false })]]
  state.filterSecurity = 'with'
  const filters = cloneFilterFields()
  assert.equal(filters.filterSecurity, 'with')
  assert.deepEqual(activeFilterDescriptions(filters).find(f => f.key === 'security').clear, { filterSecurity: '' })
  filters.filterSecurity = 'without'
  setFilterOverride(filters)
  assert.deepEqual(applyFilters(groups), [groups[1]])
  assert.equal(state.filterSecurity, 'with')
  clearFilterOverride()
  resetFilters()
  assert.equal(state.filterSecurity, '')
  assert.deepEqual(applyFilters(groups), groups)
})

test('known linked evidence updates cached rows without loading reports and stays local', async () => {
  const evidence = crypto.randomUUID(), id = crypto.randomUUID(), linked = crypto.randomUUID()
  const linksName = `security-links-${id}.json`, name = `security-evidence-${id}.json`
  const unsubscribeLinks = subscribeToLinkedFindings(() => { state.linksTick++ })
  const unsubscribeIndex = subscribeToBundleFindingIndex(() => { state.findingIndexTick++ })
  state.reports = [{ fileName: 'visible.json', groups: [[finding(id, { type: 'correctness' })]] }]
  const matches = () => getMergedGroups()[0].every(f => f.isSecurity)
  try {
    assert.equal(matches(), false)
    await saveFile(linksName, JSON.stringify([[{ id }, { id: linked }]]))
    setCount(linksName, 1, LINKS_KIND)
    await ensureLinkedFindingsIndexed()
    assert.equal(matches(), false, 'links with unknown targets are not evidence')
    await saveFile(name, JSON.stringify({ groups: [[finding(linked), finding(evidence, { security: true })]] }))
    assert.equal(matches(), false, 'the lens does not index an unopened report')
    assert.deepEqual(reportRowsForFindingIds([linked]), [])
    await ensureBundleFindingsIndexed()
    assert.equal(matches(), true, 'existing index evidence propagates from a linked sibling')
    assert.equal(state.reports.length, 1, 'the linked report is never loaded into the view')
    state.serverMode = 'managed'
    assert.equal(matches(), false, 'managed mode does not consult local report evidence')
    state.localMode = true
    assert.equal(matches(), true, 'local mode on a managed server uses the local index')
    await deleteFile(linksName)
    assert.equal(matches(), false, 'removing a link clears propagated evidence')
  } finally {
    await deleteFile(name)
    await deleteFile(linksName)
    unsubscribeLinks()
    unsubscribeIndex()
  }
})

const citing = (id, inputs, extra = {}) => finding(id, { isApp: true, revalidate: 'revalidation', revalidateInputs: inputs, ...extra })

for (const serverMode of ['e2e', 'managed']) {
  test(`${serverMode}: App findings and the inputs they cite in other reports share security, in either direction`, () => {
    state.serverMode = serverMode
    state.currentWorkspace = 'workspace'
    state.reports = [
      { fileName: 'secure-pass.json', groups: [[citing('secure-answer', ['cited'], { type: 'security' })]] },
      { fileName: 'pass.json', groups: [[citing('answer', ['secret'], { type: 'correctness' })]] },
      { fileName: 'source.json', groups: [
        [finding('cited', { type: 'correctness' })], [finding('secret', { type: 'security' })], [finding('plain', { type: 'correctness' })],
      ] },
    ]
    getMergedGroups()
    const stamped = Object.fromEntries(state.reports.flatMap(r => r.groups.flat()).map(f => [f.id, f.isSecurity]))
    assert.deepEqual(stamped, { 'secure-answer': true, answer: true, cited: true, secret: true, plain: false })
  })
}

test('an App row citing a loaded finding from an unopened report is evidence through the local index', async () => {
  const cited = crypto.randomUUID(), name = `security-citing-${cited}.json`
  const unsubscribeIndex = subscribeToBundleFindingIndex(() => { state.findingIndexTick++ })
  state.reports = [{ fileName: 'visible.json', groups: [[finding(cited, { type: 'correctness' })]] }]
  const matches = () => getMergedGroups()[0].every(f => f.isSecurity)
  try {
    assert.equal(matches(), false)
    await saveFile(name, JSON.stringify({ type: 'security', groups: [[citing(crypto.randomUUID(), [cited])]] }))
    await ensureBundleFindingsIndexed()
    assert.equal(matches(), true, 'the citing App row is found without loading its report')
    assert.equal(state.reports.length, 1)
    await deleteFile(name)
    assert.equal(matches(), false, 'deleting the citing report clears the evidence')
  } finally {
    await deleteFile(name)
    unsubscribeIndex()
  }
})

test('managed mode finds App rows citing a loaded finding anywhere in the team workspace', () => {
  // Rows outside the loaded reports carry the server's stamp, as team responses do.
  state.serverMode = 'managed'
  state.currentManagedTeam = 'team'
  state.managedSession = { id: 'user', login: 'user', name: null, avatarUrl: null, role: 'view', csrfToken: null }
  const source = { id: 'source', filename: 'source.json', repo: { github: null, directory: '' }, data: { findings: [finding('cited', { type: 'correctness' })] } }
  const pass = { id: 'pass', filename: 'pass.json', repo: { github: null, directory: '' }, data: { findings: [citing('answer', ['cited'], { isSecurity: true })] } }
  try {
    state.reports = [{ fileName: 'source.json', groups: [[finding('cited', { type: 'correctness' })]] }]
    setManagedWorkspace('team', [source])
    assert.equal(getMergedGroups()[0][0].isSecurity, false)
    setManagedWorkspace('team', [source, pass])
    assert.equal(getMergedGroups()[0][0].isSecurity, true)
  } finally {
    clearManagedWorkspace()
    state.currentManagedTeam = null
    state.managedSession = null
  }
})
