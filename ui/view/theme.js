// The selected theme persists; the six-press counter and green/pink unlock
// live only in this module and reset on reload. Dark remains the default.
import { LitElement, html, unsafeCSS } from 'lit'
import { ensureHostAria } from './host-aria.js'
import { playScreenCrack } from './screen-crack.js'
// Imported as a text string at build time (see build.js — the
// lit-css-as-text plugin routes JS-side `.css` imports through the
// text loader). unsafeCSS just wraps the literal in a CSSResult; the
// bytes are static, never user input.
import themeToggleCSS from './theme-toggle.css'

const THEME_KEY = 'deepview.theme'

// Canonical theme list. `dark` is the default (no body class). The
// rest map to `body.theme-${name}` blocks in styles/theme.css.
const THEMES = Object.freeze(['dark', 'light', 'green', 'pink'])
const UNLOCKED_CYCLE = Object.freeze(['green', 'pink', 'light', 'dark'])

// Per-theme `<meta name="theme-color">` values. `base` paints the
// WCO title-bar / Android browser chrome normally. `dim` swaps in
// while the print-preview scrim is open: Chrome paints the scrim
// over the web-contents rect but not the WCO strip (driven by
// `theme-color`), so without the swap the title bar stays bright and
// the seam reads as a bug. Pre-darkened rather than one alpha
// because alpha doesn't map the same across light and dark bases,
// and the scrim isn't exposed to CSS. Droppable if the browser ever
// exposes the scrim.
const THEME_COLOR = {
  dark:  { base: '#1a1a1b', dim: '#0a0a0a' },
  light: { base: '#f6f6fa', dim: '#646464' },
  green: { base: '#0a140a', dim: '#050a05' },
  pink:  { base: '#ffe4ee', dim: '#a3727f' },
}

// Sun glyph reads as "switch to light"; moon reads as "switch to dark".
// The glyph reflects what clicking would DO, not the current state —
// matches the affordance pattern used by most editors.
const ICONS = { light: '☀', dark: '☾', green: '☘', pink: '✿' }

// Fires on every applyTheme call (including the boot-time replay).
// The toggle button listens so its icon stays in sync when an
// external `DeepView.setTheme(...)` swaps the theme out from under it.
const THEME_CHANGED = 'deepview-theme-changed'

let currentTheme = 'dark'
let printDialogOpen = false
let themePresses = 0
let themesUnlocked = false
let themeUnlocking = false
let themeSelectionVersion = 0

function nextTheme() {
  if (!themesUnlocked) return currentTheme === 'light' ? 'dark' : 'light'
  return UNLOCKED_CYCLE[(UNLOCKED_CYCLE.indexOf(currentTheme) + 1) % UNLOCKED_CYCLE.length]
}

function announceTheme() {
  window.dispatchEvent(new CustomEvent(THEME_CHANGED, { detail: { theme: currentTheme } }))
}

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
  // at all on body.
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
  announceTheme()
}

// Apply the persisted theme at module evaluation time so the body
// class is set before any custom element upgrades. Flash trade-off:
// a stored non-dark theme briefly paints over default-dark before
// this runs.
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
  if (!THEMES.includes(name)) throw new TypeError('unknown theme')
  themeSelectionVersion++
  applyTheme(name)
}
export function getTheme() { return currentTheme }

class ThemeToggle extends LitElement {
  static properties = { _nextTheme: { state: true } }

  static styles = unsafeCSS(themeToggleCSS)

  constructor() {
    super()
    this._nextTheme = nextTheme()
  }

  connectedCallback() {
    super.connectedCallback()
    // ARIA — host element acts as the button.
    ensureHostAria(this, { role: 'button', tabindex: '0', 'aria-label': 'toggle theme' })
    this.addEventListener('click', this._toggle)
    this.addEventListener('keydown', this._onKeydown)
    // External theme swaps (DeepView.setTheme, or another tab via
    // storage events someday) need to update the icon so the
    // affordance the button promises stays accurate.
    window.addEventListener(THEME_CHANGED, this._onThemeChanged)
    this._onThemeChanged()
  }

  disconnectedCallback() {
    window.removeEventListener(THEME_CHANGED, this._onThemeChanged)
    this.removeEventListener('click', this._toggle)
    this.removeEventListener('keydown', this._onKeydown)
    super.disconnectedCallback()
  }

  _onThemeChanged = () => {
    this._nextTheme = nextTheme()
    this.setAttribute('aria-disabled', String(themeUnlocking))
  }

  _toggle = () => {
    if (themeUnlocking) return
    if (!themesUnlocked && ++themePresses === 6) {
      themesUnlocked = true
      themeUnlocking = true
      announceTheme()
      const versionAtStart = themeSelectionVersion
      const reveal = () => {
        // An explicit API selection during the effect still takes precedence.
        if (themeSelectionVersion === versionAtStart) applyTheme('green')
      }
      const complete = () => { themeUnlocking = false; announceTheme() }
      try {
        void playScreenCrack(reveal).catch(reveal).finally(complete)
      } catch {
        reveal()
        complete()
      }
      return
    }
    applyTheme(nextTheme())
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!e.repeat) this._toggle()
    }
  }

  render() {
    return html`${ICONS[this._nextTheme]}`
  }
}

customElements.define('theme-toggle', ThemeToggle)
