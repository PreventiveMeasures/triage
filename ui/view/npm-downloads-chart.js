// A package's weekly downloads over the last year, for the npm Overview
// (npm-overview.js): one series, as a line over a faint area, with a
// crosshair and tooltip for the week under the pointer, or under the arrow
// keys once the chart has focus. Drawn at its own pixel width, so its text
// keeps its shape.
import { LitElement, html, nothing, svg } from 'lit'

const DAY_MS = 24 * 60 * 60_000
const HEIGHT = 112
const PAD = { top: 8, right: 10, bottom: 20, left: 40 }
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en')

const dayOf = (start, offset) => new Date(Date.parse(start) + offset * DAY_MS)
const shortDate = date => date.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fullDate = date => date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const monthYear = date => date.toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' })

// The downloads in 7-day weeks ending on the last day, oldest first, a
// partial oldest week left out: `{ from, to, total }`, dates as `Date`s.
export function npmDownloadWeeks(downloads) {
  const weeks = []
  if (!downloads?.days) return weeks
  for (let end = downloads.days.length - 1; end >= 6; end -= 7) {
    let total = 0
    for (let day = end - 6; day <= end; day++) total += downloads.days[day]
    weeks.push({ from: dayOf(downloads.start, end - 6), to: dayOf(downloads.start, end), total })
  }
  return weeks.toReversed()
}

// A round number at or above `max`, for the axis's top: 1, 2, 2.5 or 5
// times a power of ten.
export function niceCeiling(max) {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 2.5, 5, 10].map(step => step * power).find(value => value >= max)
}

class NpmDownloadsChart extends LitElement {
  static properties = { downloads: { attribute: false }, _width: { state: true }, _at: { state: true } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.downloads = null
    this._width = 0
    this._at = null
    this._resize = new ResizeObserver(([entry]) => { this._width = Math.floor(entry.contentRect.width) })
  }

  connectedCallback() {
    super.connectedCallback()
    this._resize.observe(this)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._resize.disconnect()
  }

  _weekAt(weeks, offsetX) {
    const span = this._width - PAD.left - PAD.right
    const step = weeks.length > 1 ? span / (weeks.length - 1) : span
    return Math.min(weeks.length - 1, Math.max(0, Math.round((offsetX - PAD.left) / step)))
  }

  _key(event, weeks) {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -weeks.length, End: weeks.length }
    if (!(event.key in moves)) return
    event.preventDefault()
    const from = this._at ?? weeks.length - 1
    this._at = Math.min(weeks.length - 1, Math.max(0, from + moves[event.key]))
  }

  render() {
    const weeks = npmDownloadWeeks(this.downloads)
    if (weeks.length === 0 || this._width <= PAD.left + PAD.right) return html`<div class="npm-downloads-plot" style="height: ${HEIGHT}px"></div>`
    const width = this._width
    const plotWidth = width - PAD.left - PAD.right
    const plotHeight = HEIGHT - PAD.top - PAD.bottom
    const top = niceCeiling(Math.max(...weeks.map(week => week.total)))
    const x = i => PAD.left + (weeks.length > 1 ? i * plotWidth / (weeks.length - 1) : plotWidth / 2)
    const y = value => PAD.top + plotHeight - value / top * plotHeight
    const line = weeks.map((week, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(week.total).toFixed(1)}`).join('')
    const area = `${line}L${x(weeks.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`
    const at = this._at === null ? null : weeks[this._at]
    const latest = weeks.at(-1)
    const tipLeft = at ? Math.min(Math.max(x(this._at), 70), width - 70) : 0
    return html`<div class="npm-downloads-plot" style="height: ${HEIGHT}px" tabindex="0" role="img"
      aria-label=${`Weekly downloads over the last year, from ${monthYear(weeks[0].from)} to ${monthYear(latest.to)}; the latest week ${whole.format(latest.total)}.`}
      @pointermove=${event => { this._at = this._weekAt(weeks, event.offsetX) }} @pointerleave=${() => { this._at = null }}
      @keydown=${event => this._key(event, weeks)} @blur=${() => { this._at = null }}>
      <svg width=${width} height=${HEIGHT} viewBox="0 0 ${width} ${HEIGHT}" aria-hidden="true">
        ${[0, top / 2, top].map(value => svg`<line class="npm-downloads-grid" x1=${PAD.left} x2=${width - PAD.right} y1=${y(value)} y2=${y(value)}></line>
          <text class="npm-downloads-tick" x=${PAD.left - 6} y=${y(value)} dy="0.32em" text-anchor="end">${compact.format(value)}</text>`)}
        <path class="npm-downloads-area" d=${area}></path>
        <path class="npm-downloads-line" d=${line}></path>
        <text class="npm-downloads-tick" x=${PAD.left} y=${HEIGHT - 4}>${monthYear(weeks[0].from)}</text>
        <text class="npm-downloads-tick" x=${width - PAD.right} y=${HEIGHT - 4} text-anchor="end">${monthYear(latest.to)}</text>
        ${at ? svg`<line class="npm-downloads-crosshair" x1=${x(this._at)} x2=${x(this._at)} y1=${PAD.top} y2=${PAD.top + plotHeight}></line>
          <circle class="npm-downloads-dot" cx=${x(this._at)} cy=${y(at.total)} r="4"></circle>` : nothing}
      </svg>
      ${at ? html`<div class="npm-downloads-tip" style="left: ${tipLeft}px">
        <strong>${whole.format(at.total)}</strong><span>${shortDate(at.from)} – ${fullDate(at.to)}</span>
      </div>` : nothing}
    </div>`
  }
}

if (!customElements.get('npm-downloads-chart')) customElements.define('npm-downloads-chart', NpmDownloadsChart)
