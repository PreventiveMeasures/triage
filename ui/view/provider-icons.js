import { html } from 'lit'
import anthropic from '../provider-icons/claude.svg'
import deepseek from '../provider-icons/deepseek.svg'
import google from '../provider-icons/google.svg'
import grok from '../provider-icons/grok.svg'
import moonshot from '../provider-icons/moonshot.svg'
import nvidia from '../provider-icons/nvidia.svg'
import openai from '../provider-icons/openai.svg'
import openrouter from '../provider-icons/openrouter.svg'
import qwen from '../provider-icons/qwen.svg'
import zai from '../provider-icons/zai.svg'

// SVG imports are compiled into Lit html templates by the bundler.
const icons = { anthropic, deepseek, google, moonshot, moonshotai: moonshot, nvidia, openai, openrouter, qwen, 'x-ai': grok, 'z-ai': zai }
const fallback = html`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="3"/><path d="M8 1v3m4-3v3M8 16v3m4-3v3M1 8h3m-3 4h3m12-4h3m-3 4h3"/></svg>`

export function providerIcon(key) {
  return Object.hasOwn(icons, key) ? icons[key] : fallback
}
