import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelColumns, modelRows, modelSections } from '../ui/view/scan-model-layout.js'

test('GPT pairs use one row in either catalogue order, retaining each variant’s effort limits', () => {
  const base = { id: 'openai/gpt-6-astra', efforts: ['low', 'high'] }
  const pro = { id: 'openai/gpt-6-astra-pro', efforts: ['high', 'max'] }
  const other = { id: 'anthropic/claude-opus-5', efforts: ['max'] }
  for (const models of [[base, other, pro], [pro, other, base]]) {
    assert.deepEqual(modelRows(models), [{ ...base, pro }, other])
  }
  assert.deepEqual(base, { id: 'openai/gpt-6-astra', efforts: ['low', 'high'] })
  assert.deepEqual(pro, { id: 'openai/gpt-6-astra-pro', efforts: ['high', 'max'] })
})

test('unpaired models and non-GPT Pro names remain independently selectable', () => {
  const models = [
    'openai/gpt-6-astra', 'another/gpt-6-astra-pro',
    'gpt-6-other-pro', 'gpt-6-other-mini',
    'anthropic/claude-opus-5', 'anthropic/claude-opus-5-pro',
    'provider/notgpt-test', 'provider/notgpt-test-pro',
  ].map(id => ({ id, efforts: [] }))
  assert.deepEqual(modelRows(models), models)
})

test('unqualified GPT pairs and pairs in separate namespaces keep their own variants', () => {
  const models = ['gpt-test', 'gpt-test-pro', 'openai/gpt-test', 'openai/gpt-test-pro', 'other/gpt-test-pro', 'other/gpt-test'].map(id => ({ id, efforts: [] }))
  assert.deepEqual(modelRows(models), [
    { ...models[0], pro: models[1] },
    { ...models[2], pro: models[3] },
    { ...models[5], pro: models[4] },
  ])
})

test('long providers remain a single section while GPT families retain every canonical model', () => {
  const models = Array.from({ length: 17 }, (_, index) => [
    { id: `openai/gpt-test-${index}-pro`, efforts: ['max'] },
    { id: `openai/gpt-test-${index}`, efforts: ['high'] },
  ]).flat()
  const sections = modelSections(models)
  assert.deepEqual(sections.map(section => section.models.length), [17])
  const columns = modelColumns(sections, 3)
  assert.equal(columns.length, 1)
  const rows = columns.flat().flatMap(section => section.models)
  assert.equal(rows.length, 17)
  assert.deepEqual(rows.flatMap(row => [row.pro.id, row.id]), models.map(model => model.id))
})

function catalogue(lengths) {
  return lengths.flatMap((length, provider) => Array.from({ length }, (_, model) => ({ id: `provider-${provider}/model-${model}` })))
}

test('an eight-model provider and two three-model providers fill all three columns', () => {
  const sections = modelSections(catalogue([8, 3, 3]))
  const columns = modelColumns(sections, 3)
  assert.deepEqual(columns.map(column => column.map(section => section.models.length)), [[8], [3], [3]])
})

test('sparse and long catalogues retain every model and never allocate empty columns', () => {
  for (const lengths of [[], [1], [8, 3, 3], [3, 8, 3], [3, 3, 8], [25, 1, 1], [1, 25, 1], [1, 1, 25], [80, 65, 1, 2], Array.from({ length: 15 }, () => 1)]) {
    const models = catalogue(lengths)
    const sections = modelSections(models)
    for (const count of [1, 2, 3]) {
      const columns = modelColumns(sections, count)
      assert.equal(columns.length, Math.min(count, sections.length))
      assert.ok(columns.every(column => column.length > 0))
      assert.deepEqual(columns.flat(), sections)
      assert.deepEqual(columns.flat().flatMap(section => section.models), models)
    }
  }
})

function cost(list) { return list.reduce((sum, section) => sum + section.models.length * 2 + 3, 0) }

function bestThreeColumnHeight(sections) {
  // Exhaustively try every cut as an independent oracle for the packer.
  let best = Infinity
  for (let first = 1; first < sections.length - 1; first++) {
    for (let second = first + 1; second < sections.length; second++) {
      best = Math.min(best, Math.max(cost(sections.slice(0, first)), cost(sections.slice(first, second)), cost(sections.slice(second))))
    }
  }
  return best
}

test('column height matches the best ordered partition for varied group lengths', () => {
  for (let long = 1; long <= 32; long++) {
    for (let short = 1; short <= 8; short++) {
      for (const lengths of [[long, short, 1], [short, long, 1], [short, 1, long]]) {
        const sections = modelSections(catalogue(lengths))
        const columns = modelColumns(sections, 3)
        assert.equal(columns.length, 3)
        assert.equal(Math.max(...columns.map(cost)), bestThreeColumnHeight(sections), lengths.join(', '))
        assert.deepEqual(columns.flat(), sections)
      }
    }
  }
})
