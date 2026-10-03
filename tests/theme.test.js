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

test('six activations unlock a page-local green/pink cycle while only the selected theme persists', async t => {
  const stored = new Map()
  let plays = 0, resolveAnimation, reveal, session = 0
  t.mock.module('lit', { namedExports: {
    LitElement: ToggleHost,
    html: (_strings, ...values) => values.join(''),
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
  const boot = async () => {
    const classes = new Set(), elements = new Map(), meta = new ToggleHost()
    globalThis.window = new EventTarget()
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
    return { api, button, classes, meta, Toggle }
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
  assert.equal(page.button.render(), '☀')
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
  assert.equal(plays, 0)
  window.dispatchEvent(new Event('beforeprint'))
  assert.equal(page.meta.getAttribute('content'), '#646464')
  window.dispatchEvent(new Event('afterprint'))
  assert.equal(page.meta.getAttribute('content'), '#f6f6fa')
  click(page.button)
  assert.equal(plays, 1, 'only the sixth activation starts the effect')
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
  assert.equal(page.button.render(), '✿', 'the icon shows the next pink theme')
  for (const expected of ['pink', 'light', 'dark', 'green', 'pink', 'light', 'dark', 'green']) {
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
    assert.equal(page.button.render(), '☀', 'a reload restores the default switcher')
    for (const expected of ['light', 'dark', 'light', 'dark', 'light']) {
      click(page.button)
      assert.equal(page.api.getTheme(), expected)
    }
    assert.equal(plays, saved === 'green' ? 1 : 2, 'a reload resets the six-press counter')
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
  page = await boot()
  for (let i = 0; i < 6; i++) click(page.button)
  assert.equal(page.api.getTheme(), 'light')
  page.api.setTheme('pink')
  page.api.setTheme('light')
  reveal()
  resolveAnimation()
  await setImmediate()
  assert.equal(page.api.getTheme(), 'light', 'an explicit API choice survives even when it matches the pre-effect theme')
  click(page.button)
  assert.equal(page.api.getTheme(), 'dark')
  click(page.button)
  assert.equal(page.api.getTheme(), 'green', 'an explicit API choice still allows the unlocked cycle')
  page.button.disconnectedCallback()
})
