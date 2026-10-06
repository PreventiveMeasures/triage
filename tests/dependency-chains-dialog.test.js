import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import '../ui/view/frontend-install.js'

mock.module('../ui/view/dom.js', { namedExports: { makeStackedModalError: cause => new Error('Modal conflict', { cause }) } })
mock.module('../ui/view/tooltip.js', { namedExports: { installShadowTooltipListener() {} } })
await import('../ui/view/dialogs/dependency-chains-dialog.js')

test('resizing preserves the scroll position of focused cycle toggles and packages on side branches', t => {
  const globals = ['document', 'getComputedStyle', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  t.after(() => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  let resize
  globalThis.document = { documentElement: { clientWidth: 1024 } }
  globalThis.getComputedStyle = () => ({ fontSize: '16px' })
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback }
    observe() {}
  }
  const Dialog = customElements.get('dependency-chains-dialog'), dialog = new Dialog()
  const scroller = { clientWidth: 600, scrollLeft: 0 }
  dialog.renderRoot = { activeElement: null, querySelector: selector => selector === '.graph-scroll' ? scroller : null }
  dialog.layout = { width: 2400 }
  dialog._maxWidth = Math.floor(1024 * .94)
  dialog.firstUpdated()
  for (const className of ['cycle-toggle', 'package']) {
    dialog.renderRoot.activeElement = { matches: selector => selector.split(', ').includes(`.${className}`) }
    for (const scrollLeft of [0, 1800]) {
      scroller.scrollLeft = scrollLeft
      resize()
      assert.equal(scroller.scrollLeft, scrollLeft, `${className} remains visible on either side after resize`)
    }
  }
  dialog.renderRoot.activeElement = null
  resize()
  assert.equal(scroller.scrollLeft, 900, 'unfocused graphs still center their chains')
})
