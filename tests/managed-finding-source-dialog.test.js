import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { managedAppState } from '../ui/managed/state.js'
import { clearReportSources, fetchReportSources, readReportSources } from '../ui/managed/report-sources.js'

// Exercise the real dialog controller and shared loader without a browser.
// Browser verification covers native modal stacking, focus, and code scrolling.
class TestDialog {
  static styles = []
  isConnected = true
  updateComplete = Promise.resolve()
  renderRoot = { querySelector: () => null, querySelectorAll: () => [] }
  _finish() { this._settled = true; this.isConnected = false; this.disconnectedCallback() }
  _onClose = () => this._finish(null)
  disconnectedCallback() {}
}
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog: () => {} } })
mock.module('../ui/view/client-managed.js', { namedExports: { fetchReportSources, readReportSources } })
mock.module('../ui/view/format.js', { namedExports: { lineRange: () => ({ start: 80, end: 85 }) } })
let highlighting
mock.module('../ui/view/prism-highlight.js', { namedExports: {
  langForPath: () => 'javascript', highlight: content => highlighting?.promise ?? Promise.resolve(content),
} })
await import('../ui/view/dialogs/finding-source-dialog.js')
const Dialog = customElements.get('finding-source-dialog')
const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
let calls, responseGate
beforeEach(t => {
  managedAppState.reset(); managedAppState.setSession({ id: 'alice', role: 'view' })
  calls = 0; responseGate = null; highlighting = null
  t.mock.method(managedAppState, 'notify', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (responseGate) await responseGate.promise
    return Response.json({ integrity: 'bundle', files: [['src/main.js', content]], paths: [['main.js', 'src/main.js']] })
  })
})
function dialog() { return Object.assign(new Dialog(), { reportId: 'report', file: 'main.js', line: '80-85' }) }

test('the popup resolves the full file and reuses report source memory across opens', async () => {
  const first = dialog()
  await first._load()
  assert.equal(first._path, 'src/main.js')
  assert.equal(first._content, content, 'keep every line, including those outside the citation')
  assert.equal(first._loading, false)
  first._finish(null)
  assert.equal(first._content, null)
  const second = dialog()
  await second._load()
  assert.equal(second._content, content)
  assert.equal(calls, 1)
  second._finish(null)
})

async function checkReset(reset) {
  highlighting = Promise.withResolvers()
  const view = dialog()
  const loading = view._load()
  await setImmediate()
  assert.equal(view._content, content)
  reset()
  assert.equal(view._settled, true)
  assert.equal(view._content, null)
  highlighting.resolve('stale highlighted code')
  await loading
  assert.equal(view._highlighted, null)
}
for (const [name, reset] of [['session reset', () => managedAppState.reset()], ['report reload', clearReportSources]]) {
  test(`${name} closes the popup and discards its file and pending highlighting`, () => checkReset(reset))
}

test('closing while loading does not reopen the popup or cancel the shared source request', async () => {
  responseGate = Promise.withResolvers()
  const view = dialog()
  const loading = view._load()
  view._finish(null)
  responseGate.resolve()
  await loading
  assert.equal(view._content, null)
  assert.equal(readReportSources('report').data.sources.get('src/main.js'), content)
})

test('a reset during loading discards the stale response and closes the popup', async () => {
  responseGate = Promise.withResolvers()
  const view = dialog()
  const loading = view._load()
  managedAppState.reset()
  responseGate.resolve()
  await loading
  assert.equal(view._settled, true)
  assert.equal(view._content, null)
})

test('missing sources and cached failures keep the unavailable popup open without refetching', async t => {
  for (const status of [204, 503]) {
    clearReportSources()
    const fetch = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status })))
    for (let open = 0; open < 2; open++) {
      const view = dialog()
      await view._load()
      assert.equal(view._content, null)
      assert.equal(view._loading, false)
      assert.ok(!view._settled, 'Source unavailable must stay visible on every open')
      view._finish(null)
    }
    assert.equal(fetch.mock.callCount(), 1)
  }
})

for (const [name, reset] of [
  ['logout', () => managedAppState.setSession(null)],
  ['role change', () => managedAppState.setSession({ id: 'alice', role: 'none' })],
  ['mode change', () => managedAppState.reset()],
  ['report reload', clearReportSources],
]) {
  test(`${name} closes both a newly failed popup and one opened from a cached failure`, async t => {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 503 })))
    const first = dialog()
    await first._load()
    const cached = dialog()
    await cached._load()
    assert.ok(!first._settled && !cached._settled)
    reset()
    assert.equal(first._settled, true)
    assert.equal(cached._settled, true)
  })
}
