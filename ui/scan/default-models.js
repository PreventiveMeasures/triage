// Local/E2E choices before connecting. Use undated model aliases, not snapshots.
// These are preview effort controls;
// a connected service will supply its own supported models and effort limits.
export function defaultScanModels(provider = null) {
  const ids = [
    'anthropic/claude-opus-5.5',
    'anthropic/claude-fable-5.1',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-haiku-4.5',
    'openai/gpt-6-astra',
    'openai/gpt-6-astra-pro',
    'openai/gpt-6-sol',
    'openai/gpt-6-sol-pro',
    'openai/gpt-6-luna',
    'openai/gpt-6-luna-pro',
    'moonshotai/kimi-k3',
    'google/gemini-3.8-flash',
    'google/gemma-4-31b-it',
    'x-ai/grok-4.7',
    'z-ai/glm-5.3',
    'qwen/qwen3.8-max',
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4-pro',
  ]
  // OpenRouter routes all listed providers. Direct-provider credentials only
  // expose that provider's models; no selection leaves the catalogue intact.
  const models = ids.filter(id => !['anthropic', 'openai'].includes(provider) || id.startsWith(`${provider}/`))
    .map(id => ({ id, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }))
  return { models, defaultModel: models[0].id }
}
