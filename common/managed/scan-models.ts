// Model catalogue exposed by the managed scan service. The server owns the
// ids and effort levels; clients derive printable names from the ids so a
// newer model can be added without requiring a coordinated UI release.
export const MANAGED_SCAN_MODELS = Object.freeze([
  { id: 'openai/gpt-6-astra-pro', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'openai/gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'openai/gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'openai/gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'openai/gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'openai/gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'anthropic/claude-fable-5.1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'anthropic/claude-opus-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'anthropic/claude-sonnet-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'anthropic/claude-sonnet-4.6', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'anthropic/claude-haiku-4.5', efforts: [] },
  { id: 'moonshotai/kimi-k3', efforts: ['low', 'high', 'max'] },
  { id: 'google/gemini-3.8-flash', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'google/gemma-4-31b-it', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'qwen/qwen3.6-27b', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'nvidia/nemotron-3-super-120b-a12b', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'deepseek/deepseek-v4', efforts: ['low', 'medium', 'high', 'max'] },
] as const)

export const DEFAULT_MANAGED_SCAN_MODEL = 'anthropic/claude-opus-5'
