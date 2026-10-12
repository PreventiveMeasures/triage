// A package's downloads (npm-overview.js): its latest week's or month's and
// its last year's, over a chart of them across the year, with the switch
// between weeks and months and the hovered period's downloads at its top
// right. Drawn at its own pixel width, so its text keeps its shape.
import { LitElement, html, nothing, svg } from 'lit'
import { DAY_MS, npmDownloadMonths, npmDownloadTier, npmDownloadWeeks, npmTierLevel } from '../../risk/npm/downloads.js'

export { DAY_MS, npmDownloadMonths, npmDownloadTier, npmDownloadWeeks, npmTierLevel } from '../../risk/npm/downloads.js'

const HEIGHT = 72
// The plot runs to the card's right edge, as the switch over it does.
const PAD = { top: 6, right: 0, bottom: 18, left: 40 }
// A month's bar: at most this wide, the rest of its band air, its top end
// rounded.
const BAR_WIDTH = 24
const BAR_RADIUS = 4
export const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en')

const dayOf = (start, offset) => new Date(Date.parse(start) + offset * DAY_MS)
// Made once: the readout formats dates on every pointer move.
const dateFormat = options => new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' }).format
const shortDate = dateFormat({ month: 'short', day: 'numeric' })
export const fullDate = dateFormat({ month: 'short', day: 'numeric', year: 'numeric' })
const monthYear = dateFormat({ month: 'short', year: 'numeric' })
const monthName = dateFormat({ month: 'long', year: 'numeric' })

export const npmTierName = tier => tier === Infinity ? 'unpopular' : `top ${tier.toLocaleString('en')}`
const tierChip = tier => html`<dd class=${`npm-downloads-tier ${npmTierLevel(tier)}`}>${npmTierName(tier)}</dd>`

const PERIODS = {
  week: { label: 'Weekly', of: downloads => npmDownloadWeeks(downloads).slice(-52), name: period => `${shortDate(period.from)} – ${fullDate(period.to)}` },
  month: { label: 'Monthly', of: npmDownloadMonths, name: period => monthName(period.from) },
}

// `1,229 downloads, Oct 2 – Oct 8, 2026`.
const downloadsIn = (count, when) => `${whole.format(count)} downloads, ${when}`

// The last complete month's downloads, `{ total, month }`, the month named as
// the chart's readout names it (`September 2026`); null without one.
export function npmLastMonth(downloads) {
  const last = npmDownloadMonths(downloads).at(-1)
  return last ? { total: last.total, month: monthName(last.from) } : null
}

// A round number at or above `max`, for the axis's top: 1, 2, 2.5 or 5
// times a power of ten.
export function niceCeiling(max) {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 2.5, 5, 10].map(step => step * power).find(value => value >= max)
}

class NpmDownloadsChart extends LitElement {
  // `status` is its downloads' load, as npmPackageData has it: 'loading',
  // 'error' (until it asks again) or 'ready' (`downloads` null where the
  // server has none).
  static properties = {
    downloads: { attribute: false }, status: {}, _width: { state: true }, _at: { state: true }, _unit: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.downloads = null
    this.status = 'loading'
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

  _key(event) {
    const last = this._periods.length - 1
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -last - 1, End: last + 1 }
    if (!(event.key in moves)) return
    event.preventDefault()
    this._at = Math.min(last, Math.max(0, (this._at ?? last) + moves[event.key]))
  }

  // What doesn't follow the pointer, made again only when the downloads, the
  // unit or the width change: the periods charted, the figures with their
  // tooltips, and the chart's lines and labels.
  willUpdate(changed) {
    const period = PERIODS[this._unit]
    const { downloads } = this
    if (changed.has('downloads') || changed.has('_unit')) this._periods = period.of(downloads)
    if (changed.has('downloads')) {
      // The latest week's and month's both, each its own figure: the one not
      // shown keeps its room, so switching moves nothing.
      this._latest = downloads == null ? null : Object.fromEntries(Object.entries(PERIODS).map(([unit, { of, name }]) => {
        const latest = of(downloads).at(-1)
        return [unit, { total: latest?.total ?? 0, tooltip: latest && downloadsIn(latest.total, name(latest)) }]
      }))
      this._tier = npmDownloadTier(downloads)
      // The last 365 days: the downloads reach back further, to the first of
      // the month they start in, so that month is whole.
      const year = downloads?.days.slice(-365)
      const total = year?.reduce((sum, count) => sum + count, 0)
      this._year = downloads == null ? null
        : { total, tooltip: downloadsIn(total, `${fullDate(dayOf(downloads.start, downloads.days.length - year.length))} – ${fullDate(Date.parse(downloads.end))}`) }
    }
    if (changed.has('downloads') || changed.has('_unit') || changed.has('_width')) this._shape = this._shapeOf(period)
  }

  _shapeOf(period) {
    const periods = this._periods
    const width = this._width
    if (periods.length === 0 || width <= PAD.left + PAD.right) return null
    const plotWidth = width - PAD.left - PAD.right
    const bottom = HEIGHT - PAD.bottom
    const top = niceCeiling(Math.max(...periods.map(each => each.total)))
    const y = value => bottom - value / top * (bottom - PAD.top)
    const f = value => value.toFixed(1)
    // Weeks a line through each, months a bar each in a band of its own.
    const bars = this._unit === 'month'
    const step = plotWidth / (bars ? periods.length : Math.max(periods.length - 1, 1))
    const x = bars ? i => PAD.left + (i + .5) * step : i => PAD.left + (periods.length > 1 ? i * step : plotWidth / 2)
    const last = periods.length - 1
    const indexAt = offsetX => Math.min(last, Math.max(0, (bars ? Math.floor : Math.round)((offsetX - PAD.left) / step)))
    const first = monthYear(periods[0].from)
    const latest = periods.at(-1)
    let marks
    if (bars) {
      const half = Math.min(BAR_WIDTH, step * .7) / 2
      marks = { bars: periods.map(({ total }, i) => {
        const [left, right, end] = [x(i) - half, x(i) + half, y(total)]
        const r = Math.min(BAR_RADIUS, half, bottom - end)
        return `M${f(left)},${bottom}V${f(end + r)}Q${f(left)},${f(end)} ${f(left + r)},${f(end)}H${f(right - r)}Q${f(right)},${f(end)} ${f(right)},${f(end + r)}V${bottom}Z`
      }) }
    } else {
      const line = periods.map((each, i) => `${i === 0 ? 'M' : 'L'}${f(x(i))},${f(y(each.total))}`).join('')
      marks = { line, area: `${line}L${f(x(last))},${bottom}L${f(x(0))},${bottom}Z` }
    }
    return {
      x, y, bottom, indexAt, first, last: monthYear(latest.to), ...marks,
      ticks: [[0, compact.format(0)], [top, compact.format(top)]],
      label: `${period.label} downloads over the last year, from ${first} to ${monthYear(latest.to)}; the latest ${this._unit}: ${downloadsIn(latest.total, period.name(latest))}.`,
    }
  }

  // One of its figures, in short with its unit (`1.2K/week`), in full in its
  // tooltip; while it isn't known, what stands for it.
  _stat(label, figure, per) {
    return html`<div class="npm-stat"><dt class="sr-only">${label}</dt>
      <dd data-tooltip=${figure?.tooltip || nothing}>${this._figure(figure, per)}</dd></div>`
  }

  _figure(figure, per) {
    return html`${figure ? compact.format(figure.total) : this.status === 'loading' ? '…' : '—'}<span class="npm-stat-per">/${per}</span>`
  }

  // The latest week's or month's, as the switch has it, over the other's,
  // hidden, so the figure is as wide as the wider of the two.
  _latestStat() {
    const shown = this._latest?.[this._unit]
    return html`<div class="npm-stat"><dt class="sr-only">${PERIODS[this._unit].label} downloads</dt>
      <dd class="npm-stat-units" data-tooltip=${shown?.tooltip || nothing}>${Object.keys(PERIODS).map(unit => html`<span
        class=${unit === this._unit ? '' : 'is-held'} aria-hidden=${unit === this._unit ? nothing : 'true'}>${this._figure(this._latest?.[unit], unit)}</span>`)}</dd></div>`
  }

  // Weekly or monthly, over the readout of the period under the pointer,
  // which keeps its line while there is none.
  _controls(at) {
    return html`<div class="npm-downloads-controls">
      <span class="bundles-overview-sort" role="group" aria-label="Downloads by">
        ${Object.entries(PERIODS).map(([unit, { label }]) => html`<button type="button" aria-pressed=${String(this._unit === unit)}
          @click=${() => { this._unit = unit; this._at = null }}>${label}</button>`)}
      </span>
      <span class="npm-downloads-readout" aria-live="polite">${at ? html`<strong>${whole.format(at.total)}</strong>
        <span>${PERIODS[this._unit].name(at)}</span>` : nothing}</span>
    </div>`
  }

  render() {
    // Nothing to chart where the server has no downloads; until they come,
    // the chart holds its place, so nothing moves when they arrive.
    const charted = this.downloads != null || this.status !== 'ready'
    const at = this._at === null ? null : this._periods[this._at] ?? null
    return html`<div class="npm-downloads-head">
      <dl class="npm-stats">
        ${this._latestStat()}
        ${this._stat('Downloads, last 12 months', this._year, 'year')}
        ${this._tier ? html`<div class="npm-stat"><dt class="sr-only">Popularity</dt>${tierChip(this._tier)}</div>` : nothing}
      </dl>
      ${charted ? this._controls(at) : nothing}
    </div>
    ${charted ? this._plot(at) : nothing}`
  }

  _plot(at) {
    const shape = this._shape
    if (!shape) return html`<div class="npm-downloads-plot" style="height: ${HEIGHT}px"></div>`
    const width = this._width
    return html`<div class="npm-downloads-plot" style="height: ${HEIGHT}px" tabindex="0" role="img" aria-label=${shape.label}
      @pointermove=${event => { this._at = shape.indexAt(event.offsetX) }} @pointerleave=${() => { this._at = null }}
      @keydown=${event => this._key(event)} @blur=${() => { this._at = null }}>
      <svg width=${width} height=${HEIGHT} viewBox="0 0 ${width} ${HEIGHT}" aria-hidden="true">
        ${shape.ticks.map(([value, text]) => svg`<line class="npm-downloads-grid" x1=${PAD.left} x2=${width - PAD.right} y1=${shape.y(value)} y2=${shape.y(value)}></line>
          <text class="npm-downloads-tick" x=${PAD.left - 6} y=${shape.y(value)} dy="0.32em" text-anchor="end">${text}</text>`)}
        ${shape.bars ? shape.bars.map((d, i) => svg`<path class=${`npm-downloads-bar${i === this._at ? ' is-at' : ''}`} d=${d}></path>`)
          : svg`<path class="npm-downloads-area" d=${shape.area}></path><path class="npm-downloads-line" d=${shape.line}></path>`}
        <text class="npm-downloads-tick" x=${PAD.left} y=${HEIGHT - 4}>${shape.first}</text>
        <text class="npm-downloads-tick" x=${width - PAD.right} y=${HEIGHT - 4} text-anchor="end">${shape.last}</text>
        ${at && !shape.bars ? svg`<line class="npm-downloads-crosshair" x1=${shape.x(this._at)} x2=${shape.x(this._at)} y1=${PAD.top} y2=${shape.bottom}></line>
          <circle class="npm-downloads-dot" cx=${shape.x(this._at)} cy=${shape.y(at.total)} r="4"></circle>` : nothing}
      </svg>
    </div>`
  }
}

if (!customElements.get('npm-downloads-chart')) customElements.define('npm-downloads-chart', NpmDownloadsChart)
