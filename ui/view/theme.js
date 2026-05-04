// Light/dark theme toggle. Default = dark; light is opt-in and
// persisted in localStorage under THEME_KEY. We do NOT honor the
// system `prefers-color-scheme` — dark-by-default is intentional (see
// the comment in styles/theme.css).
const THEME_KEY = 'deepview.theme'
// Sun glyph reads as "switch to light"; moon reads as "switch to dark".
// The glyph reflects what clicking would DO, not the current state —
// matches the affordance pattern used by most editors.
const ICON_LIGHT = '☀'
const ICON_DARK = '☾'

const btn = document.getElementById('theme-toggle')

function isLight() { return document.body.classList.contains('theme-light') }

function syncIcon() {
  // When in light mode, show moon (click → switch to dark).
  // When in dark mode, show sun (click → switch to light).
  btn.textContent = isLight() ? ICON_DARK : ICON_LIGHT
}

// Apply the persisted theme BEFORE first paint isn't possible from a
// deferred module — there will be a brief flash if the user has light
// mode set. Keeping the persistence here (rather than a blocking head
// script) trades that flash for a CSP that stays at `script-src 'self'`.
try {
  if (localStorage.getItem(THEME_KEY) === 'light') document.body.classList.add('theme-light')
} catch {}
syncIcon()

btn.addEventListener('click', () => {
  const next = !isLight()
  document.body.classList.toggle('theme-light', next)
  try { localStorage.setItem(THEME_KEY, next ? 'light' : 'dark') } catch {}
  syncIcon()
})
