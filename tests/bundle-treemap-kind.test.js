import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import { templates } from './_lit.js'

await import('../ui/view/bundle-treemap.js')
const BundleTreemap = customElements.get('bundle-treemap')

// A bundle of code and resources both, so the Code | Resources pill is offered.
const details = {
  integrity: 'sha512-kind',
  fileSizes: new Map([['src/index.js', 1200], ['src/lib.js', 800], ['assets/logo.png', 4000]]),
  npmBinaries: new Set(['assets/logo.png']),
}

// The pill's buttons as drawn: each one's label, pressed state and click.
const pill = treemap => templates(treemap.render())
  .filter(template => template.strings.join('').includes('aria-pressed='))
  .map(({ values: [pressed, click, label] }) => ({ label, pressed, click }))
const press = (treemap, label) => {
  pill(treemap).find(button => button.label === label).click()
  treemap._rebuild()
}
const pressed = treemap => pill(treemap).filter(button => button.pressed === 'true').map(button => button.label)
const shownFiles = treemap => treemap._root ? treemap._focusNode.count : 0

test('the Code | Resources pill switches straight from one kind to the other, and the shown kind\'s press returns to all', () => {
  const treemap = Object.assign(new BundleTreemap(), { details })
  treemap._rebuild()
  assert.equal(treemap._mixedKinds, true)
  assert.deepEqual(pill(treemap).map(button => button.label), ['Code', 'Resources'])
  assert.deepEqual(pressed(treemap), [])
  assert.equal(shownFiles(treemap), 3)

  press(treemap, 'Code')
  assert.deepEqual(pressed(treemap), ['Code'])
  assert.equal(shownFiles(treemap), 2)

  // One press from Code shows Resources, not all.
  press(treemap, 'Resources')
  assert.deepEqual(pressed(treemap), ['Resources'])
  assert.equal(shownFiles(treemap), 1)

  press(treemap, 'Code')
  assert.deepEqual(pressed(treemap), ['Code'])

  // The kind already shown, pressed again, returns to all.
  press(treemap, 'Code')
  assert.deepEqual(pressed(treemap), [])
  assert.equal(shownFiles(treemap), 3)
})
