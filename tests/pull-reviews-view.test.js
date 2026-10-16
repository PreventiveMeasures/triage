import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'
import { knowGithubUsers } from '../ui/view/github-users.js'
import { headReviewed, reviewLine, reviewSections } from '../ui/view/pull-reviews.js'

const earlier = 'b'.repeat(40), head = 'e'.repeat(40)
knowGithubUsers({ users: { 'chatgpt-codex-connector': { agent: 'codex' } } })
const codex = (code, more = {}) => ({ login: 'chatgpt-codex-connector', id: 199175422, code, security: { commit: earlier, status: 'done' }, requested: false, failed: false, ...more })
const counted = (open = 0, severity = null, more = {}) => ({ open, resolved: 0, more: false, severity, ...more })

test('a tile\'s reviews mark each reviewer by how their latest review stands, dimmed where it was on an earlier commit, Codex first by its summary', () => {
  const text = templateText(reviewLine({ head, codex: codex({ commit: head, status: 'done' }), threads: counted(),
    reviewers: [{ login: 'ada', id: 2, state: 'approved', requested: false, commit: earlier, at: 1 }, { login: 'linus', id: 7, state: null, requested: true, commit: null, at: null },
      { login: null, id: null, team: 'security', state: null, requested: true, commit: null, at: null }] }))
  assert.match(text, /class=review-mark is-reviewed><span class="review-glyph" role="img" aria-label=Reviewed, on the latest commit[^]*Codex/u)
  assert.match(text, /class=review-mark is-approved is-stale>[^]*aria-label=Approved, on an earlier commit \(bbbbbbb\)[^]*ada/u)
  assert.match(text, /class=review-mark is-requested>[^]*aria-label=Review requested[^]*linus/u)
  assert.match(text, /@security/u, 'a team by its slug')
  assert.doesNotMatch(text, /Unreviewed/u, 'Codex reviewed the latest commit')
})

test('a tile says its open threads, the gravest by its badge, and that the latest commit is unreviewed where no review is on it', () => {
  const text = templateText(reviewLine({ head, codex: codex({ commit: earlier, status: 'done' }), threads: counted(3, 'p1', { more: true }), reviewers: [] }))
  assert.match(text, /class=review-mark is-reviewed is-stale>/u)
  assert.match(text, /class="review-threads" role="img" aria-label=3\+ open review threads, the gravest P1[^]*<span>3\+<\/span><span class=review-severity is-p1>P1<\/span>/u)
  assert.match(text, /class="review-unreviewed" data-tooltip=No review is on the latest commit>Unreviewed</u)
  assert.match(templateText(reviewLine({ head, codex: null, threads: counted(), reviewers: [] })), /data-tooltip=No reviews yet>Unreviewed</u)
  // Asked again, or failed since, says so over its last review.
  assert.match(templateText(reviewLine({ head, codex: codex({ commit: head, status: 'done' }, { requested: true }), threads: counted(), reviewers: [] })),
    /is-requested>[^]*aria-label=Asked to review again, on the latest commit/u)
  assert.match(templateText(reviewLine({ head, codex: codex({ commit: head, status: 'running' }, { failed: true }), threads: counted(), reviewers: [] })), /is-failed>[^]*Review failed/u)
  assert.equal(reviewLine(null), reviewLine(undefined), 'none read, none')
})

test('the latest commit is reviewed by a review on it, or Codex done with it; one dismissed, or Codex still running, is none', () => {
  const reviewed = (reviewers, code = null) => headReviewed({ head, codex: code ? codex(code) : null, reviewers, threads: counted() })
  assert.equal(reviewed([{ login: 'ada', state: 'commented', commit: head }]), true)
  assert.equal(reviewed([{ login: 'ada', state: 'dismissed', commit: head }]), false)
  assert.equal(reviewed([{ login: 'ada', state: null, requested: true, commit: null }]), false)
  assert.equal(reviewed([], { commit: head, status: 'running' }), false)
  assert.equal(reviewed([], { commit: head, status: 'done' }), true)
})

test('a popup lists each review, Codex\'s code and security reviews apart, on which commit, linked; then each open thread by its badge, title and place', () => {
  const text = templateText(reviewSections({ head, codex: codex({ commit: head, status: 'done' }),
    reviewers: [{ login: 'ada', id: 2, state: 'changes', requested: true, commit: earlier, at: Date.UTC(2026, 9, 14) }],
    threads: { open: 1, resolved: 2, more: false, severity: 'p2', list: [{ severity: 'p2', title: 'Keep the cache', path: 'server/a.ts', line: 12, outdated: true,
      author: 'chatgpt-codex-connector', authorId: 199175422, url: 'https://github.com/org/repo/pull/5#discussion_r1' }] } }, 'org/repo'))
  assert.match(text, /Code review: reviewed<\/span><span class="review-on">on <a href=https:\/\/github\.com\/org\/repo\/commit\/e{40}[^>]*><code>eeeeeee<\/code><\/a>, the latest commit/u)
  assert.match(text, /Security review: reviewed<\/span><span class="review-on">on [^]*<code>bbbbbbb<\/code><\/a>, an earlier commit/u)
  assert.match(text, /ada[^]*Changes requested, requested again[^]*an earlier commit[^]*Oct 14, 2026/u)
  assert.match(text, /<h4>Open threads<\/h4>[^]*href=https:\/\/github\.com\/org\/repo\/pull\/5#discussion_r1[^]*is-p2>P2<[^]*Keep the cache[^]*server\/a\.ts:12[^]*outdated/u)
  assert.match(text, /2 threads resolved\./u)
  assert.doesNotMatch(text, /No review is on the latest commit/u)
  const none = templateText(reviewSections({ head, codex: null, reviewers: [], threads: { open: 0, resolved: 0, more: false, severity: null, list: [] } }, null))
  assert.match(none, /No reviews yet\./u)
  assert.doesNotMatch(none, /Open threads/u, 'no threads, no list')
  const unreviewed = templateText(reviewSections({ head, codex: codex({ commit: earlier, status: 'done' }), reviewers: [], threads: counted() }, null))
  assert.match(unreviewed, /No review is on the latest commit, <code>eeeeeee<\/code>\./u)
  assert.match(unreviewed, /on <code>bbbbbbb<\/code>, an earlier commit/u, 'unlinked where the repository is unnamed')
})
