// `<npm-delta>`: the lines a version wanting reviews changes, beside its row
// (team-dependencies.js, dialogs/repository-item-dialog.js), as the server
// counts them (GET /api/npm/deltas): against `base` (of package `baseName`)
// or the whole package (`(empty)`), as `patch` changes it where given: `+x
// −y`, `(+z −w -types)` where declaration files changed in types alone, and
// `, binary` where binary files changed too. Those seeded (seedNpmDeltas) are
// held as they come; the rest read once their rows near the viewport, those
// asked within a frame together (ASKED_TOGETHER a request, READ_AT_ONCE
// requests at once), held for the session, a failure asked again after RETRY_MS.
import { LitElement, html, nothing } from 'lit'
import { fetchNpmDeltas } from './client-managed.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { sessionKept } from './activity-reads.js'

const READ_AT_ONCE = 2
const ASKED_TOGETHER = 50
// The most of its address a request's versions take, lest it be refused as too long.
const ASKED_LENGTH = 6000
const RETRY_MS = 60_000

const held = new Map()
// Those asked within this frame by key, then those waiting their turn, a request's each.
const asking = new Map()
const waiting = []
const listeners = new Set()
let inFlight = 0
let framed = false
// Each listener told of the delta that changed (its key), none where all may have.
const changed = key => { for (const notify of listeners) notify(key) }
// What is held and asked, forgotten as another session or role reads.
const sessionHeld = sessionKept(held, asking, { clear: () => { waiting.length = 0 } })

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const lines = told => count(told?.additions) === null || count(told?.deletions) === null ? null : { additions: told.additions, deletions: told.deletions }
// What the server told of one, as held.
const ready = (all, told) => ({ status: 'ready', until: Number.POSITIVE_INFINITY, ...all, typeless: lines(told.typeless), binary: told.binary === true })
const failed = error => ({ status: 'error', until: Date.now() + RETRY_MS, error })

// A delta's key: its version's, its base's (another package's named before
// it), and its patch's hash.
const keyOf = (name, version, base, patchHash, baseName = name) =>
  `${name}\0${version}\0${baseName === name ? '' : `${baseName}@`}${base}${patchHash ? `\0${patchHash}` : ''}`
// A version's delta, as held, else asked: `{ status }`, 'loading', then
// 'ready' with `additions`, `deletions`, `typeless` and `binary`, or 'error'
// with its `error`. `patch` is `{ hash, repoId, commit, path }`.
export function npmDelta(name, version, base, patch = null, baseName = name) {
  const data = sessionHeld()
  const key = keyOf(name, version, base, patch?.hash, baseName)
  const entry = data.get(key)
  if (entry && Date.now() < entry.until) return entry
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  const asked = baseName === name ? [name, version, base, ...patch ? [patch] : []] : [name, version, base, patch, baseName]
  asking.set(key, { asked, loading })
  if (!framed) {
    framed = true
    if (globalThis.requestAnimationFrame) requestAnimationFrame(askTogether)
    else setTimeout(askTogether, 0)
  }
  return loading
}

// Those told otherwise, as a team's Dependencies are, `[name, version, base,
// delta]` each, held as those asked are, one asked meanwhile asked no more.
export function seedNpmDeltas(deltas) {
  const data = sessionHeld()
  for (const [name, version, base, told] of deltas) {
    const all = lines(told), key = keyOf(name, version, base)
    if (!all || data.get(key)?.status === 'ready') continue
    asking.delete(key)
    data.set(key, ready(all, told))
    changed(key)
  }
}

// Those asked within the frame, in requests of ASKED_TOGETHER at most, no longer than ASKED_LENGTH.
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
  const left = new Map(asked.map(({ key, loading }) => [key, loading]))
  const settle = (key, entry) => {
    if (!left.has(key)) return
    if (held.get(key) === left.get(key)) {
      if (entry) held.set(key, entry)
      else held.delete(key)
    }
    left.delete(key)
    changed(key)
  }
  return fetchNpmDeltas(asked.map(ask => ask.asked), told => {
    const all = lines(told)
    settle(keyOf(told.name, told.version, told.otherVersion, told.patchHash, told.otherName ?? told.name), typeof told.error === 'string' ? failed(told.error)
      : all ? ready(all, told) : failed('The server answered with no lines.'))
  }).then(() => {
    for (const key of [...left.keys()]) settle(key, failed('The server answered with none of it.'))
    return null
  }, err => {
    for (const key of [...left.keys()]) settle(key, err?.name === 'AbortError' ? null : failed(err?.message || 'Its lines couldn’t be counted.'))
  })
}

// The version a pull request's row is reviewed against, `{ name, version }`,
// null for its whole package: the one the host names (`review.reviewedBases`),
// else one it was, a patched one's the version it patches where it was that.
export function reviewBase(pkg, review) {
  if (review?.reviewedBases) return pkg.base ?? null
  const was = pkg.patch && pkg.was?.includes(pkg.version) ? pkg.version : pkg.was?.find(prior => prior !== pkg.version)
  return was ? { name: pkg.name, version: was } : null
}

const added = n => html`<span class="is-added">+${n.toLocaleString('en-US')}</span>`
const deleted = n => html`<span class="is-deleted">−${n.toLocaleString('en-US')}</span>`
const counted = (additions, deletions) => html`${added(additions)} ${deleted(deletions)}`

class NpmDeltaElement extends LitElement {
  static properties = { name: { attribute: false }, version: { attribute: false }, base: { attribute: false }, baseName: { attribute: false }, patch: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this._near = false
    // Drawn again as its own delta is read, or all may have changed.
    this._notify = key => { if (this._near && (!key || key === this._key())) this.requestUpdate() }
  }

  connectedCallback() {
    super.connectedCallback()
    this._watch()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._unwatch()
  }

  // Told as what is held changes, and read once it nears the viewport, no longer watched for it then.
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

  // Its delta's key, and what it is against: the version, another package's named before it.
  _key() { return keyOf(this.name, this.version, this.base ?? '(empty)', this.patch?.hash, this.baseName ?? this.name) }
  _against() { return this.base && this.base !== '(empty)' ? `${this.baseName && this.baseName !== this.name ? `${this.baseName}@` : ''}${this.base}` : null }

  render() {
    if (!this._near || !this.name || !this.version) return nothing
    const entry = npmDelta(this.name, this.version, this.base ?? '(empty)', this.patch ?? null, this.baseName ?? this.name)
    const against = this._against() ? `against ${this._against()}` : 'the whole package'
    if (entry.status === 'loading') return html`<span class="npm-delta is-loading" aria-label="Counting its lines">…</span>`
    if (entry.status === 'error') {
      return html`<span class="npm-delta is-error" data-tooltip=${entry.error} .tooltipContent=${html`<div class="compare-tip">
        <div class="compare-tip-head">Lines not counted</div><div>${entry.error}</div></div>`}>?</span>`
    }
    // Its tooltip: what it is against, the lines added and removed, those
    // but for type-only declaration files, and that binary files changed too.
    const tip = html`<div class="compare-tip"><div class="compare-tip-head">Lines changed</div>
      <div class="compare-tip-rows"><span class="compare-tip-label">Against</span><span>${this._against() ?? 'none, the whole package'}</span>
        <span class="compare-tip-label">Added</span>${added(entry.additions)}
        <span class="compare-tip-label">Removed</span>${deleted(entry.deletions)}
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
