import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedReviewVerdicts, isReviewableFile, needsPackageJsonReview, npmReviewVerdictLimit, parseReviewNotes, summarizeReview } from '../common/dependency-reviews.js'

test('non-text content on either side is never reviewable and cannot yield full coverage', () => {
  const binary = { format: 'digest', size: 12, digest: 'sha256-binary' }
  for (const [before, after] of [[undefined, binary], [binary, undefined], [binary, binary], [binary, 'text'], ['text', binary], [null, 'text'], [undefined, undefined]]) {
    assert.equal(isReviewableFile(before, after), false)
  }
  for (const [before, after] of [[undefined, ''], ['', undefined], ['', 'text'], ['text', 'updated']]) assert.equal(isReviewableFile(before, after), true)
  const files = ['package.json', 'asset.bin'], nonTextFiles = ['asset.bin']
  const checked = files.map(file => ({ file, status: 'accept' }))
  assert.deepEqual(summarizeReview(checked, files, nonTextFiles), { coverage: 'partial', checkedFiles: 1, totalFiles: 2, verdictLimit: 'accept' })
  assert.equal(summarizeReview(checked.slice(1), files, nonTextFiles).checkedFiles, 0)
  assert.equal(needsPackageJsonReview(checked.slice(1), files, nonTextFiles), true)
  assert.equal(needsPackageJsonReview(checked, files, nonTextFiles), false)
  assert.equal(needsPackageJsonReview(checked, files, ['package.json', 'asset.bin']), true)
  assert.equal(summarizeReview(checked, files, null).coverage, 'partial', 'legacy coverage without type evidence cannot certify a full review')
})

test('security findings constrain only the reviewed version, combined with the strictest file verdict', () => {
  const npm = { version: '2.0.0' }
  const list = (id, severity, affected = [0]) => ({ versions: ['2.0.0', '1.0.0'], advisories: [{ id, severity, affected }] })
  const socket = (...types) => ({ alerts: types.map(type => ({ type })) })
  assert.equal(npmReviewVerdictLimit(npm, null, socket('malware')), 'reject')
  assert.equal(npmReviewVerdictLimit(npm, list('MAL-2026-1', 'critical')), 'reject')
  assert.equal(npmReviewVerdictLimit(npm, list('GHSA-test', 'critical')), 'request-changes')
  assert.equal(npmReviewVerdictLimit(npm, null, socket('criticalCVE')), 'request-changes')
  assert.equal(npmReviewVerdictLimit(npm, list('GHSA-test', 'critical'), socket('malware')), 'reject')
  assert.equal(npmReviewVerdictLimit(npm, list('MAL-2026-1', 'critical', [1])), 'accept', 'fixed findings do not constrain the target')
  assert.equal(npmReviewVerdictLimit(npm, list('GHSA-test', 'high'), socket('networkAccess', 'typosquat')), 'accept')
  assert.equal(npmReviewVerdictLimit(npm, null, { alerts: [], scores: { vulnerability: .25 } }), 'accept', 'aggregate scores are not a critical finding')
  assert.equal(npmReviewVerdictLimit({ ...npm, private: true }, null, socket('malware')), 'accept', 'Socket findings are only for public packages')
  assert.equal(npmReviewVerdictLimit(npm, { status: 'loading' }), 'accept')
  assert.equal(npmReviewVerdictLimit({ version: '0.0.1-security', manifest: { description: 'security holding package', publisher: 'npm' } }), 'reject')
  assert.deepEqual(allowedReviewVerdicts([{ file: 'a.js', status: 'accept' }], 'reject'), ['reject'])
  assert.deepEqual(allowedReviewVerdicts([{ file: 'a.js', status: 'accept-with-nits' }], 'request-changes'), ['request-changes', 'reject'])
  assert.deepEqual(allowedReviewVerdicts([{ file: 'a.js', status: 'reject' }], 'request-changes'), ['reject'])
})

const paths = ['a.js', 'b.js', 'c.js', 'd.js']
const entries = [
  { file: 'a.js', status: 'accept', comment: '' },
  { file: 'b.js', status: 'accept-with-nits', comment: 'Rename the variable.' },
  { file: 'c.js', status: 'accept', comment: '' },
  { file: 'd.js', status: null, comment: 'Not checked yet.' },
]
test('partial reviews require a root package.json verdict, while full reviews satisfy coverage', () => {
  const checked = [{ file: 'a.js', status: 'accept' }], files = ['package.json', 'a.js', 'b.js']
  assert.equal(needsPackageJsonReview(checked, files), true)
  for (const file of ['package.json', 'nested/package.json']) {
    assert.equal(needsPackageJsonReview([...checked, { file, status: null }], files), true)
  }
  assert.equal(needsPackageJsonReview([...checked, { file: 'nested/package.json', status: 'accept' }], files), true)
  for (const status of ['accept', 'accept-with-nits', 'request-changes', 'reject']) {
    assert.equal(needsPackageJsonReview([...checked, { file: 'package.json', status }], files), false)
  }
  assert.equal(needsPackageJsonReview(checked, ['a.js']), false)
  assert.equal(needsPackageJsonReview(checked, ['a.js', 'b.js']), true, 'a partial cannot bypass the requirement by omitting the manifest')
})

test('note parsing recognizes star lists and preserves paragraph text and continuations', () => {
  const comment = 'Context with a * b.\r\n * First\r\ncontinued.\r\n* Second\r\n*   '
  assert.deepEqual(parseReviewNotes(comment), [
    { text: 'Context with a * b.', bullet: false },
    { text: 'First\ncontinued.', bullet: true },
    { text: 'Second', bullet: true },
  ])
  assert.deepEqual(parseReviewNotes('  '), [])
})
test('three checks out of four remain partial with a note on the unchecked file', () => {
  assert.deepEqual(summarizeReview(entries, paths), { coverage: 'partial', checkedFiles: 3, totalFiles: 4, verdictLimit: 'accept-with-nits' })
  assert.deepEqual(allowedReviewVerdicts(entries), ['accept-with-nits', 'request-changes', 'reject'])
  assert.equal(summarizeReview([...entries, { file: 'd.js', status: 'accept' }], paths).coverage, 'full')
  for (const [status, allowed] of [['accept', 4], ['accept-with-nits', 3], ['request-changes', 2], ['reject', 1]]) {
    assert.equal(allowedReviewVerdicts([{ file: 'a.js', status }]).length, allowed)
  }
})
