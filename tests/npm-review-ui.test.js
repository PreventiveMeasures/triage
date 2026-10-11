import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { bundleCompareFiles } from '../ui/view/bundle-compare-inputs.js'
import { compareReviewPaths, reviewLineCounts, reviewViewMode } from '../ui/view/npm-review-files.js'
import { computeBundleDiff } from '../ui/view/bundle-compare-diff.js'

const requests = [], state = {}
let answer = { reviews: [], teams: [] }
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  dependencyReviews: (...args) => { requests.push(args); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) },
  myDependencyReviews: (...args) => { requests.push(args); return Promise.resolve(answer) },
} })
mock.module('../ui/view/npm-package.js', { namedExports: {
  loadNpmVersion() {}, npmCompareSource: () => ({ choices: [], options: [] }),
  npmPackageRoute: (entry, tab, location) => ({ view: 'npm', packageName: entry.npm.name, packageSpec: entry.npm.version, bundleTab: tab, ...location }),
  parseNpmPackageInput() {},
} })
mock.module('../ui/view/managed-history.js', { namedExports: { managedHistory: null } })
mock.module('../ui/view/bundle-compare.js', { namedExports: {} })
mock.module('../ui/view/npm-review-code.js', { namedExports: {} })
mock.module('../ui/view/bundle-compare-all.js', { namedExports: {} })
mock.module('../ui/view/npm-review-diff.js', { namedExports: {} })
mock.module('../ui/view/bundle-selector.js', { namedExports: {} })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, key, render) => items.map(render) } })
const { NpmReview, reviewContext } = await import('../ui/view/npm-review.js')
const { DependencyReviewList, dependencyReviewRoute } = await import('../ui/view/dependency-review-list.js')
const { ReviewAuditCopy } = await import('../ui/view/review-audit-copy.js')
const { NpmReviewTree, reviewTree } = await import('../ui/view/npm-review-tree.js')
const { reviewFileStates, reviewTitle, selectReviewOnOpen } = await import('../ui/view/npm-review-presentation.js')

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((str, i) => str + text(value.values[i])).join('')
  return value == null || typeof value === 'symbol' || typeof value === 'function' ? '' : String(value)
}
const entry = { integrity: 'sha512-new', npm: { name: '@scope/lib', version: '2.0.0' } }
const base = { integrity: 'sha512-old', npm: { name: '@scope/lib', version: '1.0.0' } }
const context = reviewContext(entry, base)
const file = { id: 'file', file: 'index.js', comment: 'A note', status: 'request-changes', time: 100 }
const review = { ...context, id: 'review', user: 'alice', userLogin: 'Alice', revision: 1, time: 100,
  publishedAt: null, revokedAt: null, entries: [file], teams: [], comment: '', status: null }
function component() {
  const page = new NpmReview()
  page.session = { id: 'alice', role: 'triage', csrfToken: 'csrf' }
  page.entry = entry
  page._context = context
  page._key = JSON.stringify(['alice', 'triage', context])
  page._reviews = [review]
  return page
}

test('review URLs round trip scoped dependencies, version-only shorthand and Diff mode', () => {
  assert.equal(managedRoutePath(parseManagedRoute(new URL('https://test/reviews'))), '/reviews')
  for (const path of ['/npm/lib@2.0.0/review', '/npm/@scope/lib@2.0.0/review/@scope/lib@1.0.0',
    '/npm/@scope/lib/review/@other/base@next?mode=diff']) {
    const parsed = parseManagedRoute(new URL(path, 'https://test'))
    assert.equal(parsed.bundleTab, 'review')
    assert.equal(managedRoutePath(parsed), path)
  }
  const shorthand = parseManagedRoute(new URL('https://test/npm/lib@2.0.0/review/1.0.0'))
  assert.equal(managedRoutePath(shorthand), '/npm/lib@2.0.0/review/lib@1.0.0')
  assert.equal(parseManagedRoute(new URL('https://test/npm/lib@2/review/@bad')), null)
  assert.equal(parseManagedRoute(new URL('https://test/npm/lib@2/review/lib@%3Cscript%3E')), null)
  assert.deepEqual(reviewContext(entry, {}), { ...context, basePackage: null, baseVersion: null, baseIntegrity: null })
})

test('My reviews lists each frozen set and its final verdict, with copy restricted to eligible sets', async () => {
  const page = new DependencyReviewList()
  const partial = { ...review, id: 'partial', publishedAt: 200, coverage: 'partial', checkedFiles: 3, totalFiles: 4, status: 'accept-with-nits', comment: 'One remains.' }
  const full = { ...partial, id: 'full', coverage: 'full', checkedFiles: 4 }
  answer = { reviews: [partial, full], next: { time: 100, id: 'partial' } }
  await page._load()
  assert.equal(page._reviews.length, 2)
  assert.match(text(page._row(partial)), /Partial · 3\/4 files checked/u)
  assert.match(text(page._row(partial)), /Accept with nits/u)
  assert.match(text(page._row(full)), /Full · 4\/4 files checked/u)
  assert.equal(managedRoutePath(dependencyReviewRoute(full)), '/npm/@scope/lib@2.0.0/review/@scope/lib@1.0.0')
  answer = { reviews: [{ ...review, id: 'older' }], next: null }
  await page._load(true)
  assert.equal(requests.at(-1)[0].id, 'partial')
  assert.equal(page._reviews.length, 3)
  const copy = new ReviewAuditCopy()
  copy.review = partial
  assert.equal(text(copy.render()), '')
  copy.review = full
  assert.match(text(copy.render()), /Copy audit Markdown/u)
  copy.review = { ...full, revokedAt: 300 }
  assert.equal(text(copy.render()), '')
})

test('only a sole eligible team is selected initially; Publish requires at least one and saved changes', async () => {
  const page = component()
  answer = { reviews: [review], teams: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] }
  await page._refresh(true)
  assert.deepEqual([...page._selectedTeams], [])
  answer = { reviews: [review], teams: [{ id: 'two', name: 'Two' }] }
  await page._refresh(true)
  assert.deepEqual([...page._selectedTeams], ['two'])
  page._teams = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]
  page._selectedTeams = new Set()
  requests.length = 0
  await page._publish()
  assert.equal(requests.length, 0)
  page._selectedTeams = new Set(['two'])
  page._comment = 'Unsaved'
  await page._publish()
  assert.equal(requests.length, 0)
  page._comment = ''
  page._files = ['index.js', 'second.js']
  page._beginPublish()
  assert.equal(page._finalStatus, 'request-changes')
  assert.match(text(page._confirmation(review)), /Partial review/u)
  page._finalStatus = 'accept'
  await page._publish()
  assert.equal(requests.length, 0, 'final verdict cannot override file concerns')
  page._finalStatus = 'request-changes'
  page._finalComment = 'Check the second file too.'
  const published = { ...review, publishedAt: 200, revision: 2, status: 'request-changes', coverage: 'partial', checkedFiles: 1, totalFiles: 2, teams: [{ id: 'two', name: 'Two' }] }
  answer = { review: published }
  await page._publish()
  assert.deepEqual(requests[0][1], { action: 'publish', reviewId: 'review', revision: 1, teamIds: ['two'], finalStatus: 'request-changes', finalComment: 'Check the second file too.' })
  assert.equal(page._canEdit, false)
  assert.match(text(page._published(published)), /Continue in a new review/u)
  assert.doesNotMatch(text(page._editor(base)), /<textarea/u, 'no editor for a published set')
  assert.match(text(page._published(published, null)), /Publish to more teams/u)
  assert.match(text(page._published(published, null)), /Revoke/u)
  assert.doesNotMatch(text(page._published({ ...published, revokedAt: 300 }, null)), /Publish to more teams/u)
  assert.match(text(page._published({ ...published, revokedAt: 300 }, null)), /Revoked/u)
})

test('a review without a base compares every package file against an empty package', async () => {
  const page = component()
  page.details = { kind: 'sourcemap', npm: entry.npm,
    json: { version: 3, sources: ['index.js', 'empty.txt', 'image.png'], sourcesContent: ['export const n = 1', '', null] },
    npmBinaries: new Map([['image.png', { digest: 'sha256-image', size: 20 }]]) }
  answer = { reviews: [], teams: [] }
  await page._loadBase('(empty)')
  const empty = page._base
  const diff = computeBundleDiff(bundleCompareFiles(empty), bundleCompareFiles(page.details), () => '.')
  assert.deepEqual(diff.files.onlyOther.map(row => row.path).toSorted(), ['empty.txt', 'image.png', 'index.js'])
  assert.deepEqual(diff.files.onlyBase, [])
  assert.deepEqual(diff.files.changed, [])
  assert.equal(reviewContext(entry, empty).basePackage, null)
})

test('review file kinds distinguish a moved comparison root from a renamed file', () => {
  const page = component()
  const sources = (paths, contents) => ({ kind: 'sourcemap', json: { version: 3, sources: paths, sourcesContent: contents } })
  page._key = null
  page.details = sources(['lib/index.js', 'lib/helper.ts'], ['new entry', 'helper'])
  answer = { reviews: [], teams: [] }
  page._ensureContext({ ...sources(['index.js', 'helper.js'], ['old entry', 'helper']), ...base })
  assert.deepEqual(page._treeFiles.map(({ path, kind }) => ({ path, kind })), [{ path: 'lib/helper.ts', kind: 'renamed' }, { path: 'lib/index.js', kind: 'changed' }])
})

test('editing captures the loaded revision, and continuing uses a separate review', async () => {
  const page = component()
  page._resetEditor('index.js')
  page._reviews = [{ ...review, revision: 2 }]
  page._comment = 'An edit against revision one'
  answer = { review: { ...review, revision: 3 } }
  requests.length = 0
  await page._save()
  assert.equal(requests[0][1].revision, 1, 'a later refresh cannot silently overwrite a concurrent edit')
  const published = { ...review, publishedAt: 200, revision: 4 }
  page._reviews = [published]
  const continued = { ...review, id: 'new-review', entries: [{ ...file, id: 'new-file' }] }
  answer = { review: continued }
  await page._change({ action: 'continue', reviewId: 'review', revision: 4 })
  assert.equal(page._activeReview.id, 'new-review')
  assert.equal(page._canEdit, true)
  assert.equal(page._reviews.find(row => row.id === 'review').publishedAt, 200)
})

test('file navigation preserves unsaved edits and publication stays blocked until every edit is saved', async () => {
  const page = component()
  page._files = ['index.js', 'other.js']
  page._resetEditor('index.js')
  page._comment = 'Keep this unsaved edit'
  page._selectFile('other.js')
  assert.equal(page._dirty, false)
  assert.equal(page._unsaved, true)
  await page._beginPublish()
  assert.equal(page._publishStep, false)
  page._status = 'accept'
  page._selectFile('index.js')
  assert.equal(page._comment, 'Keep this unsaved edit')
  answer = { review: { ...review, revision: 2, entries: [{ ...file, comment: page._comment }] } }
  await page._save()
  page._selectFile('other.js')
  assert.equal(page._status, 'accept')
  assert.equal(page._editRevision, 2, 'our save advances the revision of our other pending changes')
  page._status = ''
  assert.equal(page._unsaved, false, 'reverting a restored edit does not leave a stale unsaved marker')
})

test('a failed save preserves the editor and does not move to the next file', async () => {
  const page = component()
  page._files = ['index.js', 'other.js']; page._path = 'index.js'
  page._resetEditor('index.js'); page._comment = 'Do not lose this'
  answer = new Error('Review changed in another tab')
  await page._save(true)
  assert.equal(page._path, 'index.js')
  assert.equal(page._comment, 'Do not lose this')
  assert.equal(page._dirty, true)
  assert.equal(page._error, 'Review changed in another tab')
})

test('viewing a frozen set never loads or overwrites private unsaved buffers', () => {
  const page = component(), published = { ...review, id: 'published', publishedAt: 200, status: 'request-changes' }
  page._reviews = [review, published]; page._files = ['index.js', 'other.js']; page._path = 'index.js'
  page._resetEditor('index.js'); page._comment = 'Private pending note'
  page._showPublished(published)
  page._selectFile('other.js'); page._selectFile('index.js')
  assert.equal(page._canEdit, false)
  assert.equal(page._comment, 'A note', 'the frozen file shows its saved content')
  assert.equal(page._unsaved, true, 'changing comparison cannot discard a private edit while its frozen file is shown')
  assert.doesNotMatch(text(page._editor()), /<textarea/u)
  page._resume()
  assert.equal(page._comment, 'Private pending note')
  assert.equal(page._canEdit, true)
})

test('opening a specific published list row selects that snapshot even with an active review', async () => {
  const page = component(), published = { ...review, id: 'published', publishedAt: 200 }
  selectReviewOnOpen(published)
  answer = { reviews: [review, published], teams: [] }
  await page._refresh()
  assert.equal(page._shownReview.id, 'published')
  assert.equal(page._canEdit, false)
})

test('dense file tree counts verdicts rather than notes and bounds the initial DOM for large packages', () => {
  const entries = [file, { ...file, id: 'note', file: 'other.js', status: null }]
  const states = reviewFileStates(entries)
  assert.equal(states.get('index.js').status, 'request-changes')
  assert.equal(states.get('other.js').status, null)
  const files = Array.from({ length: 10000 }, (_, i) => ({ path: `src/file-${String(i).padStart(5, '0')}.js`, kind: 'added' }))
  const tree = reviewTree([...files, { path: 'index.js', kind: 'added' }, { path: 'other.js', kind: 'added' }], states)
  assert.equal(tree.checked, 1); assert.equal(tree.total, 10002)
  const treeView = new NpmReviewTree()
  treeView.files = files; treeView.states = new Map(); treeView.path = files[0].path
  treeView.willUpdate(new Map([['files', []], ['states', new Map()], ['path', null]]))
  assert.equal((text(treeView.render()).match(/class="npm-review-tree-file"/gu) ?? []).length, 299)
  treeView._query = 'file-09999'
  assert.match(text(treeView.render()), /file-09999.js/u)
  assert.doesNotMatch(text(treeView.render()), /file-00000.js/u)
})


test('verdict selection autosaves in place and keeps other files pending edits', async () => {
  const page = component()
  page._mode = 'diff'; page._files = ['index.js', 'other.js']; page._path = 'index.js'
  page._resetEditor('index.js'); page._comment = 'Pending note on the first file'
  answer = { review: { ...review, revision: 2, entries: [...review.entries, { ...file, id: 'other', file: 'other.js', status: 'accept', comment: '' }] } }
  requests.length = 0
  await page._setFileStatus('other.js', 'accept')
  assert.equal(requests[0][1].file, 'other.js')
  assert.equal(requests[0][1].status, 'accept')
  assert.equal(page._mode, 'diff')
  assert.equal(page._path, 'index.js', 'saving does not navigate or scroll the whole diff')
  assert.equal(page._editorState('index.js').comment, 'Pending note on the first file')
  assert.equal(page._editorState('index.js').dirty, true)
  assert.equal(page._editorState('other.js').dirty, false)
  answer = new Error('Review changed in another tab')
  await page._setFileStatus('other.js', 'reject')
  assert.equal(page._editorState('other.js').status, 'reject')
  assert.equal(page._editorState('other.js').dirty, true, 'failed autosaves remain available to retry')
})

test('finalization requires at least one checked changed file, not just a note', () => {
  const page = component()
  page._files = ['index.js']
  for (const entries of [[], [{ ...file, status: null }], [{ ...file, file: 'unrelated.js' }]]) {
    page._reviews = [{ ...review, entries }]
    page._beginPublish()
    assert.equal(page._panel, null)
  }
  page._reviews = [review]
  page._beginPublish()
  assert.equal(page._panel, 'publish')
})

test('review file order is directories first at every depth and line counts reflect additions and removals', () => {
  const files = ['index.js', 'z/a.js', 'a.js', 'a/z.js', 'a/nested/b.js', 'z/b.js']
  assert.deepEqual(files.toSorted(compareReviewPaths), ['a/nested/b.js', 'a/z.js', 'z/a.js', 'z/b.js', 'a.js', 'index.js'])
  assert.deepEqual(reviewLineCounts({ before: '', after: 'one\ntwo\n' }), { additions: 2, deletions: 0 })
  assert.deepEqual(reviewLineCounts({ before: 'one\ntwo', after: 'one\nthree' }), { additions: 1, deletions: 1 })
  assert.deepEqual(reviewLineCounts({ before: 'gone\n', after: '' }), { additions: 0, deletions: 1 })
  assert.equal(reviewLineCounts({ before: '', after: { format: 'digest' } }), null)
})


test('review drawers identify the entire version comparison', () => {
  assert.equal(reviewTitle(context), '@scope/lib 1.0.0 -> 2.0.0')
  assert.equal(reviewTitle({ ...context, basePackage: '@old/lib' }), '@old/lib 1.0.0 -> @scope/lib 2.0.0')
  assert.equal(reviewTitle({ ...context, basePackage: null }), '@scope/lib 2.0.0')
})

test('review automatically uses whole diff below both line and byte limits', () => {
  assert.equal(reviewViewMode([{ before: '', after: 'a\n'.repeat(49_999) }]), 'diff')
  assert.equal(reviewViewMode([{ before: 'a\n'.repeat(25_000), after: 'b\n'.repeat(25_000) }]), 'code')
  assert.equal(reviewViewMode([{ before: '', after: 'x'.repeat(2 * 1024 * 1024 - 1) }]), 'diff')
  assert.equal(reviewViewMode([{ before: 'x'.repeat(1024 * 1024), after: 'x'.repeat(1024 * 1024) }]), 'code')
  assert.equal(reviewViewMode([{ before: '', after: 'é'.repeat(1024 * 1024) }]), 'code', 'the limit measures UTF-8 bytes')
  assert.equal(reviewViewMode([{ before: '', after: { format: 'digest', size: 2 * 1024 * 1024 } }]), 'code')
})
