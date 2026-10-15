import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import { html } from 'lit'
import { templateText } from './_lit.js'

// The browser loads ui/compare.js beside view.js, which compare-load.js
// imports lazily (lazy-entry.js). Route that import to a stand-in, failing
// while `offline` is set, and record what each attempt asks for.
let offline = true
const asked = []
const entryUrl = new URL('../ui/view/lazy-entry.js', import.meta.url).href
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.split('?')[0] !== './compare.js' || context.parentURL !== entryUrl) return nextResolve(specifier, context)
  asked.push(specifier)
  if (offline) throw new TypeError('Failed to fetch dynamically imported module')
  return { shortCircuit: true, url: 'data:text/javascript,export {}' }
} })
let renders = 0
mock.module('../ui/view/render.js', { exports: { render: () => { renders++ } } })
const { withCompare } = await import('../ui/view/compare-load.js')
const compare = () => html`<bundle-compare></bundle-compare>`

test('Compare tabs wait for their bundle, say when it fails, and retry', async () => {
  assert.match(templateText(withCompare(compare)), /Loading…/u)
  assert.match(templateText(withCompare(compare)), /Loading…/u, 'one load at a time')
  await setImmediate()
  assert.equal(renders, 1, 'the failure renders again')
  const failed = withCompare(compare)
  assert.match(templateText(failed), /Couldn’t load: Failed to fetch dynamically imported module/u)
  offline = false
  failed.values.at(-1)()
  assert.equal(renders, 2, 'Retry renders again')
  assert.match(templateText(withCompare(compare)), /Loading…/u)
  await setImmediate()
  assert.equal(renders, 3, 'the bundle landing renders again')
  assert.match(templateText(withCompare(compare)), /<bundle-compare>/u)
  assert.deepEqual(asked, ['./compare.js', './compare.js?retry=1'], 'a browser keeps a failed fetch failed: the retry asks anew')
})
