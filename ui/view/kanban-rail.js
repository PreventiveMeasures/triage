// `<kanban-rail>` — the finding dialog's same-column rail, drawn a
// screen at a time.
//
// A column can hold thousands of findings, and building every one of
// their cards each time the dialog opened was most of its wait. So the
// rail draws the cards in view and a screen's worth either side of
// them, and two spacers stand in for the rest: one above the first card
// drawn, one below the last.
//
// The spacers need the cards' heights, which wrap with their titles. A
// card drawn is measured and its height kept; one never drawn is taken
// to be as tall as the average of those that were. What a guess gets
// wrong comes right as the card is drawn, and the rail puts the card the
// reader was looking at back where it was, however much the cards above
// it grew or shrank. By hand: Safari has no scroll anchoring to do it,
// and findings.css turns the other browsers' off here so the two don't
// both move the list.
//
// It keeps the open finding's card in view as the dialog moves to
// another — nearest, as `scrollIntoView` would, which can't be asked of
// a card that isn't drawn.
//
// The host is the scroller, in light DOM so the page's card styles and
// click delegates (events.js `[data-kanban-select]`) reach the cards.
// `renderItem` gives each item exactly one element.
import { LitElement, html, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'

// A card's height before any has been measured.
const FIRST_GUESS = 48
// Measure-and-redraw passes in a row before the rail stops trying to
// cover its view. Each pass draws with better guesses than the last, so
// two settle it; the cap only guards against heights that keep changing.
const MAX_PASSES = 4

// Each item's top, and after the last, the list's height: item `i`
// runs from `tops[i]` to `tops[i + 1]`.
export function itemTops(count, heightOf) {
  const tops = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) tops[i + 1] = tops[i] + heightOf(i)
  return tops
}

// The item at `y`: the first that reaches below it, clamped to the list.
export function indexAt(tops, y) {
  let lo = 0
  let hi = tops.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid + 1] > y) hi = mid
    else lo = mid + 1
  }
  return Math.max(0, lo)
}

// The items to draw in a view `height` tall, scrolled to `top`: those in
// it, and a view's worth either side. `to` is one past the last.
export function drawnRange(tops, top, height) {
  const count = tops.length - 1
  if (count === 0) return { from: 0, to: 0 }
  return { from: indexAt(tops, top - height), to: Math.min(count, indexAt(tops, top + 2 * height) + 1) }
}

// Where to scroll a view `height` tall, scrolled to `top`, to bring item
// `index` into it: no further than that takes, as `scrollIntoView({
// block: 'nearest' })` goes. An item taller than the view shows its top.
export function nearestTop(tops, index, top, height) {
  if (tops[index] < top) return tops[index]
  if (tops[index + 1] > top + height) return Math.min(tops[index], tops[index + 1] - height)
  return top
}

class KanbanRail extends LitElement {
  static properties = {
    items: { attribute: false },
    activeKey: { attribute: false },
    keyOf: { attribute: false },
    renderItem: { attribute: false },
  }

  constructor() {
    super()
    this.items = []
    this.activeKey = null
    this.keyOf = item => item
    this.renderItem = () => nothing
    // Measured heights by key, and their sum, for the guess.
    this._heights = new Map()
    this._total = 0
    // Each list's keys, and the tops last worked out for one: a scroll
    // event asks for them, and a column's keys are thousands of calls
    // to `keyOf`. Heights changing bumps `_version`, which stales them.
    this._keys = new WeakMap()
    this._version = 0
    this._tops = null
    this._range = { from: 0, to: 0 }
    // Where the list goes once drawn: the card the reader was looking at,
    // held where it was, or the open finding's, brought into view.
    this._hold = null
    this._goal = null
    // The held card, worked out before the heights were let go (below).
    this._carried = null
    // The open finding changed while the rail had no height to show it
    // in; it's brought into view once the rail has one.
    this._reveal = false
    this._passes = 0
    this.addEventListener('scroll', () => {
      if (!this.isUpdatePending && !this._covers()) this.requestUpdate()
    }, { passive: true })
  }

  createRenderRoot() { return this }

  connectedCallback() {
    super.connectedCallback()
    // A new height — the window resized, or the rail shown at last —
    // may want more cards drawn.
    this._resizes = new ResizeObserver(() => {
      if (!this.isUpdatePending && (this._reveal || !this._covers())) this.requestUpdate()
    })
    this._resizes.observe(this)
    // Another theme sets the cards in another face and size, so the
    // heights measured under the last one no longer hold.
    this._themes = new AbortController()
    globalThis.addEventListener('deepview-theme-changed', () => this._forgetHeights(), { signal: this._themes.signal })
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._resizes?.disconnect()
    this._themes?.abort()
  }

  // Lets go of every height measured, keeping the card at the top of the
  // view where it is: it's found by the old heights, which the spacers
  // were drawn with, before they go. The cards drawn are measured again,
  // and the rest guessed from them. Two themes in a row before the rail
  // redraws keep the first's card: by the second, the heights it was
  // found by are gone, and the spacers are still the old ones.
  _forgetHeights() {
    this._carried ??= this._holdOf(this.items, this.scrollTop)
    this._heights.clear()
    this._total = 0
    this._version++
    this.requestUpdate()
  }

  _keysOf(list) {
    let keys = this._keys.get(list)
    if (!keys) this._keys.set(list, keys = list.map(item => this.keyOf(item)))
    return keys
  }

  _topsOf(list) {
    const cached = this._tops
    if (cached?.list === list && cached.version === this._version) return cached.tops
    const keys = this._keysOf(list)
    const guess = this._heights.size > 0 ? this._total / this._heights.size : FIRST_GUESS
    const tops = itemTops(list.length, i => this._heights.get(keys[i]) ?? guess)
    this._tops = { list, version: this._version, tops }
    return tops
  }

  // The view's height inside its padding: what a card fits in to be seen
  // whole (W95 sinks the list in a bevel drawn over its padding), and,
  // with the list's top after the padding, `scrollTop` is where it starts.
  _viewHeight() {
    const style = getComputedStyle(this)
    return Math.max(0, this.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
  }

  // Whether what's drawn covers the view as it's scrolled now.
  _covers() {
    const tops = this._topsOf(this.items)
    const { from, to } = this._range
    const top = this.scrollTop
    return indexAt(tops, top) >= from && (to >= this.items.length || indexAt(tops, top + this._viewHeight()) < to)
  }

  // The card at the top of a view scrolled to `top`, and how far above
  // that its own top is, by the heights `list` was drawn with.
  _holdOf(list, top) {
    if (list.length === 0) return null
    const tops = this._topsOf(list)
    const at = indexAt(tops, top)
    return { key: this._keysOf(list)[at], index: at, offset: tops[at] - top }
  }

  // Where the held card puts the list, by its place in `tops`.
  _heldTop(tops) {
    const hold = this._hold
    if (!hold) return null
    const keys = this._keysOf(this.items)
    const index = keys[hold.index] === hold.key ? hold.index : keys.indexOf(hold.key)
    return index < 0 ? null : tops[index] - hold.offset
  }

  willUpdate(changed) {
    if (changed.has('activeKey')) this._reveal = true
    const top = this.scrollTop
    const height = this._viewHeight()
    // The card at the top of the view, in the list as it was drawn —
    // `items` may have just changed under it.
    this._hold = this._carried ?? this._holdOf(changed.get('items') ?? this.items, top)
    this._carried = null
    this._goal = null
    if (this._reveal && height > 0) {
      this._reveal = false
      const index = this._keysOf(this.items).indexOf(this.activeKey)
      if (index >= 0) this._goal = { index, from: top }
    }
    const tops = this._topsOf(this.items)
    const target = this._goal ? nearestTop(tops, this._goal.index, top, height) : this._heldTop(tops) ?? top
    this._range = drawnRange(tops, target, height)
  }

  render() {
    const { from, to } = this._range
    return html`<div class="kanban-rail-spacer" aria-hidden="true"></div>${repeat(this.items.slice(from, to), this.keyOf, this.renderItem)}<div class="kanban-rail-spacer" aria-hidden="true"></div>`
  }

  updated() {
    // Hidden (the dialog below the rail's breakpoint): nothing to
    // measure, and every card would read as no height at all.
    if (this.clientHeight === 0) return
    const height = this._viewHeight()
    const { from, to } = this._range
    const drawn = [...this.children]
    // Each card from its top to the next one's, the last to the spacer.
    const keys = this._keysOf(this.items)
    let y = drawn[1].getBoundingClientRect().top
    for (let i = from; i < to; i++) {
      const next = drawn[i - from + 2].getBoundingClientRect().top
      const was = this._heights.get(keys[i])
      if (was !== next - y) {
        this._total += next - y - (was ?? 0)
        this._heights.set(keys[i], next - y)
        this._version++
      }
      y = next
    }
    const tops = this._topsOf(this.items)
    drawn[0].style.height = `${tops[from]}px`
    drawn.at(-1).style.height = `${tops[this.items.length] - tops[to]}px`
    const target = this._goal ? nearestTop(tops, this._goal.index, this._goal.from, height) : this._heldTop(tops)
    if (target !== null && Math.abs(this.scrollTop - target) >= 1) this.scrollTop = target
    // Cards that came out shorter than guessed can leave the view's edge
    // undrawn: draw again with what's now known.
    if (this._covers() || ++this._passes >= MAX_PASSES) this._passes = 0
    else this.requestUpdate()
  }
}

customElements.define('kanban-rail', KanbanRail)
