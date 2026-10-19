// The lines a version wanting reviews changes, beside its row in a list of
// them (team-dependencies.js, dialogs/repository-item-dialog.js): against the
// version it was (`base`), or, new, its whole package's (`(empty)`), as the
// server counts them (GET /api/npm/deltas): `+x −y`, and, where declaration
// files changed in types alone, which a reviewer may pass leaving them out,
// `(+z −w -types)`; and `, binary` where binary files, which lines don't
// count, changed too. Those a team's Dependencies tab is told with its
// versions held as they come (seedNpmDeltas); the rest read once their rows
// near the viewport (lazy-render.js), those asked within a frame asked
// together, as many as ASKED_TOGETHER a request, as many requests at once as
// READ_AT_ONCE, those asked first read first; and held for the session, what
// a version holds never changing; one that fails asked again after RETRY_MS.
import { LitElement, html, nothing } from 'lit'
import { state } from '#client/index.js'
import { fetchNpmDeltas } from './client-managed.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'

const READ_AT_ONCE = 2
const ASKED_TOGETHER = 50
// The most of its address a request's versions take, lest it be refused as
// too long.
const ASKED_LENGTH = 6000
const RETRY_MS = 60_000

const held = new Map()
// Those asked within this frame, by their keys, then those waiting their
// turn, a request's each.
const asking = new Map()
const waiting = []
const listeners = new Set()
let heldFor = null
let inFlight = 0
let framed = false
// Each listener told of the delta that changed (its key), none where all may have.
const changed = key => { for (const notify of listeners) notify(key) }

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== heldFor) {
    held.clear()
    asking.clear()
    waiting.length = 0
    heldFor = session
  }
  return held
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const lines = told => count(told?.additions) === null || count(told?.deletions) === null ? null : { additions: told.additions, deletions: told.deletions }
// What the server told of one, as held.
const ready = (all, told) => ({ status: 'ready', until: Number.POSITIVE_INFINITY, ...all, typeless: lines(told.typeless), binary: told.binary === true })
const failed = error => ({ status: 'error', until: Date.now() + RETRY_MS, error })

// Version `version` of package `name`'s delta against `base`, as held, else
// asked: `{ status }`, 'loading', then 'ready' with `additions`,
// `deletions`, `typeless` and `binary`, or 'error' with its `error`.
export function npmDelta(name, version, base) {
  const data = sessionHeld()
  const key = `${name}\0${version}\0${base}`
  const entry = data.get(key)
  if (entry && Date.now() < entry.until) return entry
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  asking.set(key, { asked: [name, version, base], loading })
  if (!framed) {
    framed = true
    if (globalThis.requestAnimationFrame) requestAnimationFrame(askTogether)
    else setTimeout(askTogether, 0)
  }
  return loading
}

// Those told otherwise, as a team's Dependencies are (team-dependencies.js),
// `[name, version, base, delta]` each, held as those asked for are, one
// asked for meanwhile asked no more.
export function seedNpmDeltas(deltas) {
  const data = sessionHeld()
  for (const [name, version, base, told] of deltas) {
    const all = lines(told), key = `${name}\0${version}\0${base}`
    if (!all || data.get(key)?.status === 'ready') continue
    asking.delete(key)
    data.set(key, ready(all, told))
    changed(key)
  }
}

// Those asked within the frame, in requests of as many as ASKED_TOGETHER,
// their address no longer than ASKED_LENGTH.
function askTogether() {
  framed = false
  let length = 0, request = []
  for (const [key, ask] of asking) {
    const size = encodeURIComponent(JSON.stringify(ask.asked)).length + 3
    if (request.length === ASKED_TOGETHER || (request.length > 0 && length + size > ASKED_LENGTH)) {
      waiting.push(request)
      request = []
      length = 0
    }
    request.push({ key, ...ask })
    length += size
  }
  if (request.length > 0) waiting.push(request)
  asking.clear()
  readNext()
}
function readNext() {
  while (inFlight < READ_AT_ONCE && waiting.length > 0) {
    // Those told meanwhile (seedNpmDeltas) asked no more.
    const asked = waiting.shift().filter(({ key, loading }) => held.get(key) === loading)
    if (asked.length === 0) continue
    inFlight++
    readOf(asked).finally(readDone)
  }
}
function readDone() {
  inFlight--
  readNext()
}
// A request's versions, each held as the server tells it, or why it
// couldn't be counted; one aborted asked again once drawn.
function readOf(asked) {
  const data = held
  const left = new Map(asked.map(({ key, loading }) => [key, loading]))
  const settle = (key, entry) => {
    if (!left.has(key)) return
    if (data.get(key) === left.get(key)) {
      if (entry) data.set(key, entry)
      else data.delete(key)
    }
    left.delete(key)
    changed(key)
  }
  return fetchNpmDeltas(asked.map(ask => ask.asked), told => {
    const all = lines(told)
    settle(`${told.name}\0${told.version}\0${told.otherVersion}`, typeof told.error === 'string' ? failed(told.error)
      : all ? ready(all, told) : failed('The server answered with no lines.'))
  }).then(() => {
    for (const key of [...left.keys()]) settle(key, failed('The server answered with none of it.'))
    return null
  }, err => {
    for (const key of [...left.keys()]) settle(key, err?.name === 'AbortError' ? null : failed(err?.message || 'Its lines couldn’t be counted.'))
  })
}

// The version a row's delta is against: one it was, else none.
export const deltaBase = pkg => pkg.was?.find(prior => prior !== pkg.version) ?? '(empty)'

const counted = (additions, deletions) => html`<span class="is-added">+${additions.toLocaleString('en-US')}</span> <span class="is-deleted">−${deletions.toLocaleString('en-US')}</span>`

class NpmDeltaElement extends LitElement {
  static properties = { name: { attribute: false }, version: { attribute: false }, base: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this._near = false
    // Drawn again as its own delta is read, or all may have changed.
    this._notify = key => { if (this._near && (!key || key === `${this.name}\0${this.version}\0${this.base ?? '(empty)'}`)) this.requestUpdate() }
  }

  connectedCallback() {
    super.connectedCallback()
    this._watch()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._unwatch()
  }

  // Told as what is held changes, and read once it nears the viewport, no
  // longer watched for it then.
  _watch() {
    listeners.add(this._notify)
    if (this._near) return
    watchNearViewport(this, near => {
      if (!near || this._near) return
      this._near = true
      unwatchNearViewport(this)
      this.requestUpdate()
    })
  }

  _unwatch() {
    listeners.delete(this._notify)
    unwatchNearViewport(this)
  }

  render() {
    if (!this._near || !this.name || !this.version) return nothing
    const entry = npmDelta(this.name, this.version, this.base ?? '(empty)')
    const against = this.base && this.base !== '(empty)' ? `against ${this.base}` : 'the whole package'
    if (entry.status === 'loading') return html`<span class="npm-delta is-loading" aria-label="Counting its lines">…</span>`
    if (entry.status === 'error') {
      return html`<span class="npm-delta is-error" data-tooltip=${entry.error} .tooltipContent=${html`<div class="compare-tip">
        <div class="compare-tip-head">Lines not counted</div><div>${entry.error}</div></div>`}>?</span>`
    }
    // What it tells, formatted, its tooltip: what it is against, the lines
    // added and removed, those but for declaration files changed in types
    // alone, and that binary files changed too.
    const tip = html`<div class="compare-tip"><div class="compare-tip-head">Lines changed</div>
      <div class="compare-tip-rows"><span class="compare-tip-label">Against</span><span>${this.base && this.base !== '(empty)' ? this.base : 'none, the whole package'}</span>
        <span class="compare-tip-label">Added</span><span class="is-added">+${entry.additions.toLocaleString('en-US')}</span>
        <span class="compare-tip-label">Removed</span><span class="is-deleted">−${entry.deletions.toLocaleString('en-US')}</span>
        ${entry.typeless ? html`<span class="compare-tip-label">Types aside</span><span>${counted(entry.typeless.additions, entry.typeless.deletions)}</span>` : nothing}</div>
      ${entry.typeless ? html`<div class="compare-tip-note">Types aside: leaving out the declaration files changed in types alone</div>` : nothing}
      ${entry.binary ? html`<div class="compare-tip-note">Binary files changed too, which no line counts</div>` : nothing}</div>`
    return html`<span class="npm-delta" data-tooltip=${`Lines it adds and removes, ${against}`} .tooltipContent=${tip}>${counted(entry.additions, entry.deletions)}${entry.binary
      ? html`<span class="npm-delta-binary">, binary</span>` : nothing}${entry.typeless
      ? html` <span class="npm-delta-typeless">(${counted(entry.typeless.additions, entry.typeless.deletions)}
        -types)</span>` : nothing}</span>`
  }
}

if (!customElements.get('npm-delta')) customElements.define('npm-delta', NpmDeltaElement)
