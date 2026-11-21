// A team's Dependencies tab (workspace-content.js), its sub-tabs (TABS) at
// /team/<slug>/dependencies[/<tab>]: the open pull requests whose versions
// want reviews, in the order picked (SORTS), each version listed under one
// of those reviewing it alike, dimmed under the rest, red where it lacks a
// review made in another (standings); every version they add wanting one;
// what each default branch locks wanting one; and the reviews published to
// the team (dependency-review-list.js). Repositories not held are read in
// one request (GET /api/teams/:id/dependencies), each as its lines come, its
// pull requests' dependencies seeded into pull-dependencies.js and its line
// counts into npm-delta.js; held a while (KEEP_MS), shown as they were while
// read again, and read anew once a review is set anew. Where Stasis still
// builds a stasis.config.json a review holds to, a pull request awaiting it
// is asked again alone, a default branch read again sooner; once built, a
// version only a lockfile locks is marked (!). Each list shows those
// reviewed already first, those marked last (prioritized).
import { html, nothing, svg } from 'lit'
import { styleMap } from './style-map.js'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { fetchTeamDependencies } from './client-managed.js'
import { UNSUPPORTED_WHY, addedVersions, checked, heldPullDependencies, isPending, passedByComments, pullDependencies, readsDependencies, reviewFailures, reviewOf, seedPullDependencies,
  subscribePullDependencies, unreviewedVersions, versionKey } from './pull-dependencies.js'
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
import { sessionKept } from './activity-reads.js'

const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000
// How many times a read the server's time cut short goes on with the repositories it left.
const RESUMES = 3
// A list's rows shown, `[up to, folded to]`: as many as the first whole, a
// longer one cut to the second, leaving more than a row or two behind "and N more".
const SHOWN_VERSIONS = [15, 10]
const SHOWN_LISTED = [48, 48]
// Of a card's versions listed under other pull requests, lest they crowd its own.
const SHOWN_SAME = [6, 3]
const SHOWN_ALL = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
// Its sub-tabs, each at an address of its own, the last picked opened again (ingest.js).
const TABS = [['pulls', 'Pull requests'], ['versions', 'Versions'], ['branch', 'Default branch'], ['reviews', 'Reviews']]
// The Pull requests sub-tab's orders (`state.teamDependenciesSort`): newest
// opened, latest updated, or fewest versions to review (one with only others'
// after those adding some); ties by repository, then the newest by number.
const tied = (a, b) => a.repo.name < b.repo.name ? -1 : a.repo.name > b.repo.name ? 1 : b.item.number - a.item.number
const latest = field => (a, b) => (b.item[field] ?? 0) - (a.item[field] ?? 0) || tied(a, b)
const fewest = (a, b) => Number(a.size === 0) - Number(b.size === 0) || a.size - b.size || a.others - b.others || tied(a, b)
const SORTS = { newest: ['Newest', latest('createdAt')], updated: ['Updated', latest('updatedAt')], fewest: ['Fewest to review', fewest] }
// A pull request whose dependencies are still to be told.
const TELLING = { status: 'loading', until: Number.POSITIVE_INFINITY }
// Whether a pull request merges into its repository's default branch (one
// whose branch isn't told is): the team's read tells only those, not drafts (http.ts).
const ontoDefault = (item, defaultBranch) => !defaultBranch || typeof item.base !== 'string' || item.base === defaultBranch
const toldOf = (item, defaultBranch) => ontoDefault(item, defaultBranch) && item.draft !== true
// A pull request's dependencies as the team's read told them, else still to
// be told; one awaiting a Stasis build asked again alone as it grows old.
function pullEntry(repoId, number) {
  const held = heldPullDependencies(repoId, number, true)
  return held?.pending ? pullDependencies(repoId, number, true, { background: true }) : held ?? TELLING
}
// How long past the time one is read again its tab is told to.
const AGAIN_PAST_MS = 50

const held = new Map()
const listeners = new Set()
// The reads in flight by team, stopped once forgotten or no tab shows their
// team: a read runs minutes, and resumes.
const inFlight = new Map()
// The team each tab shows, by its element.
const showing = new Map()
let sweeping = false
const changed = () => { for (const notify of listeners) notify() }
// The reads in flight stopped, and with them what is held, as another session or role reads.
const stopReads = { clear: () => { for (const read of inFlight.keys()) read.abort(); inFlight.clear() } }
const sessionHeld = sessionKept(held, stopReads)
// Reads of teams no tab shows stopped, once tabs moved meanwhile are back in place.
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
  held.clear()
  stopReads.clear()
  changed()
})

// Team `team`'s repositories `repoIds`, each as held, else asked, all those
// not held or grown old in one read (readTeam): `{ status }`, 'loading',
// then 'ready' with its default branch's dependencies (`branch`, null where
// no review is in effect for the reader), its open `pulls` (with `error`
// where not all were read) and those still to be told (`telling`), or
// 'error'; one grown old shown as it was while read again (`refreshing`).
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

// Repositories `asked` read in one request (only `repoIds` where given), each
// held as its lines tell it; those the server's time left asked again,
// `resumes` times at most.
function readTeam(team, asked, repoIds, resumes) {
  // Each one's entry as this read last held it, those it told all of left out.
  const current = new Map(asked.map(repoId => [repoId, held.get(repoId)]))
  const set = (repoId, entry) => {
    if (held.get(repoId) === current.get(repoId)) held.set(repoId, entry)
    if (held.get(repoId) === entry && entry.telling) current.set(repoId, entry)
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
      else if (held.get(repoId) === entry) {
        if (entry.status === 'ready') held.set(repoId, { ...entry, until: 0, telling: null })
        else held.delete(repoId)
      }
    }
  }).finally(() => {
    inFlight.delete(controller)
    changed()
  })
}

// A failed read, held till it is asked again; one telling no review in effect for the reader.
const failedRead = error => ({ status: 'error', until: Date.now() + RETRY_MS, error })
const unreviewed = () => ({ status: 'ready', until: Date.now() + KEEP_MS, branch: null })

// What repository line `line` tells of one held as `entry`, given to `hold`:
// no review in effect, or why it couldn't be read; its default branch's
// dependencies and open pull requests; or some of their dependencies,
// seeded (seedPullDependencies). Its line counts seeded first, lest rows ask.
function toldLine(line, entry, hold) {
  knowGithubUsers(line)
  if (Array.isArray(line.deltas)) seedNpmDeltas(line.deltas)
  if (typeof line.error === 'string') hold(failedRead(line.error))
  else if (line.branch === null) hold(unreviewed())
  else if (line.branch) {
    let branch
    try { branch = checked(line.branch) } catch (err) {
      hold(failedRead(err.message))
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
// all read, or awaiting a Stasis build (`pending`), read again sooner, the tab told then.
function telling(entry, numbers) {
  if (numbers.size > 0) return { ...entry, until: Number.POSITIVE_INFINITY, telling: numbers }
  const wait = entry.pulls?.error || entry.pending ? RETRY_MS : KEEP_MS
  if (entry.pending) setTimeout(changed, wait + AGAIN_PAST_MS).unref?.()
  return { ...entry, until: Date.now() + wait, telling: null }
}

// One a read told no more of: told nothing (`failure` none), none of the
// team's, so reviewing none; else failed, one whose default branch was told
// kept, its pull requests still to be told failed.
function untold(repoId, entry, failure) {
  if (entry.telling) {
    seedPullDependencies(repoId, new Map([...entry.telling].map(number => [number, new Error(failure ?? 'The server’s answer ended short.')])), true)
    return { ...entry, until: Date.now() + RETRY_MS, telling: null }
  }
  return failure ? failedRead(failure) : unreviewed()
}

const plural = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
const pullName = ({ repo, item }) => `${repo.name}#${item.number}`
// `map`'s entry for `key`, made first where it has none.
const entryOf = (map, key, make) => map.get(key) ?? map.set(key, make()).get(key)

// The reader's login, in lower case, by which a review is told as theirs.
const reader = () => state.managedSession?.login?.toLowerCase() ?? null
const isReader = one => one.login.toLowerCase() === reader()

// A version's review: that it can't be reviewed, is rejected, or how many
// reviews pass it of those it needs; its label, tint and what it says, none
// where it wants no review.
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
// A review's badge, its label alone, none for one no review passes yet; the
// row's tooltip tells the rest (versionTip).
function reviewBadge(pkg, review) {
  const stance = reviewState(pkg, review)
  if (!stance || (stance.tint === 'is-wanted' && pkg.reviews === 0)) return nothing
  return html`<span class="team-deps-review ${stance.tint}">${stance.label}</span>`
}

// Each verdict as a reviewer's line of a version's tooltip says it, and those accepting it.
const VERDICT_SAID = { accept: 'accepts', 'accept-with-nits': 'accepts with nits', 'request-changes': 'requests changes', reject: 'rejects' }
const ACCEPTING = new Set(['accept', 'accept-with-nits'])
// A version's review in a pull request, as its tooltip names it there.
const reviewedThere = (pkg, review) => ({ passed: 'passes', baseline: 'needs none' })[reviewOf(pkg, review)] ?? reviewState(pkg, review)?.label ?? null

// The reviews counting of a version in a pull request: whose pass and reject it, by login.
const counting = pkg => new Map((pkg.reviewers ?? []).flatMap(one => one.passes ? [[`+${one.login.toLowerCase()}`, one]]
  : one.status === 'reject' ? [[`-${one.login.toLowerCase()}`, one]] : []))

// How each version stands under each pull request wanting it, by its key,
// then the pull request's name (`involved` the pull requests each is among
// the versions of). One holding reviews of it but lacking one made in
// another's comments (which count there alone): `lacks`, `{ login, status,
// pulls }` each; a review published to the team is never lacked, the
// server telling where it counts. Of the rest, those reviewed alike have one
// list it, with the fewest reviews left; the others tell it `under` that
// one. One holding none tells it under the one listing it with most
// reviews, else under the one holding most of those lacking some.
function standings(wanting, involved) {
  const wanted = new Map()
  for (const pull of wanting) {
    for (const pkg of pull.wanted) {
      const has = counting(pkg)
      entryOf(wanted, versionKey(pkg), () => []).push({ pull, has, alike: [...has.keys()].toSorted().join('\0') })
    }
  }
  // Of two, the one holding more reviews, then leaving fewer, then the first.
  const more = (one, other) => !one || other.has.size > one.has.size || (other.has.size === one.has.size && other.pull.left < one.pull.left) ? other : one
  const stood = new Map()
  for (const [key, wanters] of wanted) {
    const made = new Map()
    for (const { pull, pkg } of involved.get(key)?.values() ?? []) {
      for (const [stance, one] of counting(pkg)) {
        if (one.comment) entryOf(made, stance, () => ({ login: one.login, status: one.status, pulls: [] })).pulls.push(pull)
      }
    }
    const of = new Map()
    // The one listing it of those holding the same reviews; of those lacking some, the one holding most.
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

// Versions in a list's order: those reviewed there already first, those only
// a lockfile asks for (`unreached`) last. `of`: an item's version, where it isn't one.
const begun = pkg => (pkg.reviews ?? 0) > 0 || pkg.rejected === true
const rank = pkg => (pkg.unreached ? 2 : 0) + (begun(pkg) ? 0 : 1)
const prioritized = (items, of = item => item) => items.toSorted((a, b) => rank(of(a)) - rank(of(b)))

// The first of `names`, and how many more there are.
const few = (names, more = names.length - 1) => `${names[0]}${more > 0 ? ` +${more}` : ''}`

// What a version only its lockfile asks for says of that.
const UNREACHED_SAID = 'only lockfile, not stasis.config.json'

// The reader's own review of a version: its verdict, and whether partial.
const yoursSaid = ({ status, partial }) => `${verdictLabels[status]}${partial ? ', partial' : ''}`

// A version's row tooltip: its name and version whole, patched tagged; where
// it is from other than npm's registry; its patch's hash and file; its
// review; the pull request listing it (`under`); the reviews it lacks; the
// pull requests adding or holding it (`involved`, `{ name, adds, pkg, review
// }` each), the one it is listed under (`here`) marked; and who reviews it,
// by the pull request where only its comments' reviews count.
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

// A version as a row, its tooltip versionTip: its icon, name and version,
// opening its review where the reader can review it (against reviewBase, a
// patched one as its patch read of `repoId` at `head`), else its page; `!`
// where only a lockfile asks for it; its review; its line counts where it
// wants reviews (npm-delta.js); its row red where it `lacks` reviews others
// hold; the pull requests reviewing it in their comments (`elsewhere`), the
// one listing it (`under`), and those adding it besides (`adders`: all of
// them, those `lacking` reviews red). A bundle's Overview lists its versions
// so too (bundle-dependency-review.js).
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

// How many versions a pull request wants reviewed, where more than one; and
// where only a lockfile asks for some (`!`), how many Stasis reaches, at
// least, where its answer lists only some (`untold`).
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

// How far Stasis is with what the stasis.config.json files of `answers`
// (`[repoId, answer]` each) reach: each build once, by repository, file and
// commit, done where any answer tells it made; an answer telling none, its
// head's alone. Shown by Stasis's mark, a bar and the count.
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

// Where a pull request's versions' patches are read: its repository at the commit its lockfiles were read at.
const readAt = pull => ({ repoId: pull.repo.repoId, head: pull.entry.head ?? null })

// A list's toggle: its chevron turned while it is open.
const CHEVRON = icon(svg`<path d="m6 4 4 4-4 4"/>`)
// GitHub's mark, before each pull request a tooltip names.
const GITHUB_ICON = appMarkup(GITHUB_ICON_SVG)

// The rows of its masonry grid a card spans, as tall as it is with the gap under it.
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

  // Sub-tab `tab` shown at its address, a history entry of its own where picked (`push`).
  pick(tab, { push = true } = {}) {
    state.teamDependenciesTab = tab
    const route = managedRouteForIds({ view: 'workspace-dependencies', teamId: this.team, dependencyTab: tab }, state.managedTeams)
    if (push) managedHistory?.pushRoute(route)
    else managedHistory?.replaceRoute(route)
  }

  // The sub-tab its address names, the default branch's giving way to the
  // first where none wants reviews once all is read.
  updated() {
    if (this._shown && this._shown !== state.teamDependenciesTab) this.pick(this._shown, { push: false })
    this._pack()
  }

  // Its pull requests' cards packed as masonry, each spanned anew as it grows or shrinks.
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
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    listeners.delete(this._notify)
    this._unsubscribe?.()
    showing.delete(this)
    stopUnshown()
    this._masonry?.disconnect()
  }

  open(event, { repo, item }) {
    event.preventDefault()
    openRepositoryItemDialog({ repository: { repoId: repo.repoId, repo: repo.name }, target: { number: item.number, preview: { ...item, kind: 'pulls' } } })
  }

  // Rows of `items`, all where as many as `upTo`, else `folded` till the rest
  // are asked for, under `key`; those listed under other pull requests (`same`) dimmed.
  rows(key, items, row, [upTo, folded] = SHOWN_VERSIONS, same = false) {
    if (items.length === 0) return nothing
    const open = this._open.has(key), shown = items.length > upTo ? folded : items.length
    return html`<ul class="team-deps-versions${same ? ' is-same' : ''}">${(open ? items : items.slice(0, shown)).map(row)}</ul>
      ${items.length > shown ? html`<button type="button" class="team-deps-more is-list" aria-expanded=${String(open)} @click=${() => this.toggle(key)}>${CHEVRON}${open
        ? 'Show fewer' : `and ${(items.length - shown).toLocaleString('en-US')} more`}</button>` : nothing}`
  }

  // A list told by `label` alone till opened, under `key`, and how many past those it lists.
  disclosed(key, label, items, row, unlisted = 0) {
    const open = this._open.has(key)
    return html`<div class="team-deps-disclosed">
      <button type="button" class="team-deps-more" aria-expanded=${String(open)} @click=${() => this.toggle(key)}>${CHEVRON}${label}</button>
      ${open ? html`${this.rows(key, items, row, SHOWN_LISTED)}${unlisted > 0
        ? html`<p class="team-deps-quiet">and ${unlisted.toLocaleString('en-US')} more, not listed</p>` : nothing}` : nothing}
    </div>`
  }

  render() {
    // Another team shown, the one before is no longer read for it.
    if (this.isConnected && showing.get(this) !== this.team) {
      if (showing.has(this)) stopUnshown()
      showing.set(this, this.team)
    }
    const repos = [...new Map((this.repositories ?? []).map(repo => [repo.repoId, repo])).values()]
    const entries = teamRepositories(this.team, repos.map(repo => repo.repoId))
    const reads = repos.map((repo, at) => ({ repo, read: entries[at] }))
    const reviewed = reads.filter(({ read }) => read.status === 'ready' && read.branch)
    // Each pull request's as the team's read told it; those into other
    // branches (`into`) and drafts hidden but where asked for, then read
    // alone, as the team's read tells none.
    const every = state.teamDependenciesAllBranches === true
    const drafts = state.teamDependenciesDrafts === true
    const listing = reviewed.flatMap(({ repo, read }) => read.pulls.items.filter(readsDependencies).map(item => ({ repo, item, onto: ontoDefault(item, read.pulls.defaultBranch) })))
    const intoOthers = listing.filter(({ onto }) => !onto).length
    const draftCount = listing.filter(({ item, onto }) => item.draft === true && (onto || every)).length
    const pulls = listing.flatMap(({ repo, item, onto }) => (!onto && !every) || (item.draft === true && !drafts) ? []
      : onto && item.draft !== true ? [{ repo, item, entry: pullEntry(repo.repoId, item.number) }]
      : [{ repo, item, ...onto ? {} : { into: item.base }, entry: pullDependencies(repo.repoId, item.number, true, { background: true }) }])
    // Each pull request's versions wanting reviews, how many in all
    // (`toReview`), how many reviews they still want (`left`), and the other
    // versions its lockfiles lock wanting them (`others`, mostly its base's),
    // one into another branch left out where it adds none and its comments
    // review none; those adding fewest first, as Versions takes them.
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
    // The repositories with more open pull requests than read, and those not all read (a failure).
    const unchecked = reviewed.filter(({ read }) => read.pulls.more && !read.pulls.error)
    const unread = reviewed.filter(({ read }) => read.pulls.error)
    // Each version wanting reviews by the pull requests adding it, as each
    // tells it (`told`), and the first told its patch's file (`patched`).
    const adding = new Map()
    for (const pull of wanting) {
      for (const pkg of pull.wanted) {
        const added = entryOf(adding, versionKey(pkg), () => ({ pkg, pulls: [], told: [] }))
        added.pulls.push(pull)
        added.told.push(pkg)
        if (!added.patched && pkg.patch?.path) added.patched = { patch: pkg.patch, pull }
      }
    }
    const reading = reads.some(({ read }) => read.status === 'loading') || pulls.some(({ entry }) => entry.status === 'loading')
    // Whether Stasis still builds what a stasis.config.json of theirs reaches.
    const building = pulls.some(({ entry }) => entry.pending) || reviewed.some(({ read }) => read.branch.pending)
    const failures = [...reads.filter(({ read }) => read.status === 'error').map(({ repo, read }) => [repo.name, read.error]),
      ...unread.map(({ repo, read }) => [repo.name, read.pulls.error]), ...pulls.filter(({ entry }) => entry.status === 'error').map(pull => [pullName(pull), pull.entry.error])]
    // The default branches with versions wanting reviews, or failing them.
    const branches = reviewed.flatMap(({ repo, read }) => {
      const { count } = unreviewedVersions(read.branch), failed = reviewFailures(read.branch)
      return count > 0 || failed || read.branch.pending ? [{ repo, read, count: count + (failed?.count ?? 0) }] : []
    })
    // The pull requests each version is among, by its key: adding it, else
    // locking it otherwise wanting reviews, with it as it is there.
    const involved = new Map()
    for (const pull of pulls.filter(({ entry }) => entry.status === 'ready' && entry.review)) {
      for (const [adds, versions] of [[true, addedVersions(pull.entry).versions], [false, unreviewedVersions(pull.entry).versions]]) {
        for (const pkg of versions) {
          const of = entryOf(involved, versionKey(pkg), () => new Map())
          if (!of.has(pullName(pull))) of.set(pullName(pull), { pull, pkg, adds })
        }
      }
    }
    // Names without their owner where every repository reviewed, or not yet read, has the same one.
    const owners = new Set(reads.filter(({ read }) => read.status !== 'ready' || read.branch).map(({ repo }) => repo.name.split('/')[0]))
    const shorten = owners.size === 1 ? name => name.slice(name.indexOf('/') + 1) : name => name
    const named = pull => shorten(pullName(pull))
    // The pull requests a version is among, as its tooltip names them; and
    // those but `pull` reviewing it in their comments.
    const among = pkg => [...involved.get(versionKey(pkg))?.values() ?? []]
      .map(({ pull, pkg: theirs, adds }) => ({ name: named(pull), adds, pkg: theirs, review: pull.entry.review }))
    const elsewhere = (pkg, pull = null) => [...involved.get(versionKey(pkg))?.values() ?? []]
      .filter(one => one.pkg.commented > 0 && (!pull || pullName(one.pull) !== pullName(pull))).map(one => named(one.pull))
    // How each version stands under each pull request wanting it, its pull requests named.
    const stood = standings(wanting, involved)
    const standing = (pkg, pull) => {
      const { under = null, lacks = [] } = stood.get(versionKey(pkg))?.get(pullName(pull)) ?? {}
      return { under: under && named(under), lacks: lacks.map(one => ({ login: one.login, status: one.status, where: one.pulls.map(named) })) }
    }
    const naming = { elsewhere, named, shorten, among, standing }
    // Each pull request's card in the order picked: the versions it lists, how
    // many lack reviews, and those others list (`same`); set apart
    // (`covered`) where it adds none but those and nothing fails it.
    const cards = sorted.map(pull => {
      const same = prioritized(pull.wanted.filter(pkg => standing(pkg, pull).under))
      const listed = prioritized(pull.wanted.filter(pkg => !same.includes(pkg)))
      return { pull, listed, same, lacking: listed.filter(pkg => standing(pkg, pull).lacks.length > 0).length,
        covered: listed.length === 0 && same.length > 0 && pull.untold === 0 && !pull.failed }
    })
    const lacking = cards.reduce((sum, card) => sum + card.lacking, 0)
    const failed = failures.map(([name, error]) => `${shorten(name)}: ${error}`)
    // The default branch's sub-tab where it wants reviews, or while read where picked.
    const picked = state.teamDependenciesTab
    const tabs = TABS.filter(([kind]) => kind !== 'branch' || branches.length > 0 || reading && picked === 'branch')
    const tab = tabs.some(([kind]) => kind === picked) ? picked : 'pulls'
    this._shown = tab
    const counts = { pulls: wanting.length, versions: adding.size, branch: branches.reduce((sum, { count }) => sum + count, 0) }
    // Above each sub-tab's lists but Reviews', one line, there whatever it
    // says lest what is under it move: reading and failures, the red rows'
    // key, and the order.
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

  // The pull requests wanting reviews (`cards`), in the order picked: each
  // card its own versions (lacking reviews red), then those others list,
  // dimmed, and the reader's reviews to copy (dependency-review-copy.js).
  // Those adding only versions others list come after, each its head alone
  // till opened.
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

  // Every version the pull requests add wanting reviews, once, as the pull
  // request listing it tells it, else the one holding most reviews of it;
  // marked where every one adding it marks it.
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

  // What a repository's default branch locks wanting reviews, and what fails it there.
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
