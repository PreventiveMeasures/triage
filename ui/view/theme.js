// Theme system + the dark/light toggle button. Defaults to dark;
// other themes are opt-in and persisted under THEME_KEY. The
// `<theme-toggle>` element only ever cycles dark↔light — the
// green / pink easter-egg themes are reachable only via
// `DeepView.setTheme(name)` (see view/api.js). We do NOT honor the
// system `prefers-color-scheme` — dark-by-default is intentional
// (see the comment in styles/theme.css).
import { LitElement, html, unsafeCSS } from 'lit'
// Imported as a text string at build time (see build.js — the
// lit-css-as-text plugin routes JS-side `.css` imports through the
// text loader). unsafeCSS just wraps the literal in a CSSResult; the
// bytes are static, never user input.
import themeToggleCSS from './theme-toggle.css'

const THEME_KEY = 'deepview.theme'

// Canonical theme list. `dark` is the default (no body class). The
// rest map to `body.theme-${name}` blocks in styles/theme.css.
const THEMES = Object.freeze(['dark', 'light', 'green', 'pink'])

// Per-theme `<meta name="theme-color">` values. `base` paints the
// WCO title-bar / Android browser chrome in normal mode. `dim` is a
// pre-darkened variant we swap to while the print-preview scrim is
// open — Chrome paints the scrim over the web-contents rect but not
// over the WCO strip (whose colour is driven by `theme-color`), so
// without the swap the title bar stays at full brightness and the
// seam between it and the dimmed page reads as a bug. The composite-
// vs-alpha approach is intentional: a single alpha doesn't map the
// same way across light and dark base colours, and the scrim itself
// isn't exposed to CSS or the page. If the browser ever exposes it
// we can drop this.
const THEME_COLOR = {
  dark:  { base: '#1a1a1b', dim: '#0a0a0a' },
  light: { base: '#f6f6fa', dim: '#646464' },
  green: { base: '#0a140a', dim: '#050a05' },
  pink:  { base: '#ffe4ee', dim: '#a3727f' },
}

// Sun glyph reads as "switch to light"; moon reads as "switch to dark".
// The glyph reflects what clicking would DO, not the current state —
// matches the affordance pattern used by most editors.
const ICON_LIGHT = '☀'
const ICON_DARK = '☾'

// Fires on every applyTheme call (including the boot-time replay).
// The toggle button listens so its icon stays in sync when an
// external `DeepView.setTheme(...)` swaps the theme out from under it.
const THEME_CHANGED = 'deepview-theme-changed'

let currentTheme = 'dark'
let printDialogOpen = false

function readStored() {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return THEMES.includes(v) ? v : 'dark'
  } catch { return 'dark' }
}

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'dark'
  currentTheme = name
  // Wipe every named theme class so back-to-back swaps don't leave
  // stale classes layered (e.g. switching green → light must clear
  // `theme-green` first). `dark` is the implicit default — no class
  // at all on body, same as the legacy behaviour.
  for (const t of THEMES) if (t !== 'dark') document.body.classList.remove(`theme-${t}`)
  if (name !== 'dark') document.body.classList.add(`theme-${name}`)
  try {
    if (name === 'dark') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, name)
  } catch {}
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const { base, dim } = THEME_COLOR[name]
    meta.setAttribute('content', printDialogOpen ? dim : base)
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGED, { detail: { theme: name } }))
}

// Apply the persisted theme at module evaluation time so the body
// class is set before any custom element upgrades. Same flash trade-
// off as the previous boolean implementation: a stored non-dark
// theme briefly paints over default-dark before this runs.
applyTheme(readStored())

window.addEventListener('beforeprint', () => {
  printDialogOpen = true
  applyTheme(currentTheme)
})
window.addEventListener('afterprint', () => {
  printDialogOpen = false
  applyTheme(currentTheme)
})

// Public API — wired into `DeepView` from view/api.js. `setTheme`
// throws on an unknown name so a typo in the console doesn't silently
// fall back to dark (which would also clobber the persisted theme).
export function setTheme(name) {
  if (!THEMES.includes(name)) {
    throw new TypeError(
      `DeepView.setTheme: unknown theme ${JSON.stringify(name)} ` +
      `(expected one of ${THEMES.map((t) => JSON.stringify(t)).join(', ')})`,
    )
  }
  applyTheme(name)
}
export function getTheme() { return currentTheme }
export const themes = THEMES

class ThemeToggle extends LitElement {
  static properties = { _light: { state: true } }

  static styles = unsafeCSS(themeToggleCSS)

  constructor() {
    super()
    // Reads document state rather than the persisted theme so a
    // green / pink workspace lands on `false` and the button shows
    // ☀ ("click to go light"). Click handler does the same read so
    // the click always behaves correctly regardless of how we got
    // into the current theme.
    this._light = document.body.classList.contains('theme-light')
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
    // External theme swaps (DeepView.setTheme, or another tab via
    // storage events someday) need to update the icon so the
    // affordance the button promises stays accurate.
    window.addEventListener(THEME_CHANGED, this._onThemeChanged)
  }

  disconnectedCallback() {
    window.removeEventListener(THEME_CHANGED, this._onThemeChanged)
    this.removeEventListener('click', this._toggle)
    this.removeEventListener('keydown', this._onKeydown)
    super.disconnectedCallback()
  }

  _onThemeChanged = () => {
    this._light = document.body.classList.contains('theme-light')
  }

  // Only ever lands on dark or light — picking green / pink is
  // intentionally locked behind the DeepView API. Reading the
  // document state (not `this._light`) makes a click from a non-
  // light easter-egg theme do the right thing: switch to light.
  _toggle = () => {
    const nowLight = document.body.classList.contains('theme-light')
    applyTheme(nowLight ? 'dark' : 'light')
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      this._toggle()
    }
  }

  render() {
    // When in light mode, show moon (click → switch to dark).
    // Otherwise, show sun (click → switch to light).
    return html`${this._light ? ICON_DARK : ICON_LIGHT}`
  }
}

customElements.define('theme-toggle', ThemeToggle)
