// `<w95-taskbar>` — the W95 theme's taskbar along the foot of the screen,
// under the app's window (styles/theme.css): Start, which opens Home as
// the sidebar's wordmark does, the window's own button, held down as the
// active window's is, and the tray's clock. Hidden in every other theme,
// and the clock only ticks while it shows.
import { LitElement, html, unsafeCSS } from 'lit'
import { THEME_CHANGED, getTheme } from './theme.js'
import { goHome } from './ingest.js'
// Imported as a text string at build time, as theme-toggle.css is.
import taskbarCSS from './w95-taskbar.css'

const clockTime = date => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

class W95Taskbar extends LitElement {
  static properties = { _time: { state: true } }

  static styles = unsafeCSS(taskbarCSS)

  _timer = null

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener(THEME_CHANGED, this._onThemeChanged)
    this._onThemeChanged()
  }

  disconnectedCallback() {
    window.removeEventListener(THEME_CHANGED, this._onThemeChanged)
    this._stop()
    super.disconnectedCallback()
  }

  _onThemeChanged = () => {
    if (getTheme() === 'w95') { if (this._timer === null) this._tick() } else this._stop()
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

  render() {
    return html`<button type="button" class="start" @click=${() => void goHome()}><span class="logo" aria-hidden="true"></span>Start</button>
      <span class="task" aria-hidden="true"><span class="task-icon"></span>Triage</span>
      <span class="tray"><time>${this._time}</time></span>`
  }
}

customElements.define('w95-taskbar', W95Taskbar)
