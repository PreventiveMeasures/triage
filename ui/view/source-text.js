// Source text as Chromium can show it. It paints none of a run of text over
// 2^21 characters, so long text goes in as text nodes of at most 2^20. It
// lays out nothing wider than 2^25px either: at a code viewer's ch of about
// 7.5px, two for a tab or a wide glyph, a line over 2^25 / 15 characters may
// not fit, so a viewer wraps such a line whether it wraps lines or not.
export const TEXT_NODE_MAX = 2 ** 20
export const LONG_LINE = Math.floor(2 ** 25 / 15)

// Text as nodes of at most TEXT_NODE_MAX characters, a surrogate pair in one.
export function textNodes(text) {
  const nodes = []
  for (let from = 0; from < text.length;) {
    let to = Math.min(from + TEXT_NODE_MAX, text.length)
    if (to < text.length && text.codePointAt(to - 1) > 0xffff) to--
    nodes.push(text.slice(from, to))
    from = to
  }
  return nodes
}
