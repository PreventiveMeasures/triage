import { html } from 'lit'
import { CLAUDE_MARK_PATH, COPILOT_MARK_PATH, OPENAI_MARK_PATH } from './icons.js'
import deepseek from '../provider-icons/deepseek.svg'
import google from '../provider-icons/google.svg'
import grok from '../provider-icons/grok.svg'
import mistral from '../provider-icons/mistral.svg'
import moonshot from '../provider-icons/moonshot.svg'
import nvidia from '../provider-icons/nvidia.svg'
import openrouter from '../provider-icons/openrouter.svg'
import qwen from '../provider-icons/qwen.svg'
import xiaomi from '../provider-icons/xiaomi.svg'
import zai from '../provider-icons/zai.svg'

// Claude's and OpenAI's marks, as the report stickers draw them (icons.js),
// cropped to the mark, as large as the text, as the other providers' are.
const mark = path => html`<svg width="1em" height="1em" fill="currentColor" style="flex:none;line-height:1" viewBox="4 5 8 8" aria-hidden="true"><path d=${path}></path></svg>`
const anthropic = mark(CLAUDE_MARK_PATH)
const openai = mark(OPENAI_MARK_PATH)
// GitHub Copilot's, Copilot's agent mark, drawn here rather than its
// account's avatar fetched.
const githubCopilot = html`<svg width="1em" height="1em" fill="currentColor" style="flex:none;line-height:1" viewBox="0 0 24 24" aria-hidden="true"><path d=${COPILOT_MARK_PATH}></path></svg>`

// SVG imports are compiled into Lit html templates by the bundler.
const icons = { anthropic, deepseek, 'github-copilot': githubCopilot, google, mistralai: mistral, moonshot, moonshotai: moonshot, nvidia, openai, openrouter, qwen, xiaomi, 'x-ai': grok, 'z-ai': zai }
const fallback = html`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="3"/><path d="M8 1v3m4-3v3M8 16v3m4-3v3M1 8h3m-3 4h3m12-4h3m-3 4h3"/></svg>`

export function providerIcon(key) {
  return Object.hasOwn(icons, key) ? icons[key] : fallback
}
