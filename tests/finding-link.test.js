// Per-finding deep links (`#finding=<id>[&report=…][&ws=…]`).
//
// Two layers, both headless:
//   * `client/finding-link.js` — the fragment codec. Pins the
//     round-trip (including ids / report names that carry `&`, `=` and
//     spaces), the refusal to link a session-local numeric id, and the
//     rejection rules a hand-mangled fragment has to survive.
//   * `ui/view/finding-link.js` — what a link does to `state`: which
//     group it resolves to, which triage bucket gets shown, when the
//     toolbar filters are cleared (and when they're deliberately left
//     alone), and which member of a dedup group ends up selected.
//
// The DOM half (`ui/view/finding-link-nav.js`) isn't covered here — it
// needs a real document; the rules it depends on all live above.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

// `state.ts` and the client aggregator touch localStorage etc. at
// module-load time.
import './_polyfills.js'

// `ui/view/finding-link.js` → group.js → format.js → frontend-global.js
// throws at module load without the `@rray/frontend` slot; tests don't
// run the boot path that installs it. None of the stubbed symbols is
// called by the helpers under test.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const {
  buildFindingUrl,
  encodeFindingRef,
  extractFindingRef,
  isLinkableFindingId,
} = await import('../client/finding-link.js')

const { state } = await import('../client/state.ts')
const {
  findLoadedFinding,
  findingLinkFor,
  unhideFinding,
} = await import('../ui/view/finding-link.js')

const UUID_A = '1b4e28ba-2fa1-4d3b-a3f5-cc9f2f6d1a77'
const UUID_B = '9f2c1d0e-7a44-4b8e-9c31-0d5e6f7a8b90'
const WS_ID = 'c0ffee00-1111-8222-8333-444455556666'

describe('finding deep links — fragment codec', () => {
  it('rejects ids that would not survive a reload', () => {
    assert.equal(isLinkableFindingId(UUID_A), true)
    // Codex imports use the finding URL as the id — persistent, so
    // linkable, which is why this isn't a uuid-shape test.
    assert.equal(isLinkableFindingId('https://example.com/findings/7'), true)
    // Session-local `_id` fallbacks are handed out by an in-memory
    // counter and re-assigned on every load.
    assert.equal(isLinkableFindingId('42'), false)
    assert.equal(isLinkableFindingId('0'), false)
    assert.equal(isLinkableFindingId(''), false)
    assert.equal(isLinkableFindingId(undefined), false)
    assert.equal(isLinkableFindingId(7), false)
    assert.equal(isLinkableFindingId(`bad${String.fromCodePoint(10)}id`), false)
    assert.equal(isLinkableFindingId('x'.repeat(513)), false)
  })

  it('round-trips id + both location hints', () => {
    const ref = { id: UUID_A, report: 'security-2024.json', workspace: WS_ID }
    const back = extractFindingRef(`#${encodeFindingRef(ref)}`)
    assert.deepEqual(back, { id: UUID_A, report: 'security-2024.json', workspace: WS_ID })
  })

  it('omits absent hints and still parses', () => {
    const encoded = encodeFindingRef({ id: UUID_A })
    assert.equal(encoded, `finding=${UUID_A}`)
    assert.deepEqual(extractFindingRef(`#${encoded}`), {
      id: UUID_A, report: null, workspace: null,
    })
    // Empty-string hints are the shape `findingLinkFor` passes for
    // "unknown", and must not produce `report=`.
    assert.equal(encodeFindingRef({ id: UUID_A, report: '', workspace: '' }), `finding=${UUID_A}`)
  })

  it('survives separators inside the id and the report name', () => {
    // A report name carrying `&` / `=` / `#` / a space would otherwise
    // split into phantom params on the way back.
    const ref = {
      id: 'https://sec.example/f?a=1&b=2#x',
      report: 'audit &2024= final #3.json',
      workspace: WS_ID,
    }
    const encoded = encodeFindingRef(ref)
    assert.ok(!encoded.includes(' '), 'spaces must be percent-encoded')
    assert.deepEqual(extractFindingRef(`#${encoded}`), ref)
  })

  it('refuses to build a link for a session-local id', () => {
    assert.throws(() => encodeFindingRef({ id: '42' }), TypeError)
    assert.throws(() => encodeFindingRef({}), TypeError)
  })

  it('builds a hash-only URL when there is no location (node)', () => {
    // `buildFindingUrl` prefixes origin + pathname in a browser; under
    // node there is no `location`, so it degrades to the fragment.
    assert.equal(buildFindingUrl({ id: UUID_A }), `#finding=${UUID_A}`)
  })

  it('ignores fragments that carry no finding', () => {
    assert.equal(extractFindingRef(''), null)
    assert.equal(extractFindingRef('#'), null)
    assert.equal(extractFindingRef('#share=abcdef'), null)
    assert.equal(extractFindingRef('#some-in-page-anchor'), null)
    assert.equal(extractFindingRef('#finding='), null)
  })

  it('rejects a finding id that fails validation', () => {
    // Session-local id: a link built on one points somewhere else after
    // a reload, so it never resolves rather than mis-resolving.
    assert.equal(extractFindingRef('#finding=42'), null)
    // Truncated percent escape — a chat client mangled the link.
    assert.equal(extractFindingRef('#finding=%'), null)
    assert.equal(extractFindingRef('#finding=%zz'), null)
    assert.equal(extractFindingRef(`#finding=${'x'.repeat(600)}`), null)
  })

  it('drops a malformed hint but keeps the id', () => {
    // The id is what identifies the finding; the hints only speed up
    // finding it, so a broken one must not sink the whole link.
    assert.deepEqual(extractFindingRef(`#finding=${UUID_A}&report=%zz`), {
      id: UUID_A, report: null, workspace: null,
    })
    assert.deepEqual(extractFindingRef(`#finding=${UUID_A}&report=${'x'.repeat(600)}`), {
      id: UUID_A, report: null, workspace: null,
    })
  })

  it('reads the finding param wherever it sits among unknown params', () => {
    assert.deepEqual(extractFindingRef(`#utm=x&finding=${UUID_A}&ws=${WS_ID}&junk`), {
      id: UUID_A, report: null, workspace: WS_ID,
    })
  })
})

// ── view-side resolution ─────────────────────────────────────────────

function makeFinding(id, extra = {}) {
  return {
    id,
    severity: 'high',
    file: `src/${id}.js`,
    description: `desc for ${id}`,
    _reportName: 'security.json',
    ...extra,
  }
}

// Every filter neutralised (the `matchesFilters` pass-through state)
// plus the view/selection fields `unhideFinding` writes.
function reset(groups = []) {
  state.reports = [{ fileName: 'security.json', groups }]
  state.workspaceMerges = []
  state.currentFile = 'security.json'
  state.currentWorkspace = null
  state.currentView = 'findings'
  state.viewMode = 'table'
  state.severityMode = 'corrected'
  state.shownTriage = null
  state.sortBy = 'severity'
  state.tableSelectedGid = null
  state.focusGid = null
  state.kanbanExpandedColumn = null
  state.kanbanPopoverGid = null
  state.activeTabByGroup = new Map()
  state.triage = new Map()
  state.filterSeverities = new Set()
  state.filterColors = new Set()
  state.filterSources = new Set()
  state.filterAnalyzer = ''
  state.filterModel = ''
  state.filterRepo = ''
  state.filterConfMin = 0
  state.filterConfMax = 10
  state.filterInclude = ''
  state.filterIncludeNegate = false
  state.filterComment = ''
  state.filterFix = ''
  state.filterFlagged = ''
}

describe('finding deep links — building a link for a finding', () => {
  beforeEach(() => reset())

  it('carries the finding\'s own report name', () => {
    const url = findingLinkFor(makeFinding(UUID_A, { _reportName: 'codex.json' }))
    assert.deepEqual(extractFindingRef(url), {
      id: UUID_A, report: 'codex.json', workspace: null,
    })
  })

  it('names the workspace too when one is open', () => {
    state.currentWorkspace = WS_ID
    const url = findingLinkFor(makeFinding(UUID_A))
    // Both hints ride along so the link resolves for a recipient who
    // has either the workspace or just the report.
    assert.deepEqual(extractFindingRef(url), {
      id: UUID_A, report: 'security.json', workspace: WS_ID,
    })
  })

  it('offers no link for a session-local finding', () => {
    // No `id` — `tabKey` falls back to the numeric `_id`, which is
    // re-assigned on the next load.
    assert.equal(findingLinkFor({ _id: 12, severity: 'low' }), null)
    assert.equal(findingLinkFor(null), null)
  })
})

describe('finding deep links — locating a linked finding', () => {
  beforeEach(() => reset())

  it('finds a finding in any loaded report', () => {
    const a = makeFinding(UUID_A)
    const b = makeFinding(UUID_B, { _reportName: 'codex.json' })
    state.reports = [
      { fileName: 'security.json', groups: [[a]] },
      { fileName: 'codex.json', groups: [[b]] },
    ]
    assert.equal(findLoadedFinding(UUID_B).finding, b)
    assert.deepEqual(findLoadedFinding(UUID_B).group, [b])
    assert.equal(findLoadedFinding(UUID_A).finding, a)
    assert.equal(findLoadedFinding('nope'), null)
  })

  it('resolves to the MERGED group, not the per-report one', () => {
    // A cross-report dedup hint fuses two groups into the super-group
    // the UI renders; selecting the per-report group would stamp a key
    // no rendered element carries.
    const a = makeFinding(UUID_A)
    const b = makeFinding(UUID_B, { _reportName: 'codex.json' })
    state.reports = [
      { fileName: 'security.json', groups: [[a]] },
      { fileName: 'codex.json', groups: [[b]] },
    ]
    state.workspaceMerges = [new Set([UUID_A, UUID_B])]
    assert.deepEqual(findLoadedFinding(UUID_B).group, [a, b])
  })
})

describe('finding deep links — un-hiding the target', () => {
  beforeEach(() => reset())

  it('leaves another top-level view for the findings list', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.currentView = 'bundles'
    unhideFinding(group, UUID_A)
    assert.equal(state.currentView, 'findings')
  })

  it('switches the triage view to the finding\'s own bucket', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.triage.set(UUID_A, { triage: 'fixed' })
    // The bucket split is an equality test, so a fixed finding is
    // invisible until `shownTriage` matches it.
    unhideFinding(group, UUID_A)
    assert.equal(state.shownTriage, 'fixed')
  })

  it('returns to the live view for an untriaged finding', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.shownTriage = 'deleted'
    unhideFinding(group, UUID_A)
    assert.equal(state.shownTriage, null)
  })

  it('clears a filter that hides the finding, keeping the sort', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.filterInclude = 'something-else'
    state.sortBy = 'confidence-desc'
    unhideFinding(group, UUID_A)
    assert.equal(state.filterInclude, '')
    // `resetFilters` re-derives a default sort for a fresh ingest;
    // arriving via a link is not that.
    assert.equal(state.sortBy, 'confidence-desc')
  })

  it('leaves a filter the finding already passes alone', () => {
    const group = [makeFinding(UUID_A, { severity: 'critical' })]
    reset([group])
    state.filterSeverities = new Set(['critical'])
    unhideFinding(group, UUID_A)
    assert.deepEqual([...state.filterSeverities], ['critical'])
  })

  it('selects the linked member of a multi-finding group', () => {
    const group = [makeFinding(UUID_A), makeFinding(UUID_B)]
    reset([group])
    const gid = unhideFinding(group, UUID_B)
    // Without this the group opens on whichever sibling activeTabFor
    // prefers, and the recipient reads a different finding.
    assert.equal(state.activeTabByGroup.get(gid), UUID_B)
  })

  it('does not pin an active tab on a single-finding group', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    const gid = unhideFinding(group, UUID_A)
    assert.equal(gid, UUID_A)
    assert.equal(state.activeTabByGroup.size, 0)
  })

  it('uses each view mode\'s own selection state', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    unhideFinding(group, UUID_A)
    assert.equal(state.tableSelectedGid, UUID_A)
    assert.equal(state.focusGid, null)

    reset([group])
    state.viewMode = 'focus'
    unhideFinding(group, UUID_A)
    assert.equal(state.focusGid, UUID_A)
    assert.equal(state.tableSelectedGid, null)

    // Grouped / list / kanban have no selection concept — the scroll +
    // flash in the nav module is the whole signal there.
    reset([group])
    state.viewMode = 'grouped'
    unhideFinding(group, UUID_A)
    assert.equal(state.tableSelectedGid, null)
    assert.equal(state.focusGid, null)
  })

  it('collapses a kanban fullscreen column that hides the target', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.viewMode = 'kanban'
    // An expanded column drops every other column from the board, so
    // an untriaged target would land on a card that isn't rendered.
    state.kanbanExpandedColumn = 'fixed'
    state.kanbanPopoverGid = UUID_B
    unhideFinding(group, UUID_A)
    assert.equal(state.kanbanExpandedColumn, null)
    // A modal left open on another finding covers the board.
    assert.equal(state.kanbanPopoverGid, null)
  })

  it('keeps a kanban fullscreen column the target lives in', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.viewMode = 'kanban'
    state.triage.set(UUID_A, { triage: 'fixed' })
    state.kanbanExpandedColumn = 'fixed'
    unhideFinding(group, UUID_A)
    // The target is in the expanded column already — undoing the
    // user's layout would be gratuitous.
    assert.equal(state.kanbanExpandedColumn, 'fixed')
  })

  it('drops out of the graph mode, which has no per-finding card', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.viewMode = 'graph'
    unhideFinding(group, UUID_A)
    assert.equal(state.viewMode, 'table')
    assert.equal(state.tableSelectedGid, UUID_A)
  })
})
