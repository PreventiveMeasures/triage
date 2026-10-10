// A package's downloads (npm-overview.js): its latest week's or month's and
// its last year's, over a chart of them across the year, with the switch
// between weeks and months and the hovered period's downloads at its top
// right. Drawn at its own pixel width, so its text keeps its shape.
import { LitElement, html, nothing, svg } from 'lit'

const DAY_MS = 24 * 60 * 60_000
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
const fullDate = dateFormat({ month: 'short', day: 'numeric', year: 'numeric' })
const monthYear = dateFormat({ month: 'short', year: 'numeric' })
const monthName = dateFormat({ month: 'long', year: 'numeric' })

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

// The weekly downloads from which a package is among npm's top 10, 50, 100,
// …, 100,000 packages: download-counts' snapshot of a month's downloads
// (Jan 30 – Feb 28, 2026), each rank's count scaled to a week by the
// registry's weeks then, and grown by the median growth, to Sep 21 – Oct 4,
// 2026, of the packages ranked around it, over weeks npm counted whole.
// Below the last, a package is unpopular (Infinity).
const TIERS = [[10, 640e6], [50, 330e6], [100, 260e6], [500, 105e6], [1000, 60e6], [5000, 4.6e6], [10_000, 1e6], [50_000, 20e3], [100_000, 2.1e3], [Infinity, 0]]

// The tier a package's downloads put it in (TIERS), by the most it had in any
// of its latest six 7-day weeks (npmDownloadWeeks): a week lower for a day
// npm failed to count, as it now and then does, or for a holiday, is passed
// over. Infinity for an unpopular one; null without a week.
export function npmDownloadTier(downloads) {
  const latest = npmDownloadWeeks(downloads).slice(-6)
  if (latest.length === 0) return null
  const most = Math.max(...latest.map(week => week.total))
  return TIERS.find(([, from]) => most >= from)[0]
}

// A tier's name, and its tint: green for the most downloaded, through
// yellow, to orange for the unpopular, a package few would notice changing.
function tierChip(tier) {
  const level = tier <= 100 ? 'is-top' : tier <= 1000 ? 'is-high' : tier <= 10_000 ? 'is-mid' : tier <= 100_000 ? 'is-low' : 'is-unpopular'
  return html`<dd class=${`npm-downloads-tier ${level}`}>${tier === Infinity ? 'unpopular' : `top ${tier.toLocaleString('en')}`}</dd>`
}

const PERIODS = {
  week: { label: 'Weekly', of: downloads => npmDownloadWeeks(downloads).slice(-52), name: period => `${shortDate(period.from)} – ${fullDate(period.to)}` },
  month: { label: 'Monthly', of: npmDownloadMonths, name: period => monthName(period.from) },
}

// `1,229 downloads, Oct 2 – Oct 8, 2026`.
const downloadsIn = (count, when) => `${whole.format(count)} downloads, ${when}`

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
    if (changed.has('downloads') || changed.has('_unit')) {
      this._periods = period.of(downloads)
      const latest = this._periods.at(-1)
      this._latest = downloads == null ? null : { total: latest?.total ?? 0, tooltip: latest && downloadsIn(latest.total, period.name(latest)) }
    }
    if (changed.has('downloads')) {
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
      <dd data-tooltip=${figure?.tooltip || nothing}>${figure ? compact.format(figure.total) : this.status === 'loading' ? '…' : '—'}<span class="npm-stat-per">/${per}</span></dd></div>`
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
        ${this._stat(`${PERIODS[this._unit].label} downloads`, this._latest, this._unit)}
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
