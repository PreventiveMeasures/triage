// Bundle-source terminal UI — separate bundler entry point so the
// virtual-shell runtime (`@preventive/terminal`) and the lit
// component don't land in the main view.js bundle. `ui/view/
// terminal-attach.js` `await import('./terminal.js')`s this module
// lazily the first time the Terminal tab opens.
//
// The component is mostly scaffolding (scrollable output, an input
// row, ↑/↓ history, click-anywhere-to-focus). All pipeline / fs /
// command behavior lives in `@preventive/terminal`.

import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { createTerminal } from '@preventive/terminal'
// Imported as a text string at build time (see build.js — the
// lit-css-as-text plugin routes JS-side `.css` imports through the
// text loader). unsafeCSS wraps the literal in a CSSResult; the
// bytes are static, never user input.
import terminalCSS from './view/terminal.css'

// Banner suggestions. `ls` and `find /` are always present; the
// grep example surfaces the first symbol from SEARCH_SYMBOLS that
// actually appears in the bundle so the suggestion isn't a dead
// `grep` for a marker no one used (falling back to the first
// entry — `TODO` — when nothing matches or the bundle is empty).
// The `cat ... | head -n 20` example uses the shortest path from
// the bundle so it Just Works without the user having to invent a
// real file name; skipped entirely when the bundle has no files.
function bannerCommands(sources) {
  const symbol = pickSearchSymbol(sources)
  const cmds = ['ls', 'find /', `grep -r ${symbol} .`]
  if (!sources || sources.size === 0) return cmds
  let shortest = null
  for (const key of sources.keys()) {
    const p = stripLeading(key)
    if (shortest === null || p.length < shortest.length) shortest = p
  }
  if (shortest) cmds.push(`cat ${shortest} | head -n 20`)
  return cmds
}

// Priority list for the grep suggestion: code markers first
// (TODO/FIXME/etc., where a hit means something interesting to
// look at), then JS keywords (rougher "any code at all" probe),
// then `//` as a near-universal JS fallback. The first entry that
// matches any file content wins; `TODO` is the static default
// when nothing does.
const SEARCH_SYMBOLS = ['TODO', 'FIXME', 'XXX', 'HACK', 'NOTE', 'BUG', 'export', 'import', 'require', '//']

function pickSearchSymbol(sources) {
  if (!sources || sources.size === 0) return SEARCH_SYMBOLS[0]
  for (const symbol of SEARCH_SYMBOLS) {
    for (const content of sources.values()) {
      if (content.includes(symbol)) return symbol
    }
  }
  return SEARCH_SYMBOLS[0]
}

// The bundle map may key files with `./` or `/`-prefixed paths
// depending on how the source tree was assembled. Drop a single
// leading slash or `./` so the banner shows the clean form.
function stripLeading(path) {
  if (path.startsWith('./')) return path.slice(2)
  if (path.startsWith('/')) return path.slice(1)
  return path
}

class BundleTerminal extends LitElement {
  // Render-driving state stays as Lit reactive properties: Lit
  // installs prototype accessors that auto-`requestUpdate()` on
  // assignment, which `#`-private fields can't do. Everything else
  // (the shell handle, history bookkeeping, the saved draft) lives
  // in true `#`-private fields so a stray `el._term = …` poke from
  // another module can't perturb the component.
  static properties = {
    sources: { attribute: false },
    _lines: { state: true },
    _input: { state: true },
    _cwd: { state: true },
    // Faint "ghost" continuation rendered behind the input —
    // suffix-only, so the overlay span has a transparent copy of
    // `_input` to push it past the caret.
    _ghost: { state: true },
  }

  static styles = unsafeCSS(terminalCSS)

  #term = null
  #lastSources = null
  #history = []
  #histIdx = -1
  #draft = ''
  // Tab-completion cycle state. When `complete()` returns multiple
  // variants the first Tab fills in [0] and stashes the list here;
  // repeat Tabs rotate. Any input change invalidates the cycle —
  // the self-check `items[index] === _input` covers typing, history
  // navigation, and submit-reset without an explicit reset hook.
  #completions = null
  // Ghost-suggestion debounce. Each `_input` mutation reschedules
  // the timer; the suggestion only materialises ~200ms after typing
  // (or any other input change) settles. See #scheduleGhost.
  #ghostTimer = null
  // Window short enough to feel instant after a pause, long enough
  // that mid-burst typing doesn't trigger a compute every keystroke.
  static #GHOST_DELAY_MS = 200

  constructor() {
    super()
    this.sources = null
    this._lines = []
    this._input = ''
    this._cwd = '/'
    this._ghost = ''
  }

  // Bind to the current sources map: a Map reference change means
  // a different bundle, so we rebuild the shell and reset history.
  // Idempotent within a bundle — re-renders that pass the same
  // Map reference leave the running session alone.
  //
  // The second branch (an `_input` change) is what drives ghost-text
  // refresh: clear the prior suggestion and rearm the debounce.
  // Doing it here rather than in `#onInput` covers every path that
  // mutates the field — typing, history nav, Tab fill, submit-reset,
  // and the bundle-swap reset above — through a single seam.
  willUpdate(changed) {
    if (changed.has('sources') && this.sources !== this.#lastSources) {
      this.#term = this.sources ? createTerminal(this.sources) : null
      this._cwd = this.#term ? this.#term.cwd() : '/'
      this._lines = [{ kind: 'banner', commands: bannerCommands(this.sources) }]
      this.#history = []
      this.#histIdx = -1
      this.#draft = ''
      // An in-progress completion cycle is tied to the previous bundle's
      // FS / command list — keeping it would let a stale candidate
      // appear after the swap. Same reasoning for an unsubmitted input.
      this.#completions = null
      this._input = ''
      this.#lastSources = this.sources
    }
    if (changed.has('_input')) {
      this.#cancelGhost()
      this.#scheduleGhost()
    }
  }

  // Reconnecting after detach (tab flip Terminal → Code → Terminal,
  // and similar paths through terminal-attach.js's element cache)
  // resets the inner .output scrollTop — the browser clears it on
  // element removal, and no Lit update fires on reattach because
  // no reactive property changed. `updated()` therefore can't
  // restore it. Scroll to the latest output explicitly here;
  // updateComplete waits for the pending first render so
  // scrollHeight is meaningful, and on subsequent reconnects (no
  // pending update) it resolves immediately.
  connectedCallback() {
    super.connectedCallback()
    this.updateComplete.then(() => this.#scrollToBottom())
  }

  // The element is reused across tab flips (see terminal-attach.js),
  // so a pending ghost timer can outlive a detach. Cancel it — the
  // reattach path will reschedule on the next `_input` change.
  disconnectedCallback() {
    super.disconnectedCallback()
    this.#cancelGhost()
  }

  firstUpdated() { this.#focusInput() }

  // Only follow the bottom when output actually grew (a new command
  // ran, or the bundle / banner reset). Typing into the input
  // toggles `_input`, which used to fire scrollToBottom on every
  // keystroke and prevented the user from scrolling up to read
  // earlier output while composing the next command.
  updated(changed) {
    if (changed.has('_lines') || changed.has('sources')) this.#scrollToBottom()
  }

  #focusInput() {
    const input = this.renderRoot.querySelector('.input')
    if (input) input.focus()
  }

  #scrollToBottom() {
    const out = this.renderRoot.querySelector('.output')
    if (out) out.scrollTop = out.scrollHeight
  }

  #onSubmit = (e) => {
    e.preventDefault()
    if (!this.#term) return
    const line = this._input
    const trimmed = line.trim()
    // `clear` is a UI-only command — the shell module doesn't carry
    // it (a stateless CLI has nothing to clear). Mirrors bash's
    // built-in. Still recorded in history so ↑ recalls it.
    if (trimmed === 'clear') {
      this._lines = []
      this._input = ''
      if (trimmed.length > 0) this.#history = [...this.#history, line]
      this.#histIdx = -1
      return
    }
    const cwdBefore = this._cwd
    const r = this.#term.run(line)
    this._cwd = r.cwd
    const next = [...this._lines, { kind: 'prompt', cwd: cwdBefore, text: line }]
    if (r.stdout) next.push({ kind: 'stdout', text: r.stdout })
    if (r.stderr) next.push({ kind: 'stderr', text: r.stderr })
    this._lines = next
    if (trimmed.length > 0) this.#history = [...this.#history, line]
    this.#histIdx = -1
    this._input = ''
  }

  #onKeydown = (e) => {
    // Tab in a browser <input> normally tabs out to the next focusable
    // element. preventDefault keeps focus here and lets the shell's
    // completion drive the field instead. #onTab manages the cycle —
    // skip the reset below.
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); this.#onTab(); return }
    // Anything else — arrows, characters, Home/End, even bare modifier
    // taps — ends the current cycle. Without this, Tab+ArrowRight+Tab
    // would advance the previous cycle instead of starting a fresh one
    // (the cursor moved but `_input` didn't, so the items[index]
    // self-check still matched).
    this.#completions = null
    if (e.key === 'ArrowUp') { e.preventDefault(); this.#historyBack() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.#historyForward() }
    // Rearm the ghost debounce on every non-Tab key. willUpdate
    // catches keys that mutate `_input` (typing, history nav), but
    // cursor-only keys (ArrowLeft/Right, Home, End) and bare-cycle-
    // resets don't trip it — and after we clear `#completions` here
    // the ghost may newly become relevant. Double-arming on a
    // char key is harmless: the willUpdate path that follows just
    // resets the same timer.
    this.#cancelGhost()
    this.#scheduleGhost()
  }

  #onTab() {
    if (!this.#term) return
    const cycle = this.#completions
    // Self-check the cycle is still valid: if the field no longer
    // holds what we last filled in (user typed, history nav, etc.)
    // the cached items don't describe this input anymore.
    if (cycle && cycle.items[cycle.index] === this._input) {
      cycle.index = (cycle.index + 1) % cycle.items.length
      this._input = cycle.items[cycle.index]
      return
    }
    const items = this.#term.complete(this._input)
    if (items.length === 0) { this.#completions = null; return }
    this._input = items[0]
    // Only enter cycle mode when there's something to rotate
    // through — a unique completion is a one-shot fill.
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
    if (!this.#term) return
    // Cycling already commits the user's attention to one candidate
    // — the second-channel ghost would just be visual noise.
    if (this.#completions) return
    // Show only where the suggestion is useful and not noisy:
    //   - At a word boundary (empty / trailing space / trailing
    //     pipe) any valid first variant is a "what's next" hint.
    //   - Mid-token (last char in [\w./]), only when the typed
    //     text isn't already a valid completion on its own.
    //     Typing `ls` (a real command) shouldn't tease `lsblk`,
    //     but typing `lsb` (not a command) should.
    // Other trailing chars (`&`, `>`, redirects, etc.) drop out —
    // completion in those contexts is too ambiguous to surface as
    // a passive hint.
    const input = this._input
    const lastChar = input.slice(-1)
    const atBoundary = input === '' || lastChar === ' ' || lastChar === '|'
    const inToken = /[\w./]/u.test(lastChar)
    if (!atBoundary && !inToken) return
    const items = this.#term.complete(input)
    if (items.length === 0) return
    const first = items[0]
    // `complete()` returns full-line replacements; surface only the
    // tail beyond what's already typed. Defensive check on the
    // prefix in case the shell ever returns a non-prefix variant.
    if (!first.startsWith(input) || first === input) return
    // Mid-token: suppress the ghost if the typed text is itself one
    // of the completion variants — the user already has something
    // valid, so a "you could extend this" hint is just noise.
    if (inToken && items.includes(input)) return
    this._ghost = first.slice(input.length)
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

  // Banner-suggestion click: drop the example into the input and
  // focus, so the user can edit before submitting (or just hit
  // Enter). Reset history nav state — without that, the next
  // ArrowDown after a click would walk back to a stale `#draft`
  // captured before the click.
  #runExample = (cmd) => {
    this._input = cmd
    this.#histIdx = -1
    this.#draft = ''
    this.#focusInput()
  }

  // Click-anywhere-to-focus is convenient for "I want to type",
  // but unconditional refocus also fires at the end of a
  // drag-select — moving focus into the <input> collapses the
  // selection inside the shadow root and breaks copy. Bail when
  // a non-collapsed selection exists so the user can grab output
  // text. Chromium exposes selections inside shadow roots via
  // `shadowRoot.getSelection()`; Firefox surfaces them on the
  // document selection — check both.
  #onClickOutput = () => {
    const sel = this.renderRoot.getSelection?.() ?? document.getSelection()
    if (sel && !sel.isCollapsed) return
    this.#focusInput()
  }

  render() {
    return html`
      <div class="output" @click=${this.#onClickOutput}>
        ${this._lines.map((l) => this.#renderLine(l))}
      </div>
      <form class="form" @submit=${this.#onSubmit}>
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

  // Instance method so the banner branch can close over `this`
  // for the click handler. Prompts and stdout/stderr remain pure
  // markup — they don't need the component context.
  #renderLine(l) {
    if (l.kind === 'banner') {
      return html`<div class="banner">Virtual shell over the bundle source tree. Try ${l.commands.map((cmd, i) => html`${i > 0 ? ', ' : ''}\`<span class="cmd" @click=${() => this.#runExample(cmd)}>${cmd}</span>\``)}. ↑/↓ for history, Tab to complete.</div>`
    }
    if (l.kind === 'prompt') {
      return html`<div class="line"><span class="cwd">${l.cwd}</span><span class="sigil">$</span>${l.text}</div>`
    }
    if (l.kind === 'stdout') return html`<pre class="stdout">${l.text}</pre>`
    if (l.kind === 'stderr') return html`<pre class="stderr">${l.text}</pre>`
    return nothing
  }
}

customElements.define('bundle-terminal', BundleTerminal)

// Build a fresh `<bundle-terminal>` instance bound to the given
// sources map. Element lifetime is managed by the caller
// (ui/view/terminal-attach.js caches a single instance per bundle
// integrity so tab-switch rebuilds don't wipe the running session).
export function createTerminalElement(sources, integrity) {
  const el = document.createElement('bundle-terminal')
  el.dataset.integrity = integrity ?? ''
  el.sources = sources
  return el
}
