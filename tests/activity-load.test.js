import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import { html } from 'lit'
import { templateText } from './_lit.js'

// The browser loads ui/activity.js beside view.js, which activity-load.js
// imports lazily (lazy-entry.js). Route that import to a stand-in and record
// what it asks for.
const asked = []
const entryUrl = new URL('../ui/view/lazy-entry.js', import.meta.url).href
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.split('?')[0] !== './activity.js' || context.parentURL !== entryUrl) return nextResolve(specifier, context)
  asked.push(specifier)
  return { shortCircuit: true, url: 'data:text/javascript,export {}' }
} })
let renders = 0
mock.module('../ui/view/render.js', { exports: { render: () => { renders++ } } })
const { withRepositoryActivity } = await import('../ui/view/activity-load.js')
const history = () => html`<repository-history></repository-history>`

test('the Activity views wait for their bundle, loaded once, and draw once it lands', async () => {
  assert.match(templateText(withRepositoryActivity(history)), /Loading…/u)
  assert.match(templateText(withRepositoryActivity(history)), /Loading…/u, 'one load at a time')
  await setImmediate()
  assert.equal(renders, 1, 'the bundle landing renders again')
  assert.match(templateText(withRepositoryActivity(history)), /<repository-history>/u)
  assert.deepEqual(asked, ['./activity.js'])
})
