// A managed bundle's dependency review, as a line of its Overview's facts
// (render-bundle.js): where the repository it is attached to reviews
// dependencies and its review is in effect for the reader
// (server-managed/bundle-dependency-reviews.ts), whether the npm versions it
// holds pass, as the lockfiles installing it lock them at the commit it was
// built from; how many want reviews; or what fails it: versions that can't
// be reviewed, those no lockfile there locks (`unlocked`), and lockfiles
// left unread. Its details, opened, tell the review's terms and list those
// versions, each opening its review where its reader reviews
// (team-dependencies.js versionRow). Asked once its Overview shows, and kept
// for the session that asked a while, as a team's Dependencies tab keeps
// what it read; none told while it is first read, nor where no review is in
// effect.
import { html, nothing, svg } from 'lit'
import { state } from '#client/index.js'
import { fetchBundleDependencyReview } from './client-managed.js'
import { checked, reviewFailures, unreviewedVersions } from './pull-dependencies.js'
import { versionRow } from './team-dependencies.js'
import { CHECKS, icon } from './repository-tiles.js'

const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000

const held = new Map()
// The bundles whose details are open, by their ids.
const opened = new Set()
let keptFor = null
let changed = () => {}

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    held.clear()
    opened.clear()
    keptFor = session
  }
  return held
}

// A repository's review set anew (the admin's repository page): what is
// held asked again.
globalThis.addEventListener?.('dependency-review-changed', () => {
  held.clear()
  changed()
})

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const isVersion = one => typeof one?.name === 'string' && typeof one.version === 'string'

// A server's answer as it is shown: none where no review is in effect; else
// as a pull request's is (pull-dependencies.js checked), with how many
// versions the bundle holds (`versions`) and those no lockfile installing it
// locks (`unlocked`, each told why it can't be reviewed), how many more
// (`moreUnlocked`).
export function checkedBundleReview(answer) {
  if (!answer?.review) return null
  const shown = checked(answer)
  if (!shown.review) return null
  return { ...shown, versions: count(answer.versions), moreUnlocked: count(answer.moreUnlocked),
    unlocked: Array.isArray(answer.unlocked) ? answer.unlocked.filter(isVersion).map(({ name, version }) => ({ name, version, unsupported: 'unlocked' })) : [] }
}

// Bundle `bundle`'s review as held, else asked: 'loading', then 'ready'
// with its `answer` (null for none in effect), or 'error' with its `error`;
// asked again once old, shown as it was meanwhile, or once an error's retry
// is due; held by where it is too, so that one moved is asked again at once.
export function bundleDependencyReview(bundle) {
  const data = sessionHeld()
  const id = `${bundle.managedId}\0${bundle.repoId}\0${bundle.repoDirectory ?? ''}`
  const entry = data.get(id)
  if (entry && Date.now() < entry.until) return entry
  const loading = entry?.status === 'ready' ? { ...entry, until: Number.POSITIVE_INFINITY, refreshing: true } : { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(id, loading)
  fetchBundleDependencyReview(bundle.managedId).then(answer => ({ status: 'ready', until: Date.now() + KEEP_MS, answer: checkedBundleReview(answer) }))
    .catch(err => err?.name === 'AbortError' ? null : { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'It couldn’t be read.' })
    .then(next => {
      if (data.get(id) !== loading) return false
      if (next) data.set(id, next)
      else data.delete(id)
      changed()
      return true
    })
  return loading
}

const plural = (value, noun) => `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`
const CHEVRON = icon(svg`<path d="m6 4 4 4-4 4"/>`)
const paths = list => list.map((path, at) => html`${at > 0 ? ', ' : ''}<code>${path}</code>`)

// What the line says of `answer`: its state's chip, what it tells beside
// it, and the versions its details list, those failing it first.
function told(answer) {
  const { versions: wanting, count: wanted } = unreviewedVersions(answer)
  const failed = reviewFailures(answer)
  const unlocked = answer.unlocked.length + answer.moreUnlocked
  const unread = failed?.unread.flatMap(dir => dir.paths) ?? []
  const failing = [failed?.count ? `${failed.count.toLocaleString('en-US')} can’t be reviewed` : null,
    unlocked ? `${unlocked.toLocaleString('en-US')} not locked at its commit` : null,
    unread.length > 0 ? `${plural(unread.length, 'lockfile')} unread` : null,
    failed?.unchecked ? `${plural(failed.unchecked, 'version')} past those checked` : null].filter(Boolean)
  const of = `of ${plural(answer.versions, 'npm version')}`
  const chip = failing.length > 0 ? html`<span class="bundle-review-state is-failed">Fails</span>`
    : wanted > 0 ? html`<span class="bundle-review-state is-wanted">${wanted.toLocaleString('en-US')} to review</span>`
    : html`<span class="bundle-review-state is-passed">${CHECKS.success[1]}Passes</span>`
  const said = failing.length > 0 ? `${failing.join(', ')}${wanted > 0 ? `; ${wanted.toLocaleString('en-US')} to review` : ''}, ${of}`
    : wanted > 0 ? of : `${plural(answer.versions, 'npm version')}, each reviewed or needing none`
  const listed = [...failed?.versions ?? [], ...answer.unlocked, ...wanting]
  const more = Math.max(0, (failed?.count ?? 0) - (failed?.versions.length ?? 0)) + answer.moreUnlocked + Math.max(0, wanted - wanting.length)
  return { chip, said, listed, more, unread }
}

// The review's terms, as a pull request's popup tells them, the lockfiles
// read and where, and what they couldn't tell.
function terms(answer, unread) {
  const { required, since, reviewedDependencies, unasked, baselineError, baselineUnread = [], lockfiles } = answer.review
  const read = answer.lockfiles.filter(dir => !dir.error).flatMap(dir => dir.paths)
  const at = answer.head ? html` at <code>${answer.head.slice(0, 7)}</code>` : nothing
  return html`<p class="team-deps-quiet">Each version needs ${plural(required, 'full, accepting review')} by as many reviewers, of it whole or compared with any
    version of its package${reviewedDependencies ? ', or the server’s reviewed dependencies to pass it' : since
      ? html`; those the repository’s lockfiles locked at <code>${since.slice(0, 7)}</code> need none` : nothing}.</p>
    <p class="team-deps-quiet">${read.length > 0 ? html`As ${paths(read)} ${read.length === 1 ? 'locks' : 'lock'} them${at}, the nearest first.`
      : html`No lockfile installing it was read${at}.`}</p>
    ${unread.length > 0 ? html`<p class="team-deps-quiet" role="alert">Unread, so what ${unread.length === 1 ? 'it locks isn’t' : 'they lock aren’t'} checked: ${paths(unread)}.</p>` : nothing}
    ${baselineError ? html`<p class="team-deps-quiet" role="alert">The versions locked at the commit reviewed since couldn’t be read (${baselineError}), so every version wants its reviews.</p>` : nothing}
    ${baselineUnread.length > 0 ? html`<p class="team-deps-quiet" role="alert">At the commit reviewed since, ${paths(baselineUnread.slice(0, 5))}${baselineUnread.length > 5
      ? ` and ${(baselineUnread.length - 5).toLocaleString('en-US')} more` : ''} couldn’t be read, so the versions ${baselineUnread.length === 1 ? 'it' : 'they'} locked want reviews.</p>` : nothing}
    ${unasked ? html`<p class="team-deps-quiet" role="alert">The server’s reviewed dependencies didn’t answer for ${plural(unasked, 'version')}, so ${unasked === 1 ? 'it wants' : 'they want'} reviews.</p>` : nothing}
    ${lockfiles ? html`<p class="team-deps-quiet">${lockfiles.mode === 'include' ? 'Only these lockfiles are reviewed: ' : 'These lockfiles aren’t reviewed: '}${lockfiles.paths.length === 0
      ? 'none' : paths(lockfiles.paths)}.</p>` : nothing}`
}

// The Overview's line for `entry`, a managed Stasis bundle of a repository,
// as a fact of its list (`<dt>`, `<dd>`); nothing for another, or while its
// review is first read, or where none is in effect. `onChange` is called as
// what it tells changes (render.js render).
export function bundleDependencyReviewFact(entry, onChange) {
  if (!entry?.managedId || entry.repoId == null || entry.kind !== 'stasis' || !state.managedSession || state.managedSession.publicShare) return nothing
  changed = onChange
  const read = bundleDependencyReview(entry)
  if (read.status === 'loading') return nothing
  if (read.status === 'error') {
    return html`<dt>Dependency review</dt><dd class="bundle-review"><span class="bundle-review-error" role="alert">Couldn’t check its dependencies: ${read.error}</span></dd>`
  }
  const { answer } = read
  if (!answer) return nothing
  const { chip, said, listed, more, unread } = told(answer)
  const id = entry.managedId, open = opened.has(id)
  const toggle = () => {
    if (opened.has(id)) opened.delete(id)
    else opened.add(id)
    onChange()
  }
  return html`<dt>Dependency review</dt><dd class="bundle-review">
    <div class="bundle-review-line">${chip}<span class="bundle-review-said">${said}</span>
      <button type="button" class="team-deps-more" aria-expanded=${String(open)} @click=${toggle}>${CHEVRON}<span>Details</span></button></div>
    ${open ? html`<div class="bundle-review-details">${terms(answer, unread)}
      ${listed.length > 0 ? html`<ul class="team-deps-versions bundle-review-versions">${listed.map(pkg => versionRow(pkg, answer.review, { repoId: entry.repoId, head: answer.head ?? null }))}</ul>` : nothing}
      ${more > 0 ? html`<p class="team-deps-quiet">and ${more.toLocaleString('en-US')} more, not listed</p>` : nothing}
    </div>` : nothing}
  </dd>`
}
