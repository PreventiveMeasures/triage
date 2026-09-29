import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// Keep the real modal completion logic; only stub its document-level imports.
mock.module('../ui/view/dom.js', { namedExports: { makeStackedModalError: cause => new Error('Modal conflict', { cause }) } })
mock.module('../ui/view/tooltip.js', { namedExports: { installShadowTooltipListener() {} } })
for (const name of ['delete-report', 'delete-bundle', 'detach-report', 'detach-bundle']) {
  await import(`../ui/view/dialogs/${name}-dialog.js`)
}

function createDialog(name) {
  const Dialog = customElements.get(`${name}-dialog`)
  const dialog = new Dialog()
  const results = []
  let focused = false
  let closes = 0
  dialog.renderRoot = {
    querySelector(selector) {
      if (selector === 'button[data-role="cancel"]') return { focus() { focused = true } }
      if (selector === 'dialog') return { close() { closes++; dialog._onClose() } }
      assert.fail(`Unexpected selector: ${selector}`)
    },
  }
  dialog.dispatchEvent = event => { results.push(event.detail); return true }
  return { dialog, results, focused: () => focused, closes: () => closes }
}

test('delete and detach prompts focus Cancel and settle once for every completion path', () => {
  for (const name of ['delete-report', 'delete-bundle', 'detach-report', 'detach-bundle']) {
    for (const action of ['_onConfirm', '_onCancel', '_onClose']) {
      const view = createDialog(name)
      view.dialog.focusInitial()
      assert.equal(view.focused(), true)
      view.dialog[action]()
      view.dialog._onConfirm()
      view.dialog._onCancel()
      assert.equal(view.closes(), 1, `${name}: native close must not settle again`)
      assert.deepEqual(view.results, [{ confirmed: action === '_onConfirm', ...(name === 'delete-report' ? { triage: 'keep' } : {}) }])
    }
  }
})

test('report deletion preserves the orphaned-triage choice on confirm and cancel', () => {
  for (const orphaned of [0, 2]) {
    for (const triage of ['keep', 'wipe']) {
      for (const confirmed of [false, true]) {
        const { dialog, results } = createDialog('delete-report')
        dialog.orphanedTriage = orphaned
        dialog._onTriageChange({ target: { value: triage } })
        dialog._finish(confirmed)
        assert.deepEqual(results, [{ confirmed, triage: orphaned > 0 ? triage : 'keep' }])
      }
    }
  }
})
