// Per-finding deep links (`#finding=<id>[&report=<hint>][&ws=<hint>]`).
//
// Three layers, all headless:
//   * `client/finding-link.js` — the fragment codec plus the 3-byte
//     location hints. Pins the hint shape / determinism / domain
//     separation, the round-trip, the refusal to link a session-local
//     numeric id, and the rejection rules a hand-mangled fragment has
//     to survive.
//   * `client/finding-locate.js` — turning a hint back into a local
//     report, and the scan that finds the finding in ANOTHER report
//     when no hint matches. Exercised against the real
//     `client/storage.js`, which falls back to gzipped localStorage
//     under node — the same substrate the finding-index tests use.
//   * `ui/view/finding-link.js` — what a link does to `state`: which
//     group it resolves to, which triage bucket gets shown, when the
//     toolbar filters are cleared (and when they're deliberately left
//     alone), and which member of a dedup group ends up selected.
//
// The DOM half (`ui/view/finding-link-nav.js`) isn't covered here — it
// needs a real document; the rules it depends on all live above.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

// `state.ts`, `storage.js` and the client aggregator touch localStorage
// etc. at module-load time.
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
  computeLinkHint,
  encodeFindingRef,
  extractFindingRef,
  isLinkHint,
  isLinkableFindingId,
  knownLinkHint,
} = await import('../client/finding-link.js')

const {
  findReportWithFinding,
  reportForHint,
} = await import('../client/finding-locate.js')

const { saveFile } = await import('../client/storage.js')
const { deriveFindingId } = await import('../common/finding-id.js')

const { state } = await import('../client/state.ts')
const {
  findLoadedFinding,
  findingLinkFor,
  unhideFinding,
} = await import('../ui/view/finding-link.js')

const UUID_A = '1b4e28ba-2fa1-4d3b-a3f5-cc9f2f6d1a77'
const UUID_B = '9f2c1d0e-7a44-4b8e-9c31-0d5e6f7a8b90'
const WS_ID = 'c0ffee00-1111-8222-8333-444455556666'

// Every seeded report gets a unique name: the in-memory storage isn't
// cleared between tests, and `findReportWithFinding` scans everything.
let nameCounter = 0
function uniqueName(stem) {
  nameCounter += 1
  return `${stem}-${nameCounter}.json`
}

describe('finding deep links — location hints', () => {
  it('derives a 4-character base64url token', async () => {
    const hint = await computeLinkHint('report', 'security-2024.json')
    // 3 bytes → exactly 4 base64url chars, no padding.
    assert.equal(hint.length, 4)
    assert.match(hint, /^[\w-]{4}$/u)
    assert.equal(isLinkHint(hint), true)
  })

  it('is deterministic, and different per value', async () => {
    const a = await computeLinkHint('report', 'security-2024.json')
    const again = await computeLinkHint('report', 'security-2024.json')
    const b = await computeLinkHint('report', 'security-2025.json')
    assert.equal(a, again)
    assert.notEqual(a, b)
  })

  it('separates the report and workspace namespaces', async () => {
    // Without domain separation a workspace whose id happened to equal a
    // report's filename would cross-resolve.
    const shared = 'c0ffee00-1111-8222-8333-444455556666'
    const asReport = await computeLinkHint('report', shared)
    const asWorkspace = await computeLinkHint('workspace', shared)
    assert.notEqual(asReport, asWorkspace)
  })

  it('yields null rather than throwing on unusable input', async () => {
    assert.equal(await computeLinkHint('bundle', 'x'), null)
    assert.equal(await computeLinkHint('report', ''), null)
    assert.equal(await computeLinkHint('report', null), null)
  })

  it('memoises so the link builder can read it synchronously', async () => {
    const name = 'not-yet-hashed.json'
    // The Link button copies inside a click handler, where an await
    // would cost the clipboard grant — a cold entry reads as null and
    // the link is simply built without the hint.
    assert.equal(knownLinkHint('report', name), null)
    const hint = await computeLinkHint('report', name)
    assert.equal(knownLinkHint('report', name), hint)
    // Namespaced, like the derivation itself.
    assert.equal(knownLinkHint('workspace', name), null)
  })

  it('rejects anything that is not a token shape', () => {
    assert.equal(isLinkHint('abc'), false)
    assert.equal(isLinkHint('abcde'), false)
    assert.equal(isLinkHint('ab+d'), false)
    assert.equal(isLinkHint('security.json'), false)
    assert.equal(isLinkHint(null), false)
  })
})

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

  it('round-trips id + both hint tokens', () => {
    const ref = { id: UUID_A, report: 'aB3-', workspace: 'x_9Z' }
    const back = extractFindingRef(`#${encodeFindingRef(ref)}`)
    assert.deepEqual(back, ref)
  })

  it('omits absent hints and still parses', () => {
    const encoded = encodeFindingRef({ id: UUID_A })
    assert.equal(encoded, `finding=${UUID_A}`)
    assert.deepEqual(extractFindingRef(`#${encoded}`), {
      id: UUID_A, report: null, workspace: null,
    })
    // null / '' are the shapes `findingLinkFor` passes for "not hashed
    // yet"; they must not produce an empty `report=`.
    assert.equal(encodeFindingRef({ id: UUID_A, report: null, workspace: '' }), `finding=${UUID_A}`)
  })

  it('refuses a plaintext name where a hint token belongs', () => {
    // The whole point of the tokens is that names never reach the URL;
    // a caller passing one should fail loudly, not ship a link that
    // silently lost its hint.
    assert.throws(() => encodeFindingRef({ id: UUID_A, report: 'security.json' }), TypeError)
    assert.throws(() => encodeFindingRef({ id: UUID_A, workspace: WS_ID }), TypeError)
  })

  it('survives separators inside the id', () => {
    // A codex finding-URL id carrying `&` / `=` / `#` would otherwise
    // split into phantom params on the way back.
    const ref = { id: 'https://sec.example/f?a=1&b=2#x', report: 'aB3-', workspace: null }
    const encoded = encodeFindingRef(ref)
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
    // finding it (the scan is the real backstop), so a broken one must
    // not sink the whole link. This also covers a link from an older
    // build that spelled the hints out as names.
    for (const bad of ['%zz', 'security.json', 'toolong', 'ab']) {
      assert.deepEqual(extractFindingRef(`#finding=${UUID_A}&report=${bad}`), {
        id: UUID_A, report: null, workspace: null,
      })
    }
  })

  it('reads the finding param wherever it sits among unknown params', () => {
    assert.deepEqual(extractFindingRef(`#utm=x&finding=${UUID_A}&ws=x_9Z&junk`), {
      id: UUID_A, report: null, workspace: 'x_9Z',
    })
  })
})

// ── locating a finding in local storage ──────────────────────────────

describe('finding deep links — finding a report by hint or by scan', () => {
  it('matches a stored report by its hint token', async () => {
    const name = uniqueName('hinted')
    await saveFile(name, JSON.stringify({ findings: [] }))
    const hint = await computeLinkHint('report', name)
    assert.equal(await reportForHint(hint), name)
    // A hint for a name this user doesn't hold matches nothing — which
    // is exactly when the scan takes over.
    assert.equal(await reportForHint(await computeLinkHint('report', 'absent.json')), null)
    assert.equal(await reportForHint(null), null)
  })

  it('finds the report holding a finding id', async () => {
    const id = crypto.randomUUID()
    const other = uniqueName('other')
    const holder = uniqueName('holder')
    await saveFile(other, JSON.stringify({ findings: [{ id: crypto.randomUUID(), severity: 'low' }] }))
    await saveFile(holder, JSON.stringify({ findings: [{ id, severity: 'high' }] }))
    assert.equal(await findReportWithFinding(id), holder)
    assert.equal(await findReportWithFinding(crypto.randomUUID()), null)
  })

  it('looks inside dedup groups', async () => {
    const id = crypto.randomUUID()
    const name = uniqueName('grouped')
    // A report entry is either a single finding or a pre-grouped array.
    await saveFile(name, JSON.stringify({
      findings: [[{ id: crypto.randomUUID(), severity: 'low' }, { id, severity: 'high' }]],
    }))
    assert.equal(await findReportWithFinding(id), name)
  })

  it('derives ids for findings that carry none', async () => {
    // Markdown / DeepSec imports have no exporter-stamped id; the id in
    // the link was derived at ingest, so the scan has to derive too or
    // it would never match those reports.
    const finding = { severity: 'high', description: 'unstamped finding', file: 'src/a.js', line: 3 }
    const derived = await deriveFindingId(finding)
    const name = uniqueName('unstamped')
    await saveFile(name, JSON.stringify({ findings: [finding] }))
    assert.equal(await findReportWithFinding(derived), name)
  })

  it('skips reports the caller already searched in memory', async () => {
    const id = crypto.randomUUID()
    const name = uniqueName('loaded')
    await saveFile(name, JSON.stringify({ findings: [{ id, severity: 'high' }] }))
    assert.equal(await findReportWithFinding(id, { skip: [name] }), null)
    assert.equal(await findReportWithFinding(id), name)
  })

  it('keeps scanning past an unparseable report', async () => {
    const id = crypto.randomUUID()
    // `parseReport` returns undefined for content no parser claims, and
    // a `findings` field that isn't an array must not throw — one bad
    // file on disk can't be allowed to hide every other report.
    await saveFile(uniqueName('broken'), '{"findings": 7}')
    const holder = uniqueName('after-broken')
    await saveFile(holder, JSON.stringify({ findings: [{ id, severity: 'high' }] }))
    assert.equal(await findReportWithFinding(id), holder)
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

  it('carries the hint for the finding\'s own report', async () => {
    const reportName = uniqueName('linked')
    const hint = await computeLinkHint('report', reportName)
    const url = findingLinkFor(makeFinding(UUID_A, { _reportName: reportName }))
    assert.deepEqual(extractFindingRef(url), { id: UUID_A, report: hint, workspace: null })
    // The name itself never reaches the URL.
    assert.ok(!url.includes(reportName))
  })

  it('hints at the workspace too when one is open', async () => {
    state.currentWorkspace = WS_ID
    const reportHint = await computeLinkHint('report', 'security.json')
    const wsHint = await computeLinkHint('workspace', WS_ID)
    const url = findingLinkFor(makeFinding(UUID_A))
    // Both hints ride along so the link resolves for a recipient who
    // has either the workspace or just the report.
    assert.deepEqual(extractFindingRef(url), {
      id: UUID_A, report: reportHint, workspace: wsHint,
    })
    assert.ok(!url.includes(WS_ID))
  })

  it('still builds a usable link before the hint is hashed', () => {
    // Ingest primes the memo, but a report that arrived by some other
    // path just yields a hint-less link — the receiver's scan finds it.
    const url = findingLinkFor(makeFinding(UUID_A, { _reportName: 'never-primed.json' }))
    assert.deepEqual(extractFindingRef(url), { id: UUID_A, report: null, workspace: null })
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
