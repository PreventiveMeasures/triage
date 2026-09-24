import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectTokenProvider } from '../ui/scan/provider-token.js'

test('distinctive credential prefixes select the provider, including pasted whitespace', () => {
  for (const [token, provider] of [
    ['sk-ant-', 'anthropic'],
    ['sk-or-v1-', 'openrouter'],
    ['sk-kimi-', 'moonshotai'],
    ['sk-proj-', 'openai'],
    ['sk-svcacct-', 'openai'],
    ['sk-ant-api03-example_token', 'anthropic'],
    ['sk-or-v1-example123', 'openrouter'],
    ['sk-kimi-example_token', 'moonshotai'],
    ['sk-proj-example_token', 'openai'],
    ['sk-svcacct-example_token', 'openai'],
  ]) {
    assert.equal(detectTokenProvider(token), provider)
    assert.equal(detectTokenProvider(` \t${token}\n `), provider)
  }
})

test('ambiguous, partial, malformed, and embedded credentials do not suggest a provider', () => {
  for (const token of [
    '', ' ', 'sk-', 'sk-generic-key', 'sk-ant', 'sk-or-', 'sk-or-v1',
    'sk-proj', 'sk-svcacct', 'sk-project-example', 'sk-or-v2-example',
    'sk-kimi', 'sk-kim', 'SK-KIMI-example', 'sk-kimi-example with spaces',
    'SK-PROJ-example', 'sk-proj-example with spaces', 'Bearer sk-proj-example',
    'prefix-sk-ant-api03-example', 'https://example.com/sk-or-v1-example',
  ]) assert.equal(detectTokenProvider(token), null)
})
