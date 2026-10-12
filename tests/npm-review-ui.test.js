import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { bundleCompareFiles } from '../ui/view/bundle-compare-inputs.js'
import { compareReviewPaths, reviewLineCounts, reviewViewMode } from '../ui/view/npm-review-files.js'
import { computeBundleDiff } from '../ui/view/bundle-compare-diff.js'

const requests = [], state = {}
let answer = { reviews: [], teams: [] }
let discardConfirmation = { confirmed: false }
const confirmations = []
mock.module('../ui/view/dialogs/discard-review-dialog.js', { namedExports: {
  openDiscardReviewDialog: props => { confirmations.push(props); return Promise.resolve(discardConfirmation) },
} })
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  dependencyReviews: (...args) => { requests.push(args); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) },
  myDependencyReviews: (...args) => { requests.push(args); return Promise.resolve(answer) },
  discardDependencyReview: (...args) => { requests.push(args); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) },
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

test('My reviews discards only unpublished reviews after confirmation and keeps rows on failure', async () => {
  const page = new DependencyReviewList()
  page.session = { id: 'alice', role: 'triage', csrfToken: 'csrf' }
  page._key = 'alice'
  const published = { ...review, id: 'published', publishedAt: 200 }
  page._reviews = [review, published]
  assert.match(text(page._row(review)), />Discard</u)
  assert.doesNotMatch(text(page._row(published)), />Discard</u)
  requests.length = 0
  confirmations.length = 0
  discardConfirmation = { confirmed: false }
  await page._discard(review)
  assert.equal(requests.length, 0)
  assert.equal(page._reviews.length, 2)
  assert.equal(confirmations[0].reviewTitle, '@scope/lib 1.0.0 -> 2.0.0')
  discardConfirmation = { confirmed: true }
  answer = new Error('This review changed or was published in another tab.')
  await page._discard(review)
  assert.match(page._error, /changed or was published/u)
  assert.equal(page._reviews.length, 2)
  assert.equal(page._discarding, null)
  answer = { ok: true }
  await page._discard(review)
  assert.deepEqual(requests.at(-1).slice(0, 3), ['review', 1, 'csrf'])
  assert.deepEqual(page._reviews, [published])
  const count = requests.length, prompts = confirmations.length
  for (const row of [published, { ...published, revokedAt: 300 }, { ...review, user: 'bob' }]) await page._discard(row)
  page.session.role = 'view'
  await page._discard(review)
  assert.equal(requests.length, count)
  assert.equal(confirmations.length, prompts)
})

test('discard confirmation cannot delete a review after leaving My reviews', async () => {
  const page = new DependencyReviewList()
  page.session = { id: 'alice', role: 'triage', csrfToken: 'csrf' }
  page._reviews = [review]
  let resolve
  discardConfirmation = new Promise(done => { resolve = done })
  requests.length = 0
  const pending = page._discard(review)
  page.disconnectedCallback()
  resolve({ confirmed: true })
  await pending
  assert.equal(requests.length, 0)
  assert.deepEqual(page._reviews, [review])
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
  assert.doesNotMatch(text(page._confirmation(review)), /Only teams|Select at least one team/u, 'nothing said under the teams while one is selected')
  page._selectedTeams = new Set()
  assert.match(text(page._confirmation(review)), /Select at least one team to publish\./u)
  page._selectedTeams = new Set(['two'])
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

test('file navigation preserves unsaved edits and advances their revisions as files are saved', async () => {
  const page = component()
  page._files = ['index.js', 'other.js']
  page._resetEditor('index.js')
  page._comment = 'Keep this unsaved edit'
  page._selectFile('other.js')
  assert.equal(page._dirty, false)
  assert.equal(page._unsaved, true)
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
  await page._save()
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

test('autosaves allow editing and file navigation, preserving newer notes after the response', async () => {
  const page = component(), pending = Promise.withResolvers()
  page._files = ['index.js', 'other.js']; page._path = 'index.js'; page._resetEditor('index.js')
  answer = pending.promise
  const saving = page._setFileStatus('index.js', 'accept-with-nits')
  assert.equal(page._blocked, false)
  page._editFile('index.js', { _comment: 'Typed during the save' })
  page._selectFile('other.js')
  assert.equal(page._path, 'other.js')
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept-with-nits' }] } })
  await saving
  assert.equal(page._path, 'other.js')
  page._selectFile('index.js')
  assert.equal(page._status, 'accept-with-nits')
  assert.equal(page._comment, 'Typed during the save')
  assert.equal(page._editRevision, 2)
  assert.equal(page._dirty, true)
})

test('rapid verdict changes save serially with updated revisions, including reverting to Not checked', async () => {
  const first = Promise.withResolvers(), page = component(), second = Promise.withResolvers()
  page._reviews = []; page._resetEditor('other.js'); requests.length = 0
  answer = first.promise
  const accepting = page._setFileStatus('other.js', 'accept')
  const clearing = page._setFileStatus('other.js', '')
  assert.equal(requests.length, 1)
  assert.equal(page._unsaved, true)
  const created = { ...review, entries: [{ ...file, id: 'other', file: 'other.js', status: 'accept', comment: '' }] }
  answer = second.promise
  first.resolve({ review: created })
  await accepting
  assert.equal(page._status, '', 'the earlier save does not revert the latest selection')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1][1], { action: 'save', reviewId: 'review', revision: 1, entryId: 'other', file: 'other.js', comment: '', status: null })
  second.resolve({ review: { ...created, revision: 2, entries: [{ ...created.entries[0], status: null }] } })
  await clearing
  assert.equal(page._unsaved, false)
  assert.equal(page._status, '')
})

test('only saves pending for three seconds block editing, and completion clears the block', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = component(), pending = Promise.withResolvers()
  page._resetEditor('index.js'); answer = pending.promise
  const saving = page._setFileStatus('index.js', 'accept')
  t.mock.timers.tick(2999)
  assert.equal(page._blocked, false)
  t.mock.timers.tick(1)
  assert.equal(page._blocked, true)
  await page._setFileStatus('index.js', 'reject')
  assert.equal(page._status, 'accept', 'edits stop once the slow-save block appears')
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept' }] } })
  await saving
  assert.equal(page._blocked, false)
  t.mock.timers.tick(3000)
  assert.equal(page._blocked, false)
})

test('fast saves cancel their timer without blocking a newer save', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = Promise.withResolvers(), page = component(), second = Promise.withResolvers()
  page._resetEditor('index.js'); answer = first.promise
  const accepting = page._setFileStatus('index.js', 'accept')
  t.mock.timers.tick(2000)
  const rejecting = page._setFileStatus('index.js', 'reject')
  answer = second.promise
  first.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept' }] } })
  await accepting
  t.mock.timers.tick(1000)
  assert.equal(page._blocked, false, 'the completed request cannot block its successor')
  second.resolve({ review: { ...review, revision: 3, entries: [{ ...file, status: 'reject' }] } })
  await rejecting
  t.mock.timers.tick(3000)
  assert.equal(page._blocked, false)
})

test('a failed save cancels queued requests and retains the latest edits for retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = component(), pending = Promise.withResolvers()
  page._files = ['index.js', 'other.js']; page._resetEditor('index.js'); requests.length = 0
  answer = pending.promise
  const first = page._setFileStatus('index.js', 'accept')
  const second = page._setFileStatus('other.js', 'reject')
  page._editFile('other.js', { _comment: 'Keep this note' })
  t.mock.timers.tick(3000)
  pending.reject(new Error('Connection lost'))
  await Promise.all([first, second])
  assert.equal(requests.length, 1, 'queued requests stop on error')
  assert.equal(page._blocked, false)
  assert.equal(page._error, 'Connection lost')
  assert.equal(page._editorState('index.js').status, 'accept')
  assert.equal(page._editorState('other.js').status, 'reject')
  assert.equal(page._comment, 'Keep this note')
  assert.equal(page._unsaved, true)
  t.mock.timers.tick(3000)
  assert.equal(page._blocked, false)
})

test('canceling pending saves clears timers and ignores obsolete responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = component(), pending = Promise.withResolvers()
  page._resetEditor('index.js'); answer = pending.promise
  const saving = page._setFileStatus('index.js', 'accept')
  page._cancelSaves()
  assert.equal(await saving, null)
  t.mock.timers.tick(3000)
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept' }] } })
  await Promise.resolve()
  assert.equal(page._blocked, false)
  assert.equal(page._activeReview.revision, 1)
})

test('a response never changes the displayed frozen review or discards pending private edits', async () => {
  const page = component(), pending = Promise.withResolvers(), published = { ...review, id: 'published', publishedAt: 200 }
  page._reviews = [review, published]; page._path = 'index.js'; page._resetEditor('index.js')
  answer = pending.promise
  const saving = page._setFileStatus('index.js', 'accept-with-nits')
  page._editFile('index.js', { _comment: 'Still private' })
  page._showPublished(published)
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept-with-nits' }] } })
  await saving
  assert.equal(page._shownReview.id, 'published')
  assert.equal(page._shownReview.entries[0].status, 'request-changes')
  page._resume()
  assert.equal(page._comment, 'Still private')
  assert.equal(page._editRevision, 2)
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

test('leaving a note saves its file without changing the active editor, and unchanged notes need no save', async () => {
  const page = component()
  page._files = ['index.js', 'other.js']; page._resetEditor('index.js')
  page._comment = 'Save on blur'
  assert.doesNotMatch(text(page._editor()), /Save notes|Save &amp; next|Discard changes|Visible only to you until published/u)
  page._selectFile('other.js')
  answer = { review: { ...review, revision: 2, entries: [{ ...file, comment: 'Save on blur' }] } }
  requests.length = 0
  await page._saveFile('index.js')
  assert.equal(requests[0][1].comment, 'Save on blur')
  assert.equal(page._file, 'other.js')
  assert.equal(page._unsaved, false)
  await page._saveFile('index.js')
  assert.equal(requests.length, 1, 'focusing and leaving an unchanged note does not create a save')
})

test('Finalize saves a focused note before opening confirmation with the saved revision', async () => {
  const page = component(), pending = Promise.withResolvers()
  page._files = ['index.js']; page._resetEditor('index.js'); page._comment = 'Save when finalizing'
  answer = pending.promise; requests.length = 0
  const finalizing = page._beginPublish()
  assert.equal(page._publishStep, false)
  assert.equal(requests[0][1].comment, 'Save when finalizing')
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, comment: 'Save when finalizing' }] } })
  await finalizing
  assert.equal(page._panel, 'publish')
  assert.equal(page._publishRevision, 2)
  assert.equal(page._finalStatus, 'request-changes')
  assert.equal(page._unsaved, false)
})

test('blur followed by Finalize waits for the same save instead of saving the note twice', async () => {
  const page = component(), pending = Promise.withResolvers()
  page._files = ['index.js']; page._resetEditor('index.js'); page._comment = 'Only save once'
  answer = pending.promise; requests.length = 0
  const blurred = page._saveFile('index.js'), duplicate = page._saveFile('index.js'), finalizing = page._beginPublish()
  assert.equal(requests.length, 1)
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, comment: 'Only save once' }] } })
  await Promise.all([blurred, duplicate, finalizing])
  assert.equal(requests.length, 1)
  assert.equal(page._panel, 'publish')
})

test('Finalize saves all pending notes and uses the resulting verdict limit', async () => {
  const first = Promise.withResolvers(), page = component(), second = Promise.withResolvers()
  page._files = ['index.js', 'other.js']; page._resetEditor('index.js'); page._comment = 'First note'
  page._selectFile('other.js'); page._comment = 'Second note'; page._status = 'reject'
  answer = first.promise; requests.length = 0
  const finalizing = page._beginPublish()
  answer = second.promise
  first.resolve({ review: { ...review, revision: 2, entries: [{ ...file, comment: 'First note' }] } })
  await first.promise
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(page._publishStep, false)
  second.resolve({ review: { ...review, revision: 3, entries: [{ ...file, comment: 'First note' }, { ...file, id: 'other', file: 'other.js', status: 'reject', comment: 'Second note' }] } })
  await finalizing
  assert.equal(requests.length, 2)
  assert.equal(requests[1][1].revision, 2)
  assert.equal(page._file, 'other.js', 'saving other notes does not change the active editor')
  assert.equal(page._publishRevision, 3)
  assert.equal(page._finalStatus, 'reject')
})

test('a failed note save keeps Finalize out of confirmation and can be retried', async () => {
  const page = component()
  page._files = ['index.js']; page._resetEditor('index.js'); page._comment = 'Keep on failure'
  answer = new Error('Connection lost')
  await page._beginPublish()
  assert.equal(page._publishStep, false)
  assert.equal(page._comment, 'Keep on failure')
  assert.equal(page._error, 'Connection lost')
  answer = { review: { ...review, revision: 2, entries: [{ ...file, comment: 'Keep on failure' }] } }
  await page._beginPublish()
  assert.equal(page._panel, 'publish')
})

test('a blank new note does not block finalization or create an empty row', async () => {
  const page = component()
  page._files = ['index.js']; page._resetEditor(null); page._comment = '   '
  requests.length = 0
  await page._beginPublish()
  assert.equal(requests.length, 0)
  assert.equal(page._panel, 'publish')
  assert.equal(page._unsaved, false)
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
