// A package's weekly downloads over the last year, for the npm Overview
// (npm-overview.js): one series, as a line over a faint area, under a
// readout of one week's downloads: the latest, or the week under the pointer
// (or the arrow keys, once the chart has focus), which a crosshair marks.
// Drawn at its own pixel width, so its text keeps its shape.
import { LitElement, html, nothing, svg } from 'lit'

const DAY_MS = 24 * 60 * 60_000
const HEIGHT = 72
const PAD = { top: 6, right: 10, bottom: 18, left: 40 }
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en')

const dayOf = (start, offset) => new Date(Date.parse(start) + offset * DAY_MS)
const shortDate = date => date.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fullDate = date => date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const monthYear = date => date.toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const monthName = date => date.toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })

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

// The downloads in calendar months (UTC), oldest first, the partial months
// at either end left out: `{ from, to, total }`, as npmDownloadWeeks has them.
export function npmDownloadMonths(downloads) {
  const months = []
  if (!downloads?.days) return months
  const start = Date.parse(downloads.start)
  let month = null
  downloads.days.forEach((count, i) => {
    const day = new Date(start + i * DAY_MS)
    if (day.getUTCDate() === 1) {
      month = { from: day, to: day, total: 0 }
      months.push(month)
    }
    if (month) { month.total += count; month.to = day }
  })
  const last = months.at(-1)
  if (last && new Date(last.to.getTime() + DAY_MS).getUTCDate() !== 1) months.pop()
  return months
}

const PERIODS = {
  week: { label: 'Weekly', of: npmDownloadWeeks, latest: 'latest week, ', name: period => `${shortDate(period.from)} – ${fullDate(period.to)}` },
  month: { label: 'Monthly', of: npmDownloadMonths, latest: 'latest month, ', name: period => monthName(period.from) },
}

// A round number at or above `max`, for the axis's top: 1, 2, 2.5 or 5
// times a power of ten.
export function niceCeiling(max) {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 2.5, 5, 10].map(step => step * power).find(value => value >= max)
}

class NpmDownloadsChart extends LitElement {
  static properties = { downloads: { attribute: false }, _width: { state: true }, _at: { state: true }, _unit: { state: true } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.downloads = null
    this._width = 0
    this._at = null
    this._unit = 'week'
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

  _periodAt(periods, offsetX) {
    const span = this._width - PAD.left - PAD.right
    const step = periods.length > 1 ? span / (periods.length - 1) : span
    return Math.min(periods.length - 1, Math.max(0, Math.round((offsetX - PAD.left) / step)))
  }

  _key(event, periods) {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -periods.length, End: periods.length }
    if (!(event.key in moves)) return
    event.preventDefault()
    const from = this._at ?? periods.length - 1
    this._at = Math.min(periods.length - 1, Math.max(0, from + moves[event.key]))
  }

  // Weekly or monthly, at the readout's end.
  _units() {
    return html`<span class="bundles-overview-sort npm-downloads-units" role="group" aria-label="Downloads by">
      ${Object.entries(PERIODS).map(([unit, { label }]) => html`<button type="button" aria-pressed=${String(this._unit === unit)}
        @click=${() => { this._unit = unit; this._at = null }}>${label}</button>`)}
    </span>`
  }

  render() {
    const period = PERIODS[this._unit]
    const periods = period.of(this.downloads)
    // The readout keeps its line while there is nothing to read, so the
    // chart doesn't move when the downloads arrive.
    if (periods.length === 0 || this._width <= PAD.left + PAD.right) {
      return html`<div class="npm-downloads-head"><span class="npm-downloads-readout">\u00A0</span>${this._units()}</div>
        <div class="npm-downloads-plot" style="height: ${HEIGHT}px"></div>`
    }
    const width = this._width
    const plotWidth = width - PAD.left - PAD.right
    const plotHeight = HEIGHT - PAD.top - PAD.bottom
    const top = niceCeiling(Math.max(...periods.map(week => week.total)))
    const x = i => PAD.left + (periods.length > 1 ? i * plotWidth / (periods.length - 1) : plotWidth / 2)
    const y = value => PAD.top + plotHeight - value / top * plotHeight
    const line = periods.map((week, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(week.total).toFixed(1)}`).join('')
    const area = `${line}L${x(periods.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`
    const at = this._at === null ? null : periods[this._at]
    const latest = periods.at(-1)
    const shown = at ?? latest
    return html`<div class="npm-downloads-head">
      <span class="npm-downloads-readout" aria-live="polite"><strong>${whole.format(shown.total)}</strong>
        <span>${at ? '' : period.latest}${period.name(shown)}</span></span>
      ${this._units()}
    </div>
    <div class="npm-downloads-plot" style="height: ${HEIGHT}px" tabindex="0" role="img"
      aria-label=${`${period.label} downloads over the last year, from ${monthYear(periods[0].from)} to ${monthYear(latest.to)}; the ${period.latest}${period.name(latest)}: ${whole.format(latest.total)}.`}
      @pointermove=${event => { this._at = this._periodAt(periods, event.offsetX) }} @pointerleave=${() => { this._at = null }}
      @keydown=${event => this._key(event, periods)} @blur=${() => { this._at = null }}>
      <svg width=${width} height=${HEIGHT} viewBox="0 0 ${width} ${HEIGHT}" aria-hidden="true">
        ${[0, top].map(value => svg`<line class="npm-downloads-grid" x1=${PAD.left} x2=${width - PAD.right} y1=${y(value)} y2=${y(value)}></line>
          <text class="npm-downloads-tick" x=${PAD.left - 6} y=${y(value)} dy="0.32em" text-anchor="end">${compact.format(value)}</text>`)}
        <path class="npm-downloads-area" d=${area}></path>
        <path class="npm-downloads-line" d=${line}></path>
        <text class="npm-downloads-tick" x=${PAD.left} y=${HEIGHT - 4}>${monthYear(periods[0].from)}</text>
        <text class="npm-downloads-tick" x=${width - PAD.right} y=${HEIGHT - 4} text-anchor="end">${monthYear(latest.to)}</text>
        ${at ? svg`<line class="npm-downloads-crosshair" x1=${x(this._at)} x2=${x(this._at)} y1=${PAD.top} y2=${PAD.top + plotHeight}></line>
          <circle class="npm-downloads-dot" cx=${x(this._at)} cy=${y(at.total)} r="4"></circle>` : nothing}
      </svg>
    </div>`
  }
}

if (!customElements.get('npm-downloads-chart')) customElements.define('npm-downloads-chart', NpmDownloadsChart)
