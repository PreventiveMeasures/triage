// Per-finding deep links (`#finding=<id>[&v=<hints>]`).
//
// Three layers, all headless:
//   * `client/finding-link.js` — the fragment codec plus the 3-byte
//     location hints. Pins the hint shape / determinism / domain
//     separation, the 6-byte packing behind `v=`, the round-trip, the
//     refusal to link a session-local numeric id, and the rejection
//     rules a hand-mangled fragment has to survive.
//   * `client/finding-locate.js` — turning half a hint pair back into
//     a local report, and the scan that finds the finding in ANOTHER report
//     when no hint matches. Exercised against the real
//     `client/storage.js`, which falls back to gzipped localStorage
//     under node — the same substrate the finding-index tests use.
//   * `ui/view/finding-link.js` — what a link does to `state`: which
//     group it resolves to, when the toolbar filters are cleared (and
//     when they're deliberately left alone), which member of a dedup
//     group ends up selected, and which triage bucket ends up on
//     screen — the split is exclusive, so a link has to bring its own.
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
const { upsertWorkspace } = await import('../client/workspaces.js')
const { decodeReportLocation, encodeReportLocation } = await import('../client/report-location.js')
const { getItem: getSecureItem, setItem: setSecureItem, hydrate: hydrateSecureStorage } = await import('../client/secure-storage.js')
const { locateLinkedFinding } = await import('../ui/view/finding-link-route.js')
const { deriveFindingId } = await import('../report/index.js')

const { state } = await import('../client/state.ts')
const {
  findLoadedFinding,
  findingLinkFor,
  reportWorkspaceFor,
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

  it('packs both hints into one 6-byte `v=` value', () => {
    const report = 'aB3-'
    const workspace = 'x_9Z'
    // 3 bytes is exactly one base64 group, so the 8 characters really
    // are the base64 of the 6-byte buffer — not just two tokens glued
    // together. Pinned because the unpacking is a plain slice, which is
    // only correct while that holds.
    const bytes = new Uint8Array(6)
    bytes.set(Uint8Array.fromBase64(report, { alphabet: 'base64url' }), 0)
    bytes.set(Uint8Array.fromBase64(workspace, { alphabet: 'base64url' }), 3)
    const packed = bytes.toBase64({ alphabet: 'base64url', omitPadding: true })
    assert.equal(packed.length, 8)
    assert.equal(encodeFindingRef({ id: UUID_A, report, workspace }), `finding=${UUID_A}&v=${packed}`)
  })

  it('keeps report links unchanged and shortens workspace links', () => {
    for (const ref of [
      { id: UUID_A, report: 'aB3-', workspace: null },
      { id: UUID_A, report: null, workspace: 'x_9Z' },
    ]) {
      const encoded = encodeFindingRef(ref)
      assert.equal(encoded, `finding=${UUID_A}&v=${ref.report ? 'aB3-AAAA' : 'wx_9Z'}`)
      assert.deepEqual(extractFindingRef(`#${encoded}`), ref)
    }
  })

  it('keeps the whole fragment short', () => {
    // The reason `v=` exists: two named params spent 20 characters
    // (`&report=aB3-&ws=x_9Z`) to carry 8 characters of payload.
    assert.equal(
      buildFindingUrl({ id: UUID_A, report: 'aB3-', workspace: 'x_9Z' }),
      `#finding=${UUID_A}&v=aB3-x_9Z`,
    )
  })

  it('omits absent hints and still parses', () => {
    const encoded = encodeFindingRef({ id: UUID_A })
    assert.equal(encoded, `finding=${UUID_A}`)
    assert.deepEqual(extractFindingRef(`#${encoded}`), {
      id: UUID_A, report: null, workspace: null,
    })
    // null / '' are the shapes `findingLinkFor` passes for "not hashed
    // yet"; with neither half known, `v=` is dropped entirely rather
    // than shipping eight characters of filler.
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
    // not sink the whole link.
    for (const bad of ['%zz', 'security.json', 'toolong', 'aB3', 'aB3-', 'xaB3-', 'WaB3-', 'waB3', 'waB3-0', 'waB3!', 'aB3-x_9ZAQ']) {
      assert.deepEqual(extractFindingRef(`#finding=${UUID_A}&v=${bad}`), {
        id: UUID_A, report: null, workspace: null,
      })
    }
  })

  it('reads a link from the two-param era as hint-less', () => {
    // Older builds spelled the hints out as `report=` / `ws=`. Those
    // params simply go unread now — the id still resolves, via the scan.
    assert.deepEqual(extractFindingRef(`#finding=${UUID_A}&report=aB3-&ws=x_9Z`), {
      id: UUID_A, report: null, workspace: null,
    })
  })

  it('reads the finding param wherever it sits among unknown params', () => {
    assert.deepEqual(extractFindingRef(`#utm=x&finding=${UUID_A}&v=AAAAx_9Z&junk`), {
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
  state.currentReportWorkspace = null
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
  state.showRevalidation = true
  state.revalidationDetailed = false
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

  it('copies only the workspace location when its combined findings are open', async () => {
    state.currentWorkspace = WS_ID
    await computeLinkHint('report', 'security.json')
    const wsHint = await computeLinkHint('workspace', WS_ID)
    const url = findingLinkFor(makeFinding(UUID_A))
    assert.deepEqual(extractFindingRef(url), {
      id: UUID_A, report: null, workspace: wsHint,
    })
    assert.equal(url, `#finding=${UUID_A}&v=w${wsHint}`)
    assert.ok(!url.includes(WS_ID))
  })

  it('copies the report and its parent workspace with the original eight-character format', async () => {
    const name = uniqueName('workspace-report')
    await upsertWorkspace({ id: 'report-parent', name: 'Parent', reports: [name] })
    const reportHint = await computeLinkHint('report', name)
    const wsHint = await computeLinkHint('workspace', 'report-parent')
    state.currentFile = name
    const url = findingLinkFor(makeFinding(UUID_A, { _reportName: name }))
    assert.equal(url, `#finding=${UUID_A}&v=${reportHint}${wsHint}`)
  })

  it('uses the selected parent when a report belongs to several workspaces', async () => {
    const name = uniqueName('shared-report')
    await upsertWorkspace({ id: 'parent-one', name: 'One', reports: [name] })
    await upsertWorkspace({ id: 'parent-two', name: 'Two', reports: [name] })
    assert.equal(reportWorkspaceFor(name), null)
    state.currentReportWorkspace = 'parent-two'
    assert.equal(reportWorkspaceFor(name), 'parent-two')
    const reportHint = await computeLinkHint('report', name)
    const wsHint = await computeLinkHint('workspace', 'parent-two')
    assert.equal(findingLinkFor(makeFinding(UUID_A, { _reportName: name })),
      `#finding=${UUID_A}&v=${reportHint}${wsHint}`)
    // A moved report must not retain a stale parent in the next link.
    await upsertWorkspace({ id: 'parent-two', name: 'Two', reports: [] })
    assert.equal(reportWorkspaceFor(name), 'parent-one')
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

describe('finding deep links — restoring a report and its parent', () => {
  beforeEach(() => reset())

  it('keeps the selected parent and link after a cold storage restore', async () => {
    const name = uniqueName('restored-shared')
    await upsertWorkspace({ id: 'restore-first', name: 'First', reports: [name] })
    await upsertWorkspace({ id: 'restore-second', name: 'Second', reports: [name] })
    state.currentFile = name
    state.currentReportWorkspace = 'restore-second'
    const reportHint = await computeLinkHint('report', name)
    const workspaceHint = await computeLinkHint('workspace', 'restore-second')
    await setSecureItem('deepview.lastFile', encodeReportLocation(name, state.currentReportWorkspace))

    // Reload loses all in-memory selection; only persisted metadata
    // can identify which of the two otherwise equal sidebar rows won.
    reset()
    await hydrateSecureStorage()
    const saved = decodeReportLocation(getSecureItem('deepview.lastFile'))
    state.currentFile = saved.name
    state.currentReportWorkspace = reportWorkspaceFor(saved.name, saved.workspaceId)
    assert.equal(state.currentFile, name)
    assert.equal(state.currentReportWorkspace, 'restore-second')
    assert.equal(reportWorkspaceFor(name), 'restore-second')
    assert.equal(findingLinkFor(makeFinding(UUID_A, { _reportName: name })),
      `#finding=${UUID_A}&v=${reportHint}${workspaceHint}`)
  })

  it('revalidates a saved parent that no longer holds the report', async () => {
    const name = uniqueName('restored-moved')
    await upsertWorkspace({ id: 'restore-remaining', name: 'Remaining', reports: [name] })
    const saved = decodeReportLocation(encodeReportLocation(name, 'removed-parent'))
    assert.equal(reportWorkspaceFor(saved.name, saved.workspaceId), 'restore-remaining')
    await upsertWorkspace({ id: 'restore-another', name: 'Another', reports: [name] })
    assert.equal(reportWorkspaceFor(saved.name, saved.workspaceId), null)
  })

  it('still restores old plain filenames and reports without a workspace', () => {
    const name = 'standalone report.json'
    assert.equal(encodeReportLocation(name, null), name)
    assert.deepEqual(decodeReportLocation(name), { name, workspaceId: null })
    assert.equal(decodeReportLocation(null), null)
  })

  it('round-trips punctuation and ignores malformed parent metadata', () => {
    const name = 'security "quoted": report.json'
    assert.deepEqual(decodeReportLocation(encodeReportLocation(name, 'parent-id')),
      { name, workspaceId: 'parent-id' })
    for (const value of ['r:notes.json', 'r:null', 'r:{"name":"x","workspaceId":42}']) {
      assert.deepEqual(decodeReportLocation(value), { name: value, workspaceId: null })
    }
  })
})

describe('finding deep links — workspace/report navigation', () => {
  let calls, navigation, reportHint, reportName, siblingName, workspaceHint, workspaceId

  beforeEach(async () => {
    reset()
    reportName = uniqueName('route-report')
    siblingName = uniqueName('route-sibling')
    workspaceId = `workspace-${reportName}`
    for (const name of [reportName, siblingName]) {
      await saveFile(name, JSON.stringify({ findings: [makeFinding(UUID_A, { _reportName: name })] }))
    }
    await upsertWorkspace({ id: workspaceId, name: 'Link target', reports: [reportName, siblingName] })
    reportHint = await computeLinkHint('report', reportName)
    workspaceHint = await computeLinkHint('workspace', workspaceId)
    calls = []
    navigation = {
      openReport(name, _content, { workspaceId: parent }) {
        calls.push(['report', name, parent])
        state.currentFile = name
        state.currentWorkspace = null
        state.currentReportWorkspace = parent
        state.reports = [{ fileName: name, groups: [[makeFinding(UUID_A, { _reportName: name })]] }]
      },
      openWorkspace(id) {
        calls.push(['workspace', id])
        state.currentFile = null
        state.currentWorkspace = id
        state.currentReportWorkspace = null
        // The workspace's deduplicated copy came from the sibling.
        state.reports = [{ fileName: siblingName, groups: [[makeFinding(UUID_A, { _reportName: siblingName })]] }]
      },
    }
  })

  it('opens the named report even when the workspace already shows the finding', async () => {
    await navigation.openWorkspace(workspaceId)
    calls.length = 0
    const hit = await locateLinkedFinding({ id: UUID_A, report: reportHint, workspace: workspaceHint }, navigation)
    assert.deepEqual(calls, [['report', reportName, workspaceId]])
    assert.equal(hit.finding._reportName, reportName)
  })

  it('opens the workspace even when its report already shows the finding', async () => {
    await navigation.openReport(reportName, undefined, { workspaceId })
    calls.length = 0
    const hit = await locateLinkedFinding({ id: UUID_A, report: null, workspace: workspaceHint }, navigation)
    assert.deepEqual(calls, [['workspace', workspaceId]])
    assert.equal(hit.finding._reportName, siblingName)
  })

  it('opens a report directly on a cold load and retains its workspace parent', async () => {
    state.reports = []
    const hit = await locateLinkedFinding({ id: UUID_A, report: reportHint, workspace: workspaceHint }, navigation)
    assert.deepEqual(calls, [['report', reportName, workspaceId]])
    assert.equal(hit.finding.id, UUID_A)
  })

  it('does not promote an old report-only link to the merged workspace', async () => {
    await locateLinkedFinding({ id: UUID_A, report: reportHint, workspace: null }, navigation)
    assert.deepEqual(calls, [['report', reportName, workspaceId]])
  })

  it('selects the hinted parent when the report is already open in another workspace', async () => {
    await upsertWorkspace({ id: 'another-parent', name: 'Another', reports: [reportName] })
    await navigation.openReport(reportName, undefined, { workspaceId: 'another-parent' })
    calls.length = 0
    await locateLinkedFinding({ id: UUID_A, report: reportHint, workspace: workspaceHint }, navigation)
    assert.deepEqual(calls, [['report', reportName, workspaceId]])
  })

  it('does not reload a finding already in the requested context', async () => {
    await navigation.openReport(reportName, undefined, { workspaceId })
    calls.length = 0
    assert.ok(await locateLinkedFinding({ id: UUID_A, report: reportHint, workspace: workspaceHint }, navigation))
    assert.deepEqual(calls, [])
  })

  it('falls back to a locally stored report when the workspace is unavailable', async () => {
    state.reports = []
    const missingWorkspace = await computeLinkHint('workspace', 'not-joined')
    const hit = await locateLinkedFinding({ id: UUID_A, report: null, workspace: missingWorkspace }, navigation)
    assert.ok(hit)
    assert.equal(calls[0][0], 'report')
  })

  it('preserves the viewer\'s display mode in both directions', async () => {
    for (const mode of ['kanban', 'focus', 'table', 'list', 'grouped']) {
      state.viewMode = mode
      await locateLinkedFinding({ id: UUID_A, report: reportHint, workspace: workspaceHint }, navigation)
      assert.equal(state.viewMode, mode)
      await locateLinkedFinding({ id: UUID_A, report: null, workspace: workspaceHint }, navigation)
      assert.equal(state.viewMode, mode)
    }
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

  it('shows the bucket the target is in, in both directions', () => {
    // The bucket split is EXCLUSIVE, so a finding in a bucket the
    // reader isn't viewing isn't merely un-scrolled-to: it isn't
    // rendered, and the focus mode then centres whatever WAS rendered.
    // A link handing over the wrong finding is worse than one moving
    // the bucket selector, so the target's bucket is adopted.
    //
    // Live view, link to a fixed finding.
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.triage.set(UUID_A, { triage: 'fixed' })
    unhideFinding(group, UUID_A)
    assert.equal(state.shownTriage, 'fixed')

    // And back: browsing a bucket, link to an untriaged finding. Both
    // fields are the same shape, so the live list is a plain `null`.
    reset([group])
    state.shownTriage = 'deleted'
    unhideFinding(group, UUID_A)
    assert.equal(state.shownTriage, null)
  })

  it('leaves the bucket alone when the target is already in it', () => {
    // The common case, and the reason the assignment is guarded on
    // inequality: an equal write would still wake every autorun that
    // reads the field.
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.triage.set(UUID_A, { triage: 'inprogress' })
    state.shownTriage = 'inprogress'
    unhideFinding(group, UUID_A)
    assert.equal(state.shownTriage, 'inprogress')
  })

  it('leaves the bucket alone in kanban, which renders them all', () => {
    // Every bucket is a column there, so `shownTriage` doesn't decide
    // what the board holds and repartitioning it would be pure damage
    // to the view the reader returns to.
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.viewMode = 'kanban'
    state.shownTriage = 'deleted'
    state.triage.set(UUID_A, { triage: 'fixed' })
    unhideFinding(group, UUID_A)
    assert.equal(state.shownTriage, 'deleted')
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

  it('unfolds a target the app view was speaking for', () => {
    // The simplified app view draws a re-examined group as the pass's
    // row alone (group.js drawnTabs), so a link to one of the rows it
    // re-rated would open the card on the pass's row — the wrong
    // finding, which is what every other clause here exists to
    // prevent. Detail comes on, like a filter that excluded the
    // target being cleared.
    const group = [makeFinding(UUID_A, { revalidate: 'revalidation' }), makeFinding(UUID_B)]
    reset([group])
    const gid = unhideFinding(group, UUID_B)
    assert.equal(state.revalidationDetailed, true)
    assert.equal(state.activeTabByGroup.get(gid), UUID_B)
  })

  it('leaves the app view folded for a target it was already showing', () => {
    const group = [makeFinding(UUID_A, { revalidate: 'revalidation' }), makeFinding(UUID_B)]
    reset([group])
    unhideFinding(group, UUID_A)
    assert.equal(state.revalidationDetailed, false)
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

    // Kanban opens the detail modal: a board card is a title and a
    // badge, not what someone following a link came to read.
    reset([group])
    state.viewMode = 'kanban'
    unhideFinding(group, UUID_A)
    assert.equal(state.kanbanPopoverGid, UUID_A)

    // A modal left open on some OTHER finding is replaced, not just
    // dismissed — same card-to-card swap a click on that card does.
    reset([group])
    state.viewMode = 'kanban'
    state.kanbanPopoverGid = UUID_B
    unhideFinding(group, UUID_A)
    assert.equal(state.kanbanPopoverGid, UUID_A)

    // Grouped / list have no selection concept — the scroll + flash in
    // the nav module is the whole signal there.
    reset([group])
    state.viewMode = 'grouped'
    unhideFinding(group, UUID_A)
    assert.equal(state.tableSelectedGid, null)
    assert.equal(state.focusGid, null)
    assert.equal(state.kanbanPopoverGid, null)
  })

  it('collapses a kanban fullscreen column that hides the target', () => {
    const group = [makeFinding(UUID_A)]
    reset([group])
    state.viewMode = 'kanban'
    // An expanded column drops every other column from the board, so
    // an untriaged target would land on a card that isn't rendered.
    state.kanbanExpandedColumn = 'fixed'
    unhideFinding(group, UUID_A)
    assert.equal(state.kanbanExpandedColumn, null)
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
    assert.equal(state.kanbanPopoverGid, UUID_A)
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
