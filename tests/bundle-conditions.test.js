import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BundleConditions, defaultBundleConditions } from '../ui/managed/bundle-conditions.js'

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}

test('presets default to Node.js, replace conditions, and expose platforms only for Metro', () => {
  const control = new BundleConditions()
  const changes = []
  control.addEventListener('conditions-change', event => changes.push(event.detail))
  assert.deepEqual(control.value, defaultBundleConditions())
  const platforms = () => templates(control.render()).find(template => template.strings[0].includes('class="platforms"'))
  assert.equal(platforms(), undefined)
  for (const [label, expected] of [
    ['Browser', { preset: 'browser', conditions: ['browser'], platforms: [] }],
    ['Metro', { preset: 'metro', conditions: ['react-native'], platforms: ['ios', 'android'] }],
    ['Node.js', defaultBundleConditions()],
  ]) {
    const button = templates(control.render()).find(template => template.values.includes(label))
    button.values.find(value => typeof value === 'function')()
    assert.deepEqual(control.value, expected)
    assert.deepEqual(changes.at(-1), expected)
    assert.equal(Boolean(platforms()), label === 'Metro')
  }
})

test('Metro platforms are independent from export conditions, retain one target, and survive preset switches', () => {
  const control = new BundleConditions()
  control.selectPreset('metro')
  control.togglePlatform('ios')
  assert.deepEqual(control.value, { preset: 'metro', conditions: ['react-native'], platforms: ['android'] })
  control.togglePlatform('android')
  assert.deepEqual(control.value.platforms, ['android'], 'cannot remove the only remaining platform')
  control.selectPreset('browser')
  assert.deepEqual(control.value.platforms, [], 'hidden Metro platforms do not leak into Browser settings')
  control.selectPreset('metro')
  assert.deepEqual(control.value.platforms, ['android'])
  control.togglePlatform('ios')
  control.togglePlatform('android')
  assert.deepEqual(control.value.platforms, ['ios'])
  control.togglePlatform('web')
  assert.deepEqual(control.value.platforms, ['ios'])
  control.selectPreset('unknown')
  assert.equal(control.value.preset, 'metro')
})

test('Metro hides manual conditions and keeps its react-native condition unchanged', () => {
  const control = new BundleConditions()
  const hidden = marker => {
    const template = templates(control.render()).find(item => item.strings.some(string => string.endsWith(marker)))
    return template.values[template.strings.findIndex(string => string.endsWith(marker))]
  }
  control._manualOpen = true
  assert.equal(hidden('class="manual-toggle" ?hidden='), false)
  assert.equal(hidden('<div id="manual-conditions" ?hidden='), false)
  control.selectPreset('metro')
  assert.equal(hidden('class="manual-toggle" ?hidden='), true)
  assert.equal(hidden('<div id="manual-conditions" ?hidden='), true)
  const changes = []
  control.addEventListener('conditions-change', event => changes.push(event.detail))
  control._draft = 'development'
  control.addConditions()
  control.removeCondition('react-native')
  assert.deepEqual(control.value.conditions, ['react-native'])
  assert.equal(changes.length, 0)
  control.selectPreset('node')
  assert.equal(hidden('<div id="manual-conditions" ?hidden='), false, 'leaving Metro restores the open editor')
})

test('custom conditions support adding, deduplicating, and removing', () => {
  const control = new BundleConditions()
  control._draft = ' development, custom:condition node development '
  const form = templates(control.render()).find(template => template.strings.some(string => string.includes('class="condition-editor"')))
  const submit = form.values[form.strings.findIndex(string => string.includes('<form class="condition-editor"'))]
  let prevented = false
  submit({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(control.value.conditions, ['node', 'development', 'custom:condition'])
  assert.equal(control._draft, '')
  const remove = templates(control.render()).find(template => template.values.includes('Remove condition development'))
  remove.values.find(value => typeof value === 'function')()
  assert.deepEqual(control.value.conditions, ['node', 'custom:condition'])
  const snapshot = control.value
  snapshot.conditions.push('external mutation')
  assert.deepEqual(control.value.conditions, ['node', 'custom:condition'])
})

test('switching presets replaces only the preset condition and keeps manual conditions', () => {
  const control = new BundleConditions()
  const changes = []
  control.addEventListener('conditions-change', event => changes.push(event.detail.conditions))
  control._draft = 'development browser'
  control.addConditions()
  control.selectPreset('browser')
  control.selectPreset('metro')
  control.selectPreset('node')
  assert.deepEqual(changes, [
    ['node', 'development', 'browser'],
    ['browser', 'development'],
    ['react-native'],
    ['node', 'development', 'browser'],
  ], 'Metro sets its own conditions; a manual browser merges into the Browser preset')
  control.selectPreset('browser')
  control.removeCondition('browser')
  assert.deepEqual(control.value.conditions, ['browser', 'development'])
  control.selectPreset('node')
  control.removeCondition('browser')
  control._draft = Array.from({ length: 15 }, (_, i) => `condition-${i}`).join(' ')
  control.addConditions()
  assert.ok(control._error, 'the preset condition counts toward the limit of 16')
  control._draft = Array.from({ length: 14 }, (_, i) => `condition-${i}`).join(' ')
  control.addConditions()
  assert.equal(control.value.conditions.length, 16)
})

test('the Node.js and Browser preset conditions stay first and cannot be removed', () => {
  const control = new BundleConditions()
  const removable = name => templates(control.render()).some(template => template.values.includes(`Remove condition ${name}`))
  for (const [preset, condition] of [['node', 'node'], ['browser', 'browser']]) {
    control.selectPreset(preset)
    control._draft = `development ${condition}`
    control.addConditions()
    assert.deepEqual(control.value.conditions, [condition, 'development'], 'retyping the preset condition is a no-op')
    assert.equal(removable(condition), false)
    assert.equal(removable('development'), true)
    control.removeCondition(condition)
    assert.deepEqual(control.value.conditions, [condition, 'development'])
    control.removeCondition('development')
    assert.deepEqual(control.value.conditions, [condition])
  }
  control._draft = 'node'
  control.addConditions()
  assert.deepEqual(control.value.conditions, ['browser'], 'Browser builds resolve with node already')
  assert.match(control._error, /node.*automatically/u)
})

test('typed conditions are accepted on space and when the field loses focus, without an add button', () => {
  const control = new BundleConditions()
  const changes = []
  control.addEventListener('conditions-change', event => changes.push(event.detail))
  const input = () => templates(control.render()).find(template => template.strings.some(string => string.includes('class="condition-input"')))
  const handler = name => input().values[input().strings.findIndex(string => string.endsWith(`${name}=`))]
  assert.equal(input().strings.some(string => string.includes('type="submit"')), false)
  let prevented = false
  control._draft = 'development'
  handler('@keydown')({ key: ' ', isComposing: false, preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'the separator space is not typed into the next condition')
  assert.deepEqual(control.value.conditions, ['node', 'development'])
  assert.equal(control._draft, '')
  control._draft = 'prod'
  handler('@keydown')({ key: 'd', isComposing: false, preventDefault() { assert.fail('only space accepts') } })
  handler('@keydown')({ key: ' ', isComposing: true, preventDefault() { assert.fail('IME composition is left alone') } })
  assert.equal(control._draft, 'prod')
  handler('@blur')()
  assert.deepEqual(control.value.conditions, ['node', 'development', 'prod'])
  assert.equal(control._draft, '')
  handler('@blur')()
  assert.equal(changes.length, 2, 'an empty field accepts nothing on blur')
  control._draft = 'import'
  handler('@blur')()
  assert.equal(control._draft, 'import', 'an invalid draft stays for correction')
  assert.ok(control._error)
  assert.equal(changes.length, 2)
})

test('invalid or excessive custom conditions do not partially apply or change the configuration', () => {
  const control = new BundleConditions()
  const changes = []
  control.addEventListener('conditions-change', event => changes.push(event.detail))
  for (const draft of ['import', 'require', 'default', 'node-addons', 'module-sync', 'valid .invalid', '123', 'x'.repeat(65), Array.from({ length: 16 }, (_, i) => `condition-${i}`).join(' ')]) {
    control._draft = draft
    control.addConditions()
    assert.deepEqual(control.value, defaultBundleConditions())
    assert.ok(control._error)
    assert.equal(changes.length, 0)
  }
  control._draft = 'production'
  control.addConditions()
  assert.equal(control._error, '')
  assert.equal(changes.length, 1)
  assert.deepEqual(control.value.conditions, ['node', 'production'])
})
