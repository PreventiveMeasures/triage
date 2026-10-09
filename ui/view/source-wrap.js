// Line wrap for the source viewer. The gutter is a column of its own with
// one row per line, kept level with the code by sharing its line height
// (see `.bundle-source-lineno-row`), so a wrapped line, which takes more
// than one row, would pull the two apart. Measure how many rows each line
// takes and give its gutter row as many line boxes, from generated line
// breaks: the rows still follow text flow, line for line. A line too long
// to lay out unwrapped wraps in either mode (`.bundle-source-long-line`).
// The same pass shows the bar's wrap toggle only where wrapping makes a
// difference.

const VIEWERS = '.bundle-code-main, .bundle-source-modal, .bundle-search-side'
const watched = new Map()
// Per viewer: the gutter rows given breaks, the code width they were
// measured at, and whether wrapping made a difference there.
const synced = new WeakMap()
let canvas = null

// Lit ref callback for `.bundle-source-lines`: called with each element as
// it renders, and with undefined as one leaves.
export function watchSourceWrap(lines) {
  // Lit clears the ref before it removes the element, so let go of the
  // ones that have gone once it has.
  if (!lines) { queueMicrotask(unwatchRemoved); return }
  unwatchRemoved()
  if (watched.has(lines)) return
  // Lit calls back before a new element's template joins the document,
  // when the code's scroller is not its parent yet.
  if (!lines.isConnected) {
    queueMicrotask(() => { if (lines.isConnected) watchSourceWrap(lines) })
    return
  }
  const pre = lines.querySelector(':scope > .bundle-source-code')
  if (!pre) return
  // A new file, its highlighting or the wrap mode can change the wrapping
  // at any size. Otherwise only the code's width can, not the code growing
  // taller as it does once lines wrap.
  const resize = new ResizeObserver(() => {
    if (synced.get(lines)?.width !== codeWidth(lines)) syncSourceWrap(lines)
  })
  resize.observe(pre)
  resize.observe(lines.parentElement)
  const mutation = new MutationObserver(() => syncSourceWrap(lines))
  mutation.observe(pre, { childList: true, subtree: true, characterData: true })
  mutation.observe(lines, { attributes: true, attributeFilter: ['class'] })
  watched.set(lines, () => { resize.disconnect(); mutation.disconnect() })
}

function unwatchRemoved() {
  for (const [element, stop] of watched) {
    if (!element.isConnected) { stop(); watched.delete(element) }
  }
}

// The width the code wraps at, in either mode: the scroller's, less the
// gutter and the code's own padding.
function codeWidth(lines) {
  const pre = lines.querySelector(':scope > .bundle-source-code')
  const gutter = lines.querySelector(':scope > .bundle-source-lineno-col')
  if (!pre || !gutter) return 0
  const style = getComputedStyle(pre)
  return lines.parentElement.clientWidth - gutter.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
}

function syncSourceWrap(lines) {
  const pre = lines.querySelector(':scope > .bundle-source-code')
  const gutter = lines.querySelector(':scope > .bundle-source-lineno-col')
  const width = codeWidth(lines)
  if (!pre || !gutter || !lines.isConnected || width <= 0) return
  const wrapped = lines.classList.contains('is-wrapped')
  // Rows are as tall as laid out: the line height rounded to the layout's
  // units, which over a line of thousands of rows adds up to more than a
  // row. A gutter row given no breaks takes one. Its computed height gives
  // that to six digits, where its rectangle loses precision far down a
  // long file.
  let pitch = parseFloat(getComputedStyle(pre).lineHeight)
  for (const row of gutter.children) {
    if (!row.style.getPropertyValue('--wrap-breaks')) { pitch = parseFloat(getComputedStyle(row).height); break }
  }
  const { rows, toggles } = measureLines(pre, width, wrapped, pitch)
  const previous = synced.get(lines)?.rows ?? new Set()
  const current = new Set()
  for (const [line, count] of rows) {
    const row = gutter.children[line]
    if (!row) continue
    // Each `\A` (the escape takes the space after it) ends a row; the last
    // space opens the final one, which a trailing break alone would not.
    const breaks = `"${'\\A '.repeat(count - 1)} "`
    if (row.style.getPropertyValue('--wrap-breaks') !== breaks) row.style.setProperty('--wrap-breaks', breaks)
    current.add(row)
  }
  for (const row of previous) if (!current.has(row)) row.style.removeProperty('--wrap-breaks')
  synced.set(lines, { rows: current, width })
  const toggle = lines.closest(VIEWERS)?.querySelector('[data-bundle-source-wrap]')
  if (toggle) toggle.hidden = !toggles
}

// The rows each wrapped line takes, by its 0-based index, and whether
// wrapping lines makes a difference: whether a line that wraps only when
// lines do is wider than the code wraps at. Only a line that could be is
// measured: no glyph is wider than 2ch, tabs included at the viewer's tab
// size of 2. Trailing whitespace hangs, so a line ends at its last other
// character, and a docs link's label or trailing spaces past the edge never
// wrap a line.
function measureLines(pre, width, wrapped, pitch) {
  const style = getComputedStyle(pre)
  canvas ??= document.createElement('canvas').getContext('2d')
  canvas.font = `${style.fontSize} ${style.fontFamily}`
  const limit = width / (2 * canvas.measureText('0').width)
  const candidates = []
  let first = null, last = null, length = 0, line = 0
  const end = () => {
    if (length > limit && last) candidates.push({ line, first, last })
    line++
    length = 0
    first = last = null
  }
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data
    for (let from = 0; from < text.length;) {
      const at = text.indexOf('\n', from)
      const stop = at === -1 ? text.length : at
      if (stop > from) {
        // A surrogate pair is one character, for its rectangle.
        first ??= { node, from, to: from + (text.codePointAt(from) > 0xffff ? 2 : 1) }
        let to = stop
        while (to > from && (text[to - 1] === ' ' || text[to - 1] === '\t')) to--
        if (to > from) last = { node, from: to - (to - 2 >= from && text.codePointAt(to - 2) > 0xffff ? 2 : 1), to }
        length += stop - from
      }
      if (at === -1) break
      end()
      from = at + 1
    }
  }
  end()
  const rows = new Map()
  const range = document.createRange()
  const rect = ({ node, from, to }) => {
    range.setStart(node, from)
    range.setEnd(node, to)
    return range.getBoundingClientRect()
  }
  const left = pre.getBoundingClientRect().left + pre.clientLeft + parseFloat(style.paddingLeft)
  let toggles = false
  for (const { line: index, first: start, last: finish } of candidates) {
    const long = !!start.node.parentElement.closest('.bundle-source-long-line')
    if (wrapped || long) {
      // The first and last characters sit on the line's first and last rows.
      const count = Math.round((rect(finish).top - rect(start).top) / pitch) + 1
      if (count > 1) rows.set(index, count)
      if (count > 1 && !long) toggles = true
    }
    // Within half a pixel: the widths come rounded differently.
    else if (!toggles && rect(finish).right - left > width + 0.5) toggles = true
  }
  return { rows, toggles }
}

// The line at the top of a viewer's code, to put back in place once its
// lines rewrap: returns the function that does.
export function keepSourceLine(toggle) {
  const scroller = toggle.closest(VIEWERS)?.querySelector('.bundle-source-code-wrap')
  const rows = scroller?.querySelectorAll('.bundle-source-lineno-row')
  if (!rows?.length) return () => {}
  const edge = scroller.getBoundingClientRect().top
  let high = rows.length - 1, low = 0
  while (low < high) {
    const middle = (low + high) >> 1
    if (rows[middle].getBoundingClientRect().bottom <= edge) low = middle + 1
    else high = middle
  }
  const row = rows[low]
  const offset = row.getBoundingClientRect().top - edge
  return () => {
    if (row.isConnected) scroller.scrollTop += row.getBoundingClientRect().top - edge - offset
  }
}
