import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'

class ToggleHost extends EventTarget {
  attributes = new Map()
  hasAttribute(name) { return this.attributes.has(name) }
  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return this.attributes.get(name) }
  connectedCallback() {}
  disconnectedCallback() {}
}

test('the first activation from dark at or after eight presses unlocks a page-local bonus-theme cycle', async t => {
  const stored = new Map()
  let plays = 0, resolveAnimation, reveal, session = 0
  t.mock.module('lit', { namedExports: {
    LitElement: ToggleHost,
    html: (strings, ...values) => String.raw({ raw: strings }, ...values),
    unsafeCSS: css => css,
  } })
  t.mock.module('../ui/view/screen-crack.js', { namedExports: {
    playScreenCrack: callback => {
      plays++
      reveal = callback
      return new Promise(resolve => { resolveAnimation = resolve })
    },
  } })
  const globals = ['window', 'document', 'localStorage', 'customElements']
  const previous = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  t.after(() => {
    for (const [i, name] of globals.entries()) {
      if (previous[i]) Object.defineProperty(globalThis, name, previous[i])
      else delete globalThis[name]
    }
  })
  const boot = async (options = {}) => {
    const classes = new Set(), elements = new Map(), meta = new ToggleHost()
    globalThis.window = new EventTarget()
    const standaloneMode = Object.assign(new EventTarget(), { matches: options.standalone ?? false })
    const overlayMode = Object.assign(new EventTarget(), { matches: options.collapsed ?? false })
    const overlay = options.overlayApi === false ? undefined : Object.assign(new EventTarget(), { visible: options.collapsed ?? false })
    window.matchMedia = query => query === '(display-mode: standalone)' ? standaloneMode : overlayMode
    window.navigator = { windowControlsOverlay: overlay }
    globalThis.document = { body: { classList: {
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
    } }, querySelector: () => meta }
    globalThis.localStorage = {
      getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key),
    }
    globalThis.customElements = { define: (name, value) => elements.set(name, value) }
    const api = await import(`../ui/view/theme.js?session=${++session}`)
    const Toggle = elements.get('theme-toggle')
    const button = new Toggle()
    button.connectedCallback()
    return { api, button, classes, meta, Toggle, standaloneMode, overlayMode, overlay }
  }
  const click = button => button.dispatchEvent(new Event('click'))
  const key = (button, value, repeat = false) => {
    const event = new Event('keydown', { cancelable: true })
    Object.assign(event, { key: value, repeat })
    button.dispatchEvent(event)
    return event
  }
  let page = await boot()
  assert.equal(page.api.getTheme(), 'dark')
  assert.equal(page.button.render(), '☾', 'the icon shows the active dark theme')
  for (const expected of ['light', 'dark', 'light']) { click(page.button); assert.equal(page.api.getTheme(), expected) }
  page.button.disconnectedCallback()
  page.button = new page.Toggle()
  page.button.connectedCallback()
  key(page.button, 'Enter')
  assert.equal(page.api.getTheme(), 'dark', 'component replacement retains the page counter')
  key(page.button, ' ', true)
  assert.equal(page.api.getTheme(), 'dark', 'holding a key does not count repeated keydowns')
  assert.equal(key(page.button, ' ').defaultPrevented, true)
  assert.equal(page.api.getTheme(), 'light')
  assert.equal(page.button.render(), '☀', 'the icon shows the active white theme')
  assert.equal(plays, 0)
  window.dispatchEvent(new Event('beforeprint'))
  assert.equal(page.meta.getAttribute('content'), '#646464')
  window.dispatchEvent(new Event('afterprint'))
  assert.equal(page.meta.getAttribute('content'), '#f6f6fa')
  for (const expected of ['dark', 'light', 'dark']) {
    click(page.button)
    assert.equal(page.api.getTheme(), expected)
    assert.equal(plays, 0, 'starting from dark does not trigger within the first eight activations')
  }
  click(page.button)
  assert.equal(page.api.getTheme(), 'dark', 'the animation begins on the dark theme')
  assert.equal(page.button.render(), '☾', 'the icon stays dark until the green theme is revealed')
  assert.equal(plays, 1, 'starting from dark triggers on the ninth activation')
  assert.equal(page.button.getAttribute('aria-disabled'), 'true')
  click(page.button)
  key(page.button, 'Enter')
  assert.equal(plays, 1, 'rapid input cannot start overlapping effects')
  reveal()
  assert.equal(page.api.getTheme(), 'green')
  assert.deepEqual([...page.classes], ['theme-green'])
  assert.equal(stored.get('deepview.theme'), 'green')
  resolveAnimation()
  await setImmediate()
  assert.equal(page.button.getAttribute('aria-disabled'), 'false')
  assert.equal(page.button.render(), '🕶️', 'the active green theme shows the sunglasses glyph')
  for (const expected of ['pink', 'paper', 'light', 'dark', 'green', 'pink', 'paper', 'light', 'dark', 'green']) {
    click(page.button)
    assert.equal(page.api.getTheme(), expected)
  }
  assert.equal(plays, 1, 'later clicks cycle without replaying the effect')
  assert.deepEqual([...stored.keys()], ['deepview.theme'], 'counter and availability never reach storage')

  for (const saved of ['green', 'pink']) {
    page.api.setTheme(saved)
    page.button.disconnectedCallback()
    page = await boot()
    assert.equal(page.api.getTheme(), saved, 'a reload keeps the selected bonus theme')
    assert.equal(page.button.render(), saved === 'green' ? '🕶️' : '✿', 'a reload shows the persisted theme')
    for (const expected of ['light', 'dark', 'light', 'dark', 'light', 'dark', 'light']) {
      click(page.button)
      assert.equal(page.api.getTheme(), expected)
    }
    assert.equal(plays, saved === 'green' ? 1 : 2, 'a reload resets the eight-press counter')
    click(page.button)
    assert.equal(page.api.getTheme(), 'dark')
    assert.equal(plays, saved === 'green' ? 1 : 2, 'a saved bonus theme waits for an activation from dark')
    click(page.button)
    reveal()
    resolveAnimation()
    await setImmediate()
    assert.equal(page.api.getTheme(), 'green')
  }
  assert.equal(plays, 3)
  page.api.setTheme('pink')
  assert.equal(page.api.getTheme(), 'pink')
  assert.throws(() => page.api.setTheme('unknown'), TypeError)
  assert.equal(page.api.getTheme(), 'pink', 'invalid API input still preserves the current theme')
  page.api.setTheme('dark')
  assert.equal(stored.has('deepview.theme'), false, 'the default theme retains its existing storage behavior')
  page.button.disconnectedCallback()
  stored.set('deepview.theme', 'light')
  page = await boot()
  for (const expected of ['dark', 'light', 'dark', 'light', 'dark', 'light', 'dark']) {
    click(page.button)
    assert.equal(page.api.getTheme(), expected)
  }
  assert.equal(plays, 3)
  click(page.button)
  assert.equal(plays, 4, 'starting from white triggers on the eighth activation')
  assert.equal(page.api.getTheme(), 'dark')
  page.api.setTheme('pink')
  page.api.setTheme('dark')
  reveal()
  resolveAnimation()
  await setImmediate()
  assert.equal(page.api.getTheme(), 'dark', 'an explicit API choice survives even when it matches the pre-effect theme')
  click(page.button)
  assert.equal(page.api.getTheme(), 'green', 'an explicit API choice still allows the unlocked cycle')
  page.button.disconnectedCallback()

  page = await boot()
  for (let i = 0; i < 10; i++) {
    page.api.setTheme('light')
    click(page.button)
    assert.equal(page.api.getTheme(), 'dark')
    assert.equal(plays, 4, 'activations from other themes never trigger the animation')
  }
  click(page.button)
  assert.equal(plays, 5, 'the first eligible activation can be later than the ninth')
  assert.equal(page.api.getTheme(), 'dark')
  reveal()
  assert.equal(page.api.getTheme(), 'green')
  resolveAnimation()
  await setImmediate()
  page.button.disconnectedCallback()

  page.api.setTheme('paper')
  assert.deepEqual([...page.classes], ['theme-paper'], 'paper replaces the previous theme class')
  assert.equal(page.meta.getAttribute('content'), '#ffffff')
  window.dispatchEvent(new Event('beforeprint'))
  assert.equal(page.meta.getAttribute('content'), '#666666')
  window.dispatchEvent(new Event('afterprint'))
  assert.equal(page.meta.getAttribute('content'), '#ffffff')
  assert.equal(stored.get('deepview.theme'), 'paper')
  page = await boot()
  assert.equal(page.api.getTheme(), 'paper', 'paper persists across reloads')
  assert.equal(page.button.render(), '📄')
  click(page.button)
  assert.equal(page.api.getTheme(), 'light', 'a reload restores the default switcher even when paper is selected')
  click(page.button)
  assert.equal(page.api.getTheme(), 'dark')
  assert.deepEqual([...page.classes], [], 'leaving paper removes its body class')
  assert.equal(plays, 5, 'reloading paper resets the unlock counter')
  page.button.disconnectedCallback()

  stored.set('deepview.theme', 'green')
  page = await boot({ standalone: true })
  assert.equal(page.meta.getAttribute('content'), '#0f1e0f', 'Green native title bar uses the sidebar surface RGB')
  page.overlay.visible = true
  page.overlay.dispatchEvent(new Event('geometrychange'))
  assert.equal(page.meta.getAttribute('content'), '#0a140a', 'collapsing the title bar restores the overlay color')
  page.overlay.visible = false
  page.overlay.dispatchEvent(new Event('geometrychange'))
  assert.equal(page.meta.getAttribute('content'), '#0f1e0f', 'expanding restores the sidebar color without reloading')
  assert.equal(page.api.getTheme(), 'green')
  assert.equal(page.button.render(), '🕶️')
  assert.equal(stored.get('deepview.theme'), 'green')
  page.standaloneMode.matches = false
  page.overlayMode.matches = true
  page.overlayMode.dispatchEvent(new Event('change'))
  assert.equal(page.meta.getAttribute('content'), '#0f1e0f', 'the overlay API visibility takes precedence over the display mode')
  page.standaloneMode.matches = true
  page.overlayMode.matches = false
  page.api.setTheme('pink')
  assert.equal(page.meta.getAttribute('content'), '#ffe0f0', 'Pink native title bar uses the sidebar surface RGB')
  window.dispatchEvent(new Event('beforeprint'))
  assert.equal(page.meta.getAttribute('content'), '#a3727f', 'print-preview dimming still takes precedence')
  page.overlay.visible = true
  page.overlay.dispatchEvent(new Event('geometrychange'))
  assert.equal(page.meta.getAttribute('content'), '#a3727f')
  window.dispatchEvent(new Event('afterprint'))
  assert.equal(page.meta.getAttribute('content'), '#ffe4ee', 'closing print preview follows the current overlay state')
  page.overlay.visible = false
  page.overlay.dispatchEvent(new Event('geometrychange'))
  assert.equal(page.meta.getAttribute('content'), '#ffe0f0')
  for (const [theme, color] of [['dark', '#1a1a1b'], ['light', '#f6f6fa'], ['paper', '#ffffff']]) {
    page.api.setTheme(theme)
    assert.equal(page.meta.getAttribute('content'), color, 'other themes retain their native title-bar colors')
  }
  page.api.setTheme('green')
  page.standaloneMode.matches = false
  page.standaloneMode.dispatchEvent(new Event('change'))
  assert.equal(page.meta.getAttribute('content'), '#0a140a', 'browser tabs retain the existing chrome color')
  page.button.disconnectedCallback()

  page = await boot({ standalone: true, overlayApi: false })
  assert.equal(page.meta.getAttribute('content'), '#0f1e0f', 'display-mode detection works without the overlay API')
  page.overlayMode.matches = true
  page.overlayMode.dispatchEvent(new Event('change'))
  assert.equal(page.meta.getAttribute('content'), '#0a140a')
  page.overlayMode.matches = false
  page.overlayMode.dispatchEvent(new Event('change'))
  assert.equal(page.meta.getAttribute('content'), '#0f1e0f')
  assert.deepEqual([...stored.keys()], ['deepview.theme'], 'title-bar state is not persisted')
  page.button.disconnectedCallback()
})
