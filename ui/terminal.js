// Bundle-source terminal UI — separate esbuild entry point so the
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

const BANNER = 'Virtual shell over the bundle source tree. Try `ls`, `find /`, `grep TODO src/...`, `cat src/foo.js | head -n 20`. ↑/↓ for history.'

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
  }

  static styles = unsafeCSS(terminalCSS)

  #term = null
  #lastSources = null
  #history = []
  #histIdx = -1
  #draft = ''

  constructor() {
    super()
    this.sources = null
    this._lines = []
    this._input = ''
    this._cwd = '/'
  }

  // Bind to the current sources map: a Map reference change means
  // a different bundle, so we rebuild the shell and reset history.
  // Idempotent within a bundle — re-renders that pass the same
  // Map reference leave the running session alone.
  willUpdate(changed) {
    if (!changed.has('sources') || this.sources === this.#lastSources) return
    this.#term = this.sources ? createTerminal(this.sources) : null
    this._cwd = this.#term ? this.#term.cwd() : '/'
    this._lines = [{ kind: 'banner', text: BANNER }]
    this.#history = []
    this.#histIdx = -1
    this.#draft = ''
    this.#lastSources = this.sources
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
    if (e.key === 'ArrowUp') { e.preventDefault(); this.#historyBack() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.#historyForward() }
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
        ${this._lines.map((l) => renderLine(l))}
      </div>
      <form class="form" @submit=${this.#onSubmit}>
        <span class="cwd">${this._cwd}</span><span class="sigil">$</span>
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
      </form>
    `
  }
}

function renderLine(l) {
  if (l.kind === 'banner') return html`<div class="banner">${l.text}</div>`
  if (l.kind === 'prompt') {
    return html`<div class="line"><span class="cwd">${l.cwd}</span><span class="sigil">$</span>${l.text}</div>`
  }
  if (l.kind === 'stdout') return html`<pre class="stdout">${l.text}</pre>`
  if (l.kind === 'stderr') return html`<pre class="stderr">${l.text}</pre>`
  return nothing
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
