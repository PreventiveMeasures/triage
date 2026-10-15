// The code viewer's Pulse tab (render-bundle.js): how the repository moves,
// as the server reads it (GET /api/admin/repositories/pulse) for the week,
// month, quarter or year the reader picks, each a run of whole weeks to
// today as GitHub counts them (Sunday first, UTC). Its figures first, each
// beside what the same days of the week a period earlier gave, where
// GitHub's counts go by the day: the default branch's commits, who made them, the pull
// requests merged and the issues closed, the lines added and removed. Then
// the year's weeks, the period's marked in them: commits a week, and lines
// added over removed; the period's contributors ranked by their commits; when
// in the week commits are made; and the pull requests and issues merged,
// closed and opened in the period, each opening its popup. Each chart shows
// as a table too. Statistics GitHub is still computing are asked for again a
// few times, a while apart. What was read is kept a while, for the session
// that read it; a period read anew shows the last one read, faded, till it
// is.
import { LitElement, html, nothing } from 'lit'
import { state } from '#client/index.js'
import { fetchRepositoryPulse } from './client-managed.js'
import { compactTime } from './repository-history.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { STATE_ICONS, issueState, plainClick } from './repository-tiles.js'

const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
// GitHub computing its statistics: asked again this long apart, this many
// times, then left to the reader to ask again.
const PENDING_MS = 5_000
const PENDING_TRIES = 6
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const TOP_CONTRIBUTORS = 8
// The periods, each its weeks, its name, and the same days a period earlier.
export const PERIODS = [[1, 'Week', 'the week before'], [4, 'Month', 'the month before'], [13, 'Quarter', 'the quarter before'], [52, 'Year', 'the year before']]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// The punch card's rows, Monday first, the weekend under the working week.
const PUNCH_DAYS = [1, 2, 3, 4, 5, 6, 0]
const PUNCH_STEPS = 6

const reads = new Map()
const lastShown = new Map()
const shownElements = new Set()
let keptFor = null
// The period and the form the reader last picked.
let shownWeeks = 4
let shownAs = 'charts'

function sessionReads() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    reads.clear()
    lastShown.clear()
    keptFor = session
  }
  return reads
}

const repaint = () => { for (const element of shownElements) element.requestUpdate() }
const counted = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

// A server's answer, what it lists those it names by number and period.
function checked(answer) {
  if (!Number.isSafeInteger(answer?.since) || !PERIODS.some(([weeks]) => weeks === answer.weeks)) throw new Error('The server answered with no period.')
  const told = kind => ({ count: counted(answer[kind]?.count), previous: Number.isSafeInteger(answer[kind]?.previous) ? answer[kind].previous : null,
    items: Array.isArray(answer[kind]?.items) ? answer[kind].items.filter(item => Number.isSafeInteger(item?.number) && typeof item.title === 'string') : [] })
  const stats = answer.stats && Array.isArray(answer.stats.weeks) && Array.isArray(answer.stats.contributors) && Array.isArray(answer.stats.punch) ? {
    weeks: answer.stats.weeks.filter(week => Number.isSafeInteger(week?.week) && Array.isArray(week.days)),
    contributors: answer.stats.contributors.filter(person => typeof person?.login === 'string' && Array.isArray(person.weeks)),
    punch: PUNCH_DAYS.map(day => Array.from({ length: 24 }, (_, hour) => counted(answer.stats.punch[day]?.[hour]))),
    lines: answer.stats.lines !== false,
  } : null
  return { weeks: answer.weeks, since: answer.since, merged: told('merged'), opened: told('opened'), closed: told('closed'), created: told('created'),
    stats, pending: !stats && answer.pending === true }
}

// The pulse of repository `repoId` over `weeks` weeks, as held, else read:
// `{ status }` 'loading', then 'ready' with its `answer`, or 'error' with its
// `error`; read again once old, or an error's retry is due. One GitHub is
// still computing the statistics of is asked again (askAgain).
function pulseRead(repoId, weeks) {
  const data = sessionReads()
  const key = `${repoId}\0${weeks}`
  const held = data.get(key)
  if (held && Date.now() < held.until) return held
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  fetchRepositoryPulse(repoId, weeks).then(checked).then(answer => {
    if (data.get(key) !== loading) return null
    const entry = { status: 'ready', until: Date.now() + KEEP_MS, answer, tries: 0, asking: false }
    data.set(key, entry)
    lastShown.set(repoId, entry)
    if (answer.pending) askAgain(key, entry, repoId, weeks)
    return null
  }, err => {
    if (data.get(key) !== loading) return null
    if (err?.name === 'AbortError') data.delete(key)
    else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'The repository’s pulse could not be read.' })
    return null
  }).finally(repaint)
  return loading
}

// The statistics GitHub was computing, asked for again PENDING_MS later, as
// many as PENDING_TRIES times; what else the pulse told shown meanwhile.
function askAgain(key, entry, repoId, weeks, wait = PENDING_MS) {
  entry.asking = true
  setTimeout(() => {
    if (sessionReads().get(key) !== entry) return
    fetchRepositoryPulse(repoId, weeks).then(checked).then(answer => {
      if (sessionReads().get(key) !== entry) return null
      entry.answer = answer
      entry.until = Date.now() + KEEP_MS
      entry.tries++
      if (answer.pending && entry.tries < PENDING_TRIES) askAgain(key, entry, repoId, weeks)
      else entry.asking = false
      return null
    }, () => {
      entry.asking = false
      return null
    }).finally(repaint)
  }, wait)
}

// The commits a week's `days` hold from `from` to `to` (both days, UTC).
const commitsBetween = (weeks, from, to) => weeks.reduce((sum, week) => sum + week.days.reduce((days, count, day) => {
  const at = week.week + day * DAY_MS
  return at >= from && at <= to ? days + counted(count) : days
}, 0), 0)

// The period's figures, `now` in its last day: its commits, and those of the
// same days of the week a period earlier (a week's Sunday to Thursday beside
// the week before's), where the year's weeks reach that far back; its lines
// added and removed, where GitHub counts them; and how many made commits.
export function pulseSummary(answer, now = Date.now()) {
  const { stats, since } = answer
  if (!stats) return { commits: null, previous: null, additions: null, deletions: null, authors: null }
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const back = answer.weeks * WEEK_MS
  const period = stats.weeks.filter(week => week.week >= since)
  const reaches = stats.weeks.length > 0 && stats.weeks[0].week <= since - back
  const lines = kind => stats.lines ? period.reduce((sum, week) => sum + counted(week[kind]), 0) : null
  return { commits: commitsBetween(stats.weeks, since, today), previous: reaches ? commitsBetween(stats.weeks, since - back, today - back) : null,
    additions: lines('additions'), deletions: lines('deletions'), authors: periodContributors(stats.contributors, since).length }
}

// Who made commits since `since`, the most first: how many, and the lines
// they added and removed.
export function periodContributors(contributors, since) {
  return contributors.map(({ login, weeks }) => weeks.reduce((sum, [week, commits, additions, deletions]) => week >= since
    ? { login, commits: sum.commits + counted(commits), additions: sum.additions + counted(additions), deletions: sum.deletions + counted(deletions) } : sum,
  { login, commits: 0, additions: 0, deletions: 0 })).filter(person => person.commits > 0).toSorted((a, b) => b.commits - a.commits || a.login.localeCompare(b.login))
}

// A scale for counts as high as `max`: its top and the ticks to it, a round
// step apart, three at most past naught.
export function niceScale(max) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] }
  const rough = max / 3
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = Math.max(1, [1, 2, 5, 10].map(times => times * power).find(value => value >= rough))
  const top = Math.ceil(max / step) * step
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, at) => at * step) }
}

const number = value => value.toLocaleString('en-US')
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const compact = value => compactNumber.format(value)
const plural = (count, one, many = `${one}s`) => `${number(count)} ${count === 1 ? one : many}`
const day = (at, year = false) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year ? { year: 'numeric' } : {}, timeZone: 'UTC' })
const isoDay = at => new Date(at).toISOString().slice(0, 10)
const weekName = at => `Week of ${day(at, true)}`
// A period's days, the years named where they differ.
const rangeName = (since, now) => {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const years = new Date(since).getUTCFullYear() !== new Date(today).getUTCFullYear()
  return since >= today ? day(today, years) : `${day(since, years)} – ${day(today, years)}`
}
// A figure beside what the same days a period earlier gave.
const versus = (count, previous, before) => previous === null || count === null ? null
  : count === previous ? `Same as ${before}` : `${count > previous ? '↑' : '↓'} from ${number(previous)} ${before}`
const profile = login => login.endsWith('[bot]') ? `https://github.com/apps/${encodeURIComponent(login.slice(0, -5))}` : `https://github.com/${encodeURIComponent(login)}`

// The tab's body, for the repository a directory shown (`repository`, an
// entry's) is in.
class RepositoryPulse extends LitElement {
  static properties = { repository: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
  }

  connectedCallback() {
    super.connectedCallback()
    shownElements.add(this)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    shownElements.delete(this)
  }

  pick(weeks) {
    shownWeeks = weeks
    repaint()
  }

  show(as) {
    shownAs = as
    repaint()
  }

  // The shown period's statistics asked for anew, as many times again.
  askAgain() {
    const { repoId } = this.repository
    const key = `${repoId}\0${shownWeeks}`
    const entry = sessionReads().get(key)
    if (entry?.status !== 'ready' || entry.asking) return
    entry.tries = 0
    askAgain(key, entry, repoId, shownWeeks, 0)
    repaint()
  }

  render() {
    if (!this.repository) return nothing
    const { repoId } = this.repository
    const entry = pulseRead(repoId, shownWeeks)
    if (entry.status === 'ready') lastShown.set(repoId, entry)
    // While a period reads, the last one read, faded.
    const shown = entry.status === 'ready' ? entry : entry.status === 'loading' ? lastShown.get(repoId) ?? null : null
    const now = Date.now()
    return html`<div class="history-bar pulse-bar">
        <div class="history-modes" role="group" aria-label="Period">
          ${PERIODS.map(([weeks, name]) => html`<button type="button" aria-pressed=${String(shownWeeks === weeks)} @click=${() => this.pick(weeks)}>${name}</button>`)}
        </div>
        ${shown ? html`<span class="pulse-range">${rangeName(shown.answer.since, now)}</span>` : nothing}
        <div class="history-modes pulse-as" role="group" aria-label="Show as">
          ${[['charts', 'Charts'], ['table', 'Table']].map(([as, name]) => html`<button type="button" aria-pressed=${String(shownAs === as)} @click=${() => this.show(as)}>${name}</button>`)}
        </div>
      </div>
      ${shown ? html`<div class=${`pulse-scroll${shown === entry ? '' : ' is-reading'}`} aria-busy=${String(shown !== entry)}>${this.renderPulse(shown, now)}</div>`
        : entry.status === 'error' ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
            <button type="button" @click=${() => { sessionReads().delete(`${repoId}\0${shownWeeks}`); repaint() }}>Retry</button></div>`
        : html`<div class="bundles-slide-placeholder" role="status">Reading the repository’s pulse…</div>`}`
  }

  renderPulse(entry, now) {
    const { answer } = entry
    const before = PERIODS.find(([weeks]) => weeks === answer.weeks)[2]
    const summary = pulseSummary(answer, now)
    const counting = answer.pending ? 'Counting…' : null
    return html`<section class="pulse-tiles" aria-label="Figures">
        ${this.renderTile('Commits', summary.commits === null ? '–' : number(summary.commits), counting ?? versus(summary.commits, summary.previous, before), 'to the default branch')}
        ${this.renderTile('Contributors', summary.authors === null ? '–' : number(summary.authors), counting, 'who made them')}
        ${this.renderTile('Pull requests merged', number(answer.merged.count), versus(answer.merged.count, answer.merged.previous, before), `${number(answer.opened.count)} opened`)}
        ${this.renderTile('Issues closed', number(answer.closed.count), versus(answer.closed.count, answer.closed.previous, before), `${number(answer.created.count)} opened`)}
        ${answer.stats && !answer.stats.lines ? nothing : this.renderTile('Lines', summary.additions === null ? '–'
          : html`<span>+${number(summary.additions)}</span> <span>−${number(summary.deletions)}</span>`, counting, 'added and removed')}
      </section>
      ${answer.stats ? shownAs === 'table' ? this.renderTables(answer, now) : this.renderCharts(answer)
        : html`<div class="pulse-pending" role="status">${entry.asking ? 'GitHub is still counting this repository’s commits…'
          : html`GitHub hasn’t counted this repository’s commits yet. <button type="button" class="history-link" @click=${() => this.askAgain()}>Ask again</button>`}</div>`}
      <section class="pulse-lists" aria-label="Pull requests and issues">
        ${this.renderList(answer, 'merged', 'pulls', 'Merged pull requests', 'is:pr is:merged merged:')}
        ${this.renderList(answer, 'opened', 'pulls', 'Opened pull requests', 'is:pr created:')}
        ${this.renderList(answer, 'closed', 'issues', 'Closed issues', 'is:issue is:closed closed:')}
        ${this.renderList(answer, 'created', 'issues', 'Opened issues', 'is:issue created:')}
      </section>`
  }

  renderTile(label, value, note, detail) {
    return html`<div class="pulse-tile">
      <span class="pulse-tile-label">${label}</span>
      <span class="pulse-tile-value">${value}</span>
      <span class="pulse-tile-note">${note ?? detail}</span>
      ${note ? html`<span class="pulse-tile-note">${detail}</span>` : nothing}
    </div>`
  }

  // The year's weeks, a column each, those of the period marked: commits
  // over a scale of counts, and under them lines added above a line and
  // removed below it, one scale for both; then the months, named where each
  // starts; the period's contributors and when commits are made beside.
  renderCharts(answer) {
    const { stats, since } = answer
    if (stats.weeks.length === 0) return html`<p class="pulse-pending">No commits in the last year.</p>`
    const commits = niceScale(Math.max(...stats.weeks.map(week => week.commits)))
    const lines = stats.lines ? niceScale(Math.max(...stats.weeks.flatMap(week => [counted(week.additions), counted(week.deletions)]))) : null
    const marked = week => week.week >= since ? ' is-period' : ''
    return html`<section class="pulse-charts">
      <figure class="pulse-panel pulse-year">
        <figcaption class="pulse-head"><h3>Commits</h3><span>a week, over the last year</span>
          <span class="pulse-legend"><span class="pulse-key is-period"></span>${PERIODS.find(([weeks]) => weeks === answer.weeks)[1] === 'Year' ? 'The year' : 'The period'}</span></figcaption>
        <div class="pulse-plot">
          ${this.renderTicks(commits.ticks.map(tick => [tick / commits.top, compact(tick)]))}
          <div class="pulse-columns">${stats.weeks.map(week => {
            const name = `${weekName(week.week)}: ${plural(week.commits, 'commit')}`
            return html`<span class=${`pulse-column${marked(week)}`} role="img" aria-label=${name} data-tooltip=${name}>
              <span class="pulse-bar" style=${`--value: ${week.commits / commits.top}`}></span></span>`
          })}</div>
        </div>
        ${lines ? html`<div class="pulse-head is-sub"><h3>Lines</h3><span>added and removed a week</span>
            <span class="pulse-legend"><span class="pulse-key is-added"></span>Added<span class="pulse-key is-removed"></span>Removed</span></div>
          <div class="pulse-plot is-diverging">
            ${this.renderTicks([[1, `+${compact(lines.top)}`], [0.5, '0'], [0, `−${compact(lines.top)}`]])}
            <div class="pulse-columns">${stats.weeks.map(week => {
              const name = `${weekName(week.week)}: +${number(week.additions)} −${number(week.deletions)} lines`
              return html`<span class=${`pulse-column${marked(week)}`} role="img" aria-label=${name} data-tooltip=${name}>
                <span class="pulse-half"><span class="pulse-bar is-added" style=${`--value: ${week.additions / lines.top}`}></span></span>
                <span class="pulse-half is-below"><span class="pulse-bar is-removed" style=${`--value: ${week.deletions / lines.top}`}></span></span></span>`
            })}</div>
          </div>` : html`<p class="pulse-note">GitHub doesn’t count lines added and removed in a repository of 10,000 commits or more.</p>`}
        <div class="pulse-months" aria-hidden="true">${stats.weeks.map((week, at) => {
          const month = new Date(week.week).getUTCMonth()
          const starts = at === 0 ? stats.weeks.length > 3 && new Date(stats.weeks[3].week).getUTCMonth() === month : new Date(stats.weeks[at - 1].week).getUTCMonth() !== month
          return html`<span>${starts ? month === 0 ? new Date(week.week).getUTCFullYear() : new Date(week.week).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : ''}</span>`
        })}</div>
      </figure>
      ${this.renderContributors(answer)}
      ${this.renderPunch(stats.punch)}
    </section>`
  }

  // A plot's scale: a hairline at each tick, its label beside.
  renderTicks(ticks) {
    return html`<div class="pulse-ticks" aria-hidden="true">${ticks.map(([at, label]) => html`<span style=${`--at: ${at}`}><span>${label}</span></span>`)}</div>`
  }

  renderContributors(answer) {
    const people = periodContributors(answer.stats.contributors, answer.since)
    const top = people[0]?.commits ?? 1
    const lines = answer.stats.lines
    return html`<figure class="pulse-panel">
      <figcaption class="pulse-head"><h3>Contributors</h3><span>by their commits in the period</span></figcaption>
      ${people.length === 0 ? html`<p class="pulse-note">No commits in the period.</p>` : html`<ol class="pulse-ranks">${people.slice(0, TOP_CONTRIBUTORS).map(person => html`<li>
        <a class="pulse-rank-name" href=${profile(person.login)} target="_blank" rel="noopener noreferrer">${person.login}</a>
        <span class="pulse-rank-bar"><span style=${`--value: ${person.commits / top}`}></span><span class="pulse-rank-value">${number(person.commits)}</span></span>
        ${lines ? html`<span class="pulse-rank-lines">+${compact(person.additions)} −${compact(person.deletions)}</span>` : nothing}
      </li>`)}</ol>
      ${people.length > TOP_CONTRIBUTORS ? html`<p class="pulse-note">and ${plural(people.length - TOP_CONTRIBUTORS, 'more', 'more')}</p>` : nothing}`}
    </figure>`
  }

  // Commits by day of the week, a row each, Monday first, and hour, a cell
  // each, each a step darker or lighter the more it holds, as the scale
  // under them shows; an hour of none plain.
  renderPunch(punch) {
    const most = Math.max(1, ...punch.flat())
    return html`<figure class="pulse-panel">
      <figcaption class="pulse-head"><h3>When commits are made</h3><span>by day and hour, in each commit’s own time zone, not only the period’s</span></figcaption>
      <div class="pulse-punch">
        ${punch.map((hours, row) => html`<span class="pulse-punch-day">${DAYS[PUNCH_DAYS[row]].slice(0, 3)}</span>${hours.map((count, hour) => {
          const name = `${DAYS[PUNCH_DAYS[row]]}s, ${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00: ${plural(count, 'commit')}`
          return html`<span class=${`pulse-cell is-${count === 0 ? 0 : Math.ceil(count / most * PUNCH_STEPS)}`} role="img" aria-label=${name} data-tooltip=${name}></span>`
        })}`)}
        <span></span>${Array.from({ length: 24 }, (_, hour) => html`<span class="pulse-punch-hour">${hour % 6 === 0 ? `${hour}h` : ''}</span>`)}
      </div>
      <div class="pulse-scale" aria-hidden="true">Fewer${Array.from({ length: PUNCH_STEPS }, (_, step) => html`<span class=${`pulse-cell is-${step + 1}`}></span>`)}More</div>
    </figure>`
  }

  // The charts' figures as tables: the year's weeks, the latest first; the
  // period's contributors; and commits by day and hour.
  renderTables(answer, now) {
    const { stats, since } = answer
    const lines = stats.lines
    const people = periodContributors(stats.contributors, since)
    return html`<section class="pulse-tables">
      <table class="pulse-table">
        <caption>Commits${lines ? ' and lines' : ''} a week, over the last year</caption>
        <thead><tr><th scope="col">Week of</th><th scope="col">Commits</th>${lines ? html`<th scope="col">Added</th><th scope="col">Removed</th>` : nothing}</tr></thead>
        <tbody>${stats.weeks.toReversed().map(week => html`<tr class=${week.week >= since ? 'is-period' : ''}>
          <th scope="row">${day(week.week, true)}</th><td>${number(week.commits)}</td>
          ${lines ? html`<td>+${number(week.additions)}</td><td>−${number(week.deletions)}</td>` : nothing}</tr>`)}</tbody>
      </table>
      <table class="pulse-table">
        <caption>Contributors in the period</caption>
        <thead><tr><th scope="col">Contributor</th><th scope="col">Commits</th>${lines ? html`<th scope="col">Added</th><th scope="col">Removed</th>` : nothing}</tr></thead>
        <tbody>${people.length === 0 ? html`<tr><td colspan="4">No commits in the period.</td></tr>` : people.map(person => html`<tr>
          <th scope="row">${person.login}</th><td>${number(person.commits)}</td>
          ${lines ? html`<td>+${number(person.additions)}</td><td>−${number(person.deletions)}</td>` : nothing}</tr>`)}</tbody>
      </table>
      <table class="pulse-table is-punch">
        <caption>Commits by day and hour, in each commit’s own time zone</caption>
        <thead><tr><th scope="col">Day</th>${Array.from({ length: 24 }, (_, hour) => html`<th scope="col">${hour}</th>`)}</tr></thead>
        <tbody>${stats.punch.map((hours, row) => html`<tr><th scope="row">${DAYS[PUNCH_DAYS[row]].slice(0, 3)}</th>${hours.map(count => html`<td>${count}</td>`)}</tr>`)}</tbody>
      </table>
      <p class="pulse-note">As of ${day(now, true)}.</p>
    </section>`
  }

  // The latest of a kind GitHub found in the period, each its state, title,
  // number, author and when, opening its popup; where there were more, the
  // rest on GitHub.
  renderList(answer, kind, items, title, search) {
    const { count, items: listed } = answer[kind]
    const repo = this.repository.repo
    const all = repo ? `https://github.com/${repo}/${items === 'pulls' ? 'pulls' : 'issues'}?q=${encodeURIComponent(`${search}>=${isoDay(answer.since)}`)}` : null
    return html`<div class="pulse-list">
      <h3>${title}<span class="issues-count">${number(count)}</span></h3>
      ${listed.length === 0 ? html`<p class="pulse-note">None in the period.</p>` : html`<ol>${listed.map(item => {
        const [stateClass, stateName] = issueState(items, item)
        return html`<li><a class=${`pulse-item is-${stateClass}`} href=${repo ? `https://github.com/${repo}/${items === 'pulls' ? 'pull' : 'issues'}/${item.number}` : nothing}
          target="_blank" rel="noopener noreferrer" @click=${event => this.openItem(event, items, item)}>
          <span class="issue-state" role="img" aria-label=${stateName}>${STATE_ICONS[items][stateClass]}</span>
          <span class="pulse-item-title">${item.title || '(no title)'}</span>
          <span class="pulse-item-meta"><span>#${item.number}</span>${item.author ? html`<span>${item.author}</span>` : nothing}
            ${item.at == null ? nothing : html`<time datetime=${new Date(item.at).toISOString()}>${compactTime(item.at)}</time>`}</span>
        </a></li>`
      })}</ol>`}
      ${all && count > listed.length ? html`<a class="pulse-all" href=${all} target="_blank" rel="noopener noreferrer">All ${number(count)} on GitHub</a>` : nothing}
    </div>`
  }

  // An item clicked opens its popup (dialogs/repository-item-dialog.js),
  // what the list knew of it shown as the rest is read; held with a key, or
  // another button, it opens on GitHub.
  openItem(event, kind, item) {
    if (!plainClick(event)) return
    event.preventDefault()
    openRepositoryItemDialog({ repository: this.repository, target: { number: item.number, preview: { ...item, kind, labels: [], comments: 0 } } })
  }
}
if (!customElements.get('repository-pulse')) customElements.define('repository-pulse', RepositoryPulse)
