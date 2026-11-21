// A team's dependencies to review, its Dependencies tab, where its reader
// reviews them in it (workspace-content.js), a sub-tab each (TABS), drawn
// as a dialog's header tabs are (header-tabs.js), the one open
// (`state.teamDependenciesTab`) its address's, /team/<slug>/dependencies
// [/<tab>], and scrolling under them: of each
// of its repositories whose review is in effect for them, the open pull
// requests whose versions want reviews, in the order picked (SORTS), each
// version with its review as its pull request's is (pull-dependencies.js),
// listed under one of those reviewing it alike, dimmed under the rest, red
// under those lacking a review made in another (standings), those adding
// only versions others list set apart; every version they add
// wanting one, each once, by the pull requests adding it; what each
// repository's default branch locks that wants one, where any does; and the
// reviews published to the team
// (dependency-review-list.js). Its repositories not held read in one request
// of the team's (GET /api/teams/:id/dependencies), each as its lines come:
// its default branch and open pull requests, then their dependencies, held
// as pull-dependencies.js holds those a tile or a popup asks for
// (seedPullDependencies), and the lines their versions change where they
// are counted already (npm-delta.js seedNpmDeltas). A repository's are held
// for the session a while (KEEP_MS), each shown as it was while read again;
// those the server's time left asked for again; and read anew once a
// repository's or a team's review is set anew. A pull request is named
// without its repository's owner where every repository reviewed has the
// same one. Where its review holds to a stasis.config.json Stasis still
// builds, a pull request awaiting it is asked again alone, and a repository
// whose default branch awaits it read again sooner, its lockfiles' versions
// listed meanwhile; once built, a version a lockfile beside it locks that it
// reaches not is marked (!). Each list shows those reviewed already first,
// those marked last (prioritized).
import { html, nothing, svg } from 'lit'
import { styleMap } from './style-map.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { fetchTeamDependencies, fetchTeamReviewChanges } from './client-managed.js'
import { UNSUPPORTED_WHY, addedVersions, checked, heldPullDependencies, isPending, passedByComments, pullDependencies, readsDependencies, reviewFailures, reviewOf, seedPullDependencies,
  staleReviews, subscribePullDependencies, unreviewedVersions, versionKey } from './pull-dependencies.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { icon } from './repository-tiles.js'
import { sourcePackageIcon } from './source-file-icon.js'
import { dialogTabs } from './header-tabs.js'
import { verdictIcon, verdictLabels } from './npm-review-presentation.js'
import { withCompare } from './compare-load.js'
import { reviewBase, seedNpmDeltas } from './npm-delta.js'
import { githubUser, githubUserName, knowGithubUsers } from './github-users.js'
import { GITHUB_ICON_SVG } from './icons.js'
import { appMarkup } from './markup.js'
import './dependency-review-copy.js'
import './mode-switch.js'
import { managedHistory } from './managed-history.js'
import { managedRouteForIds, managedRoutePath } from '../../common/managed/routes.js'

const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000
// How many times a read the server's time cut short goes on, the
// repositories it left asked for again; and the versions shown of a list,
// under a pull request or a default branch, the rest shown once asked for.
const RESUMES = 3
// Each `[up to, folded to]`: a list of as many as the first shown whole, a
// longer one cut to the second, which leaves more than a row or two behind
// its "and N more".
const SHOWN_VERSIONS = [15, 10]
const SHOWN_LISTED = [48, 48]
// Of a card's versions listed under other pull requests, lest they crowd its own.
const SHOWN_SAME = [6, 3]
const SHOWN_ALL = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
// Its sub-tabs, each at an address of its own, the one last picked
// opened again by the team's Dependencies tab (ingest.js
// switchToWorkspaceContent).
const TABS = [['pulls', 'Pull requests'], ['versions', 'Versions'], ['branch', 'Default branch'], ['reviews', 'Reviews']]
// The orders of its Pull requests sub-tab (`state.teamDependenciesSort`),
// by what each is named in its picker: the newest opened first, the latest
// updated first, or those adding fewest versions to review first, one held by
// others alone after those adding some, then by the fewest those are; each
// one's ties by repository, then the newest by number.
const tied = (a, b) => a.repo.name < b.repo.name ? -1 : a.repo.name > b.repo.name ? 1 : b.item.number - a.item.number
const latest = field => (a, b) => (b.item[field] ?? 0) - (a.item[field] ?? 0) || tied(a, b)
const fewest = (a, b) => Number(a.size === 0) - Number(b.size === 0) || a.size - b.size || a.others - b.others || tied(a, b)
const SORTS = { newest: ['Newest', latest('createdAt')], updated: ['Updated', latest('updatedAt')], fewest: ['Fewest to review', fewest] }
// A pull request whose dependencies are still to be told.
const TELLING = { status: 'loading', until: Number.POSITIVE_INFINITY }
// Whether a pull request is to merge into its repository's default branch
// (`defaultBranch`), as its team's read tells the dependencies of those
// alone (http.ts): one whose branch, or the default, isn't told is.
const ontoDefault = (item, defaultBranch) => !defaultBranch || typeof item.base !== 'string' || item.base === defaultBranch
// Whether its team's read tells a pull request's dependencies: one into its
// repository's default branch, not a draft (http.ts).
const toldOf = (item, defaultBranch) => ontoDefault(item, defaultBranch) && item.draft !== true
// A pull request's dependencies as its team's read told them, else still to
// be told; one awaiting a build of Stasis's asked again alone as it grows
// old, as is one whose versions' reviews changed (`stale`, staleReviews).
function pullEntry(repoId, number) {
  const held = heldPullDependencies(repoId, number, true)
  return held?.pending || held?.stale ? pullDependencies(repoId, number, true, { background: true }) : held ?? TELLING
}
// How often a tab showing asks whether reviews counting for its team's
// repositories changed, while its page is seen; and how long before its
// first answer it asks since, as what it shows may be as old.
const REVIEWS_EVERY_MS = 30_000
const REVIEWS_BEFORE_MS = KEEP_MS
// How long past the time one is read again its tab is told to.
const AGAIN_PAST_MS = 50

const held = new Map()
const listeners = new Set()
// The reads in flight, by the team each reads, stopped once what they read
// is forgotten, or once no tab shows their team: a read runs minutes, and
// resumes, which a tab left would leave running for none.
const inFlight = new Map()
// The team each tab shows, by its element.
const showing = new Map()
let heldFor = null
let sweeping = false
const changed = () => { for (const notify of listeners) notify() }
function forget() {
  held.clear()
  for (const read of inFlight.keys()) read.abort()
  inFlight.clear()
}
// Reads of teams no tab shows stopped, once those moved meanwhile are back
// in place, what they held read again once drawn (readTeam).
function stopUnshown() {
  if (sweeping) return
  sweeping = true
  queueMicrotask(() => {
    sweeping = false
    const teams = new Set(showing.values())
    for (const [read, team] of inFlight) if (!teams.has(team)) read.abort()
  })
}
globalThis.addEventListener?.('dependency-review-changed', () => {
  forget()
  changed()
})

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== heldFor) {
    forget()
    heldFor = session
  }
  return held
}

// Repositories `repoIds` of team `team`, each as held, else asked for, all
// those not held, or grown old, in one read (readTeam): `{ status }`,
// 'loading', then 'ready' with its default branch's dependencies (`branch`,
// none where no review is in effect, nor where its reader may read only
// some of it) and, where they are, its open pull requests (`pulls`, with
// why not all of them were read, where they weren't, `error`), those
// whose dependencies are still to be told by their numbers (`telling`), or
// 'error' with its `error`; one grown old shown as it was while it is read
// again (`refreshing`), lest its pull requests leave the tab meanwhile.
function teamRepositories(team, repoIds) {
  const data = sessionHeld()
  const asked = []
  const entries = repoIds.map(repoId => {
    const entry = data.get(repoId)
    if (entry && Date.now() < entry.until) return entry
    const loading = entry?.status === 'ready' ? { ...entry, until: Number.POSITIVE_INFINITY, telling: null, refreshing: true }
      : { status: 'loading', until: Number.POSITIVE_INFINITY }
    data.set(repoId, loading)
    asked.push(repoId)
    return loading
  })
  if (asked.length > 0) readTeam(team, asked, asked.length === repoIds.length ? null : asked, RESUMES)
  return entries
}

// Repositories `asked` of team `team` read in one request, those
// `repoIds` names alone where it names some, each held as its lines tell
// it; those the server's time left asked for again, as many times as
// `resumes`.
function readTeam(team, asked, repoIds, resumes) {
  const data = held
  // Each one's entry as this read last held it, those it told all of left out.
  const current = new Map(asked.map(repoId => [repoId, data.get(repoId)]))
  const set = (repoId, entry) => {
    if (data.get(repoId) === current.get(repoId)) data.set(repoId, entry)
    if (data.get(repoId) === entry && entry.telling) current.set(repoId, entry)
    else current.delete(repoId)
  }
  const controller = new AbortController()
  inFlight.set(controller, team)
  let unread = null
  fetchTeamDependencies(team, line => {
    if (controller.signal.aborted) return
    if (typeof line.done === 'boolean') unread = line.done ? [] : (Array.isArray(line.unread) ? line.unread : [])
    else if (current.has(line.repoId)) {
      toldLine(line, current.get(line.repoId), entry => set(line.repoId, entry))
      changed()
    }
  }, { repoIds, signal: controller.signal }).then(() => {
    const again = (unread ?? []).filter(repoId => current.has(repoId)), resuming = again.length > 0 && resumes > 0
    for (const [repoId, entry] of [...current]) {
      if (resuming && again.includes(repoId)) continue
      set(repoId, untold(repoId, entry, unread === null ? 'The server’s answer ended short.' : again.includes(repoId) ? 'Reading its pull requests took too long.' : null))
    }
    if (resuming) readTeam(team, again, again, resumes - 1)
    return null
  }, err => {
    for (const [repoId, entry] of [...current]) {
      if (err?.name !== 'AbortError') set(repoId, untold(repoId, entry, err?.message || 'It couldn’t be read.'))
      // One aborted read again once drawn, shown as it was meanwhile.
      else if (data.get(repoId) === entry) {
        if (entry.status === 'ready') data.set(repoId, { ...entry, until: 0, telling: null })
        else data.delete(repoId)
      }
    }
  }).finally(() => {
    inFlight.delete(controller)
    changed()
  })
}

// What repository line `line` tells of one held as `entry`, given to `hold`:
// that no review is in effect for its reader, or why it couldn't be read;
// its default branch's dependencies and its open pull requests; or some of
// their dependencies, seeded (seedPullDependencies), those to be told
// fewer. Each with the lines its versions change, seeded first
// (seedNpmDeltas), lest their rows ask for them.
function toldLine(line, entry, hold) {
  knowGithubUsers(line)
  if (Array.isArray(line.deltas)) seedNpmDeltas(line.deltas)
  if (typeof line.error === 'string') hold({ status: 'error', until: Date.now() + RETRY_MS, error: line.error })
  else if (line.branch === null) hold({ status: 'ready', until: Date.now() + KEEP_MS, branch: null })
  else if (line.branch) {
    let branch
    try { branch = checked(line.branch) } catch (err) {
      hold({ status: 'error', until: Date.now() + RETRY_MS, error: err.message })
      return
    }
    const items = (Array.isArray(line.pulls?.items) ? line.pulls.items : []).filter(item => Number.isSafeInteger(item?.number) && item.number > 0)
    const defaultBranch = typeof line.pulls?.defaultBranch === 'string' && line.pulls.defaultBranch ? line.pulls.defaultBranch : null
    const unread = typeof line.pulls?.error === 'string' && line.pulls.error ? { error: line.pulls.error } : {}
    hold(telling({ status: 'ready', branch, pulls: { items, more: line.pulls?.more === true, ...unread, ...defaultBranch ? { defaultBranch } : {} },
      ...branch.pending ? { pending: true } : {} }, new Set(items.filter(item => readsDependencies(item) && toldOf(item, defaultBranch)).map(item => item.number))))
  } else if (line.dependencies instanceof Map && entry.telling) {
    seedPullDependencies(line.repoId, line.dependencies, true)
    hold(telling(entry, new Set([...entry.telling].filter(number => !line.dependencies.has(number)))))
  }
}
// One held with the pull requests still to be told, till none are; one not
// all of whose pull requests were read, or whose default branch awaits a
// build of Stasis's (`pending`), till it is read again, sooner, the tab told then.
function telling(entry, numbers) {
  if (numbers.size > 0) return { ...entry, until: Number.POSITIVE_INFINITY, telling: numbers }
  const wait = entry.pulls?.error || entry.pending ? RETRY_MS : KEEP_MS
  if (entry.pending) setTimeout(changed, wait + AGAIN_PAST_MS).unref?.()
  return { ...entry, until: Date.now() + wait, telling: null }
}

// One a read told no more of, as held: one it told nothing of, as none of
// its team's, so reviewing none for its reader (`failure` none); else
// failed, till it is read again, one whose default branch was told kept,
// its pull requests still to be told failed.
function untold(repoId, entry, failure) {
  if (entry.telling) {
    seedPullDependencies(repoId, new Map([...entry.telling].map(number => [number, new Error(failure ?? 'The server’s answer ended short.')])), true)
    return { ...entry, until: Date.now() + RETRY_MS, telling: null }
  }
  return failure ? { status: 'error', until: Date.now() + RETRY_MS, error: failure } : { status: 'ready', until: Date.now() + KEEP_MS, branch: null }
}

const plural = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
const pullName = ({ repo, item }) => `${repo.name}#${item.number}`

// The reader's login, in lower case, by which a review is told as theirs.
const reader = () => state.managedSession?.login?.toLowerCase() ?? null
const isReader = one => one.login.toLowerCase() === reader()

// A version's review: that it can't be reviewed, a reviewer rejects it, or
// how many reviews pass it of those it needs, a patched one's of it as
// patched; its label, tint and what it says, none where it wants no review.
function reviewState(pkg, review) {
  const shown = reviewOf(pkg, review)
  if (shown === 'unsupported') return { label: 'can’t review', tint: 'is-failed', said: UNSUPPORTED_WHY[pkg.unsupported] }
  if (pkg.rejected) return { label: 'rejected', tint: 'is-failed', said: 'A reviewer rejects it: it wants their newer accepting review' }
  if (shown === 'wanted') {
    return { label: `${pkg.reviews}/${review.required}`, tint: 'is-wanted',
      said: `${plural(pkg.reviews, 'review')} of ${review.required} required${pkg.commented ? `; ${plural(pkg.commented, 'reviewer')} in its comments` : ''}` }
  }
  if (passedByComments(pkg, review)) {
    return { label: `${pkg.reviews}/${review.required}`, tint: 'is-commented', said: `${plural(pkg.reviews, 'review')} of ${review.required} required, in its comments, not yet in the reviewed dependencies` }
  }
  return null
}
// A review's badge, its label alone; none for one no review passes yet,
// which most are. What it says, and whose its reviews are, is its row's
// tooltip's to tell (versionTip).
function reviewBadge(pkg, review) {
  const stance = reviewState(pkg, review)
  if (!stance || (stance.tint === 'is-wanted' && pkg.reviews === 0)) return nothing
  return html`<span class="team-deps-review ${stance.tint}">${stance.label}</span>`
}

// Each verdict as a reviewer's line of a version's tooltip says it, and
// those of them accepting it.
const VERDICT_SAID = { accept: 'accepts', 'accept-with-nits': 'accepts with nits', 'request-changes': 'requests changes', reject: 'rejects' }
const ACCEPTING = new Set(['accept', 'accept-with-nits'])
// A version's review in a pull request, as its tooltip names it there.
const reviewedThere = (pkg, review) => ({ passed: 'passes', baseline: 'needs none' })[reviewOf(pkg, review)] ?? reviewState(pkg, review)?.label ?? null

// The reviews counting of a version in a pull request: whose pass it and
// whose reject it, by their login, whatever its case.
const counting = pkg => new Map((pkg.reviewers ?? []).flatMap(one => one.passes ? [[`+${one.login.toLowerCase()}`, one]]
  : one.status === 'reject' ? [[`-${one.login.toLowerCase()}`, one]] : []))

// How each version stands under each pull request wanting it (`wanting`,
// those taking a tie first), by its key, then the pull request's name;
// `involved` the pull requests each is among the versions of (render).
// One holding reviews of it but lacking one made in another's comments,
// which count there alone and could be made here too: `lacks`, each `{
// login, status, pulls }`. A review published to the team isn't lacked:
// where it counts is the server's to tell (of a version a pull request adds,
// whole or against one it was; of one it locks besides, against any), not
// where it was made. Of the rest, those reviewed alike have one list it,
// that with the fewest reviews left (`left`); the others tell it `under`
// that one. One holding none, but unreviewed, tells it under the one listing
// it with most reviews, else under that holding most of those lacking some;
// where none wanting it holds any, one of them lists it.
function standings(wanting, involved) {
  const wanted = new Map()
  for (const pull of wanting) {
    for (const pkg of pull.wanted) {
      const has = counting(pkg)
      ;(wanted.get(versionKey(pkg)) ?? wanted.set(versionKey(pkg), []).get(versionKey(pkg))).push({ pull, has, alike: [...has.keys()].toSorted().join('\0') })
    }
  }
  // Of two, the one holding more reviews, then leaving fewer, then the first.
  const more = (one, other) => !one || other.has.size > one.has.size || (other.has.size === one.has.size && other.pull.left < one.pull.left) ? other : one
  const stood = new Map()
  for (const [key, wanters] of wanted) {
    const made = new Map()
    for (const { pull, pkg } of involved.get(key)?.values() ?? []) {
      for (const [stance, one] of counting(pkg)) {
        if (one.comment) (made.get(stance) ?? made.set(stance, { login: one.login, status: one.status, pulls: [] }).get(stance)).pulls.push(pull)
      }
    }
    const of = new Map()
    // The one listing it of those holding the same reviews, by those; and
    // of those lacking some, the one holding most.
    const listing = new Map()
    let most = null
    for (const wanter of wanters) {
      const { pull, has, alike } = wanter
      const lacks = has.size > 0 ? [...made].filter(([stance]) => !has.has(stance)).map(([, review]) => review) : []
      if (lacks.length === 0) {
        if (!listing.has(alike) || pull.left < listing.get(alike).pull.left) listing.set(alike, wanter)
        continue
      }
      of.set(pullName(pull), { lacks })
      most = more(most, wanter)
    }
    const reviewed = [...listing.values()].filter(({ has }) => has.size > 0).reduce(more, null) ?? most
    for (const { pull, alike } of wanters) {
      if (of.has(pullName(pull))) continue
      const lister = (alike === '' && reviewed ? reviewed : listing.get(alike)).pull
      of.set(pullName(pull), pull === lister ? {} : { under: lister })
    }
    stood.set(key, of)
  }
  return stood
}

// Versions in the order a list shows them: those a review is made of there
// already first (`1/2`, or rejected), then the rest, those their package
// manager alone asks for (`unreached`, marked) last, a reviewed one first
// among them. `of`: an item's version, where it isn't one itself.
const begun = pkg => (pkg.reviews ?? 0) > 0 || pkg.rejected === true
const rank = pkg => (pkg.unreached ? 2 : 0) + (begun(pkg) ? 0 : 1)
const prioritized = (items, of = item => item) => items.toSorted((a, b) => rank(of(a)) - rank(of(b)))

// The first of `names`, and how many more there are.
const few = (names, more = names.length - 1) => `${names[0]}${more > 0 ? ` +${more}` : ''}`

// What a version its package manager alone asks for says of that.
const UNREACHED_SAID = 'only lockfile, not stasis.config.json'

// The reader's own review of a version, as its row's tooltip and mark say
// it: its verdict, and whether it is partial.
const yoursSaid = ({ status, partial }) => `${verdictLabels[status]}${partial ? ', partial' : ''}`

// A version's details, its row's tooltip, formatted: its ecosystem's icon,
// its name and version whole, as its row may cut them short, tagged where
// it is patched, as Review's version selector tags it; where it is from, other
// than npm's registry; its patch's hash and file, where it is patched, or
// that it is told no file, which reviews here then read none of; its review; the
// pull request listing it, where another does (`under`); the reviews it
// lacks (`lacks`, each `{ login, status, where }`); the pull requests adding
// it, then those holding it on their base branch (`involved`, each `{ name,
// adds, pkg, review }`), by name, its patch the same, each with its review
// there, but none of no reviews on a base branch, the one it is listed
// under (`here`) marked; and who reviews it, each once where its teams'
// reviews count, and by the pull request in whose comments they review it,
// which count there alone.
function versionTip(pkg, review, { under, lacks, involved, here }) {
  const stance = reviewState(pkg, review)
  const facts = [pkg.source !== 'registry' && pkg.from ? ['From', pkg.from] : null,
    pkg.patch ? ['Patch', html`<code class="team-deps-tip-hash">${pkg.patch.hash}</code>`] : null,
    pkg.patch ? ['Patch file', pkg.patch.path ?? 'not known, so reviews here can’t read it'] : null,
    pkg.unreached ? ['Needed by', UNREACHED_SAID] : null,
    stance ? ['Review', stance.said ?? stance.label] : null, pkg.yours ? ['Your review', yoursSaid(pkg.yours)] : null, under ? ['Listed', `under ${under}`] : null,
    lacks.length > 0 ? ['Lacks', lacks.map(one => `${isReader(one) ? 'your' : `${githubUserName(one.login)}’s`} review in ${one.where.join(', ')}`).join('; ')] : null]
    .filter(Boolean)
  const reviewers = new Map()
  for (const { name, pkg: theirs } of [{ name: here, pkg }, ...involved]) {
    for (const one of theirs.reviewers ?? []) {
      if (one.comment && !name) continue
      const key = one.comment ? `${one.login}\0${name}` : one.login
      if (!reviewers.has(key)) reviewers.set(key, { ...one, where: one.comment ? name : null })
    }
  }
  return html`<div class="compare-tip">
    <div class="team-deps-tip-name">${sourcePackageIcon(pkg.ecosystem)}<span>${pkg.name}${pkg.version ? `@${pkg.version}` : ''}</span>${pkg.patch
      ? html`<span class="team-deps-tip-patched">patched</span>` : nothing}</div>
    ${facts.length > 0 ? html`<div class="compare-tip-rows">${facts.map(([label, value]) => html`<span class="compare-tip-label">${label}</span><span>${value}</span>`)}</div>` : nothing}
    ${involved.length > 0 ? html`<div class="compare-tip-head">Pull requests</div>
      <div class="compare-tip-rows">${involved.toSorted((one, other) => Number(other.adds) - Number(one.adds) || one.name.localeCompare(other.name, 'en', { numeric: true }))
        .map(({ name, adds, pkg: theirs, review: theirReview }) => html`<span class=${`team-deps-tip-pull${name === here ? ' team-deps-tip-here' : ''}`}>${GITHUB_ICON}${name}</span>
        <span>${[adds ? 'adds it' : 'on the base branch', adds || theirs.reviews !== 0 || theirs.rejected ? reviewedThere(theirs, theirReview) : null].filter(Boolean).join(', ')}</span>`)}</div>`
      : nothing}
    ${reviewers.size > 0 ? html`<div class="compare-tip-head">Reviewed by</div>
      <div class="compare-tip-rows">${[...reviewers.values()].map(one => html`<span>${githubUser(one.login)}</span>
        <span>${VERDICT_SAID[one.status]}${ACCEPTING.has(one.status) && !one.passes ? ', not counted' : ''}${one.where ? `, in ${one.where}’s comments` : ''}</span>`)}</div>`
      : nothing}
  </div>`
}

// A version as a row, its details its tooltip (versionTip): its ecosystem's
// icon (npm's, where it names none), its name and version, opening its review where its reader reviews it and it can be,
// against the version it was where it was one, a patched one's as patched,
// against the version it patches where that was one, its patch alone, its
// patch read of repository `repoId` at `head`, the commit its lockfiles were
// read at, where it is told its file, else its page; a mark (`!`) where
// its package manager alone asks for it (`unreached`); its review;
// the lines it changes against the version it is reviewed against, of its
// package or another the host names, or whole, where it wants reviews, a
// patched one's as its patch changes them, where its file is told
// (npm-delta.js); the
// reviews it lacks that others hold (`lacks`, standings), its row red,
// its tooltip telling them; the pull requests reviewing it in their comments
// (`elsewhere`), which count for them alone; the pull request listing it
// (`under`); and the pull requests adding it besides, or, `adders`, all
// those adding it, those lacking reviews (`lacking`) red, those reviewing
// it in their comments named by that alone. A bundle's Overview lists its
// versions so too (bundle-dependency-review.js).
export function versionRow(pkg, review, { others = [], adders = false, elsewhere = [], under = null, lacks = [], lacking = [], involved = [], here = null,
  repoId = null, head = null } = {}) {
  const npm = pkg.source === 'registry' && pkg.version
  const before = reviewBase(pkg, review)
  const patch = pkg.patch?.path && repoId && head ? { hash: pkg.patch.hash, repoId, commit: head, path: pkg.patch.path } : null
  const reviewing = review?.canReview && (!pkg.patch || patch) && reviewOf(pkg, review) !== 'unsupported'
  const href = npm ? managedRoutePath({ view: 'npm', packageName: pkg.name, packageSpec: pkg.version,
    ...reviewing ? { bundleTab: 'review', ...before ? { reviewPackage: before.name, reviewSpec: before.version } : {}, ...patch ? { patch } : {} } : {} }) : null
  const named = `${pkg.name}${pkg.version ? `@${pkg.version}` : ''}${pkg.patch ? ' (patched)' : ''}`
  const tip = versionTip(pkg, review, { under, lacks, involved, here })
  const inReview = elsewhere.filter(name => !lacking.includes(name))
  const unnamed = adders ? others.filter(name => !elsewhere.includes(name) && !lacking.includes(name)) : others
  const label = html`${sourcePackageIcon(pkg.ecosystem)}<span class="team-deps-name">${pkg.name}${pkg.version ? html`<span class="team-deps-version">@${pkg.version}</span>` : nothing}</span>
    ${pkg.patch ? html`<span class="team-deps-patched">patched</span>` : nothing}
    ${pkg.unreached ? html`<span class="team-deps-unreached" role="img" aria-label=${`Needed by ${UNREACHED_SAID}`}>!</span>` : nothing}
    ${npm && (!pkg.patch || patch) && reviewOf(pkg, review) === 'wanted'
      ? html`<npm-delta .name=${pkg.name} .version=${pkg.version} .base=${before?.version ?? '(empty)'} .baseName=${before?.name ?? pkg.name} .patch=${patch}></npm-delta>` : nothing}
    ${reviewBadge(pkg, review)}
    ${under ? html`<span class="team-deps-under">${under}</span>` : nothing}
    ${lacking.length > 0 ? html`<span class="team-deps-lacks">${few(lacking)}</span>` : nothing}
    ${inReview.length > 0 ? html`<span class="team-deps-elsewhere">${few(inReview)}</span>` : nothing}
    ${unnamed.length > 0 ? html`<span class="team-deps-also">${adders ? few(unnamed) : `+${others.length}`}</span>` : nothing}
    ${pkg.yours ? html`<span class="team-deps-yours" role="img" aria-label=${`Your review: ${yoursSaid(pkg.yours)}`}>${verdictIcon(pkg.yours.status)}</span>` : nothing}`
  const behind = lacks.length > 0 ? ' is-behind' : ''
  return html`<li>${href ? html`<a class="team-deps-row${behind}" href=${href} target="_blank" rel="noopener noreferrer" data-tooltip=${named} .tooltipContent=${tip}>${label}</a>`
    : html`<span class="team-deps-row${behind}" data-tooltip=${named} .tooltipContent=${tip}>${label}</span>`}</li>`
}

// How many versions a pull request wants reviewed, as its card's head tells
// them, where more than one; and, where its package manager alone asks for
// some (`unreached`, marked `!`), how many of them Stasis reaches, by its
// mark, its one too: of those its answer lists, at least as many where it
// lists only some (`untold`), whose reach it doesn't tell.
const STASIS_MARK = html`<img class="team-deps-stasis" src="./stasis.svg" alt="by Stasis">`
function deps(pull) {
  const alone = pull.wanted.filter(pkg => pkg.unreached && reviewOf(pkg, pull.entry.review) === 'wanted').length
  if (pull.toReview < 2 && alone === 0) return nothing
  const count = value => value.toLocaleString('en-US'), reached = pull.toReview - pull.untold - alone
  const said = `${count(reached)} by Stasis, ${count(alone)} only lockfile${pull.untold > 0 ? `, ${count(pull.untold)} more not listed` : ''}`
  return html`<span class="team-deps-count">${count(pull.toReview)} ${pull.toReview === 1 ? 'dep' : 'deps'}${alone > 0
    ? html`<span class="team-deps-reach" data-tooltip=${said}>(${count(reached)}${pull.untold > 0 ? '+' : ''} ${STASIS_MARK})</span>`
    : nothing}</span>`
}

// How far Stasis is with what the stasis.config.json files `answers` hold
// to reach (`[repoId, answer]` each, a pull request's or a default branch's):
// each build once, by its repository, file and commit, done where any answer
// tells it made, as one Stasis kept is at once, though the rest of its
// directory is still to be made; an answer telling none of its builds, its
// directory's head's alone. Shown by Stasis's mark, a bar and the count.
function stasisProgress(answers) {
  const builds = new Map()
  for (const [repoId, answer] of answers) {
    for (const dir of answer?.lockfiles ?? []) {
      const told = Array.isArray(dir.builds) ? dir.builds : isPending(dir) ? [{ commit: answer.head ?? '', built: false }] : []
      for (const { commit, built } of told) {
        const key = `${repoId}\0${dir.paths[0]}\0${commit}`
        builds.set(key, builds.get(key) === true || built === true)
      }
    }
  }
  const done = [...builds.values()].filter(Boolean).length, total = builds.size
  const said = `Stasis is working out what their stasis.config.json entries reach: ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} builds made.`
  return html`<p class="team-deps-quiet team-deps-building" role="status" data-tooltip=${said}><img class="team-deps-stasis" src="./stasis.svg" alt="Stasis">
    <span class="team-deps-progress" role="progressbar" aria-label="Stasis builds made" aria-valuemin="0" aria-valuemax=${total} aria-valuenow=${done}><span
      style=${styleMap({ width: `${total ? done / total * 100 : 0}%` })}></span></span>
    <span class="team-deps-progress-n">${done.toLocaleString('en-US')}/${total.toLocaleString('en-US')}</span></p>`
}

// Where a pull request's versions' patches are read: its repository, at the
// commit its lockfiles were read at (versionRow).
const readAt = pull => ({ repoId: pull.repo.repoId, head: pull.entry.head ?? null })

// A list's toggle: its chevron turned while it is open.
const CHEVRON = icon(svg`<path d="m6 4 4 4-4 4"/>`)
// GitHub's mark, before each pull request a tooltip names.
const GITHUB_ICON = appMarkup(GITHUB_ICON_SVG)

// The rows of its masonry grid a card spans: as many as it is tall, with
// the gap under it, of its list's rows (`grid-auto-rows`); none where it
// isn't in one.
export function masonrySpan(card) {
  const row = card.isConnected ? parseFloat(getComputedStyle(card.parentElement).gridAutoRows) : Number.NaN
  if (!(row > 0)) return
  card.style.gridRowEnd = `span ${Math.max(1, Math.ceil((card.getBoundingClientRect().height + (parseFloat(getComputedStyle(card).marginBottom) || 0)) / row))}`
}

class TeamDependencies extends StateElement {
  static properties = { repositories: { attribute: false }, team: { attribute: false }, _open: { state: true } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repositories = []
    this.team = null
    // The lists opened past those shown, by their keys.
    this._open = new Set()
    this._notify = () => this.requestUpdate()
  }

  // Sub-tab `tab` shown, at its address, an entry of its own where it is
  // picked (`push`), else the one shown's replaced.
  pick(tab, { push = true } = {}) {
    state.teamDependenciesTab = tab
    const route = managedRouteForIds({ view: 'workspace-dependencies', teamId: this.team, dependencyTab: tab }, state.managedTeams)
    if (push) managedHistory?.pushRoute(route)
    else managedHistory?.replaceRoute(route)
  }

  // The sub-tab its address names, the default branch's, which isn't shown
  // where none wants reviews once all is read, giving way to the first.
  updated() {
    if (this._shown && this._shown !== state.teamDependenciesTab) this.pick(this._shown, { push: false })
    this._pack()
  }

  // Its pull requests' cards packed as masonry (team-deps-pulls.is-masonry),
  // each spanning rows as it is tall, spanned anew as it grows or shrinks;
  // those it no longer shows let go.
  _pack() {
    if (!globalThis.ResizeObserver) return
    this._masonry ??= new ResizeObserver(entries => { for (const { target } of entries) masonrySpan(target) })
    this._masonry.disconnect()
    for (const list of this.querySelectorAll('.team-deps-pulls')) {
      list.classList.add('is-masonry')
      for (const card of list.children) this._masonry.observe(card)
    }
  }

  toggle(key) {
    const open = new Set(this._open)
    if (!open.delete(key)) open.add(key)
    this._open = open
  }

  connectedCallback() {
    super.connectedCallback()
    listeners.add(this._notify)
    this._unsubscribe = subscribePullDependencies(this._notify)
    showing.set(this, this.team)
    this._reviewsSince = null
    this._reviewsTimer = setInterval(() => { this._askReviews() }, REVIEWS_EVERY_MS)
    this._askReviews()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    listeners.delete(this._notify)
    this._unsubscribe?.()
    showing.delete(this)
    stopUnshown()
    this._masonry?.disconnect()
    clearInterval(this._reviewsTimer)
  }

  // Asks whether reviews counting for its team's repositories were
  // published or revoked since it last asked, the server's time each answer
  // tells (fetchTeamReviewChanges), its first answer's time less
  // REVIEWS_BEFORE_MS, while its page is seen; and makes the pull requests
  // shown that list a version of theirs stale, or all where too many
  // changed, for each to be asked again alone (pullEntry).
  async _askReviews() {
    const team = this.team
    if (!team || this._askingReviews || globalThis.document?.hidden) return
    const since = this._reviewsSince?.team === team ? this._reviewsSince.at : null
    this._askingReviews = true
    try {
      const told = await fetchTeamReviewChanges(team, since)
      if (team !== this.team || told.now === null) return
      if (since !== null) {
        const changes = told.all ? null : new Set(told.versions.map(({ name, version }) => `${name}@${version}`))
        const lists = ({ entry }) => entry.status === 'ready' && (changes === null
          || [...addedVersions(entry).versions, ...unreviewedVersions(entry).versions].some(pkg => changes.has(`${pkg.name}@${pkg.version}`)))
        if (changes === null || changes.size > 0) staleReviews((this._listed ?? []).filter(lists).map(({ repo, item }) => ({ repoId: repo.repoId, number: item.number })))
      }
      this._reviewsSince = { team, at: since === null ? told.now - REVIEWS_BEFORE_MS : told.now }
    } catch {
      // Asked again on its next turn.
    } finally {
      this._askingReviews = false
    }
  }

  open(event, { repo, item }) {
    event.preventDefault()
    openRepositoryItemDialog({ repository: { repoId: repo.repoId, repo: repo.name }, target: { number: item.number, preview: { ...item, kind: 'pulls' } } })
  }

  // Rows of `items`, all of them where they are as many as `upTo`, else as
  // many as `folded` till the rest are asked for, under `key`, as one list,
  // filling as many columns as fit; those listed under other pull requests
  // (`same`) dimmed.
  rows(key, items, row, [upTo, folded] = SHOWN_VERSIONS, same = false) {
    if (items.length === 0) return nothing
    const open = this._open.has(key), shown = items.length > upTo ? folded : items.length
    return html`<ul class="team-deps-versions${same ? ' is-same' : ''}">${(open ? items : items.slice(0, shown)).map(row)}</ul>
      ${items.length > shown ? html`<button type="button" class="team-deps-more is-list" aria-expanded=${String(open)} @click=${() => this.toggle(key)}>${CHEVRON}${open
        ? 'Show fewer' : `and ${(items.length - shown).toLocaleString('en-US')} more`}</button>` : nothing}`
  }

  // A list told by `label` alone till it is opened, under `key`, and how
  // many past those it lists (`unlisted`).
  disclosed(key, label, items, row, unlisted = 0) {
    const open = this._open.has(key)
    return html`<div class="team-deps-disclosed">
      <button type="button" class="team-deps-more" aria-expanded=${String(open)} @click=${() => this.toggle(key)}>${CHEVRON}${label}</button>
      ${open ? html`${this.rows(key, items, row, SHOWN_LISTED)}${unlisted > 0
        ? html`<p class="team-deps-quiet">and ${unlisted.toLocaleString('en-US')} more, not listed</p>` : nothing}` : nothing}
    </div>`
  }

  render() {
    // Another team shown, the one shown before no longer read for it; one
    // drawn once its tab is gone shows none.
    if (this.isConnected && showing.get(this) !== this.team) {
      if (showing.has(this)) stopUnshown()
      showing.set(this, this.team)
    }
    const repos = [...new Map((this.repositories ?? []).map(repo => [repo.repoId, repo])).values()]
    const entries = teamRepositories(this.team, repos.map(repo => repo.repoId))
    const reads = repos.map((repo, at) => ({ repo, read: entries[at] }))
    const reviewed = reads.filter(({ read }) => read.status === 'ready' && read.branch)
    // Each pull request's as the team's read told it, or as it was while it
    // is read again; those to merge into other branches than their
    // repository's default (`into`) hidden but where all are asked for, and
    // drafts but where they are, each then read alone (pullDependencies), as
    // the team's read tells none.
    const every = state.teamDependenciesAllBranches === true
    const drafts = state.teamDependenciesDrafts === true
    const listing = reviewed.flatMap(({ repo, read }) => read.pulls.items.filter(readsDependencies).map(item => ({ repo, item, onto: ontoDefault(item, read.pulls.defaultBranch) })))
    const intoOthers = listing.filter(({ onto }) => !onto).length
    const draftCount = listing.filter(({ item, onto }) => item.draft === true && (onto || every)).length
    const pulls = listing.flatMap(({ repo, item, onto }) => (!onto && !every) || (item.draft === true && !drafts) ? []
      : onto && item.draft !== true ? [{ repo, item, entry: pullEntry(repo.repoId, item.number) }]
      : [{ repo, item, ...onto ? {} : { into: item.base }, entry: pullDependencies(repo.repoId, item.number, true, { background: true }) }])
    // Those shown, for reviews changed since to make those listing their versions stale (_askReviews).
    this._listed = pulls
    // Each pull request's versions wanting reviews, as many as its answer
    // tells, and how many in all, those past them too (`toReview`), by which
    // it is kept; how many reviews they still want between them (`left`),
    // one rejected at least one, those past them as many as it requires; and
    // the other versions its lockfiles lock that want them (`others`), the
    // default branch's mostly, which hold it too, one into another branch
    // left out where it adds none and its comments review none (`intoOther`);
    // those adding fewest first, as Versions takes them, then as picked.
    const wanting = pulls.filter(({ entry }) => entry.status === 'ready' && entry.review).map(pull => {
      const { review } = pull.entry
      const wanted = addedVersions(pull.entry).versions.filter(pkg => ['wanted', 'unsupported'].includes(reviewOf(pkg, review)) || passedByComments(pkg, review))
      const told = wanted.filter(pkg => reviewOf(pkg, review) === 'wanted')
      const toReview = Math.max(review.toReview ?? told.length, told.length)
      const past = toReview - told.length
      return { ...pull, wanted, failed: reviewFailures(pull.entry), toReview, untold: past, size: wanted.length + past,
        left: told.reduce((sum, pkg) => sum + Math.max(1, review.required - pkg.reviews), past * review.required), others: unreviewedVersions(pull.entry).count }
    }).filter(pull => pull.size > 0 || ((pull.others > 0 || pull.failed) && !(pull.entry.intoOther && !pull.entry.review.commentReviews))).toSorted(fewest)
    const sort = Object.hasOwn(SORTS, state.teamDependenciesSort) ? state.teamDependenciesSort : 'newest'
    const sorted = sort === 'fewest' ? wanting : wanting.toSorted(SORTS[sort][1])
    // The repositories whose open pull requests are more than are read, and
    // those not all of whose were, which their failure tells instead.
    const unchecked = reviewed.filter(({ read }) => read.pulls.more && !read.pulls.error)
    const unread = reviewed.filter(({ read }) => read.pulls.error)
    // Each version wanting reviews, as the first adding it tells it, by the
    // pull requests adding it, each with it as it is there (`told`); and the
    // first told its patch's file, whence that is read (`patched`).
    const adding = new Map()
    for (const pull of wanting) {
      for (const pkg of pull.wanted) {
        const added = adding.get(versionKey(pkg)) ?? adding.set(versionKey(pkg), { pkg, pulls: [], told: [] }).get(versionKey(pkg))
        added.pulls.push(pull)
        added.told.push(pkg)
        if (!added.patched && pkg.patch?.path) added.patched = { patch: pkg.patch, pull }
      }
    }
    const reading = reads.some(({ read }) => read.status === 'loading') || pulls.some(({ entry }) => entry.status === 'loading')
    // Whether Stasis still builds what a stasis.config.json of theirs reaches: nothing is known to want none till it has.
    const building = pulls.some(({ entry }) => entry.pending) || reviewed.some(({ read }) => read.branch.pending)
    const failures = [...reads.filter(({ read }) => read.status === 'error').map(({ repo, read }) => [repo.name, read.error]),
      ...unread.map(({ repo, read }) => [repo.name, read.pulls.error]), ...pulls.filter(({ entry }) => entry.status === 'error').map(pull => [pullName(pull), pull.entry.error])]
    // The default branches with versions wanting reviews, or failing them.
    const branches = reviewed.flatMap(({ repo, read }) => {
      const { count } = unreviewedVersions(read.branch), failed = reviewFailures(read.branch)
      return count > 0 || failed || read.branch.pending ? [{ repo, read, count: count + (failed?.count ?? 0) }] : []
    })
    // The pull requests each version is among the versions of, by its key:
    // each adding it, else locking it otherwise wanting reviews, with it as
    // it is there.
    const involved = new Map()
    for (const pull of pulls.filter(({ entry }) => entry.status === 'ready' && entry.review)) {
      for (const [adds, versions] of [[true, addedVersions(pull.entry).versions], [false, unreviewedVersions(pull.entry).versions]]) {
        for (const pkg of versions) {
          const of = involved.get(versionKey(pkg)) ?? involved.set(versionKey(pkg), new Map()).get(versionKey(pkg))
          if (!of.has(pullName(pull))) of.set(pullName(pull), { pull, pkg, adds })
        }
      }
    }
    // Repositories and pull requests named without their owner where every
    // repository reviewed, or not yet read, has the same one.
    const owners = new Set(reads.filter(({ read }) => read.status !== 'ready' || read.branch).map(({ repo }) => repo.name.split('/')[0]))
    const shorten = owners.size === 1 ? name => name.slice(name.indexOf('/') + 1) : name => name
    const named = pull => shorten(pullName(pull))
    // The pull requests a version is among the versions of, its patch the
    // same, as its tooltip names them (versionTip); and those reviewing it in
    // their comments, which count for them alone, but `pull`.
    const among = pkg => [...involved.get(versionKey(pkg))?.values() ?? []]
      .map(({ pull, pkg: theirs, adds }) => ({ name: named(pull), adds, pkg: theirs, review: pull.entry.review }))
    const elsewhere = (pkg, pull = null) => [...involved.get(versionKey(pkg))?.values() ?? []]
      .filter(one => one.pkg.commented > 0 && (!pull || pullName(one.pull) !== pullName(pull))).map(one => named(one.pull))
    // How each version stands under each pull request wanting it
    // (standings), whatever order is picked, its pull requests named.
    const stood = standings(wanting, involved)
    const standing = (pkg, pull) => {
      const { under = null, lacks = [] } = stood.get(versionKey(pkg))?.get(pullName(pull)) ?? {}
      return { under: under && named(under), lacks: lacks.map(one => ({ login: one.login, status: one.status, where: one.pulls.map(named) })) }
    }
    const naming = { elsewhere, named, shorten, among, standing }
    // Each pull request's card, in the order picked: the versions it lists,
    // how many of them lack reviews (`lacking`), and those others list
    // (`same`), each in its order (prioritized); set apart (`covered`) where
    // it adds none but those and nothing fails it.
    const cards = sorted.map(pull => {
      const same = prioritized(pull.wanted.filter(pkg => standing(pkg, pull).under))
      const listed = prioritized(pull.wanted.filter(pkg => !same.includes(pkg)))
      return { pull, listed, same, lacking: listed.filter(pkg => standing(pkg, pull).lacks.length > 0).length,
        covered: listed.length === 0 && same.length > 0 && pull.untold === 0 && !pull.failed }
    })
    const lacking = cards.reduce((sum, card) => sum + card.lacking, 0)
    const failed = failures.map(([name, error]) => `${shorten(name)}: ${error}`)
    // The default branch's sub-tab where it wants reviews, or, picked, while
    // its repositories are read.
    const picked = state.teamDependenciesTab
    const tabs = TABS.filter(([kind]) => kind !== 'branch' || branches.length > 0 || reading && picked === 'branch')
    const tab = tabs.some(([kind]) => kind === picked) ? picked : 'pulls'
    this._shown = tab
    const counts = { pulls: wanting.length, versions: adding.size, branch: branches.reduce((sum, { count }) => sum + count, 0) }
    // Above each sub-tab's lists but Reviews', one line, there whatever it
    // says, lest what is under it move: that they are being read and what
    // couldn't be, at its start, then what its red rows are, where the pull
    // requests have any, and the pull requests' order at its end.
    return html`<div class="team-deps">
      ${dialogTabs({ tabs: tabs.map(([id, label]) => ({ id, label: html`${label}${counts[id] == null || reading && counts[id] === 0 ? nothing
        : html`<span class="team-deps-tab-n">${counts[id].toLocaleString('en-US')}</span>`}` })), current: tab, prefix: 'team-deps', select: kind => this.pick(kind) })}
      <div class="team-deps-panel" role="tabpanel" id=${`team-deps-panel-${tab}`} aria-labelledby=${`team-deps-tab-${tab}`}>
      ${tab === 'reviews' ? withCompare(() => html`<dependency-review-list .session=${state.managedSession} .team=${this.team}></dependency-review-list>`) : html`
      <div class="team-deps-bar">
        ${reading ? html`<p class="team-deps-quiet" role="status">Reading their pull requests…</p>`
          : building ? stasisProgress([...pulls.map(({ repo, entry }) => [repo.repoId, entry]), ...reviewed.map(({ repo, read }) => [repo.repoId, read.branch])]) : nothing}
        ${failed.length === 1 ? html`<p class="team-deps-quiet" data-tooltip=${failed[0]} role="alert">${failed[0]}</p>` : failed.length > 1
          ? html`<p class="team-deps-quiet" role="alert" data-tooltip=${failed.join('\n')} .tooltipContent=${html`<div class="compare-tip">
            <div class="compare-tip-head">Couldn’t be read</div>
            <div class="compare-tip-rows">${failures.map(([name, error]) => html`<span>${shorten(name)}</span><span>${error}</span>`)}</div></div>`}>${plural(failed.length,
            'repository or pull request')} couldn’t be read.</p>` : nothing}
        ${tab === 'pulls' && lacking > 0 ? html`<p class="team-deps-quiet team-deps-key">${plural(lacking, 'version')} ${lacking === 1 ? 'lacks' : 'lack'} reviews made elsewhere</p>` : nothing}
        ${tab === 'pulls' && (intoOthers > 0 || every || draftCount > 0 || drafts) ? html`<span class="team-deps-switches">${intoOthers > 0 || every
          ? html`<mode-switch class="team-deps-branches" label="All branches" .checked=${every}
          data-tooltip=${`${plural(intoOthers, 'pull request')} into ${intoOthers === 1 ? 'a branch' : 'branches'} other than the default`}
          @click=${() => { state.teamDependenciesAllBranches = !every }}></mode-switch>` : nothing}${draftCount > 0 || drafts
          ? html`<mode-switch class="team-deps-drafts" label="Drafts" .checked=${drafts} data-tooltip=${plural(draftCount, 'draft pull request')}
          @click=${() => { state.teamDependenciesDrafts = !drafts }}></mode-switch>` : nothing}</span>` : nothing}
        ${tab === 'pulls' && reviewed.length > 0 && sorted.length > 1 ? html`<span class="bundles-overview-sort" role="group" aria-label="Pull request order">${Object.entries(SORTS)
          .map(([value, [label]]) => html`<button type="button" aria-pressed=${String(value === sort)} @click=${() => { state.teamDependenciesSort = value }}>${label}</button>`)}</span>`
          : nothing}
      </div>
      ${!reading && reads.length > 0 && reviewed.length === 0 && failures.length === 0
        ? html`<p class="workspace-content-empty">None of this team’s repositories reviews its dependencies for you.</p>` : nothing}
      ${tab === 'branch' ? nothing : unchecked.map(({ repo, read }) => html`<p class="team-deps-quiet" role="alert">Only ${shorten(repo.name)}’s ${plural(read.pulls.items.length, 'open pull request')}
        updated latest are checked; its others aren’t.</p>`)}
      ${reviewed.length === 0 ? nothing : tab === 'pulls' ? this.renderPulls(cards, adding, reading || building, unchecked.length + unread.length > 0, naming,
        { others: !every && intoOthers > 0, drafts: !drafts && draftCount > 0 })
        : tab === 'versions' ? this.renderVersions(adding, reading || building, naming) : branches.map(({ repo, read }) => this.renderBranch(repo, read, naming))}`}
      </div>
    </div>`
  }

  // The pull requests wanting reviews (`cards`, render), in the order
  // picked. A card lists its own versions, those lacking reviews red, then
  // those others list, dimmed, a few till the rest are asked for; and the
  // reader's reviews of its versions to copy, where the server's host
  // formats them (dependency-review-copy.js). Those adding only versions
  // others list come after the rest, each its head alone till opened, all
  // hidden once asked; one whose lockfiles lock other versions wanting
  // reviews says how many in its head, as none else lists those. One wanting none is not listed, its copy in its
  // popup. Every card a column wide, however many versions it lists; how
  // many it wants reviewed told where more than one, muted.
  renderPulls(cards, adding, reading, unchecked, { elsewhere, named, among, standing }, { others: othersHidden = false, drafts: draftsHidden = false } = {}) {
    if (cards.length === 0) {
      return reading ? nothing : html`<p class="workspace-content-empty">No open pull request${unchecked ? ' checked' : ''}${othersHidden ? ' into a default branch' : ''} wants its dependencies reviewed.${
        draftsHidden ? ' Drafts are hidden.' : ''}</p>`
    }
    const row = pull => pkg => {
      const { under, lacks } = standing(pkg, pull)
      return versionRow(pkg, pull.entry.review, { others: (adding.get(versionKey(pkg))?.pulls ?? []).map(named).filter(name => name !== named(pull) && name !== under),
        under, lacks, involved: among(pkg), here: named(pull), ...readAt(pull) })
    }
    const card = ({ pull, listed, same, covered }) => {
      const key = pullName(pull)
      const others = unreviewedVersions(pull.entry)
      const href = `https://github.com/${pull.repo.name}/pull/${pull.item.number}`
      const opened = !covered || this._open.has(`${key}:covered`)
      return html`<li class="team-deps-pull${covered ? ' is-covered' : ''}">
        <div class="team-deps-pull-top">${covered ? html`<button type="button" class="team-deps-fold" aria-expanded=${String(opened)} aria-label=${`${named(pull)}’s versions`}
          @click=${() => this.toggle(`${key}:covered`)}>${CHEVRON}</button>` : nothing}<a class="team-deps-pull-head" href=${href} target="_blank" rel="noopener noreferrer" @click=${event => this.open(event, pull)}>
          <span class="team-deps-pull-name">${named(pull)}</span>${pull.into ? html`<span class="team-deps-pull-base" data-tooltip=${`Into ${pull.into}`}>→ ${pull.into}</span>` : nothing}${pull.item.draft === true
            ? html`<span class="team-deps-pull-draft">Draft</span>` : nothing}<span class="team-deps-pull-title">${pull.item.title || '(no title)'}</span>
          ${covered ? html`${pull.others > 0 ? html`<span class="team-deps-count is-wanted">${pull.others.toLocaleString('en-US')} ${pull.others === 1 ? 'other' : 'others'} unreviewed</span>` : nothing}
            <span class="team-deps-under">${few([...new Set(same.map(pkg => standing(pkg, pull).under))])}</span>`
            : pull.failed ? html`<span class="team-deps-count is-failed">review fails</span>`
            : pull.size === 0 ? html`<span class="team-deps-count is-wanted">${plural(pull.others, 'other version')} unreviewed</span>`
            : deps(pull)}
        </a>${pull.entry.formatted ? html`<dependency-review-copy .text=${pull.entry.formatted} .label=${'Copy your dependency reviews'}></dependency-review-copy>`
          : nothing}</div>
        ${opened ? html`${this.rows(`${key}:own`, listed, row(pull))}
        ${pull.untold > 0 ? html`<p class="team-deps-quiet">and ${plural(pull.untold, 'more version')} past those listed</p>` : nothing}
        ${this.rows(`${key}:same`, same, row(pull), covered ? SHOWN_VERSIONS : SHOWN_SAME, true)}
        ${pull.others > 0 ? this.disclosed(`${key}:others`, pull.size > 0 || pull.failed ? `${pull.others.toLocaleString('en-US')} on the base branch`
          : `Its own versions pass; ${pull.others.toLocaleString('en-US')} on the base branch`,
        prioritized(others.versions), pkg => versionRow(pkg, pull.entry.review, { elsewhere: elsewhere(pkg, pull), involved: among(pkg), here: named(pull), ...readAt(pull) }),
        pull.others - others.versions.length) : nothing}` : nothing}
      </li>`
    }
    const apart = cards.filter(one => one.covered), hidden = this._open.has('covered')
    return html`<ol class="team-deps-pulls" aria-label="Pull requests wanting reviews">${cards.filter(one => !one.covered).map(card)}</ol>
      ${apart.length > 0 ? html`<section class="team-deps-covered" aria-label="Pull requests adding only versions listed above">
        <button type="button" class="team-deps-more" aria-expanded=${String(!hidden)} @click=${() => this.toggle('covered')}>${CHEVRON}${apart.length.toLocaleString('en-US')} more
          ${apart.length === 1 ? 'adds' : 'add'} only versions listed above</button>
        ${hidden ? nothing : html`<ol class="team-deps-pulls is-covered">${apart.map(card)}</ol>`}
      </section>` : nothing}`
  }

  // Every version the pull requests add wanting reviews, each once, as the
  // pull request listing it tells it, else the one holding most reviews of
  // it; those lacking reviews red, the others reviewing it in their comments
  // blue; one marked where every pull request adding it marks it.
  renderVersions(adding, reading, { elsewhere, named, among, standing }) {
    if (adding.size === 0) return reading ? nothing : html`<p class="workspace-content-empty">No version an open pull request adds wants a review.</p>`
    const versions = [...adding.values()].map(({ pulls, told, patched }) => {
      const stands = pulls.map((pull, at) => standing(told[at], pull))
      const listing = stands.flatMap(({ under, lacks }, one) => !under && lacks.length === 0 ? [one] : [])
      const at = (listing.length > 0 ? listing : stands.map((_, one) => one)).reduce((most, other) => counting(told[other]).size > counting(told[most]).size ? other : most)
      return { pulls, stands, at, patched, pkg: { ...told[at], ...patched ? { patch: patched.patch } : {}, unreached: told.every(one => one.unreached) } }
    })
    return html`<section class="team-deps-section" aria-label="Versions to review">
      ${this.rows('versions', prioritized(versions, one => one.pkg), ({ pulls, stands, at, patched, pkg }) => versionRow(pkg, pulls[at].entry.review, { others: pulls.map(named), adders: true,
        elsewhere: elsewhere(pkg), lacking: pulls.filter((_, other) => stands[other].lacks.length > 0).map(named), involved: among(pkg),
        ...readAt(patched?.pull ?? pulls[at]) }), SHOWN_ALL)}
    </section>`
  }

  // What a repository's default branch locks that wants reviews, and what
  // fails it there, its lockfiles left unread too.
  renderBranch(repo, read, { elsewhere, shorten, among }) {
    const { versions, count } = unreviewedVersions(read.branch)
    const failed = reviewFailures(read.branch)
    const unread = failed?.unread.flatMap(dir => dir.paths) ?? []
    const listed = [...prioritized(versions), ...failed?.versions ?? []]
    return html`<section class="team-deps-section" aria-label=${`${shorten(repo.name)}’s default branch`}><h2>${shorten(repo.name)}</h2>
      <p class="team-deps-quiet">${plural(count, 'version')} unreviewed${failed?.count
      ? `, ${failed.count.toLocaleString('en-US')} can’t be reviewed` : ''}${unread.length > 0 ? `, ${plural(unread.length, 'lockfile')} unread` : ''}</p>
      ${unread.length > 0 ? html`<p class="team-deps-quiet" role="alert">Unread, so what ${unread.length === 1 ? 'it locks isn’t' : 'they lock aren’t'} checked:
        ${unread.map((path, at) => html`${at > 0 ? ', ' : ''}<code>${path}</code>`)}</p>` : nothing}
      ${this.rows(`branch:${repo.repoId}`, listed, pkg => versionRow(pkg, read.branch.review, { elsewhere: elsewhere(pkg), involved: among(pkg),
        repoId: repo.repoId, head: read.branch.head ?? null }), SHOWN_LISTED)}
      ${count > versions.length ? html`<p class="team-deps-quiet">and ${(count - versions.length).toLocaleString('en-US')} more, not listed</p>` : nothing}
    </section>`
  }
}

customElements.define('team-dependencies', TeamDependencies)
