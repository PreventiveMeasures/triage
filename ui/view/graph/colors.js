export const GRAPH_BACKGROUNDS = { dark: '#0c0c0c', light: '#f6f8fa', pink: '#fff0f7', paper: '#fff' }

export function graphBackground() {
  const classes = typeof document === 'undefined' ? null : document.body?.classList
  if (classes?.contains('theme-paper')) return GRAPH_BACKGROUNDS.paper
  if (classes?.contains('theme-pink')) return GRAPH_BACKGROUNDS.pink
  if (classes?.contains('theme-light')) return GRAPH_BACKGROUNDS.light
  return GRAPH_BACKGROUNDS.dark
}

// Shared by Layers and Size flow: choose text against the opaque package
// fill, rather than using the surrounding page's foreground color.
export function textOnPackage(color) {
  const channels = [1, 3, 5].map((offset) => {
    const c = parseInt(color.slice(offset, offset + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return luminance > 0.18 ? '#000' : '#fff'
}

