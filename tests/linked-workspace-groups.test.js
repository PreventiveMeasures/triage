import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import './_polyfills.js'

globalThis[Symbol.for('@rray/frontend')] ??= { html: () => null, nothing: null, LitElement: class {}, StateElement: class {} }

const { mergeLinkedWorkspaceGroups } = await import('../ui/view/linked-workspace-groups.js')
const { collectDuplicates, LINKS_KIND } = await import('../client/linked-findings.js')
const { configureRevalidation, canDropRevalidation } = await import('../ui/view/format.js')
const { state, patchEntry, saveFile, deleteFile, ensureLinkedFindingsIndexed, subscribeToLinkedFindings } = await import('../client/index.js')
const { setCount } = await import('../client/counts.js')
const { getMergedGroups, getRevalidationConflicts, groupState, sortTabs, syncGroupTriage, triageActionPlan, triageScope } = await import('../ui/view/group.js')
const { findLoadedFinding, unhideFinding } = await import('../ui/view/finding-link.js')

const finding = (id, extra = {}) => ({ id, isApp: true, severity: 'high', confidence: 9, file: 'src/app.js', description: id, ...extra })
const ids = (groups) => groups.map((g) => g.map((f) => f.id))
const links = (...groups) => {
  const index = new Map()
  collectDuplicates(groups, index)
  return (id) => [...index.get(id) ?? []]
}

describe('explicit links between workspace rows', () => {
  it('combines whole rows transitively while retaining only their originally visible tabs', () => {
    const a = finding('A'), b = finding('B'), c = finding('C'), d = finding('D')
    const dep = finding('upstream', { isApp: false, isUpstream: true })
    const groups = [[a, dep], [b, c], [d]]
    const result = mergeLinkedWorkspaceGroups(groups, links(['A', 'B'], ['C', 'D']), (g) => g.filter((f) => !f.isUpstream))
    assert.deepEqual(ids(result), [['A', 'upstream', 'B', 'C', 'D']])
    assert.deepEqual(result[0].linkedTabs, [a, b, c, d])
    assert.deepEqual(ids(groups), [['A', 'upstream'], ['B', 'C'], ['D']], 'original report rows stay intact')
  })

  it('does not use hidden source findings as a bridge between App rows', () => {
    const groups = [[finding('A'), finding('D', { isUpstream: true })], [finding('B'), finding('E', { isUpstream: true })]]
    assert.equal(mergeLinkedWorkspaceGroups(groups, links(['D', 'E']), (g) => g.filter((f) => !f.isUpstream)), groups)
  })

  it('does not infer links through findings absent from the workspace', () => {
    const groups = [[finding('A')], [finding('C')]]
    assert.equal(mergeLinkedWorkspaceGroups(groups, links(['A', 'B'], ['B', 'C']), (g) => g), groups)
  })

  it('prefers the visible copy when the same id is also a hidden member', () => {
    const hidden = finding('B', { description: 'Hidden answer' }), visible = finding('B', { description: 'Visible answer' })
    const groups = [[finding('A'), hidden], [visible]]
    const [group] = mergeLinkedWorkspaceGroups(groups, links(['A', 'B']), (g) => g === groups[0] ? [g[0]] : g)
    assert.equal(group.find((f) => f.id === 'B'), visible)
    assert.equal(group.linkedTabs[1], visible)
  })
})

describe('workspace linked-row integration', () => {
  const names = []
  let unsubscribe
  let a, b, depA, depB
  beforeEach(() => {
    state.reports = []
    state.workspaceMerges = []
    state.currentWorkspace = 'workspace'
    state.showRevalidation = true
    state.revalidationDetailed = false
    state.upstreamOnly = false
    state.triage = new Map()
    state.activeTabByGroup = new Map()
    state.filterAnalyzer = ''
    state.filterModel = ''
    configureRevalidation(true)
    a = finding(crypto.randomUUID(), { revalidate: 'revalidation' })
    b = finding(crypto.randomUUID(), { _source: 'codex-security' })
    depA = finding(crypto.randomUUID(), { isApp: false, isUpstream: true, revalidate: 'confirmed' })
    depB = finding(crypto.randomUUID(), { isApp: false, isUpstream: true, revalidate: 'partial' })
    state.reports = [
      { fileName: 'first.json', groups: [[a, depA]] },
      { fileName: 'second.json', groups: [[b]] },
    ]
    // Same invalidation signal the app's linked-findings subscription supplies.
    unsubscribe = subscribeToLinkedFindings(() => { state.linksTick++ })
  })
  afterEach(async () => {
    for (const name of names.splice(0)) await deleteFile(name)
    unsubscribe()
    state.currentWorkspace = null
    state.reports = []
    state.showRevalidation = true
    state.upstreamOnly = false
    state.revalidationDetailed = false
    configureRevalidation(true)
  })
  async function link(...groups) {
    const name = `workspace-links-${crypto.randomUUID()}.json`
    names.push(name)
    await saveFile(name, JSON.stringify(groups.map((g) => g.map((id) => ({ id })))))
    setCount(name, groups.length, LINKS_KIND)
    await ensureLinkedFindingsIndexed()
    return name
  }

  it('merges only in workspace App view, including a workspace with a single report', async () => {
    await link([a.id, b.id])
    assert.deepEqual(ids(getMergedGroups().map(sortTabs)), [[a.id, b.id]], 'imported App tab stays visible beside the pass tab')
    state.revalidationDetailed = true
    assert.deepEqual(ids(getMergedGroups().map(sortTabs)), [[a.id, depA.id, b.id]], 'the linked row stays one row and shows its workings')
    state.revalidationDetailed = false
    assert.deepEqual(ids(getMergedGroups().map(sortTabs)), [[a.id, b.id]], 'and folds them away again')
    state.currentWorkspace = null
    assert.equal(getMergedGroups().length, 2, 'report view never merges by links')
    state.currentWorkspace = 'workspace'
    state.showRevalidation = false
    configureRevalidation(false)
    assert.equal(getMergedGroups().length, 2, 'code view keeps its existing grouping')
    state.showRevalidation = true
    state.upstreamOnly = true
    configureRevalidation(true, true)
    state.reports = [{ fileName: 'first.json', groups: [[a, depA], [b, depB]] }]
    await link([depA.id, depB.id])
    assert.equal(getMergedGroups().length, 2, 'upstream view does not merge linked dependencies')
    state.upstreamOnly = false
    configureRevalidation(true)
    assert.equal(getMergedGroups().length, 1, 'one-report workspaces still use explicit App links')
    state.currentWorkspace = null
    assert.equal(getMergedGroups().length, 2, 'opening that report restores its own rows')
  })

  it('keeps row boundaries where a link runs through tabs the detail stop reveals', async () => {
    state.reports = [{ fileName: 'first.json', groups: [[a, depA]] }, { fileName: 'second.json', groups: [[b, depB]] }]
    await link([depA.id, depB.id])
    assert.equal(getMergedGroups().length, 2, 'a link between folded dependency tabs does not join two App rows')
    state.revalidationDetailed = true
    assert.equal(getMergedGroups().length, 2, 'and still does not once the reader can see them')
    state.revalidationDetailed = false
  })

  it('uses the triage conflict indicator without disabling App mode or changing source status', async () => {
    state.triage = new Map([[a.id, { triage: 'fixed' }], [b.id, { triage: 'invalid' }], [depA.id, { triage: 'deleted' }]])
    await link([a.id, b.id])
    const [group] = getMergedGroups()
    assert.equal(groupState(group).hasConflict, true)
    assert.equal(groupState(group).commonTriage, null)
    assert.equal(getRevalidationConflicts().size, 0)
    assert.equal(canDropRevalidation(state.reports), true)
    assert.equal(state.showRevalidation, true)
    assert.equal(syncGroupTriage(group), false, 'conflicting saved statuses are preserved')
    assert.deepEqual(triageScope(group).map((f) => f.id), [a.id, b.id])
    const plan = triageActionPlan(group, 'inprogress')
    assert.equal(plan.clearing, false)
    for (const f of plan.targets) patchEntry(state.triage, f.id, { triage: 'inprogress' })
    assert.equal(groupState(group).hasConflict, false)
    assert.equal(groupState(group).commonTriage, 'inprogress')
    assert.equal(state.triage.get(depA.id).triage, 'deleted')
  })

  it('shares an agreed status using the existing row semantics', async () => {
    state.triage = new Map([[a.id, { triage: 'fixed' }]])
    await link([a.id, b.id])
    const [group] = getMergedGroups()
    assert.equal(groupState(group).commonTriage, 'fixed')
    assert.equal(syncGroupTriage(group), true)
    assert.equal(state.triage.get(b.id).triage, 'fixed')
    assert.equal(state.triage.has(depA.id), false)
  })

  it('does not turn linked App contexts into revalidation conflicts', async () => {
    const shared = { ...depA, revalidate: 'partial', revalidateVerdict: 'App A answer.' }
    const otherApp = { ...b, revalidate: 'revalidation' }
    state.reports = [
      { fileName: 'first.json', groups: [[a, shared]] },
      { fileName: 'second.json', groups: [[otherApp, { ...shared, revalidateVerdict: 'App B answer.' }]] },
    ]
    await link([a.id, b.id])
    assert.equal(getMergedGroups().length, 1)
    assert.equal(getRevalidationConflicts().size, 0, 'links group the view after report conflicts are checked')
    assert.equal(state.reports[1].groups[0][1].revalidateVerdict, 'App B answer.')
  })

  it('refreshes cached rows when a links file is added and deleted', async () => {
    assert.equal(getMergedGroups().length, 2)
    const name = await link([a.id, b.id])
    assert.equal(getMergedGroups().length, 1)
    await deleteFile(name)
    assert.equal(getMergedGroups().length, 2)
  })

  it('resolves links to any tab of the combined workspace card', async () => {
    await link([a.id, b.id])
    const hit = findLoadedFinding(b.id)
    assert.equal(hit.group, getMergedGroups()[0])
    const gid = unhideFinding(hit.group, b.id)
    assert.equal(state.activeTabByGroup.get(gid), b.id)
    assert.equal(state.showRevalidation, true)
    assert.equal(state.revalidationDetailed, false)
    assert.equal(state.upstreamOnly, false)
  })
})
