import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedReviewVerdicts, auditMarkdown, summarizeReview } from '../common/dependency-reviews.js'

const paths = ['a.js', 'b.js', 'c.js', 'd.js']
const entries = [
  { file: 'a.js', status: 'accept', comment: '' },
  { file: 'b.js', status: 'accept-with-nits', comment: 'Rename the variable.' },
  { file: 'c.js', status: 'accept', comment: '' },
  { file: 'd.js', status: null, comment: 'Not checked yet.' },
  { file: null, status: null, comment: 'General note.' },
]
test('three checks out of four remain partial even with whole-diff notes and a final verdict', () => {
  assert.deepEqual(summarizeReview(entries, paths), { coverage: 'partial', checkedFiles: 3, totalFiles: 4, verdictLimit: 'accept-with-nits' })
  assert.deepEqual(allowedReviewVerdicts(entries), ['accept-with-nits', 'request-changes', 'reject'])
  assert.equal(summarizeReview([...entries, { file: null, status: 'accept' }], paths).coverage, 'partial')
  assert.equal(summarizeReview([...entries, { file: 'd.js', status: 'accept' }], paths).coverage, 'full')
  for (const [status, allowed] of [['accept', 4], ['accept-with-nits', 3], ['request-changes', 2], ['reject', 1]]) {
    assert.equal(allowedReviewVerdicts([{ file: 'a.js', status }]).length, allowed)
  }
})

const review = { package: '@scope/pkg', version: '2.0.0', integrity: 'sha512-bytes', basePackage: null, baseVersion: null,
  publishedAt: 100, revokedAt: null, coverage: 'full', status: 'accept', comment: '', entries: [] }
test('audit Markdown formats whole packages, same-package updates and cross-package updates', () => {
  assert.equal(auditMarkdown(review), 'Audited:\n```\n@scope/pkg 2.0.0 sha512-bytes\n```')
  assert.equal(auditMarkdown({ ...review, basePackage: '@scope/pkg', baseVersion: '1.0.0' }), 'Audited:\n```\n@scope/pkg 1.0.0 -> 2.0.0 sha512-bytes\n```')
  assert.equal(auditMarkdown({ ...review, basePackage: 'old', baseVersion: '1.0.0' }), 'Audited:\n```\nold 1.0.0 -> @scope/pkg 2.0.0 sha512-bytes\n```')
})
test('only non-revoked full published accepting reviews have an audit export, including file and final notes', () => {
  for (const patch of [{ publishedAt: null }, { revokedAt: 200 }, { coverage: 'partial' }, { status: 'request-changes' }, { status: 'reject' }]) {
    assert.equal(auditMarkdown({ ...review, ...patch }), null)
  }
  assert.equal(auditMarkdown({ ...review, status: 'accept-with-nits', entries: [{ file: 'src/a.js', comment: 'Keep compatibility.' }], comment: 'Ready to update.' }),
    'Audited:\n```\n@scope/pkg 2.0.0 sha512-bytes\n```\n\nNotes:\n* In src/a.js, Keep compatibility.\n* In the whole diff, Ready to update.')
  assert.match(auditMarkdown({ ...review, entries: [{ file: 'a[1].js', comment: 'Line one\n* another line' }] }), /a\\\[1\\\]\.js, Line one\n  \\\* another line/u)
})
