// The selected theme persists; the press counters and bonus-theme unlocks live
// only in this module and reset on reload. Dark remains the default.
import { LitElement, html, unsafeCSS } from 'lit'
import { ensureHostAria } from './host-aria.js'
import { playScreenCrack } from './screen-crack.js'
import themeToggleCSS from './theme-toggle.css'

const THEME_KEY = 'deepview.theme'

// `dark` is the default, with no body class; the rest are
// `body.theme-${name}` in styles/theme.css.
const THEMES = Object.freeze(['dark', 'light', 'green', 'pink', 'w95', 'paper'])
const UNLOCKED_CYCLE = Object.freeze(['dark', 'green', 'pink', 'w95', 'paper', 'light'])
// W95 joins the unlocked cycle, after pink, once the toggle itself has
// turned green into pink this many times on the page. Landing on pink any
// other way (a reload, the API) doesn't count.
const W95_PINK_TURNS = 3

// `<meta name="theme-color">` per theme: `base` for the WCO title bar /
// Android browser chrome, `dim` while the print preview's scrim is up —
// Chrome draws the scrim over the page but not the strip `theme-color`
// paints, and the seam would read as a bug. Pre-darkened, as one alpha maps
// differently over light and dark bases (the scrim isn't exposed to CSS).
const THEME_COLOR = {
  dark:  { base: '#1a1a1b', dim: '#0a0a0a' },
  light: { base: '#f6f6fa', dim: '#646464' },
  // Native title bars use the opaque RGB of each sidebar's --surface;
  // the overlay strip keeps its existing --theme-bar color.
  green: { base: '#0a140a', dim: '#050a05', sidebar: '#0f1e0f' },
  pink:  { base: '#ffe4ee', dim: '#a3727f', sidebar: '#ffe0f0' },
  // W95's is its title bar's navy, the strip an installed app's own
  // controls sit on.
  w95:   { base: '#000080', dim: '#000033' },
  paper: { base: '#ffffff', dim: '#666666' },
}

const overlayMode = window.matchMedia?.('(display-mode: window-controls-overlay)')
const standaloneMode = window.matchMedia?.('(display-mode: standalone)')
const windowControlsOverlay = window.navigator?.windowControlsOverlay

const ICONS = { light: '☀', dark: '☾', green: '🕶️', pink: '✿', w95: '⊞', paper: '📄' }

// Fired on every applyTheme, so the toggle's glyph follows an external
// `DeepView.setTheme(...)`.
const THEME_CHANGED = 'deepview-theme-changed'

let currentTheme = 'dark'
let printDialogOpen = false
let themePresses = 0
let themesUnlocked = false
let themeUnlocking = false
let themeSelectionVersion = 0
let pinkTurns = 0
let w95Unlocked = false

// The next theme of the cycle, without w95 while it is locked; w95 chosen
// through the API meanwhile steps on as from pink, to what follows it.
function nextTheme() {
  if (!themesUnlocked) return currentTheme === 'light' ? 'dark' : 'light'
  const cycle = w95Unlocked ? UNLOCKED_CYCLE : UNLOCKED_CYCLE.filter(theme => theme !== 'w95')
  const from = cycle.includes(currentTheme) ? currentTheme : 'pink'
  return cycle[(cycle.indexOf(from) + 1) % cycle.length]
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

function updateThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const { base, dim, sidebar } = THEME_COLOR[currentTheme]
  const collapsed = windowControlsOverlay?.visible ?? overlayMode?.matches ?? false
  const normalTitlebar = (standaloneMode?.matches || overlayMode?.matches) && !collapsed
  meta.setAttribute('content', printDialogOpen ? dim : normalTitlebar && sidebar ? sidebar : base)
}

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'dark'
  currentTheme = name
  for (const t of THEMES) if (t !== 'dark') document.body.classList.remove(`theme-${t}`)
  if (name !== 'dark') document.body.classList.add(`theme-${name}`)
  try {
    if (name === 'dark') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, name)
  } catch {}
  updateThemeColor()
  announceTheme()
}

// At module evaluation, so the body class is set before any custom element
// upgrades (a stored non-dark theme still briefly paints over dark first).
applyTheme(readStored())

// The user can collapse or restore the native title bar without reloading.
overlayMode?.addEventListener('change', updateThemeColor)
standaloneMode?.addEventListener('change', updateThemeColor)
windowControlsOverlay?.addEventListener('geometrychange', updateThemeColor)

window.addEventListener('beforeprint', () => {
  printDialogOpen = true
  applyTheme(currentTheme)
})
window.addEventListener('afterprint', () => {
  printDialogOpen = false
  applyTheme(currentTheme)
})

// `DeepView` API (view/api.js). An unknown name throws rather than silently
// falling back to dark, which would also clobber the persisted theme.
export function setTheme(name) {
  if (!THEMES.includes(name)) throw new TypeError('unknown theme')
  themeSelectionVersion++
  applyTheme(name)
}
export function getTheme() { return currentTheme }

class ThemeToggle extends LitElement {
  static properties = { _theme: { state: true } }

  static styles = unsafeCSS(themeToggleCSS)

  constructor() {
    super()
    this._theme = currentTheme
  }

  connectedCallback() {
    super.connectedCallback()
    // The host is the button.
    ensureHostAria(this, { role: 'button', tabindex: '0', 'aria-label': 'toggle theme' })
    this.addEventListener('click', this._toggle)
    this.addEventListener('keydown', this._onKeydown)
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
    this._theme = currentTheme
    this.setAttribute('aria-disabled', String(themeUnlocking))
  }

  _toggle = () => {
    if (themeUnlocking) return
    // From the eighth press onward, the first activation from dark cracks into green.
    if (!themesUnlocked && ++themePresses >= 8 && currentTheme === 'dark') {
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
    const next = nextTheme()
    if (currentTheme === 'green' && next === 'pink' && ++pinkTurns >= W95_PINK_TURNS) w95Unlocked = true
    applyTheme(next)
  }

  _onKeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!e.repeat) this._toggle()
    }
  }

  render() {
    return html`${ICONS[this._theme]}`
  }
}

customElements.define('theme-toggle', ThemeToggle)
