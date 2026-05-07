// Light/dark theme toggle, implemented as a Lit custom element
// (`<theme-toggle>`). Default = dark; light is opt-in and persisted in
// localStorage under THEME_KEY. We do NOT honor the system
// `prefers-color-scheme` — dark-by-default is intentional (see the
// comment in styles/theme.css).
import { LitElement, html, unsafeCSS } from 'lit'
// Imported as a text string at build time (see build.js — the
// lit-css-as-text plugin routes JS-side `.css` imports through the
// text loader). unsafeCSS just wraps the literal in a CSSResult; the
// bytes are static, never user input.
import themeToggleCSS from './theme-toggle.css'

const THEME_KEY = 'deepview.theme'
// Sun glyph reads as "switch to light"; moon reads as "switch to dark".
// The glyph reflects what clicking would DO, not the current state —
// matches the affordance pattern used by most editors.
const ICON_LIGHT = '☀'
const ICON_DARK = '☾'

// Apply the persisted theme at module evaluation time so the body class
// is set before the custom element is upgraded. Same flash trade-off as
// the previous implementation (see comment in render() below).
try {
  if (localStorage.getItem(THEME_KEY) === 'light') document.body.classList.add('theme-light')
} catch {}

class ThemeToggle extends LitElement {
  static properties = { _light: { state: true } }

  static styles = unsafeCSS(themeToggleCSS)

  constructor() {
    super()
    let light = false
    try { light = localStorage.getItem(THEME_KEY) === 'light' } catch {}
    this._light = light
  }

  connectedCallback() {
    super.connectedCallback()
    // ARIA — host element acts as the button.
    if (!this.hasAttribute('role')) this.setAttribute('role', 'button')
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'toggle theme')
    if (!this.hasAttribute('title')) this.setAttribute('title', 'toggle light/dark theme')
    this.addEventListener('click', this._toggle)
    this.addEventListener('keydown', this._onKeydown)
  }

  disconnectedCallback() {
    this.removeEventListener('click', this._toggle)
    this.removeEventListener('keydown', this._onKeydown)
    super.disconnectedCallback()
  }

  _toggle = () => {
    this._light = !this._light
    document.body.classList.toggle('theme-light', this._light)
    try { localStorage.setItem(THEME_KEY, this._light ? 'light' : 'dark') } catch {}
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      this._toggle()
    }
  }

  render() {
    // When in light mode, show moon (click → switch to dark).
    // When in dark mode, show sun (click → switch to light).
    return html`${this._light ? ICON_DARK : ICON_LIGHT}`
  }
}

customElements.define('theme-toggle', ThemeToggle)
