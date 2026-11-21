// Bundle-source terminal: its own esbuild entry, so `@preventive/terminal`
// stays out of view.js; terminal-attach.js imports it the first time a
// terminal opens. All shell behavior lives in `@preventive/terminal`.

import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './view/style-map.js'
import { createTerminal } from '@preventive/terminal'
import { classifyDiff } from './view/diff-color.js'
import { silencedGaps } from './view/silenced-gaps.js'
// Static text from the build's CSS loader, never user input.
import terminalCSS from './view/terminal.css'

// Not `/`: the writable overlay is refused over a read-only tree mounted at
// `/` or in `/tmp`. The prompt starts here (`cwd` defaults to the mount).
const MOUNT = '/sources'

const TERMINAL_OPTIONS = {
  mount: MOUNT,
  // A bare `cd` steps out to where both /sources and /tmp are in view.
  home: '/',
  // Scratch space for redirects; the bundle itself stays read-only.
  writable: '/tmp/',
}

// Banner suggestions: a grep for a symbol the bundle holds, and a `cat` of
// its shortest path (`./` or `/` dropped). Both read text files only: a
// binary arrives as `{ format: 'base64', data }`, which `cat` won't print.
function bannerCommands(sources) {
  const symbol = pickSearchSymbol(sources)
  const cmds = ['ls', 'find /', `grep -r ${symbol} .`]
  if (!sources || sources.size === 0) return cmds
  let shortest = null
  for (const [key, content] of sources) {
    if (typeof content !== 'string') continue
    const p = key.replace(/^\.?\//u, '')
    if (shortest === null || p.length < shortest.length) shortest = p
  }
  if (shortest) cmds.push(`cat ${shortest} | head -n 20`)
  return cmds
}

// Code markers first, then keywords; `TODO` when nothing matches.
const SEARCH_SYMBOLS = ['TODO', 'FIXME', 'XXX', 'HACK', 'NOTE', 'BUG', 'export', 'import', 'require', '//']

function pickSearchSymbol(sources) {
  if (!sources || sources.size === 0) return SEARCH_SYMBOLS[0]
  for (const symbol of SEARCH_SYMBOLS) {
    for (const content of sources.values()) {
      if (typeof content === 'string' && content.includes(symbol)) return symbol
    }
  }
  return SEARCH_SYMBOLS[0]
}

class BundleTerminal extends LitElement {
  // Render-driving state is reactive; the rest is `#`-private.
  static properties = {
    sources: { attribute: false },
    _lines: { state: true },
    _input: { state: true },
    _cwd: { state: true },
    // The completion's suffix, drawn behind the input after a transparent
    // copy of `_input`.
    _ghost: { state: true },
    // Transient hints top-right, `{ id, text, dwell }` each (#pushNotes).
    _notes: { state: true },
    // A line is in flight (#onSubmit).
    _running: { state: true },
  }

  static styles = unsafeCSS(terminalCSS)

  #term = null
  #lastSources = null
  #history = []
  #histIdx = -1
  #draft = ''
  // Tab-completion cycle `{ items, index }`; any input change invalidates it,
  // as `items[index]` then no longer matches `_input`.
  #completions = null
  // The ghost appears once input has settled for #GHOST_DELAY_MS.
  #ghostTimer = null
  static #GHOST_DELAY_MS = 200
  // One removal timer per note id; ids only climb, so a stale timer can't
  // expire a later note.
  #noteTimers = new Map()
  #noteSeq = 0
  // The newest few, so a burst can't cover the output it comments on.
  static #NOTE_MAX = 3
  // Matches the fade in terminal.css (`--dwell-out` is dwell − fade).
  static #NOTE_FADE_MS = 400

  constructor() {
    super()
    this.sources = null
    this._lines = []
    this._input = ''
    this._cwd = MOUNT
    this._ghost = ''
    this._notes = []
    this._running = false
  }

  // A new sources Map is a different bundle: a new shell, history, input,
  // completions and hints. Any change of `_input`, by any path, rearms the
  // ghost.
  willUpdate(changed) {
    if (changed.has('sources') && this.sources !== this.#lastSources) {
      this.#term = this.sources ? createTerminal(this.sources, TERMINAL_OPTIONS) : null
      this._cwd = this.#term ? this.#term.cwd() : MOUNT
      this._lines = [{ kind: 'banner', commands: bannerCommands(this.sources) }]
      this.#history = []
      this.#histIdx = -1
      this.#draft = ''
      this.#completions = null
      this._input = ''
      this.#clearNotes()
      this.#lastSources = this.sources
    }
    if (changed.has('_input')) {
      this.#cancelGhost()
      this.#scheduleGhost()
    }
  }

  // terminal-attach.js reattaches a cached element, whose .output lost its
  // scrollTop on removal and gets no update to restore it.
  connectedCallback() {
    super.connectedCallback()
    this.updateComplete.then(() => this.#scrollToBottom())
  }

  // The cached element outlives a detach; its timers must not.
  disconnectedCallback() {
    super.disconnectedCallback()
    this.#cancelGhost()
    this.#clearNotes()
  }

  firstUpdated() { this.focusInput() }

  // Follow the bottom only as output grows, not while typing, so earlier
  // output stays readable.
  updated(changed) {
    if (changed.has('_lines') || changed.has('sources')) this.#scrollToBottom()
  }

  // Public for a host that shows the terminal again, where firstUpdated's
  // focus has been spent (terminal-attach.js focusTerminal).
  focusInput() {
    const input = this.renderRoot.querySelector('.input')
    if (input) input.focus()
  }

  #scrollToBottom() {
    const out = this.renderRoot.querySelector('.output')
    if (out) out.scrollTop = out.scrollHeight
  }

  // One line at a time: `run` is truly asynchronous, and two lines in flight
  // would each read a stale cwd and transcript (`cd sub` then `pwd`, or a
  // `clear` a pending line appends to). A second send is refused, not
  // queued; the field stays live.
  #onSubmit = async (e) => {
    e.preventDefault()
    if (!this.#term || this._running) return
    const line = this._input
    const cwdBefore = this._cwd
    // The prompt empties on the keypress, not after the await.
    if (line.trim().length > 0) this.#history = [...this.#history, line]
    this.#histIdx = -1
    this._input = ''
    // `clear` is the UI's own, as bash's built-in: the shell has nothing to clear.
    if (line.trim() === 'clear') {
      this._lines = []
      this.#clearNotes()
      return
    }
    let r
    this._running = true
    try {
      r = await this.#term.run(line)
    } catch (err) {
      // Shown beside the line that caused it, not lost as an unhandled rejection.
      this._lines = [...this._lines,
        { kind: 'prompt', cwd: cwdBefore, text: line },
        { kind: 'stderr', text: `${err?.message ?? err}\n` }]
      return
    } finally {
      this._running = false
    }
    this._cwd = r.cwd
    const next = [...this._lines, { kind: 'prompt', cwd: cwdBefore, text: line }]
    // Classified once here, not on every keystroke's render; null unless a diff.
    if (r.stdout) next.push({ kind: 'stdout', text: r.stdout, diff: classifyDiff(r.stdout) })
    if (r.stderr) next.push({ kind: 'stderr', text: r.stderr })
    this._lines = next
    this.#pushHints(r)
  }

  #onKeydown = (e) => {
    // Tab completes rather than moving focus.
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); this.#onTab(); return }
    // Any other key ends the cycle, cursor-only ones too: Tab, ArrowRight,
    // Tab starts afresh though `_input` didn't change.
    this.#completions = null
    if (e.key === 'ArrowUp') { e.preventDefault(); this.#historyBack() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.#historyForward() }
    // Cursor-only keys don't change `_input`, so rearm the ghost here too.
    this.#cancelGhost()
    this.#scheduleGhost()
  }

  #onTab() {
    if (!this.#term) return
    const cycle = this.#completions
    if (cycle && cycle.items[cycle.index] === this._input) {
      cycle.index = (cycle.index + 1) % cycle.items.length
      this._input = cycle.items[cycle.index]
      return
    }
    const items = this.#term.complete(this._input)
    if (items.length === 0) { this.#completions = null; return }
    this._input = items[0]
    this.#completions = items.length > 1 ? { items, index: 0 } : null
  }

  #cancelGhost() {
    this._ghost = ''
    if (this.#ghostTimer !== null) {
      clearTimeout(this.#ghostTimer)
      this.#ghostTimer = null
    }
  }

  #scheduleGhost() {
    this.#ghostTimer = setTimeout(() => {
      this.#ghostTimer = null
      this.#computeGhost()
    }, BundleTerminal.#GHOST_DELAY_MS)
  }

  #computeGhost() {
    // None while cycling. At a word boundary any first variant is a hint;
    // mid-token only where the typed text isn't a variant itself (`ls`
    // shouldn't tease `lsblk`; `lsb` should). Elsewhere it is too ambiguous.
    if (!this.#term || this.#completions) return
    const input = this._input
    const lastChar = input.slice(-1)
    const atBoundary = input === '' || lastChar === ' ' || lastChar === '|'
    const inToken = /[\w./]/u.test(lastChar)
    if (!atBoundary && !inToken) return
    const items = this.#term.complete(input)
    if (items.length === 0) return
    // Full-line replacements: only the tail beyond what's typed shows.
    const first = items[0]
    if (!first.startsWith(input) || first === input) return
    if (inToken && items.includes(input)) return
    this._ghost = first.slice(input.length)
  }

  // A run's asides (`notes`: hidden entries, a literal glob, a truncating
  // `head`) and the errors its command line silenced (silenced-gaps.js),
  // labelled so, as nothing else explains their absence from the
  // transcript. Gaps go last, so it is notes that overflow the stack.
  #pushHints(r) {
    const hints = r.notes.map((text) => ({ text, kind: 'note' }))
    for (const message of silencedGaps(r)) hints.push({ text: `silenced: ${message}`, kind: 'gap' })
    this.#pushNotes(hints)
  }

  // Each hint expires on its own timer.
  #pushNotes(notes) {
    if (notes.length === 0) return
    const next = [...this._notes]
    for (const { text, kind } of notes) {
      // A repeated note replaces the visible copy; its new id re-keys the
      // repeat() entry, restarting the CSS animation.
      const dup = next.findIndex((n) => n.text === text)
      if (dup !== -1) this.#dropNote(next, dup)
      next.push({ id: ++this.#noteSeq, text, kind, dwell: BundleTerminal.#noteDwell(text) })
    }
    while (next.length > BundleTerminal.#NOTE_MAX) this.#dropNote(next, 0)
    for (const note of next) {
      if (this.#noteTimers.has(note.id)) continue
      this.#noteTimers.set(note.id, setTimeout(() => this.#expireNote(note.id), note.dwell))
    }
    this._notes = next
  }

  // Hints run from ~45 characters to a few hundred: dwell scales with length.
  static #noteDwell(text) {
    return Math.min(10000, 3200 + text.length * 55)
  }

  #dropNote(stack, index) {
    const [note] = stack.splice(index, 1)
    this.#clearNoteTimer(note.id)
  }

  #clearNoteTimer(id) {
    const timer = this.#noteTimers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#noteTimers.delete(id)
  }

  #expireNote(id) {
    this.#noteTimers.delete(id)
    this._notes = this._notes.filter((n) => n.id !== id)
  }

  #clearNotes() {
    for (const timer of this.#noteTimers.values()) clearTimeout(timer)
    this.#noteTimers.clear()
    this._notes = []
  }

  #historyBack() {
    if (this.#history.length === 0) return
    if (this.#histIdx < 0) {
      this.#draft = this._input
      this.#histIdx = this.#history.length - 1
    } else {
      this.#histIdx = Math.max(0, this.#histIdx - 1)
    }
    this._input = this.#history[this.#histIdx]
  }

  #historyForward() {
    if (this.#histIdx < 0) return
    const next = this.#histIdx + 1
    if (next >= this.#history.length) {
      this.#histIdx = -1
      this._input = this.#draft
      this.#draft = ''
    } else {
      this.#histIdx = next
      this._input = this.#history[next]
    }
  }

  #onInput = (e) => { this._input = e.target.value }

  // A banner suggestion, to edit or submit; history navigation starts afresh.
  #runExample = (cmd) => {
    this._input = cmd
    this.#histIdx = -1
    this.#draft = ''
    this.focusInput()
  }

  // Click to focus, but not at the end of a drag-select, which focusing
  // would collapse. Chromium exposes a shadow root's selection on it,
  // Firefox on the document.
  #onClickOutput = () => {
    const sel = this.renderRoot.getSelection?.() ?? document.getSelection()
    if (sel && !sel.isCollapsed) return
    this.focusInput()
  }

  render() {
    return html`
      <!-- Rendered even when empty, so the first hint is announced. \`log\`,
           not \`status\`, whose implicit aria-atomic re-reads every hint. -->
      <div class="notes" role="log" aria-atomic="false">
        ${repeat(this._notes, (n) => n.id, (n) => html`<div class="note ${n.kind === 'gap' ? 'note-gap' : ''}" style=${styleMap({ '--dwell-out': `${n.dwell - BundleTerminal.#NOTE_FADE_MS}ms` })}>${n.text}</div>`)}
      </div>
      <div class="output" @click=${this.#onClickOutput}>
        ${this._lines.map((l) => this.#renderLine(l))}
      </div>
      <form class="form" @submit=${this.#onSubmit} aria-busy=${this._running ? 'true' : 'false'}>
        <span class="cwd">${this._cwd}</span><span class="sigil">$</span>
        <div class="input-wrap">
          ${this._ghost ? html`<div class="ghost" aria-hidden="true"><span class="ghost-pad">${this._input}</span>${this._ghost}</div>` : nothing}
          <input
            class="input"
            type="text"
            aria-label="Terminal command"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            .value=${this._input}
            @input=${this.#onInput}
            @keydown=${this.#onKeydown}
          />
        </div>
      </form>
    `
  }

  #renderLine(l) {
    if (l.kind === 'banner') {
      return html`<div class="banner">Virtual shell over the bundle source tree. Try ${l.commands.map((cmd, i) => html`${i > 0 ? ', ' : ''}\`<span class="cmd" @click=${() => this.#runExample(cmd)}>${cmd}</span>\``)}. ↑/↓ for history, Tab to complete.</div>`
    }
    // Real spaces around the sigil, not margins, so a copied line reads
    // `/sources $ ls` as it looks. Bound as expressions: the build's HTML
    // minifier may drop a bare space between tags.
    if (l.kind === 'prompt') {
      return html`<div class="line"><span class="cwd">${l.cwd}</span>${' '}<span class="sigil">$</span>${' '}${l.text}</div>`
    }
    if (l.kind === 'stdout') return this.#renderStdout(l)
    if (l.kind === 'stderr') return html`<pre class="stderr">${l.text}</pre>`
    return nothing
  }

  // A span per diff line, the newlines between them, so a copy yields the
  // exact bytes.
  #renderStdout(l) {
    if (!l.diff) return html`<pre class="stdout">${l.text}</pre>`
    const parts = l.diff.flatMap((d, i) => {
      const line = d.kind ? html`<span class="diff-${d.kind}">${d.text}</span>` : d.text
      return i === 0 ? [line] : ['\n', line]
    })
    return html`<pre class="stdout">${parts}</pre>`
  }
}

customElements.define('bundle-terminal', BundleTerminal)

// terminal-attach.js caches one per bundle, so tab switches keep its session.
export function createTerminalElement(sources, integrity) {
  const el = document.createElement('bundle-terminal')
  el.dataset.integrity = integrity ?? ''
  el.sources = sources
  return el
}
