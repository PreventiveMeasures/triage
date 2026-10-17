// The lines a version wanting reviews changes, beside its row in a list of
// them (team-dependencies.js, dialogs/repository-item-dialog.js): against the
// version it was (`base`), or, new, its whole package's (`(empty)`), as the
// server counts them (GET /api/npm/delta): `+x −y`, and, where declaration
// files changed in types alone, which a reviewer may pass leaving them out,
// `(+z −w -types)`; and `, binary` where binary files, which lines don't
// count, changed too. Read once its row nears the viewport
// (lazy-render.js), as many at once as READ_AT_ONCE, those asked first read
// first, and held for the session, what a version holds never changing; one
// that fails asked again after RETRY_MS.
import { LitElement, html, nothing } from 'lit'
import { state } from '#client/index.js'
import { fetchNpmDelta } from './client-managed.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'

const READ_AT_ONCE = 2
const RETRY_MS = 60_000

const held = new Map()
const waiting = []
const listeners = new Set()
let heldFor = null
let inFlight = 0
const changed = () => { for (const notify of listeners) notify() }

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== heldFor) {
    held.clear()
    waiting.length = 0
    heldFor = session
  }
  return held
}
function readNext() {
  while (inFlight < READ_AT_ONCE && waiting.length > 0) {
    inFlight++
    waiting.shift()().finally(readDone)
  }
}
function readDone() {
  inFlight--
  changed()
  readNext()
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const lines = told => count(told?.additions) === null || count(told?.deletions) === null ? null : { additions: told.additions, deletions: told.deletions }

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
  waiting.push(() => fetchNpmDelta(name, version, base).then(told => {
    const all = lines(told)
    if (data.get(key) !== loading) return null
    data.set(key, all ? { status: 'ready', until: Number.POSITIVE_INFINITY, ...all, typeless: lines(told.typeless), binary: told.binary === true }
      : { status: 'error', until: Date.now() + RETRY_MS, error: 'The server answered with no lines.' })
    return null
  }, err => {
    if (data.get(key) !== loading) return null
    if (err?.name === 'AbortError') data.delete(key)
    else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'Its lines couldn’t be counted.' })
    return null
  }))
  readNext()
  return loading
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
    this._notify = () => this.requestUpdate()
  }

  connectedCallback() {
    super.connectedCallback()
    this._watch()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._unwatch()
  }

  // Told as what is held changes, and read once it nears the viewport.
  _watch() {
    listeners.add(this._notify)
    watchNearViewport(this, near => {
      if (!near || this._near) return
      this._near = true
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
    if (entry.status === 'error') return html`<span class="npm-delta is-error" data-tooltip=${entry.error}>?</span>`
    return html`<span class="npm-delta" data-tooltip=${`Lines it adds and removes, ${against}`}>${counted(entry.additions, entry.deletions)}${entry.binary
      ? html`<span class="npm-delta-binary" data-tooltip="Binary files changed too, which no line counts">, binary</span>` : nothing}${entry.typeless
      ? html` <span class="npm-delta-typeless" data-tooltip="Leaving out the declaration files changed in types alone">(${counted(entry.typeless.additions, entry.typeless.deletions)}
        -types)</span>` : nothing}</span>`
  }
}

if (!customElements.get('npm-delta')) customElements.define('npm-delta', NpmDeltaElement)
