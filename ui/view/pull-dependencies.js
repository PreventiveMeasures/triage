// The package versions a pull request's lockfiles add, a package's new to them
// or a new version of one they locked before, as an open pull request's tile
// (repository-issues.js) and any one's popup
// (dialogs/repository-item-dialog.js) show them (GET
// /api/admin/repositories/pull-dependencies): read only of one GitHub says
// changes a lockfile, or may, its files more than it listed
// (`touchesLockfile`), as many at once as READ_AT_ONCE, those asked first
// read first, as a page of tiles asks of each in turn; and kept for the
// session that read them a while, as the tiles are.
import { state } from '#client/index.js'
import { fetchPullDependencies } from './client-managed.js'

const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
const READ_AT_ONCE = 2

const held = new Map()
const waiting = []
const listeners = new Set()
let keptFor = null
let reading = 0

// Calls `notify` as what is held changes, till the returned function is called.
export function subscribePullDependencies(notify) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}
const changed = () => { for (const notify of listeners) notify() }

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    held.clear()
    waiting.length = 0
    keptFor = session
  }
  return held
}

// Whether a pull request's new packages are read: one GitHub says changes a
// lockfile, or may.
export const readsDependencies = item => item?.touchesLockfile === true || item?.touchesLockfile === null

// A server's answer, its directories those it names by their lockfiles'
// paths, each's package versions those it names, the versions each was
// those it names.
function checked(answer) {
  if (!Array.isArray(answer?.lockfiles)) throw new Error('The server answered with no lockfiles.')
  const versions = was => Array.isArray(was) && was.every(version => typeof version === 'string') && was.length > 0 ? { was } : {}
  const lockfiles = answer.lockfiles.filter(dir => Array.isArray(dir?.paths) && (Array.isArray(dir.added) || typeof dir.error === 'string')).map(dir => dir.error ? dir
    : { ...dir, added: dir.added.flatMap(pkg => {
      if (typeof pkg?.name !== 'string') return []
      const { was, ...version } = pkg
      return [{ ...version, ...versions(was) }]
    }), more: Number.isSafeInteger(dir.more) ? dir.more : 0 })
  return { lockfiles, cut: answer.cut === true }
}

// The next asked read as one is, as many at once as READ_AT_ONCE.
function readNext() {
  while (reading < READ_AT_ONCE && waiting.length > 0) {
    reading++
    waiting.shift()().finally(readDone)
  }
}
function readDone() {
  reading--
  changed()
  readNext()
}

// What pull request `number` of repository `repoId` adds, as held, else
// asked: `{ status }`, 'loading', then 'ready' with its `lockfiles` and
// `cut`, or 'error' with its `error`; asked again once old, or once an
// error's retry is due.
export function pullDependencies(repoId, number) {
  const data = sessionHeld()
  const key = `${repoId}\0${number}`
  const entry = data.get(key)
  if (entry && Date.now() < entry.until) return entry
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  waiting.push(() => fetchPullDependencies(repoId, number).then(checked).then(answer => {
    if (data.get(key) === loading) data.set(key, { status: 'ready', until: Date.now() + KEEP_MS, ...answer })
    return null
  }, err => {
    if (data.get(key) !== loading) return null
    if (err?.name === 'AbortError') data.delete(key)
    else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'Its lockfiles could not be read.' })
    return null
  }))
  readNext()
  return loading
}

// What an answer tells new: each package version once, across its
// directories, those of packages new to them first (`fresh`, no `was`), then
// the new versions of those they locked before; how many of each; and
// whether it tells more than it sends (`more`).
export function addedVersions({ lockfiles }) {
  const all = new Map()
  for (const pkg of lockfiles.flatMap(dir => dir.added ?? [])) {
    const key = `${pkg.name}@${pkg.version ?? ''}`
    if (!all.has(key)) all.set(key, pkg)
  }
  const versions = [...all.values()]
  const fresh = versions.filter(pkg => !pkg.was)
  return { versions: [...fresh, ...versions.filter(pkg => pkg.was)], fresh: fresh.length, updated: versions.length - fresh.length, more: lockfiles.some(dir => dir.more > 0) }
}
