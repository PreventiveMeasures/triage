import { managedFetch } from '../../client/managed/request.js'
// Presentation belongs to the client. The service supplies canonical ids and
// allowed effort values, using ai/src/models.js's `efforts` vocabulary.
const MODEL_NAMES = new Map([
  ['openai/gpt-6-astra', 'GPT-6 Astra'],
  ['openai/gpt-6-astra-pro', 'GPT-6 Astra Pro'],
  ['openai/gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['openai/gpt-5.6-terra', 'GPT-5.6 Terra'],
  ['openai/gpt-5.6-luna', 'GPT-5.6 Luna'],
  ['anthropic/claude-fable-5.1', 'Claude Fable 5.1'],
  ['anthropic/claude-opus-5', 'Claude Opus 5'],
  ['anthropic/claude-sonnet-5', 'Claude Sonnet 5'],
  ['moonshotai/kimi-k3', 'Kimi K3'],
])

const DEVELOPER_NAMES = new Map([
  ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['moonshotai', 'Moonshot AI'],
  ['google', 'Google'], ['nvidia', 'NVIDIA'], ['qwen', 'Qwen'], ['deepseek', 'DeepSeek'],
])

const WORD_REPLACEMENTS = new Map([
  ['gpt', 'GPT'], ['gptoss', 'GPT OSS'], ['oss', 'OSS'], ['o', 'O'], ['ai', 'AI'], ['api', 'API'],
  ['k3', 'K3'], ['k4', 'K4'], ['qwen', 'Qwen'], ['kimi', 'Kimi'], ['gemini', 'Gemini'],
  ['claude', 'Claude'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'],
  ['astra', 'Astra'], ['terra', 'Terra'], ['luna', 'Luna'], ['codex', 'Codex'],
  ['deepseek', 'DeepSeek'], ['nemotron', 'Nemotron'], ['gemma', 'Gemma'],
])

function prettySlug(slug) {
  const words = slug.replace(/:free$/u, '').replaceAll('_', '-').split('-').filter(Boolean)
  const result = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    const next = words[index + 1]
    if (/^\d+$/u.test(word) && /^\d+$/u.test(next ?? '')) {
      result.push(`${word}.${next}`)
      index++
      continue
    }
    const known = WORD_REPLACEMENTS.get(word.toLowerCase())
    result.push(known ?? (/^(?:[a-z]+\d+|\d+[a-z]+)$/iu.test(word) ? word.toUpperCase() : word[0]?.toUpperCase() + word.slice(1)))
  }
  const name = result.join(' ')
  return name.replace(/^GPT (\d)/u, 'GPT-$1')
}

export function modelName(id) {
  return MODEL_NAMES.get(id) ?? prettySlug(id.includes('/') ? id.slice(id.indexOf('/') + 1) : id)
}

export function modelDeveloper(id) {
  const key = id.includes('/') ? id.split('/')[0] : 'other'
  return { key, name: DEVELOPER_NAMES.get(key) ?? (key === 'other' ? 'Other' : prettySlug(key)) }
}

export function effortName(effort) {
  return effort === 'xhigh' ? 'Extra high' : effort ? effort[0].toUpperCase() + effort.slice(1) : 'Unavailable'
}

export function defaultEffort(model) {
  return model.efforts.includes('max') ? 'max' : model.efforts.at(-1) ?? null
}

export async function fetchScanModels(signal) {
  const res = await managedFetch('/api/admin/models', { credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.models)) throw new Error('No model catalogue returned')
  const models = body.models.filter((model) => typeof model?.id === 'string' && model.id.length > 0)
    .map((model) => ({
      id: model.id,
      efforts: Array.isArray(model.efforts) ? [...new Set(model.efforts.filter((effort) => typeof effort === 'string' && effort.length > 0))] : [],
    }))
  if (models.length === 0) throw new Error('No models available')
  return { models, defaultModel: models.find((model) => model.id === body.defaultModel)?.id ?? models[0].id }
}
