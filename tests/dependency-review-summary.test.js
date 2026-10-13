import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedReviewVerdicts, auditMarkdown, isReviewableFile, needsPackageJsonReview, npmReviewVerdictLimit, parseReviewNotes, summarizeReview } from '../common/dependency-reviews.js'

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
  { file: null, status: null, comment: 'General note.' },
]
test('partial reviews require a root package.json verdict, while full reviews satisfy coverage', () => {
  const checked = [{ file: 'a.js', status: 'accept' }], files = ['package.json', 'a.js', 'b.js']
  assert.equal(needsPackageJsonReview(checked, files), true)
  for (const file of ['package.json', 'nested/package.json', null]) {
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
    'Audited:\n```\n@scope/pkg 2.0.0 sha512-bytes\n```\n\nNotes:\n* In src/a.js: Keep compatibility.\n* Ready to update.')
})
test('audit notes split star lists, repeat the file prefix, and omit prefixes for whole-diff and final notes', () => {
  const output = auditMarkdown({ ...review, entries: [
    { file: 'crc.js', comment: '* Can we make it faster?\n* Keep the current behavior.' },
    { file: null, comment: '* More notes.\n* Another general note.' },
  ], comment: '* Ready to update.\n* Follow up next week.' })
  assert.equal(output, 'Audited:\n```\n@scope/pkg 2.0.0 sha512-bytes\n```\n\nNotes:\n'
    + '* In crc.js: Can we make it faster?\n* In crc.js: Keep the current behavior.\n'
    + '* More notes.\n* Another general note.\n* Ready to update.\n* Follow up next week.')
})
test('audit notes preserve multiline text and escaping while splitting indented CRLF lists', () => {
  const output = auditMarkdown({ ...review, entries: [
    { file: 'a[1].js', comment: 'Context with a * b.\r\n  * First note\r\ncontinued.\r\n\t* Second `note`.\r\n*   ' },
    { file: null, comment: '   ' },
  ] })
  assert.equal(output, 'Audited:\n```\n@scope/pkg 2.0.0 sha512-bytes\n```\n\nNotes:\n'
    + '* In a\\[1\\].js: Context with a \\* b.\n* In a\\[1\\].js: First note\n  continued.\n* In a\\[1\\].js: Second \\`note\\`.')
  assert.equal(auditMarkdown({ ...review, entries: [{ file: 'crc.js', comment: '*  \n*  ' }] }), auditMarkdown(review))
})
