import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultScanModels } from '../ui/scan/default-models.js'
import { modelRows } from '../ui/view/scan-model-layout.js'

test('unselected and OpenRouter providers expose every default model with Opus 5.5 as the default', () => {
  const catalogue = defaultScanModels()
  assert.equal(catalogue.defaultModel, 'anthropic/claude-opus-5.5')
  assert.deepEqual(defaultScanModels(null), catalogue)
  assert.deepEqual(defaultScanModels('openrouter'), catalogue)
  assert.ok(catalogue.models.some(model => model.id === 'qwen/qwen3.8-max'))
  assert.ok(catalogue.models.some(model => model.id === 'deepseek/deepseek-v4-pro'))
})

test('direct-provider defaults contain only their own models and keep GPT Pro pairs', () => {
  const full = defaultScanModels()
  for (const provider of ['anthropic', 'openai', 'moonshot']) {
    const filtered = defaultScanModels(provider)
    const expected = full.models.filter(model => model.id.startsWith(`${provider === 'moonshot' ? 'moonshotai' : provider}/`))
    assert.deepEqual(filtered.models, expected)
    assert.equal(filtered.defaultModel, expected[0].id)
  }
  assert.equal(defaultScanModels('openai').defaultModel, 'openai/gpt-6-astra')
  assert.equal(defaultScanModels('moonshot').defaultModel, 'moonshotai/kimi-k3')
  assert.deepEqual(modelRows(defaultScanModels('openai').models).map(model => [model.id, model.pro?.id]), [
    ['openai/gpt-6-astra', 'openai/gpt-6-astra-pro'],
    ['openai/gpt-6-sol', 'openai/gpt-6-sol-pro'],
    ['openai/gpt-6-luna', 'openai/gpt-6-luna-pro'],
  ])
})
