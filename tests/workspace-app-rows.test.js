import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import './_polyfills.js'
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    html: () => null, nothing: null, LitElement: class {}, StateElement: class {},
  }
}
const { mergeReportGroups } = await import('../ui/view/workspace-groups.js')
const { revalidationDifferences } = await import('../ui/view/revalidation-conflicts.js')
const { state } = await import('../client/state.ts')
const { canDropRevalidation, configureDepsDir, configureRevalidation, stampUpstreamFindings } = await import('../ui/view/format.js')
const { applyFilters, applyOpeningFilters, shouldLockConfirmed } = await import('../ui/view/filters.js')
const { findGroupById, getMergedGroups, getShownGroups, getRevalidationConflicts, groupKey, groupWithPassRows, sortTabs, underlyingFindingsShown } = await import('../ui/view/group.js')

const { isAppFinding, stampSecurityGroups } = await import('../report/index.js')
const source = (id, extra = {}) => ({ id, severity: 'high', confidence: 9, file: 'src/auth.js', description: `Finding ${id}`, isApp: isAppFinding(extra, extra.source ?? extra._source), ...extra })
const app = (id) => source(id, { revalidate: 'revalidation' })
const report = (fileName, ...groups) => {
  const r = { fileName, groups }
  configureDepsDir([r])
  stampUpstreamFindings([r])
  stampSecurityGroups(groups)
  return r
}
const ids = (groups) => groups.map((g) => g.map((f) => f.id))

function permutations(items) {
  if (items.length <= 1) return [items]
  return items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]))
}

describe('workspace Confirmed dropdown lock', () => {
  let saved
  beforeEach(() => {
    const fields = ['reports', 'workspaceMerges', 'currentWorkspace', 'showRevalidation', 'upstreamOnly', 'revalidationDetailed', 'viewMode', 'shownTriage', 'triage']
    saved = Object.fromEntries(fields.map((key) => [key, state[key]]))
    state.reports = []
    state.workspaceMerges = []
    state.showRevalidation = true
    state.upstreamOnly = false
    state.revalidationDetailed = false
    state.shownTriage = null
    state.triage = new Map()
    configureRevalidation(true)
  })
  afterEach(() => {
    Object.assign(state, saved)
    configureRevalidation(state.showRevalidation, state.upstreamOnly)
  })

  const reports = () => {
    const inputs = Array.from({ length: 26 }, (_, i) => source(`source-${i}`))
    const low = source('low', { severity: 'low', confidence: 7 })
    const refuted = source('refuted'), unreachable = source('unreachable')
    return [
      report('analysis.json', ...[...inputs, low, refuted, unreachable].map((f) => [f])),
      report('app.json',
        ...inputs.map((f, i) => i % 2 === 0
          ? [{ ...app(`App-${i}`), revalidateInputs: [f.id] }]
          : [app(`App-${i}`), { ...f, revalidate: 'partial' }]),
        [low], [{ ...refuted, revalidate: 'refuted' }], [{ ...unreachable, revalidate: 'unreachable' }]),
    ]
  }

  it('hides the whole dropdown for C and A+C in either load order and every findings layout', () => {
    const [analysis, appReport] = reports()
    for (const viewMode of ['kanban', 'table', 'list', 'grouped', 'focus']) {
      state.viewMode = viewMode
      for (const loaded of [[appReport], [analysis, appReport], [appReport, analysis]]) {
        state.currentWorkspace = loaded.length > 1 ? 'workspace' : null
        state.reports = loaded
        const groups = getShownGroups()
        applyOpeningFilters(groups)
        assert.equal(state.filterConfMin, 8)
        assert.equal(state.filterRevalidate, 'confirmed')
        assert.equal(shouldLockConfirmed(groups), true, `${viewMode}: ${loaded.map((r) => r.fileName)}`)
      }
    }
  })

  it('keeps the dropdown for a new non-LOW source finding in the 6–10 band', () => {
    const [analysis, appReport] = reports()
    analysis.groups.push([source('not represented', { confidence: 6, severity: 'medium' })])
    state.currentWorkspace = 'workspace'
    state.reports = [analysis, appReport]
    const groups = getShownGroups()
    applyOpeningFilters(groups)
    assert.equal(state.filterRevalidate, 'confirmed', 'the new 6 is outside the opening 8–10 range')
    assert.equal(shouldLockConfirmed(groups), false, 'the non-LOW 6–10 coverage check still applies')
  })

  it('restores the dropdown in the report when underlying findings are shown', () => {
    state.currentWorkspace = null
    state.reports = [reports()[1]]
    assert.equal(shouldLockConfirmed(getShownGroups()), true)
    state.revalidationDetailed = true
    assert.equal(shouldLockConfirmed(getShownGroups()), false)
  })
})

describe('workspace App row boundaries', () => {
  it('uses the stamped App flag and merges shared upstream findings in the upstream lens', () => {
    state.workspaceMerges = []
    state.showRevalidation = true
    state.upstreamOnly = false
    state.reports = [
      report('first.json', [source('D', { isUpstream: true }), source('P', { isApp: true })]),
      report('second.json', [source('D', { isUpstream: true }), source('Q', { isApp: true })]),
    ]
    assert.equal(getMergedGroups().length, 2, 'explicit App flags preserve separate contexts')
    state.upstreamOnly = true
    assert.deepEqual(ids(getMergedGroups()), [['D']], 'one upstream row, without duplicate card keys')
    state.upstreamOnly = false
    assert.equal(getMergedGroups().length, 2)
    state.reports = []
  })
  it('retains each App row and its revalidation answer in every report load order', () => {
    const reports = [
      report('first.json', [source('A', { revalidate: 'confirmed', revalidateVerdict: 'Account route.' }), app('P')]),
      report('second.json', [source('A', { revalidate: 'refuted', revalidateVerdict: 'Not exposed by this app.' }), app('Q')]),
      report('source.json', [source('A')]),
    ]
    for (const order of permutations(reports)) {
      const { conflicts, groups } = mergeReportGroups(order)
      assert.equal(groups.length, 3)
      assert.equal(conflicts.size, 0, 'separate App contexts do not conflict')
      assert.equal(groups.find((g) => g.some((f) => f.id === 'P'))[0].revalidate, 'confirmed')
      assert.equal(groups.find((g) => g.some((f) => f.id === 'Q'))[0].revalidate, 'refuted')
      assert.equal(new Set(groups.map(groupKey)).size, 3, 'shared source IDs must not collide as card keys')
      const code = mergeReportGroups(order, { showRevalidation: false })
      assert.deepEqual(ids(code.groups), [['A']])
      assert.equal(reports[2].groups[0][0].revalidate, undefined, 'merging never mutates original copies')
    }
  })

  it('keeps Confirmed as the opening default for separate, judged App rows', () => {
    configureRevalidation(true)
    state.showRevalidation = true
    state.revalidationDetailed = false
    const { groups, conflicts } = mergeReportGroups([
      report('first.json', [source('A', { revalidate: 'confirmed' }), app('P')]),
      report('second.json', [source('A', { revalidate: 'refuted' }), app('Q')]),
    ])
    assert.equal(conflicts.size, 0)
    applyOpeningFilters(groups)
    assert.equal(state.filterRevalidate, 'confirmed')
  })
  it('keeps Confirmed when a source report is fully represented by App inputs', () => {
    configureRevalidation(true)
    state.showRevalidation = true
    state.revalidationDetailed = false
    const sourceReport = report('analysis.json', [source('a')], [source('b')])
    const appReport = report(
      'app.json',
      [{ ...app('A'), revalidateInputs: ['a'] }],
      [{ ...app('B'), revalidateInputs: ['b'] }],
    )
    const { groups } = mergeReportGroups([sourceReport, appReport])
    applyOpeningFilters(groups)
    assert.equal(state.filterRevalidate, 'confirmed')
    state.filterRevalidate = 'confirmed'
    assert.deepEqual(applyFilters(groups).map((g) => g.map((f) => f.id)), [['A'], ['B']])
  })
  it('keeps Confirmed when represented source copies are ruled out by the App report', () => {
    configureRevalidation(true)
    state.showRevalidation = true
    state.revalidationDetailed = false
    const sourceReport = report('analysis.json', [source('a')])
    const appReport = report('app.json', [
      { ...app('A'), revalidateInputs: ['a'] },
      source('a', { revalidate: 'refuted' }),
    ])
    const { groups } = mergeReportGroups([sourceReport, appReport], { hideRuledOut: true })
    applyOpeningFilters(groups)
    assert.equal(state.filterRevalidate, 'confirmed')
  })
  it('keeps Confirmed through the live workspace group projection', () => {
    configureRevalidation(true)
    state.currentWorkspace = 'workspace'
    state.showRevalidation = true
    state.upstreamOnly = false
    state.revalidationDetailed = false
    state.workspaceMerges = []
    state.reports = [
      report('analysis.json', [source('a')]),
      report('app.json', [
        { ...app('A'), revalidateInputs: ['a'] },
        source('a', { revalidate: 'refuted' }),
      ]),
    ]
    const groups = getMergedGroups()
    applyOpeningFilters(groups)
    assert.equal(state.filterRevalidate, 'confirmed')
    assert.equal(shouldLockConfirmed(groups), true)
    state.currentWorkspace = null
    state.reports = []
  })
  it('does not let a source copy block Confirmed when another report ruled out its id', () => {
    configureRevalidation(true)
    state.currentWorkspace = 'workspace'
    state.showRevalidation = true
    state.upstreamOnly = false
    state.revalidationDetailed = false
    state.workspaceMerges = []
    state.reports = [
      report('analysis.json', [source('a')]),
      report('app.json', [app('A'), source('a', { revalidate: 'refuted' })]),
    ]
    const groups = getMergedGroups()
    applyOpeningFilters(groups)
    assert.equal(state.filterRevalidate, 'confirmed')
    state.currentWorkspace = null
    state.reports = []
  })

  it('merges rows sharing an App id, including partial overlap, and records real conflicts', () => {
    const { groups, conflicts } = mergeReportGroups([
      report('first.json', [source('A', { revalidate: 'partial', revalidateVerdict: 'First explanation.' }), app('P')]),
      report('second.json', [source('A', { revalidate: 'partial', revalidateVerdict: 'Second explanation.' }), app('P'), source('B')]),
    ])
    assert.deepEqual(ids(groups), [['A', 'P', 'B']])
    assert.equal(conflicts.size, 1)
    assert.deepEqual(revalidationDifferences(conflicts.get('A').copies), [{
      field: 'revalidateVerdict', variants: [
        { value: 'First explanation.', reports: ['first.json'] },
        { value: 'Second explanation.', reports: ['second.json'] },
      ],
    }])
  })

  it('keeps imported App rows separate even in code mode', () => {
    for (const marker of [{ source: 'codex-security' }, { _source: 'claude-security' }]) {
      const reports = [
        report('first.json', [source('A'), source('P', marker)]),
        report('second.json', [source('A'), source('Q', marker)]),
      ]
      assert.equal(mergeReportGroups(reports).groups.length, 2)
      assert.equal(mergeReportGroups(reports, { showRevalidation: false }).groups.length, 2)
    }
  })

  it('merges source-only rows transitively, without pulling in a row that has an App finding', () => {
    for (const order of permutations([
      report('first.json', [source('A'), source('B')]),
      report('second.json', [source('B'), source('C')]),
      report('third.json', [source('C'), app('P')]),
    ])) {
      const { groups } = mergeReportGroups(order)
      assert.equal(groups.length, 2)
      assert.deepEqual(groups.find((g) => g.some((f) => f.id === 'P')).map((f) => f.id), ['C', 'P'])
      assert.deepEqual(groups.find((g) => !g.some((f) => f.id === 'P')).map((f) => f.id).toSorted(), ['A', 'B', 'C'])
    }
  })

  it('preserves within-report deduplication of rows containing App findings', () => {
    const { groups } = mergeReportGroups([report('same.json', [source('A'), app('P')], [source('A'), app('Q')])])
    assert.deepEqual(ids(groups), [['A', 'P', 'Q']])
  })

  it('splits source rows by complete App revalidation input components in code mode', () => {
    const row = [
      { ...app('A'), revalidateInputs: ['a'] },
      { ...app('B'), revalidateInputs: ['b', 'c'] },
      { ...app('C'), revalidateInputs: ['c', 'd'] },
      { ...app('E') },
      source('a'), source('b'), source('c'), source('d'),
    ]
    const { groups } = mergeReportGroups([report('inputs.json', row)], { showRevalidation: false })
    assert.deepEqual(ids(groups), [['a'], ['b', 'c', 'd']])
  })

  it('keeps the row intact when App inputs do not exactly cover its source findings', () => {
    const row = [
      { ...app('A'), revalidateInputs: ['a'] },
      source('a'), source('unaccounted'),
    ]
    const { groups } = mergeReportGroups([report('incomplete.json', row)], { showRevalidation: false })
    assert.deepEqual(ids(groups), [['a', 'unaccounted']])
  })

  it('applies the same input split before the upstream lens projection', () => {
    const row = [
      { ...app('A'), revalidateInputs: ['a'] },
      { ...app('B'), revalidateInputs: ['b', 'c'] },
      source('a', { isUpstream: true }), source('b', { isUpstream: true }), source('c', { isUpstream: true }),
    ]
    const { groups } = mergeReportGroups([report('upstream-inputs.json', row)], { showRevalidation: false, upstreamOnly: true })
    assert.deepEqual(ids(groups), [['a'], ['b', 'c']])
  })

  it('splits upstream rows using App inputs outside the upstream projection', () => {
    const first = [
      { ...app('A'), revalidateInputs: ['a'] },
      source('a'), source('b', { isUpstream: true }),
    ]
    const second = [
      { ...app('B'), revalidateInputs: ['c'] },
      source('c'), source('d', { isUpstream: true }),
    ]
    const { groups } = mergeReportGroups([
      report('first.json', first),
      report('second.json', second),
    ], { showRevalidation: false, upstreamOnly: true })
    assert.deepEqual(ids(groups), [['b'], ['d']])
  })

  it('keeps row keys and metadata stable through repeated mode switches', () => {
    state.workspaceMerges = []
    state.reports = [
      report('first.json', [source('A', { revalidate: 'confirmed' }), app('P')]),
      report('second.json', [source('A', { revalidate: 'refuted' }), app('Q')]),
    ]
    for (let i = 0; i < 3; i++) {
      state.showRevalidation = true
      const groups = getMergedGroups()
      assert.equal(groups.length, 2)
      for (const g of groups) assert.equal(findGroupById(groupKey(g)), g)
      state.showRevalidation = false
      const code = getMergedGroups()
      assert.deepEqual(ids(code), [['A']])
      assert.deepEqual(groupWithPassRows(code[0]).map((f) => f.id).toSorted(), ['A', 'P', 'Q'])
    }
    state.showRevalidation = true
    state.reports = []
  })
})

describe('workspace conflicts follow App visibility', () => {
  beforeEach(() => {
    state.currentWorkspace = 'workspace'
    state.workspaceMerges = []
    state.showRevalidation = true
    state.upstreamOnly = false
    state.revalidationDetailed = false
    configureRevalidation(true)
  })
  afterEach(() => {
    state.currentWorkspace = null
    state.reports = []
    state.showRevalidation = true
    state.upstreamOnly = false
    state.revalidationDetailed = false
    configureRevalidation(true)
  })
  const upstream = (kind, verdict) => source('D', {
    file: 'node_modules/pkg/auth.js', revalidate: kind, revalidateVerdict: verdict,
  })
  const shapes = [
    { name: 'A: separate App rows', first: [app('P'), upstream('confirmed', 'Reachable.')], second: [app('Q'), upstream('partial', 'Partly reachable.')], visible: [['P'], ['Q']] },
    { name: 'B: two refuted rows', first: [upstream('refuted', 'First reason.')], second: [upstream('refuted', 'Second reason.')], visible: [] },
    { name: 'C: App row and unreachable row', first: [app('P'), upstream('confirmed', 'Reachable.')], second: [upstream('unreachable', 'Not reachable.')], visible: [['P']] },
  ]
  for (const shape of shapes) {
    it(`${shape.name} permits App mode in either load order and merges in source lenses`, () => {
      const reports = [report('first.json', shape.first), report('second.json', shape.second)]
      const original = structuredClone(reports)
      for (const order of permutations(reports)) {
        state.reports = order
        state.showRevalidation = true
        state.upstreamOnly = false
        configureRevalidation(true)
        assert.equal(getRevalidationConflicts().size, 0)
        assert.equal(canDropRevalidation(order), true, 'App switch remains available')
        assert.deepEqual(ids(getMergedGroups().map(sortTabs)).toSorted(), shape.visible.toSorted())
        assert.equal(new Set(getMergedGroups().map(groupKey)).size, getMergedGroups().length)
        for (const upstreamOnly of [false, true]) {
          state.showRevalidation = upstreamOnly
          state.upstreamOnly = upstreamOnly
          configureRevalidation(state.showRevalidation, upstreamOnly)
          const groups = getMergedGroups()
          assert.deepEqual(ids(groups), [['D']])
          assert.ok(groups.flat().every((f) => Object.keys(f).every((key) => !key.startsWith('revalidate'))))
          assert.equal(getRevalidationConflicts().size, 0)
        }
        assert.deepEqual(reports, original, 'source lenses preserve the reports\' original answers')
      }
    })
  }

  it('filters hidden rows before a merge can borrow their fields', () => {
    for (const order of permutations([
      report('visible.json', [source('D', { revalidate: 'confirmed' })]),
      report('hidden.json', [source('D', { revalidate: 'refuted', revalidateVerdict: 'Not reachable here.' })]),
    ])) {
      state.reports = order
      assert.equal(getRevalidationConflicts().size, 0)
      const [[finding]] = getMergedGroups()
      assert.equal(finding.revalidate, 'confirmed')
      assert.equal(finding.revalidateVerdict, undefined, 'hidden prose cannot fill a visible answer')
    }
  })

  it('composes visibility, App separation and ordinary source merging in one workspace', () => {
    const reports = [
      report('first.json', [app('P'), source('D0', { revalidate: 'confirmed' })], [source('D1', { revalidate: 'refuted', revalidateVerdict: 'First reason.' })], [app('R'), source('D2', { revalidate: 'confirmed' })], [source('U'), source('V')]),
      report('second.json', [app('Q'), source('D0', { revalidate: 'partial' })], [source('D1', { revalidate: 'unreachable', revalidateVerdict: 'Second reason.' })], [source('D2', { revalidate: 'unreachable' })], [source('V'), source('W')]),
    ]
    for (const order of permutations(reports)) {
      state.reports = order
      assert.equal(getRevalidationConflicts().size, 0)
      const shown = getMergedGroups().map(sortTabs)
      assert.equal(shown.length, 4)
      assert.deepEqual(shown.filter((g) => g.some((f) => f.isApp)).map((g) => g[0].id).toSorted(), ['P', 'Q', 'R'])
      assert.deepEqual(shown.find((g) => g.some((f) => f.id === 'U')).map((f) => f.id).toSorted(), ['U', 'V', 'W'])
    }
  })

  it('still reports disagreements between visible source rows', () => {
    state.reports = [
      report('first.json', [source('D', { revalidate: 'confirmed', revalidateVerdict: 'First answer.' })]),
      report('second.json', [source('D', { revalidate: 'confirmed', revalidateVerdict: 'Second answer.' })]),
    ]
    assert.equal(getRevalidationConflicts().size, 1)
  })

  it('still checks duplicate answers in the same App row, even if a source tab is folded', () => {
    state.reports = [
      report('first.json', [app('P'), upstream('partial', 'First answer.')]),
      report('second.json', [app('P'), upstream('partial', 'Second answer.')]),
    ]
    assert.equal(getRevalidationConflicts().size, 1)
    assert.deepEqual(ids(getMergedGroups().map(sortTabs)), [['P']])
    state.reports = [
      report('first.json', [{ ...app('P'), revalidateVerdict: 'First app answer.' }]),
      report('second.json', [{ ...app('P'), revalidateVerdict: 'Second app answer.' }]),
    ]
    assert.equal(getRevalidationConflicts().size, 1)
  })

  it('unfolds a workspace row without handing back what the merge ruled out', () => {
    state.reports = [report('first.json', [app('P'), upstream('confirmed', 'Reachable.')], [source('X', { revalidate: 'refuted' })])]
    assert.deepEqual(ids(getMergedGroups().map(sortTabs)), [['P']])
    state.revalidationDetailed = true
    assert.equal(underlyingFindingsShown(), true, 'the detail stop reads the same in a workspace')
    assert.deepEqual(ids(getMergedGroups().map(sortTabs)), [['P', 'D']], 'the folded row comes back, the refuted one stays out of the merge')
    state.currentWorkspace = null
    assert.deepEqual(ids(getMergedGroups().map(sortTabs)), [['P', 'D'], ['X']], 'a single report hands its ruled-out row back too')
  })

  it('retains conflict detection inside an individual report', () => {
    state.currentWorkspace = null
    state.reports = [report('first.json', [upstream('refuted', 'First answer.')], [upstream('unreachable', 'Second answer.')])]
    assert.equal(getRevalidationConflicts().size, 1)
    state.currentWorkspace = 'workspace'
    assert.equal(getRevalidationConflicts().size, 0)
    assert.deepEqual(getMergedGroups(), [])
  })
})

describe('revalidation conflict evidence', () => {
  it('does not replace a real conflict with agreeing copies from a separate App row', () => {
    const { conflicts } = mergeReportGroups([
      report('first.json', [source('A', { revalidate: 'confirmed' }), app('P')]),
      report('second.json', [source('A', { revalidate: 'refuted' }), app('P')]),
      report('separate.json', [source('A', { revalidate: 'partial' }), app('Q')]),
      report('separate-agrees.json', [source('A', { revalidate: 'partial' }), app('Q')]),
    ])
    assert.equal(conflicts.size, 1)
    assert.deepEqual(revalidationDifferences(conflicts.get('A').copies), [{
      field: 'revalidate', variants: [
        { value: 'confirmed', reports: ['first.json'] },
        { value: 'refuted', reports: ['second.json'] },
      ],
    }])
  })

  it('attributes filled gaps to the report supplying them, grouping agreeing copies', () => {
    for (const order of permutations([
      report('unstamped.json', [source('A')]),
      report('first.json', [source('A', { revalidate: 'confirmed', revalidateVerdict: 'Reachable.' })]),
      report('agrees.json', [source('A', { revalidate: ' CONFIRMED ', revalidateVerdict: ' Reachable. ' })]),
      report('other.json', [source('A', { revalidate: 'refuted', revalidateVerdict: 'Not reachable.' })]),
    ])) {
      const { conflicts } = mergeReportGroups(order)
      assert.equal(conflicts.size, 1)
      const differences = revalidationDifferences(conflicts.get('A').copies)
      assert.deepEqual(differences.map((d) => d.field), ['revalidate', 'revalidateVerdict'])
      const confirmed = differences[0].variants.find((v) => v.value === 'confirmed')
      assert.deepEqual(confirmed.reports.toSorted(), ['agrees.json', 'first.json'])
      assert.ok(differences.every((d) => d.variants.every((v) => !v.reports.includes('unstamped.json'))))
    }
  })

  it('does not call missing, normalized or unknown stamps a conflict', () => {
    const { conflicts } = mergeReportGroups([
      report('empty.json', [source('A')]),
      report('typo.json', [source('A', { revalidate: 'confirmeed' })]),
      report('real.json', [source('A', { revalidate: 'confirmed' })]),
      report('same.json', [source('A', { revalidate: ' Confirmed ' })]),
    ])
    assert.equal(conflicts.size, 0)
  })

  it('retains corrected severity variants and source provenance on a real duplicate', () => {
    const { groups } = mergeReportGroups([
      report('first.json', [source('A', { correctedSeverity: 'medium', _source: 'codex-security' })]),
      report('second.json', [source('A', { correctedSeverity: 'low', source: 'claude-security' })]),
    ])
    assert.equal(groups[0][0].source, undefined)
    assert.deepEqual(groups[0][0]._correctedByReport, {
      'first.json': { severity: 'medium', reason: undefined },
      'second.json': { severity: 'low', reason: undefined },
    })
  })
})

const { patchEntry } = await import('../client/index.js')
const { groupState, scopedTriage, syncGroupTriage, triageActionPlan, triageScope } = await import('../ui/view/group.js')

describe('status actions on mixed App/source rows', () => {
  const makeRow = () => report('report.json', [source('A', { file: 'node_modules/pkg/index.js' }), app('P'), source('C', { _source: 'claude-security' }), source('Own')]).groups[0]
  it('disables status buttons on an underlying dependency tab while retaining the row drag scope', () => {
    for (const detailed of [false, true]) {
      for (const action of ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored', 'restore']) {
        state.triage = new Map([['A', { triage: 'invalid' }]])
        state.showRevalidation = true
        state.upstreamOnly = false
        configureRevalidation(true)
        state.revalidationDetailed = detailed
        const row = makeRow()
        state.activeTabByGroup.set(groupKey(row), 'A')
        assert.deepEqual(triageActionPlan(row, action).targets.map((f) => f.id), detailed ? [] : ['P', 'C', 'Own'])
        assert.deepEqual(triageScope(row).map((f) => f.id), ['P', 'C', 'Own'], 'drag still targets the eligible row members')
        for (const active of ['P', 'Own']) {
          state.activeTabByGroup.set(groupKey(row), active)
          assert.deepEqual(triageActionPlan(row, action).targets.map((f) => f.id), ['P', 'C', 'Own'])
        }
      }
    }
  })

  it('uses the report dependency directory and preserves App findings even at dependency paths', () => {
    state.triage = new Map()
    for (const dir of ['node_modules', 'vendor', 'dependencies']) {
      const row = [source('Dependency', { file: `${dir}/pkg/index.js` }), source('Own'), { ...app('App'), file: `${dir}/pkg/index.js` }]
      configureDepsDir([report('report.json', row)])
      assert.deepEqual(triageScope(row).map((f) => f.id), ['Own', 'App'])
    }
  })

  it('keeps own-source findings in the status scope when there are no dependency findings', () => {
    state.triage = new Map()
    const row = [source('Own'), app('App')]
    assert.equal(triageScope(row), row)
  })

  it('respects stamped upstream flags instead of reclassifying paths', () => {
    state.triage = new Map()
    const own = source('Own', { file: 'node_modules/pkg/index.js', isUpstream: false })
    const upstream = source('Dependency', { file: 'src/auth.js', isUpstream: true })
    const appFinding = app('App')
    assert.deepEqual(triageScope([own, upstream, appFinding]), [own, appFinding])
  })

  it('moves the row without changing dependency status, and clears on a repeat click', () => {
    const row = makeRow()
    for (const action of ['inprogress', 'fixed', 'invalid', 'deleted']) {
      state.triage = new Map([['A', { triage: 'deleted', color: 'red' }]])
      state.activeTabByGroup.set(groupKey(row), 'P')
      const plan = triageActionPlan(row, action)
      for (const f of plan.targets) patchEntry(state.triage, f.id, { triage: action })
      assert.equal(groupState(row).commonTriage, action)
      assert.equal(scopedTriage(row), action)
      assert.equal(triageActionPlan(row, action).clearing, true)
      assert.deepEqual(state.triage.get('A'), { triage: 'deleted', color: 'red' })
    }
  })

  it('does not propagate dependency status into the App row when details open', () => {
    const row = makeRow()
    state.triage = new Map([['A', { triage: 'fixed' }]])
    assert.equal(groupState(row).commonTriage, null)
    assert.equal(syncGroupTriage(row), false)
    assert.equal(state.triage.has('P'), false)
    assert.equal(state.triage.has('C'), false)
  })

  it('levels App and own-source members without importing dependency colors or statuses', () => {
    const row = makeRow()
    state.triage = new Map([
      ['A', { triage: 'invalid', color: 'red' }],
      ['P', { triage: 'fixed', color: 'blue' }],
    ])
    assert.equal(groupState(row).hasConflict, false)
    assert.equal(groupState(row).commonTriage, 'fixed')
    assert.equal(syncGroupTriage(row), true)
    assert.equal(state.triage.get('C').triage, 'fixed')
    assert.equal(state.triage.get('Own').triage, 'fixed')
    assert.equal(state.triage.get('A').triage, 'invalid')
  })

  it('counts ignored App members without requiring underlying dependencies to be ignored', () => {
    const row = makeRow().map((f) => ({ ...f, _reportName: 'report.json' }))
    state.triage = new Map([
      ['P', { ignoredReports: ['report.json'] }],
      ['C', { ignoredReports: ['report.json'] }],
      ['Own', { ignoredReports: ['report.json'] }],
    ])
    assert.equal(groupState(row).commonTriage, 'ignored')
    assert.equal(groupState(row).allIgnored, true)
    assert.equal(triageActionPlan(row, 'ignored').clearing, true)
  })

  it('still updates dependency findings after code mode removes the DeepView App findings', () => {
    state.triage = new Map()
    state.showRevalidation = false
    const { groups } = mergeReportGroups([
      report('first.json', [source('A', { file: 'node_modules/pkg/a.js' }), app('P')]),
      report('second.json', [source('A', { file: 'node_modules/pkg/a.js' }), source('B', { file: 'node_modules/pkg/b.js' }), app('Q')]),
    ], { showRevalidation: false })
    assert.deepEqual(triageScope(groups[0]).map((f) => f.id), ['A', 'B'])
    state.showRevalidation = true
  })
})
