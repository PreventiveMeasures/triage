// `<w95-desktop>` — what the W95 theme draws around the app's window
// (styles/w95.css): the desktop's icons in a column at its left, and the
// taskbar along the foot of the screen. My Computer opens Home, as the
// sidebar's wordmark does — on a double click, as a desktop icon opens,
// or on a key or a screen reader's press; a single click picks it. The
// Recycle Bin is only there to be seen. The taskbar holds Start, which
// opens Home too, the window's own button held down as the active
// window's is, and the tray's clock. Hidden in every other theme, and the
// clock only ticks while it shows.
import { LitElement, html, svg, unsafeCSS } from 'lit'
import { THEME_CHANGED, getTheme } from './theme.js'
import { goHome } from './ingest.js'
// Imported as a text string at build time, as theme-toggle.css is.
import desktopCSS from './w95-desktop.css'

const clockTime = date => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// Drawn on Windows 95's 32px grid in its 16 colours: a monitor on its
// system unit, and the wire bin.
const COMPUTER_ICON = svg`<svg viewBox="0 0 32 32" width="32" height="32" shape-rendering="crispEdges" aria-hidden="true">
  <path d="M5.5 2.5h21v18h-21z" fill="#c0c0c0" stroke="#000"/>
  <path d="M6 3h20M6 3v17" stroke="#fff"/>
  <path d="M8.5 5.5h15v12h-15z" fill="#008080" stroke="#808080"/>
  <path d="M9 6h14v1H9z" fill="#00a0a0"/>
  <path d="M12.5 20.5h7v2h-7z" fill="#808080" stroke="#000"/>
  <path d="M2.5 22.5h27v7h-27z" fill="#c0c0c0" stroke="#000"/>
  <path d="M3 23h26M3 23v6" stroke="#fff"/>
  <path d="M5 26h8v1H5z" fill="#000"/>
  <path d="M24 25h3v2h-3z" fill="#00ff00"/>
</svg>`
const BIN_ICON = svg`<svg viewBox="0 0 32 32" width="32" height="32" shape-rendering="crispEdges" aria-hidden="true">
  <path d="M7.5 7.5h17l-2 22h-13z" fill="#c0c0c0" stroke="#000"/>
  <path d="M11.5 10v17M14.5 10v18M17.5 10v18M20.5 10v17" stroke="#808080"/>
  <path d="M9 10h14M10 14h12M10 18h12M10 22h12M11 26h10" stroke="#fff"/>
  <path d="M5.5 4.5h21v3h-21z" fill="#dfdfdf" stroke="#000"/>
</svg>`

class W95Desktop extends LitElement {
  static properties = { _time: { state: true }, _picked: { state: true } }

  static styles = unsafeCSS(desktopCSS)

  _timer = null
  _picked = null

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener(THEME_CHANGED, this._onThemeChanged)
    window.addEventListener('pointerdown', this._onPointerDown, true)
    this._onThemeChanged()
  }

  disconnectedCallback() {
    window.removeEventListener(THEME_CHANGED, this._onThemeChanged)
    window.removeEventListener('pointerdown', this._onPointerDown, true)
    this._stop()
    super.disconnectedCallback()
  }

  _onThemeChanged = () => {
    if (getTheme() === 'w95') { if (this._timer === null) this._tick() } else this._stop()
  }

  // A press anywhere but on an icon puts the picked one down.
  _onPointerDown = (event) => {
    if (this._picked !== null && !event.composedPath().some(node => node instanceof Element && node.classList.contains('icon'))) this._picked = null
  }

  // Shows the time, then wakes again as the next minute turns.
  _tick = () => {
    const now = new Date()
    this._time = clockTime(now)
    this._timer = setTimeout(this._tick, 60_000 - now.getSeconds() * 1000 - now.getMilliseconds())
  }

  _stop() {
    clearTimeout(this._timer)
    this._timer = null
  }

  // A mouse's single click picks My Computer; a key's or a screen
  // reader's press (no click count) opens it, as a double click does.
  _onComputerClick = (event) => {
    if (event.detail === 0) void goHome()
    else this._picked = 'computer'
  }

  render() {
    return html`<div class="icons">
        <button type="button" class=${`icon${this._picked === 'computer' ? ' picked' : ''}`} aria-label="My Computer: open Home"
          @click=${this._onComputerClick} @dblclick=${() => void goHome()}>${COMPUTER_ICON}<span class="label">My Computer</span></button>
        <div class=${`icon${this._picked === 'bin' ? ' picked' : ''}`} aria-hidden="true"
          @pointerdown=${() => { this._picked = 'bin' }}>${BIN_ICON}<span class="label">Recycle Bin</span></div>
      </div>
      <div class="taskbar">
        <button type="button" class="start" @click=${() => void goHome()}><span class="logo" aria-hidden="true"></span>Start</button>
        <span class="task" aria-hidden="true"><span class="task-icon"></span>Triage</span>
        <span class="tray"><time>${this._time}</time></span>
      </div>`
  }
}

customElements.define('w95-desktop', W95Desktop)
