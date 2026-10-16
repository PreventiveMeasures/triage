import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pullReviews, reviewFields, reviewsRefused } from '../server-managed/pull-reviews.ts'

const earlier = 'b'.repeat(40), head = 'a'.repeat(40)
const codex = { login: 'chatgpt-codex-connector', databaseId: 199175422 }
const review = (author, state, commit = head, at = '2026-10-16T05:00:00Z') => ({ author, state, submittedAt: at, commit: { oid: commit } })
const summary = (code, security, updatedAt = '2026-10-16T05:10:00Z') => ({ author: codex, updatedAt, body: '<!-- codex-pull-request-review-summary -->\n'
  + `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: code, security_review: security })} -->\n## Codex Review Summary` })
const finding = (badge, title) => `**<sub><sub>![${badge} Badge](https://img.shields.io/badge/${badge}-yellow?style=flat)</sub></sub>  ${title}**\n\nWhy it matters.`

test('a pull request\'s reviewers are each by their latest review and its commit, its author\'s own aside, whose is requested beside them', () => {
  const reviews = pullReviews({ headRefOid: head.toUpperCase(),
    latestReviews: { nodes: [review({ login: 'ada', databaseId: 2 }, 'APPROVED'), review({ login: 'grace', databaseId: 3 }, 'CHANGES_REQUESTED', earlier),
      review({ login: 'Author', databaseId: 4 }, 'COMMENTED'), review({ login: 'alan', databaseId: 5 }, 'PENDING'), review({ login: 'kay', databaseId: 6 }, 'COMMENTED', null), null] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'grace', databaseId: 3 } }, { requestedReviewer: { __typename: 'User', login: 'linus', databaseId: 7 } },
      { requestedReviewer: { __typename: 'Team', slug: 'security' } }, { requestedReviewer: { __typename: 'Bot', login: 'Copilot', databaseId: 175728472 } },
      { requestedReviewer: { __typename: 'Mannequin', login: 'imported-ada', databaseId: 8 } }, { requestedReviewer: { __typename: 'EnterpriseTeam', slug: 'auditors' } },
      { requestedReviewer: { __typename: 'SomethingNew' } }, { requestedReviewer: null }] } }, 'author')
  assert.equal(reviews.head, head, 'the head commit, as GitHub names it, in lowercase')
  assert.deepEqual(reviews.reviewers, [
    { login: 'ada', id: 2, state: 'approved', requested: false, commit: head, at: Date.parse('2026-10-16T05:00:00Z') },
    { login: 'grace', id: 3, state: 'changes', requested: true, commit: earlier, at: Date.parse('2026-10-16T05:00:00Z') },
    { login: 'kay', id: 6, state: 'commented', requested: false, commit: null, at: Date.parse('2026-10-16T05:00:00Z') },
    { login: 'linus', id: 7, state: null, requested: true, commit: null, at: null },
    { login: null, id: null, team: 'security', state: null, requested: true, commit: null, at: null },
    { login: 'Copilot', id: 175728472, state: null, requested: true, commit: null, at: null },
    { login: 'imported-ada', id: 8, state: null, requested: true, commit: null, at: null },
    { login: null, id: null, team: 'auditors', state: null, requested: true, commit: null, at: null },
  ], 'none pending, none the author\'s; one reviewed and requested again once; Copilot\'s code review asked for, by its bot; a mannequin and an enterprise\'s team')
  assert.deepEqual(reviews.threads, { open: 0, resolved: 0, more: false, severity: null })
  assert.equal(reviews.moreReviewers, 2, 'those GitHub names no one for, counted rather than gone: a reviewer of a kind unknown, and a request naming none')
  const many = pullReviews({ headRefOid: head, latestReviews: { totalCount: 23, nodes: [review({ login: 'ada', databaseId: 2 }, 'APPROVED')] }, reviewRequests: { totalCount: 12, nodes: [] } }, 'author')
  assert.equal(many.moreReviewers, 22 + 12, 'those past the reviews and requests read, as GitHub counts them')
  assert.equal(reviews.codex, null)
  assert.equal(pullReviews({}, 'author'), null, 'none read, none')
  for (const refused of ['latestReviews', 'reviewRequests', 'reviewThreads']) {
    assert.equal(pullReviews({ headRefOid: head, latestReviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, [refused]: null }, 'author'), null,
      `${refused} refused, none rather than no reviews`)
  }
})

test('Codex\'s reviews are its summary\'s, each kind\'s commit and state, its review objects aside; asked again since, or failed since, said', () => {
  const node = (lastComments, extra = {}) => ({ headRefOid: head, latestReviews: { nodes: [review(codex, 'COMMENTED', earlier)] },
    firstComments: { nodes: [{ author: { login: 'ada' }, body: 'First!', updatedAt: '2026-10-16T05:00:00Z' },
      summary({ commit_sha: head, status: 'completed', has_unresolved_findings: false }, { commit_sha: earlier, status: 'running' })] },
    lastComments: { nodes: lastComments }, ...extra })
  const done = pullReviews(node([]), 'author')
  assert.deepEqual(done.codex, { login: 'chatgpt-codex-connector', id: 199175422, code: { commit: head, status: 'done' }, security: { commit: earlier, status: 'running' },
    requested: false, failed: false }, 'by its account, which the app draws as Codex')
  assert.deepEqual(done.reviewers, [], 'its review is the summary\'s')
  const asked = pullReviews(node([{ author: { login: 'author' }, body: '@codex review\n\nFixed both.', createdAt: '2026-10-16T05:20:00Z' }]), 'author')
  assert.deepEqual([asked.codex.requested, asked.codex.failed], [true, false])
  const security = pullReviews(node([{ author: { login: 'author' }, body: '@codex security review', createdAt: '2026-10-16T05:20:00Z' }]), 'author')
  assert.equal(security.codex.requested, false, 'asking for a security review is not asking its code review again')
  const before = pullReviews(node([{ author: { login: 'author' }, body: '@codex review', createdAt: '2026-10-16T05:05:00Z' }]), 'author')
  assert.equal(before.codex.requested, false, 'one asked before the summary last changed is answered')
  const failed = pullReviews(node([{ author: { login: 'author' }, body: '@codex review', createdAt: '2026-10-16T05:20:00Z' },
    { author: codex, body: 'Codex Review: Something went wrong. Try again later by commenting “@codex review”.', createdAt: '2026-10-16T05:22:00Z' }]), 'author')
  assert.deepEqual([failed.codex.requested, failed.codex.failed], [false, true])
  const retried = pullReviews(node([{ author: codex, body: 'Codex Review: Something went wrong.', createdAt: '2026-10-16T05:22:00Z' },
    { author: { login: 'author' }, body: '@codex review', createdAt: '2026-10-16T05:25:00Z' }]), 'author')
  assert.deepEqual([retried.codex.requested, retried.codex.failed], [true, false])
  const impostor = pullReviews({ headRefOid: head, firstComments: { nodes: [{ ...summary({ commit_sha: head, status: 'completed' }, null), author: { login: 'mallory', databaseId: 9 } }] } }, 'author')
  assert.equal(impostor.codex, null, 'a summary is Codex\'s alone')
  const broken = pullReviews({ headRefOid: head, firstComments: { nodes: [{ author: codex, body: '<!-- codex-review-state:v1 {nope} -->' }] } }, 'author')
  assert.equal(broken.codex, null)
  const later = pullReviews({ headRefOid: head, firstComments: { nodes: Array.from({ length: 5 }, () => ({ author: { login: 'ada' }, body: 'Hm.' })) },
    lastComments: { nodes: [summary({ commit_sha: head, status: 'running' }, null)] } }, 'author')
  assert.deepEqual(later.codex.code, { commit: head, status: 'running' }, 'its summary among the last, where it was first asked past the first comments')
  const actions = { login: 'github-actions', databaseId: 41898282 }
  const workflow = pullReviews({ headRefOid: head, latestReviews: { nodes: [{ ...review(actions, 'APPROVED'), body: 'Looks right.\n\n> Generated by [PR review](https://github.com/o/r/actions/runs/1)\n\n<!-- gh-aw-workflow-id: pr-review -->' },
    { ...review({ login: 'ada', databaseId: 2 }, 'COMMENTED'), body: '<!-- gh-aw-workflow-id: not a name! -->' }] } }, 'author', true)
  assert.deepEqual(workflow.reviewers.map(item => [item.login, item.state, item.workflow]), [['github-actions', 'approved', 'pr-review'], ['ada', 'commented', undefined]],
    'an agentic workflow\'s review by its marker, GitHub Actions\' bot approving')
  const reviewed = pullReviews({ headRefOid: head, latestReviews: { nodes: [review(codex, 'COMMENTED', earlier)] } }, 'author')
  assert.deepEqual(reviewed.reviewers.map(item => [item.login, item.state, item.commit]), [['chatgpt-codex-connector', 'commented', earlier]], 'no summary: its review')
})

test('review threads count those open and resolved, the gravest open one by its badge; a popup lists each open one, where it is and what it says', () => {
  const thread = (resolved, body, more = {}) => ({ isResolved: resolved, isOutdated: false, comments: { nodes: [{ author: codex, body, url: 'https://github.com/org/repo/pull/1#discussion_r1' }] }, ...more })
  const node = { headRefOid: head, reviewThreads: { totalCount: 5, nodes: [thread(true, finding('P0', 'Resolved already')), thread(false, finding('P2', 'Keep the cache')),
    thread(false, finding('P1', 'Paginate commit files'), { path: 'server/a.ts', line: null, originalLine: 12, isOutdated: true }),
    thread(false, 'Why not a `Set`?\n\nIt reads twice.', { path: 'ui/b.js', line: 4, comments: { nodes: [{ author: { login: 'ada', databaseId: 2 }, body: '\nWhy not a `Set`?', url: 'javascript:alert(1)' }] } })] } }
  assert.deepEqual(pullReviews(node, 'author').threads, { open: 3, resolved: 1, more: true, severity: 'p1' }, 'the gravest open one, P1 over P2, the resolved P0 aside')
  assert.deepEqual(pullReviews(node, 'author', true).threads.list, [
    { severity: 'p2', title: 'Keep the cache', path: null, line: null, outdated: false, author: 'chatgpt-codex-connector', authorId: 199175422, url: 'https://github.com/org/repo/pull/1#discussion_r1' },
    { severity: 'p1', title: 'Paginate commit files', path: 'server/a.ts', line: 12, outdated: true, author: 'chatgpt-codex-connector', authorId: 199175422, url: 'https://github.com/org/repo/pull/1#discussion_r1' },
    { severity: null, title: 'Why not a `Set`?', path: 'ui/b.js', line: 4, outdated: false, author: 'ada', authorId: 2, url: null },
  ])
})

test('the fields read for reviews are those GitHub may refuse alone; a popup reads its threads\' places too', () => {
  assert.match(reviewFields(50, false), /headRefOid[^]*latestReviews\(first: 20\) \{ totalCount[^]*reviewRequests\(first: 10\) \{ totalCount[^]*reviewThreads\(last: 50\)[^]*/u)
  assert.match(reviewFields(50, false), /firstComments: comments\(first: 5\)[^]*lastComments: comments\(last: 20\) \{[^]*body createdAt updatedAt \} \}$/u)
  assert.doesNotMatch(reviewFields(50, false), /path line/u)
  assert.match(reviewFields(50, false), /requestedReviewer \{ __typename \.\.\. on User \{ login databaseId \} \.\.\. on Bot \{ login databaseId \}\s+\.\.\. on Mannequin \{ login databaseId \} \.\.\. on Team \{ slug \} \.\.\. on EnterpriseTeam \{ slug \}/u)
  assert.match(reviewFields(100, true), /reviewThreads\(last: 100\) \{ totalCount nodes \{ isResolved isOutdated path line originalLine[^]*body url/u)
  assert.match(reviewFields(100, true), /latestReviews\(first: 20\) \{ totalCount nodes \{[^]*commit \{ oid \} body \} \}/u, 'a popup reads its reviews\' bodies')
  assert.doesNotMatch(reviewFields(50, false).split('reviewRequests')[0], /\bbody\b/u, 'a tile none')
  assert.equal(reviewsRefused({ type: 'FORBIDDEN', path: ['repository', 'page', 'nodes', 0, 'reviewThreads'] }), true)
  assert.equal(reviewsRefused({ type: 'FORBIDDEN', path: ['repository', 'page'] }), false)
  assert.equal(reviewsRefused({ type: 'NOT_FOUND', path: ['repository', 'page', 'nodes', 0, 'lastComments'] }), false)
})
