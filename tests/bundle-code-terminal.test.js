import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { createTerminal } from '@preventive/terminal'
import { templateText, templates } from './_lit.js'

// The Code tab's terminal pane: a toggle in its Files rail, and under the code
// panel the Terminal tab's own terminal, closed from the pane.

// The browser loads ui/terminal.js beside view.js, which terminal-attach.js
// imports lazily. Route that import to a stand-in for the terminal element,
// recording what each is handed.
const terminals = []
globalThis.createTestTerminal = (sources, integrity) => {
  const terminal = { sources, integrity, isConnected: false, focused: 0, focusInput() { this.focused++ } }
  terminals.push(terminal)
  return terminal
}
const attachUrl = new URL('../ui/view/terminal-attach.js', import.meta.url).href
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier !== './terminal.js' || context.parentURL !== attachUrl) return nextResolve(specifier, context)
  return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent('export const createTerminalElement = (...args) => globalThis.createTestTerminal(...args)')}` }
} })

// render.js attaches the terminal into the slot the Code tab renders; the
// stand-in does the same into a slot of its own.
let onRender = () => {}
mock.module('../ui/view/render.js', { exports: { render: () => onRender() } })
mock.module('../ui/view/dom.js', { exports: { report: null } })
mock.module('../ui/view/scan-navigation.js', { exports: { canScanBundle: () => false, openScan() {} } })
mock.module('../ui/view/ingest.js', { exports: { bundleKind: () => null } })
mock.module('../ui/view/tooltip.js', { exports: { hideTooltip() {}, installShadowTooltipListener() {}, showTooltip() {} } })
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
mock.module('../ui/view/dialogs/npm-compare-advisories-dialog.js', { exports: { openNpmCompareAdvisoriesDialog() {} } })
mock.module('../ui/view/dialogs/why-dialog.js', { exports: { openWhyDialog() {} } })
mock.module('../ui/view/prism-highlight.js', { exports: { langForPath: () => null, langForTag: () => null, highlight: () => Promise.resolve(null) } })
const { state } = await import('../client/state.ts')
const { renderBundlesList } = await import('../ui/view/render-bundle.js')
const { attachTerminal } = await import('../ui/view/terminal-attach.js')
const { fileRowDetails } = await import('../common/bundle-sources.js')

const toggle = { focused: 0, focus() { this.focused++ } }
globalThis.document = { querySelector: selector => selector === '[data-bundle-code-terminal-toggle]' ? toggle : null }

function slot() {
  return { isConnected: true, children: [], contains(el) { return this.children.includes(el) },
    replaceChildren(el) { el.isConnected = true; this.children = [el] } }
}

// A click handler bound after `marker`: the first `@click=` from the part
// naming it.
function clickAfter(view, marker) {
  const template = templates(view).find(t => t.strings.some(part => part.includes(marker)))
  const from = template.strings.findIndex(part => part.includes(marker))
  return template.values[template.strings.findIndex((part, i) => i >= from && part.trimEnd().endsWith('@click='))]
}

let bundleId = 0
function openBundle(details) {
  const integrity = `sha512-terminal-${++bundleId}`
  const entry = { name: 'test.bundle', integrity }
  state.bundles = [entry]
  state.selectedBundle = integrity
  state.bundleDetails = { ...details, integrity, size: 123 }
  return () => renderBundlesList([entry])
}

beforeEach(() => {
  terminals.length = 0
  toggle.focused = 0
  onRender = () => {}
  state.currentView = 'bundles'
  state.bundleDetailsTab = 'code'
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  state.bundleCodeSearchMode = 'files'
  state.bundleCodeSearchQuery = ''
  state.bundleCodeTerminal = false
  state.triage = new Map()
})

test('the Files rail opens the terminal under the code panel, the same one each time, and its pane closes it', async () => {
  const view = openBundle({ kind: 'sourcemap', json: { version: 3, sources: ['src/a.js', 'src/b.js'], sourcesContent: ['a', 'b'] } })
  const host = slot()
  let attaching = null
  onRender = () => { if (state.bundleCodeTerminal) attaching = attachTerminal(host, state.bundleDetails) }

  const closed = templateText(view())
  const actions = closed.slice(closed.indexOf('bundle-code-rail-actions'))
  assert.ok(actions.indexOf('aria-label="Terminal"') < actions.indexOf('Reveal current file'), 'the toggle comes before the other two')
  assert.ok(actions.indexOf('Reveal current file') < actions.indexOf('Collapse directories'))
  assert.match(closed, /data-bundle-code-terminal-toggle\s+aria-pressed=false/u)
  assert.doesNotMatch(closed, /bundle-terminal-slot/u)

  clickAfter(view(), 'data-bundle-code-terminal-toggle')()
  assert.equal(state.bundleCodeTerminal, true)
  await attaching
  await setImmediate()
  assert.equal(terminals.length, 1)
  assert.deepEqual([...terminals[0].sources.keys()], ['a.js', 'b.js'], 'the files as the tree names them')
  assert.equal(host.children[0], terminals[0])
  assert.equal(terminals[0].focused, 1, 'opening puts the caret on its command line')

  const open = templateText(view())
  assert.match(open, /data-bundle-code-terminal-toggle\s+aria-pressed=true/u)
  // Under the code panel, in the right column.
  assert.ok(open.indexOf('bundle-code-main-body') < open.indexOf('<section class="bundle-code-terminal" aria-label="Terminal">'))
  assert.match(open, /<div id="bundle-terminal-slot" class="bundle-code-terminal-slot"><\/div>/u)

  clickAfter(view(), 'aria-label="Close terminal"')()
  assert.equal(state.bundleCodeTerminal, false)
  assert.equal(toggle.focused, 1, 'closing hands focus back to the toggle')
  assert.doesNotMatch(templateText(view()), /bundle-terminal-slot/u)

  // Reopened, it is the same terminal, its session kept, and focused again.
  host.children = []
  terminals[0].isConnected = false
  clickAfter(view(), 'data-bundle-code-terminal-toggle')()
  await attaching
  await setImmediate()
  assert.equal(terminals.length, 1)
  assert.equal(host.children[0], terminals[0])
  assert.equal(terminals[0].focused, 2)

  // The toggle closes it too.
  clickAfter(view(), 'data-bundle-code-terminal-toggle')()
  assert.equal(state.bundleCodeTerminal, false)
})

test('a file read as its digest alone stays out of the terminal, which would refuse it', async () => {
  const details = fileRowDetails({ integrity: 'sha512-terminal-npm', size: 10 }, [
    ['package/index.js', 1, 'x', 'sha512-text'],
    ['package/lib/a.js', 1, 'y', 'sha512-text'],
    ['package/logo.png', 9, null, 'sha512-binary'],
  ])
  const terminal = await attachTerminal(slot(), details)
  assert.deepEqual([...terminal.sources.keys()], ['index.js', 'lib/a.js'])
  assert.equal((await createTerminal(terminal.sources, { mount: '/sources', home: '/', writable: '/tmp/' }).run('ls /sources')).stdout, 'index.js\nlib\n')
})
