// An open pull request's reviews (server-managed/pull-reviews.ts), as the
// code viewer's Pull requests tab draws them on its tile, a line of them
// (repository-issues.js), and its popup lists them
// (dialogs/repository-item-dialog.js): each reviewer by how their latest
// review stands, dimmed where it was on an earlier commit than the latest;
// Codex by its summary's code review, its security review named in the
// popup; the open review threads, by the gravest of them; and whether the
// latest commit has a review at all. The pull request's author's own replies
// in its threads are none of its reviews.
import { html, nothing, svg } from 'lit'
import { githubUser } from './github-users.js'
import { COMMENT_ICON, REVIEWS, icon } from './repository-tiles.js'

const CHECK = icon(svg`<path d="M3.5 8.4l2.9 2.9 6.1-6.6"/>`)
const SPINNER = icon(svg`<circle class="fill" cx="8" cy="8" r="3"/>`)
const FAILED = icon(svg`<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>`)
const ASKED = icon(svg`<circle class="dotted" cx="8" cy="8" r="5.5"/>`)
const THREAD = icon(svg`<path d="M2.6 3.2h7.6v5.3H6.3L4 10.4V8.5H2.6z"/><path d="M12.2 6.2h1.2v5.3H12v1.9l-2.3-1.9H7"/>`)

// A reviewer's latest review, as its mark shows and names it.
const STANDING = {
  approved: ['approved', REVIEWS.approved[1], 'Approved'],
  changes: ['changes', REVIEWS.changes[1], 'Changes requested'],
  commented: ['commented', COMMENT_ICON, 'Commented'],
  dismissed: ['dismissed', COMMENT_ICON, 'Review dismissed'],
}
// Codex's, by its summary: its code review's, else what it was asked since.
const CODEX = {
  done: ['reviewed', CHECK, 'Reviewed'],
  running: ['running', SPINNER, 'Reviewing'],
  failed: ['failed', FAILED, 'Review failed'],
  requested: ['requested', ASKED, 'Asked to review again'],
}
const REQUESTED = ['requested', ASKED, 'Review requested']

const short = commit => commit.slice(0, 7)
const date = at => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const plural = (count, noun, more = false) => `${count.toLocaleString('en-US')}${more ? '+' : ''} ${noun}${count === 1 && !more ? '' : 's'}`

// Codex's mark: its code review's state, asked again or failed since
// overriding it; null where its summary names none.
function codexStanding(codex) {
  if (!codex) return null
  if (codex.failed) return CODEX.failed
  if (codex.requested) return CODEX.requested
  return CODEX[codex.code?.status] ?? null
}

// Each reviewer as their mark shows them: who, how their review stands,
// the commit it was on, and whether that is the latest; Codex first, by its
// summary's code review.
export function reviewStandings(reviews) {
  const codex = codexStanding(reviews.codex)
  const commit = reviews.codex?.code?.commit ?? null
  return [
    ...codex ? [{ who: githubUser(reviews.codex.login, 'Codex'), standing: codex, commit, stale: commit !== null && commit !== reviews.head }] : [],
    ...reviews.reviewers.map(reviewer => ({
      who: reviewer.team ? html`<span class="app-user-name">@${reviewer.team}</span>` : githubUser(reviewer.login, reviewer.login ?? 'someone'),
      standing: STANDING[reviewer.state] ?? REQUESTED, requested: reviewer.requested && Boolean(STANDING[reviewer.state]), workflow: reviewer.workflow ?? null,
      commit: reviewer.commit, at: reviewer.at, stale: reviewer.commit !== null && reviewer.commit !== reviews.head })),
  ]
}

// How many reviewers more than those read: their reviews and requests.
const moreReviewers = reviews => (reviews.moreReviews ?? 0) + (reviews.moreRequests ?? 0)

// Whether a review is on the latest commit: one that reviewed it, or Codex,
// done with it; taken as so where more reviews are than were read, one of
// them perhaps on it (a request unread is none).
export function headReviewed(reviews) {
  if (!reviews.head || reviews.moreReviews > 0) return true
  const codex = reviews.codex?.code
  return (codex?.status === 'done' && codex.commit === reviews.head)
    || reviews.reviewers.some(reviewer => STANDING[reviewer.state] && reviewer.state !== 'dismissed' && reviewer.commit === reviews.head)
}

// The gravest open thread's badge, as Codex draws it: P0 and P1 grave, P2
// and P3 less so.
const severity = level => level ? html`<span class=${`review-severity is-${level}`}>${level.toUpperCase()}</span>` : nothing

// A tile's line of its reviews: a mark a reviewer, then its open threads,
// then, where no review is on the latest commit, that it is unreviewed.
export function reviewLine(reviews) {
  if (!reviews) return nothing
  const standings = reviewStandings(reviews)
  const { open, more, severity: gravest } = reviews.threads
  const threads = open > 0 ? `${plural(open, 'open review thread', more)}${gravest ? `, the gravest ${gravest.toUpperCase()}` : ''}`
    : more ? 'No open review thread among those read; more on GitHub' : null
  const unreviewed = !headReviewed(reviews)
  return html`<span class="issue-reviews">
    ${standings.map(({ who, standing: [state, glyph, name], commit, stale, requested }) => {
      // Named on its mark, as the reviewer is on their name.
      const said = `${name}${requested ? ', and requested again' : ''}${stale ? `, on an earlier commit (${short(commit)})` : commit ? ', on the latest commit' : ''}`
      return html`<span class=${`review-mark is-${state}${stale ? ' is-stale' : ''}`}><span class="review-glyph" role="img" aria-label=${said}
        data-tooltip=${said}>${glyph}</span><span class="review-who">${who}</span></span>`
    })}
    ${moreReviewers(reviews) > 0 ? html`<span class="review-more" data-tooltip=${plural(moreReviewers(reviews), 'more reviewer')}>+${moreReviewers(reviews)}</span>` : nothing}
    ${threads ? html`<span class="review-threads" role="img" aria-label=${threads} data-tooltip=${threads}>${THREAD}<span>${open}${more ? '+' : ''}</span>${severity(gravest)}</span>` : nothing}
    ${unreviewed ? html`<span class="review-unreviewed" data-tooltip=${standings.length > 0 ? 'No review is on the latest commit' : 'No reviews yet'}>Unreviewed</span>` : nothing}
  </span>`
}

// A commit a review was on, linked on GitHub where the repository is named
// (`repo`), and whether it is the latest.
function onCommit(commit, head, repo) {
  if (!commit) return nothing
  const sha = html`<code>${short(commit)}</code>`
  return html`<span class="review-on">on ${repo ? html`<a href=${`https://github.com/${repo}/commit/${commit}`} target="_blank" rel="noopener noreferrer">${sha}</a>` : sha}${
    commit === head ? ', the latest commit' : ', an earlier commit'}</span>`
}

// A popup's reviews: a row a reviewer, Codex's code and security reviews
// a row each, how it stands, the agentic workflow (gh-aw) that posted it,
// on which commit, when; then its open threads,
// each linked to where it is on GitHub, and how many are resolved.
export function reviewSections(reviews, repo) {
  if (!reviews) return nothing
  const { head, codex } = reviews
  const codexRow = (review, [state, glyph, name], title) => html`<li class="review-row">${githubUser(codex.login, 'Codex')}
    <span class=${`review-state is-${state}`}>${glyph}${title}: ${name.toLowerCase()}</span>${onCommit(review.commit, head, repo)}</li>`
  const rows = [
    ...codex?.code ? [codexRow(codex.code, codexStanding(codex) ?? CODEX.done, 'Code review')] : [],
    ...codex?.security ? [codexRow(codex.security, CODEX[codex.security.status] ?? CODEX.done, 'Security review')] : [],
    ...reviewStandings({ ...reviews, codex: null }).map(({ who, standing: [state, glyph, name], commit, at, requested, workflow }) => html`<li class="review-row">${who}
      <span class=${`review-state is-${state}`}>${glyph}${name}${requested ? ', requested again' : ''}</span>${
      workflow ? html`<span class="review-on">by the workflow <code>${workflow}</code></span>` : nothing}${onCommit(commit, head, repo)}${
      at ? html`<time datetime=${new Date(at).toISOString()}>${date(at)}</time>` : nothing}</li>`),
  ]
  const { open, resolved, more, list = [] } = reviews.threads
  return html`<section class="repo-item-section"><h4>Reviews</h4>
      ${rows.length > 0 ? html`<ul>${rows}</ul>` : html`<p class="repo-item-quiet">No reviews yet.</p>`}
      ${moreReviewers(reviews) > 0 ? html`<p class="repo-item-quiet">And ${plural(moreReviewers(reviews), 'more reviewer')}, on GitHub.</p>` : nothing}
      ${rows.length > 0 && !headReviewed(reviews) ? html`<p class="repo-item-quiet">No review is on the latest commit, <code>${short(head)}</code>.</p>` : nothing}
    </section>
    ${open > 0 || resolved > 0 ? html`<section class="repo-item-section"><h4>Open threads</h4>
      ${list.length > 0 ? html`<ul>${list.map(thread => html`<li><a class="repo-item-row review-thread" href=${thread.url ?? nothing} target="_blank" rel="noopener noreferrer">
        ${severity(thread.severity)}<span class="repo-item-title">${thread.title || '(no comment)'}</span>
        ${thread.path ? html`<code class="review-path">${thread.path}${thread.line ? `:${thread.line}` : ''}</code>` : nothing}
        ${thread.outdated ? html`<span class="repo-item-quiet">outdated</span>` : nothing}</a></li>`)}</ul>`
        : html`<p class="repo-item-quiet">${more ? 'None open among those read.' : 'None open.'}</p>`}
      ${resolved > 0 || more ? html`<p class="repo-item-quiet">${resolved > 0 ? `${plural(resolved, 'thread')} resolved` : ''}${
        more ? `${resolved > 0 ? '; ' : ''}more on GitHub` : ''}.</p>` : nothing}
    </section>` : nothing}`
}
