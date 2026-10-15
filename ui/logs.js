import { html, nothing, render as litRender } from 'lit'

const dropZone = document.getElementById('drop-zone')
const dropError = document.getElementById('drop-error')
const viewer = document.getElementById('viewer')

const TOOL_PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'prompt', 'description', 'query', 'url']

let currentData = null
let currentFileName = ''
let currentTab = null
let filterText = ''
let showTools = true
let showThinking = true
let showSystem = false

document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('hover') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('hover'))
dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('hover')
  const file = e.dataTransfer.files[0]
  if (file) readFile(file)
})

function readFile(file) {
  const reader = new FileReader()
  reader.onload = () => {
    let parsed
    try {
      parsed = JSON.parse(reader.result)
    } catch (err) {
      showDropError(`Failed to parse JSON: ${err.message}`)
      return
    }
    const format = detectFormat(parsed)
    if (format !== 'deepfix-log') {
      showDropError('Unsupported format. Expected a deepfix log: { "file": [...entries] }')
      return
    }
    currentData = parsed
    currentFileName = file.name
    currentTab = Object.keys(parsed)[0] || null
    filterText = ''
    dropError.textContent = ''
    render()
  }
  reader.readAsText(file)
}

function showDropError(msg) { dropError.textContent = msg }

// Detect deepfix log format: top-level object where every value is an array of
// entries, and entries (when present) have a string `type` field.
function detectFormat(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const values = Object.values(data)
  if (values.length === 0) return null
  if (!values.every((v) => Array.isArray(v))) return null
  for (const list of values) {
    if (list.length === 0) continue
    const first = list[0]
    if (!first || typeof first !== 'object' || typeof first.type !== 'string') return null
    return 'deepfix-log'
  }
  // All empty arrays — still a valid (degenerate) deepfix log
  return 'deepfix-log'
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour12: false })
}

function stringifyJSON(value) {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

// Pick a short single-line preview for a tool input/result.
function toolInputPreview(input) {
  if (input == null) return ''
  if (typeof input === 'string') return input.split('\n')[0].slice(0, 200)
  if (typeof input !== 'object') return String(input)
  for (const k of TOOL_PREVIEW_KEYS) {
    if (k in input && typeof input[k] === 'string') return `${k}: ${input[k].split('\n')[0].slice(0, 200)}`
  }
  return Object.keys(input).join(', ')
}

function toolResultPreview(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content.split('\n')[0].slice(0, 200)
  if (Array.isArray(content)) {
    // Anthropic tool_result content: [{ type: 'text', text: '...' }]
    const first = content.find((b) => b && b.type === 'text')
    if (first && typeof first.text === 'string') return first.text.split('\n')[0].slice(0, 200)
    return `${content.length} block${content.length === 1 ? '' : 's'}`
  }
  return stringifyJSON(content).split('\n')[0].slice(0, 200)
}

function toolResultText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && b.type === 'text') ? b.text : stringifyJSON(b)).join('\n\n')
  }
  return stringifyJSON(content)
}

// Extract a flat list of renderable blocks from an entry.
//   kind: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'summary' | 'system' | 'unknown'
function blocksOf(entry) {
  const out = []
  if (entry.type === 'summary') {
    if (entry.summary) out.push({ kind: 'summary', text: String(entry.summary) })
    return out
  }
  if (entry.type === 'system') {
    if (entry.content) out.push({ kind: 'system', text: String(entry.content) })
    else if (entry.message) out.push({ kind: 'system', text: stringifyJSON(entry.message) })
    return out
  }
  const msg = entry.message
  if (!msg) return out
  const content = msg.content
  if (typeof content === 'string') {
    out.push({ kind: 'text', text: content })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text })
    else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push({ kind: 'thinking', text: b.thinking })
    else if (b.type === 'tool_use') out.push({ kind: 'tool_use', name: b.name || '(tool)', input: b.input, id: b.id })
    else if (b.type === 'tool_result') out.push({ kind: 'tool_result', content: b.content, isError: b.is_error === true, id: b.tool_use_id })
    else out.push({ kind: 'unknown', text: stringifyJSON(b) })
  }
  return out
}

// Badge label: collapse tool_use-only / tool_result-only entries to that
// kind; otherwise the raw `type`.
function entryBadge(entry, blocks) {
  if (entry.type === 'user' && blocks.every((b) => b.kind === 'tool_result')) return 'tool_result'
  if (entry.type === 'assistant' && blocks.every((b) => b.kind === 'tool_use' || b.kind === 'thinking')) {
    if (blocks.some((b) => b.kind === 'tool_use')) return 'tool_use'
  }
  return entry.type
}

function entryMatchesFilter(entry, blocks, needle) {
  if (!needle) return true
  for (const b of blocks) {
    if (b.kind === 'text' || b.kind === 'thinking' || b.kind === 'summary' || b.kind === 'system' || b.kind === 'unknown') {
      if (b.text && b.text.toLowerCase().includes(needle)) return true
    } else if (b.kind === 'tool_use') {
      if (b.name.toLowerCase().includes(needle)) return true
      if (stringifyJSON(b.input).toLowerCase().includes(needle)) return true
    } else if (b.kind === 'tool_result') {
      if (toolResultText(b.content).toLowerCase().includes(needle)) return true
    }
  }
  return false
}

function entryVisible(entry, blocks) {
  if (entry.type === 'system' && !showSystem) return false
  const onlyTools = blocks.length > 0 && blocks.every((b) => b.kind === 'tool_use' || b.kind === 'tool_result')
  if (onlyTools && !showTools) return false
  const onlyThinking = blocks.length > 0 && blocks.every((b) => b.kind === 'thinking')
  if (onlyThinking && !showThinking) return false
  return true
}

function renderBlock(block) {
  if (block.kind === 'text') return html`<div class="text-block">${block.text}</div>`
  if (block.kind === 'summary') return html`<div class="text-block summary-text">${block.text}</div>`
  if (block.kind === 'system') return html`<div class="text-block" style="color:var(--muted); font-size:.825rem;">${block.text}</div>`
  if (block.kind === 'thinking') {
    if (!showThinking) return nothing
    return html`<div class="thinking-block">${block.text}</div>`
  }
  if (block.kind === 'tool_use') {
    if (!showTools) return nothing
    const preview = toolInputPreview(block.input)
    return html`<details class="tool"><summary><span class="tool-name">🔧 ${block.name}</span><span class="tool-preview">${preview}</span></summary><pre>${stringifyJSON(block.input)}</pre></details>`
  }
  if (block.kind === 'tool_result') {
    if (!showTools) return nothing
    const preview = toolResultPreview(block.content)
    const cls = block.isError ? 'tool error' : 'tool'
    const label = block.isError ? '✗ error' : '✓ result'
    return html`<details class=${cls}><summary><span class="tool-name">${label}</span><span class="tool-preview">${preview}</span></summary><pre>${toolResultText(block.content)}</pre></details>`
  }
  return html`<div class="text-block" style="color:var(--muted);">${block.text || ''}</div>`
}

function entryTemplate(entry, blocks) {
  const badge = entryBadge(entry, blocks)
  const time = formatTime(entry.timestamp)
  return html`<div class=${`entry type-${badge}`}>
    <div class="entry-meta">
      <span class=${`badge ${badge}`}>${badge}</span>
      ${entry.uuid ? html`<span class="mono" style="font-size:.7rem;">#${String(entry.uuid).slice(0, 8)}</span>` : nothing}
      ${time ? html`<span class="time">${time}</span>` : nothing}
    </div>
    <div class="entry-body">${blocks.length === 0
      ? html`<div class="text-block" style="color:var(--muted);">(no content)</div>`
      : blocks.map(renderBlock)}</div>
  </div>`
}

// Lit draws the log, so everything the file says goes in as text.
function render() {
  if (!currentData) return
  const files = Object.keys(currentData)
  if (!files.includes(currentTab)) currentTab = files[0] || null

  const totalEntries = files.reduce((n, f) => n + currentData[f].length, 0)
  const needle = filterText.trim().toLowerCase()
  const entries = currentTab ? currentData[currentTab] : []
  const shown = []
  for (const entry of entries) {
    const blocks = blocksOf(entry)
    if (entryMatchesFilter(entry, blocks, needle) && entryVisible(entry, blocks)) shown.push([entry, blocks])
  }

  litRender(html`
    <header>
      <h1>deepfix logs</h1>
      <div class="meta">${currentFileName} &mdash; ${files.length} file${files.length === 1 ? '' : 's'}, ${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'}</div>
    </header>
    <div class="toolbar">
      <input type="text" id="filter-text" .value=${filterText} placeholder="search text, tool names, arguments...">
      <div class="sep"></div>
      <label><input type="checkbox" id="toggle-tools" .checked=${showTools}> tools</label>
      <label><input type="checkbox" id="toggle-thinking" .checked=${showThinking}> thinking</label>
      <label><input type="checkbox" id="toggle-system" .checked=${showSystem}> system</label>
      <span class="result-count" id="result-count">${shown.length} of ${entries.length}</span>
    </div>
    ${files.length > 1 ? html`<div class="tabs">${files.map(f => html`<button class=${f === currentTab ? 'tab active' : 'tab'} data-tab=${f}>${f}<span class="count">${currentData[f].length}</span></button>`)}</div>` : nothing}
    <div class="entries" id="entries">${shown.map(([entry, blocks]) => entryTemplate(entry, blocks))}</div>
    <button class="reset-btn" id="reset-btn">Load another file</button>
  `, viewer)
  viewer.classList.add('active')
  dropZone.classList.add('hidden')
  document.title = `deepfix logs - ${currentFileName}`
}

function renderKeepFocus(inputId) {
  const prev = document.getElementById(inputId)
  const pos = prev ? prev.selectionStart : 0
  render()
  const el = document.getElementById(inputId)
  if (el) { el.focus(); el.setSelectionRange(pos, pos) }
}

function resetView() {
  currentData = null
  currentFileName = ''
  currentTab = null
  viewer.classList.remove('active')
  litRender(nothing, viewer)
  dropZone.classList.remove('hidden')
  dropError.textContent = ''
  document.title = 'deepview logs'
}

viewer.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')
  if (tab) { currentTab = tab.dataset.tab; render(); return }
  if (e.target.closest('#reset-btn')) { resetView() }
})

viewer.addEventListener('change', (e) => {
  const id = e.target.id
  if (id === 'toggle-tools') { showTools = e.target.checked; render() }
  else if (id === 'toggle-thinking') { showThinking = e.target.checked; render() }
  else if (id === 'toggle-system') { showSystem = e.target.checked; render() }
})

viewer.addEventListener('input', (e) => {
  if (e.target.id === 'filter-text') { filterText = e.target.value; renderKeepFocus('filter-text') }
})
