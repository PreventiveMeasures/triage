import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { bundleCompareFiles } from '../ui/view/bundle-compare-inputs.js'
import { withinComparisonLimits } from '../ui/view/bundle-compare-files.js'
import { computeBundleDiff } from '../ui/view/bundle-compare-diff.js'

const requests = [], state = {}
let answer = { reviews: [], teams: [] }
let latestAnswer = null
const latestRequests = [], loadedBases = []
let discardConfirmation = { confirmed: false }
const confirmations = []
const loadingToasts = []
const navigations = []
mock.module('../ui/view/toast.js', { namedExports: { showToast: (message, options) => {
  const toast = { message, options, dismissed: false }; loadingToasts.push(toast)
  return () => { toast.dismissed = true }
} } })
mock.module('../ui/view/dialogs/discard-review-dialog.js', { namedExports: {
  openDiscardReviewDialog: props => { confirmations.push(props); return Promise.resolve(discardConfirmation) },
} })
mock.module('../client/index.js', { namedExports: { state } })
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchPrettyBundleChanges() {}, fetchPrettyBundleFile() {}, fetchPrettyNpmChanges() {}, fetchPrettyNpmFile() {}, fetchPrettyNpmFiles() {}, fetchBundleRenameDiff() {}, fetchNpmRenameDiff() {}, fetchBundleRenameDiffs() {}, fetchNpmRenameDiffs() {}, fetchBundleTypeOnly() {}, fetchNpmTypeOnly() {},
  dependencyReviews: (...args) => { requests.push(args); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) },
  myDependencyReviews: (...args) => { requests.push(args); return Promise.resolve(answer) },
  discardDependencyReview: (...args) => { requests.push(args); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) },
  latestDependencyReview: (...args) => { latestRequests.push(args); return latestAnswer instanceof Error ? Promise.reject(latestAnswer) : Promise.resolve(latestAnswer) },
} })
mock.module('../ui/view/npm-compare-source.js', { namedExports: { npmComparisonSource: () => ({ choices: [], options: [] }) } })
mock.module('../ui/view/npm-package.js', { namedExports: {
  loadNpmVersion: (name, version) => { loadedBases.push([name, version]); return Promise.resolve({ details: base }) }, npmCompareSource: () => ({ choices: [], options: [] }),
  npmPackageRoute: (entry, tab, location) => ({ view: 'npm', packageName: entry.npm.name, packageSpec: entry.npm.version, bundleTab: tab, ...location }),
  parseNpmPackageInput: input => ({ name: input.slice(0, input.lastIndexOf('@')), spec: input.slice(input.lastIndexOf('@') + 1) }),
} })
mock.module('../ui/view/managed-history.js', { namedExports: { managedHistory: {
  navigate: route => { navigations.push(route) }, replaceRoute: () => {},
} } })
mock.module('../ui/view/bundle-compare.js', { namedExports: {} })
mock.module('../ui/view/bundle-code-splitter.js', { namedExports: {} })
mock.module('../ui/view/bundle-selector.js', { namedExports: {} })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, key, render) => items.map(render) } })
const { EMPTY_REVIEW_BASE, NpmReview, REVIEW_DISPLAY_LIMITS, reviewContext } = await import('../ui/view/npm-review.js')
const { renderReview, renderReviewEditor, renderReviewConfirmation, renderReviewEntry, reviewExtensions } = await import('../ui/view/npm-review-view.js')
const { DependencyReviewList, dependencyReviewRoute } = await import('../ui/view/dependency-review-list.js')
const { ReviewAuditCopy } = await import('../ui/view/review-audit-copy.js')
const { BundleCompareCode } = await import('../ui/view/bundle-compare-code.js')
const { reviewFileStates, reviewNote, reviewTitle, selectReviewOnOpen } = await import('../ui/view/npm-review-presentation.js')

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((str, i) => str + text(value.values[i])).join('')
  if (value?._$litDirective$) {
    const [first] = value.values
    if (first && typeof first === 'object' && !Array.isArray(first) && !first.strings) return Object.entries(first).filter(([, on]) => on).map(([name]) => name).join(' ')
    return text(first)
  }
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

test('non-text files stay visible and unchecked in both review modes, with disabled verdicts and editable notes', async () => {
  const page = component()
  page.details = { ...entry, kind: 'sourcemap', json: { sources: ['package.json', 'index.js'], sourcesContent: ['{}', 'new text'] },
    npmBinaries: new Map([['asset.bin', { size: 24, digest: 'sha256-new' }]]) }
  page._base = { ...base, kind: 'sourcemap', json: { sources: ['package.json'], sourcesContent: ['old'] },
    npmBinaries: new Map([['index.js', { size: 12, digest: 'sha256-old' }]]) }
  const saved = { ...review, entries: ['package.json', 'asset.bin', 'index.js'].map((path, i) => ({ ...file, id: String(i), file: path, status: 'accept', comment: '' })) }
  answer = { reviews: [saved], teams: [] }
  page._key = null
  page._ensureContext(page._base)
  await Promise.resolve()
  assert.deepEqual(page._files, ['asset.bin', 'index.js', 'package.json'])
  assert.deepEqual(page._nonTextFiles, ['asset.bin', 'index.js'], 'a binary-to-text change remains non-reviewable')
  assert.deepEqual(page._summary, { coverage: 'partial', checkedFiles: 1, totalFiles: 3, verdictLimit: 'accept' })
  assert.match(text(reviewExtensions(page).filters), /Unchecked 2/u)
  for (const mode of ['code', 'diff']) {
    page._mode = mode
    page._selectFile('asset.bin')
    assert.equal(page._editorState(page._file).dirty, false, 'a previously saved binary verdict is ignored without creating a new edit')
    const editor = text(renderReviewEditor(page, 'asset.bin', mode === 'diff'))
    assert.equal((editor.match(/\?disabled=true/gu) ?? []).length, 5, 'all verdict controls, including Not checked, are disabled')
    assert.match(editor, /Non-text file.*remains unchecked/u)
    assert.match(editor, /aria-label="File note"/u)
    requests.length = 0
    for (const status of ['accept', 'accept-with-nits', 'request-changes', 'reject']) await page._setFileStatus('asset.bin', status)
    assert.equal(requests.length, 0)
    assert.equal(page._editorState(page._file).status, '')
  }
  const comment = '* Still visible\n* External inspection needed'
  answer = { review: { ...saved, revision: 2, entries: saved.entries.map(row => row.file === 'asset.bin' ? { ...row, comment, status: null } : row) } }
  page._editFile('asset.bin', { comment: comment })
  await page._saveFile('asset.bin')
  assert.equal(requests.at(-1)[1].status, null)
  assert.equal(requests.at(-1)[1].comment, comment)
  assert.equal(page._unsaved, false)
  assert.equal(page._summary.coverage, 'partial')
  assert.match(text(renderReviewConfirmation(page, page._activeReview)), /1 of 3 files checked/u)
})

test('Review uses the current comparison source for badges, dependency chips, and file alerts in both diff modes', () => {
  const called = [], dependencyCalls = [], dependencyTags = () => {}, openDependency = () => {}, page = component()
  page.details = { ...entry, kind: 'sourcemap', json: { sources: ['index.js'], sourcesContent: ['export const value = 1\n'] } }
  page._target = '(empty)'
  page._base = EMPTY_REVIEW_BASE
  page._diff = computeBundleDiff(bundleCompareFiles(page._base), bundleCompareFiles(page.details), () => '.')
  page.source = { choices: [], options: [], widest: { name: '0.0.0', detail: 'latest' },
    badges: (...sides) => { called.push(sides); return 'Shared comparison chips' },
    dependencies: (...sides) => { dependencyCalls.push(sides); return 'Shared dependency changes' }, dependencyTags, openDependency,
    files: { alerts: details => details === page._base ? 'Base alerts' : 'Version alerts', alertTags: () => {},
      newHosts: (was, now) => was === page._base && now === page.details ? 'New hosts by path' : null, newHostTag: () => {} },
  }
  for (const mode of ['code', 'diff']) {
    page._mode = mode
    const result = renderReview(page)
    assert.match(text(result), mode === 'code' ? /<bundle-compare-code /u : /<bundle-compare-all /u)
    const rendered = text(result)
    const values = item => Array.isArray(item) ? item.flatMap(values) : item?.strings ? item.values.flatMap(values) : [item]
    assert.match(rendered, /bundle-compare-picker is-versions/u)
    assert.match(rendered, /Shared comparison chips/u)
    assert.match(rendered, /\.baseAlerts=Base alerts \.otherAlerts=Version alerts/u)
    assert.match(rendered, /\.newHosts=New hosts by path/u)
    assert.ok(values(result).includes(page.source.files.newHostTag))
    assert.match(rendered, /\.dependencies=Shared dependency changes/u)
    assert.ok(values(result).includes(openDependency))
    assert.ok(values(result).includes(dependencyTags))
    assert.deepEqual(dependencyCalls.at(-1), [EMPTY_REVIEW_BASE, page.details])
    assert.deepEqual(called.at(-1), [EMPTY_REVIEW_BASE, page.details, page._diff.files])
  }
  page._base = base
  page.source = { ...page.source, badges: (...sides) => { called.push(sides); return 'Loaded comparison chips' } }
  assert.match(text(renderReview(page)), /Loaded comparison chips/u)
  assert.deepEqual(called.at(-1), [base, page.details, page._diff.files])
  page._files = ['index.js']
  page._openLine({ path: 'index.js', line: 1, query: 'value' })
  assert.deepEqual(page._seek, { path: 'index.js', line: 0, query: 'value' })
  assert.match(text(renderReview(page)), /<bundle-compare-all[^>]*\.seek=\[object Object\]/u)
  page._saveBlocked = true
  page._openLine({ path: 'index.js', line: 2, query: 'blocked' })
  assert.equal(page._seek.query, 'value', 'chip navigation respects the review save guard')
})

test('review selectors preserve the shared version dates and recent-release warnings', () => {
  const page = component()
  page.details = { ...entry, kind: 'sourcemap', json: { sources: ['index.js'], sourcesContent: ['new\n'] } }
  page._base = EMPTY_REVIEW_BASE; page._target = '(empty)'
  page._diff = computeBundleDiff(bundleCompareFiles(page._base), bundleCompareFiles(page.details), () => '.')
  const version = { id: '2.0.0', name: '@scope/lib@2.0.0', displayLabel: '2.0.0', format: 'npm', detail: 'latest', date: 'Oct 12, 2026', dateWarning: '3h ago' }
  page.source = { choices: [version], options: [{ ...version, id: '1.0.0', name: '@scope/lib@1.0.0', displayLabel: '1.0.0' }] }
  const values = value => value?.strings ? value.values.flatMap(values) : [value]
  const options = values(renderReview(page)).filter(value => Array.isArray(value) && value[0]?.format === 'npm')
  assert.equal(options.length, 2)
  assert.deepEqual(options.map(rows => [rows[0].id, rows[0].date, rows[0].dateWarning]),
    [['@scope/lib@1.0.0', 'Oct 12, 2026', '3h ago'], ['2.0.0', 'Oct 12, 2026', '3h ago']])
})

test('Finalize tint follows allowed verdicts, including edits awaiting save and security findings', async () => {
  const page = component()
  page.details = { ...entry, kind: 'sourcemap', json: { sources: ['index.js'], sourcesContent: ['new\n'] } }
  page._base = EMPTY_REVIEW_BASE
  page._diff = computeBundleDiff(bundleCompareFiles(page._base), bundleCompareFiles(page.details), () => '.')
  page._files = ['index.js']
  page._reviews = [{ ...review, entries: [{ ...file, status: 'accept' }] }]
  page._resetEditor('index.js')
  for (const status of ['accept', 'accept-with-nits', 'request-changes', 'reject']) {
    page._editFile(page._file, { status: status })
    assert.match(text(renderReview(page)), new RegExp(`npm-review-primary npm-review-finalize ${status}`, 'u'))
    assert.equal(page._allowedVerdicts[0], status)
  }
  page._editFile(page._file, { status: 'accept' })
  page._editFile('other.js', { status: 'reject' })
  assert.equal(page._allowedVerdicts[0], 'reject', 'a verdict on a different file still constrains Finalize')
  page._editors.delete('other.js')
  let limit = 'request-changes'
  page.source = { choices: [], options: [], reviewVerdictLimit: () => limit }
  await page._beginPublish()
  assert.equal(page._finalStatus, 'request-changes')
  assert.deepEqual(page._allowedVerdicts, ['request-changes', 'reject'])
  assert.match(text(renderReviewConfirmation(page, page._activeReview)), /Critical vulnerabilities detected/u)
  page._selectedTeams = new Set(['one'])
  requests.length = 0
  page._finalStatus = 'accept'
  await page._publish()
  assert.equal(requests.length, 0)
  limit = 'reject'
  page._finalStatus = 'request-changes'
  assert.match(text(renderReview(page)), /npm-review-primary npm-review-finalize reject/u)
  assert.match(text(renderReviewConfirmation(page, page._activeReview)), /Malware detected/u)
  await page._publish()
  assert.equal(requests.length, 0, 'a finding arriving during confirmation prevents a now-disallowed verdict')
  await page._beginPublish()
  assert.equal(page._finalStatus, 'reject')
  assert.deepEqual(page._allowedVerdicts, ['reject'])
})

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
  assert.match(text(page._row(partial)), />Partial<\/span> · 3\/4 files checked/u)
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
  assert.match(text(page._row(review)), /aria-label="Discard review"/u)
  assert.doesNotMatch(text(page._row(published)), /aria-label="Discard review"/u)
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
  page._editFile(page._file, { comment: 'Unsaved' })
  await page._publish()
  assert.equal(requests.length, 0)
  page._editFile(page._file, { comment: '' })
  page._files = ['index.js', 'second.js', 'package.json']
  page._reviews = [{ ...review, entries: [...review.entries, { ...file, id: 'manifest', file: 'package.json', status: 'accept', comment: '' }] }]
  page._beginPublish()
  assert.equal(page._finalStatus, 'request-changes')
  assert.match(text(renderReviewConfirmation(page, review)), /Partial review/u)
  assert.doesNotMatch(text(renderReviewConfirmation(page, review)), /Only teams|Select at least one team/u, 'nothing said under the teams while one is selected')
  page._selectedTeams = new Set()
  assert.match(text(renderReviewConfirmation(page, review)), /Select at least one team to publish\./u)
  page._selectedTeams = new Set(['two'])
  page._finalStatus = 'accept'
  await page._publish()
  assert.equal(requests.length, 0, 'final verdict cannot override file concerns')
  page._finalStatus = 'request-changes'
  page._finalComment = 'Check the second file too.'
  const published = { ...page._activeReview, publishedAt: 200, revision: 2, status: 'request-changes', coverage: 'partial', checkedFiles: 2, totalFiles: 3, teams: [{ id: 'two', name: 'Two' }] }
  answer = { review: published }
  await page._publish()
  assert.deepEqual(requests[0][1], { action: 'publish', reviewId: 'review', revision: 1, teamIds: ['two'], finalStatus: 'request-changes', finalComment: 'Check the second file too.' })
  assert.equal(page._canEdit, false)
  assert.match(text(renderReviewEntry(page, published)), /Continue in a new review/u)
  assert.doesNotMatch(text(renderReviewEditor(page)), /<textarea/u, 'no editor for a published set')
  assert.match(text(renderReviewEntry(page, published)), /Publish to more teams/u)
  assert.match(text(renderReviewEntry(page, published)), /Revoke/u)
  assert.doesNotMatch(text(renderReviewEntry(page, { ...published, revokedAt: 300 })), /Publish to more teams/u)
  assert.match(text(renderReviewEntry(page, { ...published, revokedAt: 300 })), /Revoked/u)
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
  assert.deepEqual(page._files, ['lib/helper.ts', 'lib/index.js'])
  assert.equal(page._diff.files.changed.find(row => row.path === 'lib/helper.ts').renamedFrom, 'lib/helper.js')
  assert.equal(page._diff.files.changed.find(row => row.path === 'lib/index.js').renamedFrom, undefined)
})

test('Review resumes the latest saved base while explicit links and new reviews keep their selected base', async () => {
  const page = component()
  page.details = { kind: 'sourcemap', json: { version: 3, sources: [], sourcesContent: [] } }
  latestRequests.length = 0; loadedBases.length = 0
  latestAnswer = review
  answer = { reviews: [review], teams: [] }
  await page._loadBase('(empty)', true)
  assert.deepEqual(loadedBases, [['@scope/lib', '1.0.0']])
  assert.equal(page._context.baseVersion, '1.0.0')
  assert.equal(page.request.reviewSpec, '1.0.0')
  assert.equal(page.request.resume, undefined)
  assert.equal(latestRequests[0][0].integrity, entry.integrity)
  const direct = component()
  direct.details = page.details
  await direct._loadBase('(empty)')
  assert.equal(latestRequests.length, 1, 'explicit routes do not switch to another review')
  assert.equal(direct._context.basePackage, null)
  latestAnswer = null
  const fresh = component()
  fresh.details = page.details
  await fresh._loadBase('@scope/lib@1.0.0', true)
  assert.equal(fresh._context.baseVersion, '1.0.0', 'with no prior review, keep the base carried from Compare')
  latestAnswer = { ...review, basePackage: null, baseVersion: null, baseIntegrity: null }
  const empty = component()
  empty.details = page.details
  await empty._loadBase('@scope/lib@1.0.0', true)
  assert.equal(empty._context.basePackage, null, 'a saved full-package review overrides Compare’s base too')
})

test('a late latest-review lookup cannot override a new selection, and a failed lookup is retryable', async () => {
  const page = component()
  page.details = { kind: 'sourcemap', json: { version: 3, sources: [], sourcesContent: [] } }
  let resolve
  latestAnswer = new Promise(done => { resolve = done })
  const loading = page._loadBase('@scope/lib@1.0.0', true)
  await page._loadBase('(empty)')
  resolve(review)
  await loading
  assert.equal(page._context.basePackage, null)
  page._baseKey = null
  latestAnswer = new Error('Could not load your latest review')
  await page._loadBase('(empty)', true)
  assert.match(page._baseError, /Could not load/u)
  assert.equal(page._base, null)
  latestAnswer = null
  page._baseKey = null
  await page._loadBase('(empty)', true)
  assert.equal(page._baseError, null)
  assert.equal(page._context.basePackage, null)
})

test('editing captures the loaded revision, and continuing uses a separate review', async () => {
  const page = component()
  page._resetEditor('index.js')
  page._reviews = [{ ...review, revision: 2 }]
  page._editFile(page._file, { comment: 'An edit against revision one' })
  answer = { review: { ...review, revision: 3 } }
  requests.length = 0
  await page._saveFile(page._file)
  assert.equal(requests[0][1].revision, 1, 'a later refresh cannot silently overwrite a concurrent edit')
  const published = { ...review, publishedAt: 200, revision: 4 }
  page._reviews = [published]
  const continued = { ...review, id: 'new-review', entries: [{ ...file, id: 'new-file' }] }
  requests.length = 0
  await page._change({ action: 'continue', reviewId: 'review', revision: 4 })
  assert.equal(page._canEdit, true)
  assert.equal(requests.length, 0, 'continuing an unchanged review does not save a draft')
  assert.equal(page._reviews.length, 1)
  page._resetEditor('index.js')
  await page._saveFile(page._file)
  assert.equal(requests.length, 0, 'leaving an unchanged note does not save a draft')
  const creating = Promise.withResolvers()
  answer = creating.promise
  page._editFile(page._file, { comment: 'A new note' })
  const saving = page._saveFile(page._file)
  assert.equal(requests[0][1].action, 'continue')
  answer = { review: { ...continued, revision: 2, entries: [{ ...continued.entries[0], comment: 'A new note' }] } }
  creating.resolve({ review: continued })
  await saving
  assert.equal(page._activeReview.id, 'new-review')
  assert.deepEqual(requests[1][1], { action: 'save', reviewId: 'new-review', revision: 1, entryId: 'new-file', file: 'index.js', comment: 'A new note', status: 'request-changes' })
  assert.equal(page._reviews.find(row => row.id === 'review').publishedAt, 200)
})

test('a continuation with only a changed final comment is created at publication, while unchanged copies stay local', async () => {
  const page = component(), source = { ...review, publishedAt: 200, status: 'reject', comment: 'Original summary' }
  page._reviews = [source]; page._files = ['index.js']; page._path = 'index.js'
  await page._change({ action: 'continue', reviewId: source.id, revision: source.revision })
  page._selectedTeams = new Set(['one'])
  await page._beginPublish()
  assert.equal(page._finalStatus, 'reject', 'continuation retains the existing final verdict')
  requests.length = 0
  await page._publish()
  assert.equal(requests.length, 0, 'the identical published review is not duplicated')
  assert.equal(page._unchangedContinuation, true)
  page._finalComment = 'Updated summary'
  const continued = { ...review, id: 'continued', comment: source.comment }, creating = Promise.withResolvers()
  answer = creating.promise
  const publishing = page._publish()
  assert.equal(requests[0][1].action, 'continue')
  answer = { review: { ...continued, publishedAt: 300, status: 'reject', comment: 'Updated summary' } }
  creating.resolve({ review: continued })
  await publishing
  assert.deepEqual(requests[1][1], { action: 'publish', reviewId: 'continued', revision: 1, teamIds: ['one'], finalStatus: 'reject', finalComment: 'Updated summary' })
})

test('edits queued while creating a continuation use the new review and file IDs', async () => {
  const page = component(), published = { ...review, publishedAt: 200, revision: 4,
    entries: [file, { ...file, id: 'old-other', file: 'other.js', status: 'accept' }] }
  page._reviews = [published]; page._files = ['index.js', 'other.js']; page._path = 'index.js'
  await page._change({ action: 'continue', reviewId: published.id, revision: published.revision })
  const continued = { ...review, id: 'new-review', entries: [
    { ...file, id: 'new-index' }, { ...file, id: 'new-other', file: 'other.js', status: 'accept' },
  ] }, creating = Promise.withResolvers(), firstSave = Promise.withResolvers()
  requests.length = 0; answer = creating.promise
  const first = page._setFileStatus('index.js', 'accept')
  const second = page._setFileStatus('other.js', 'reject')
  answer = firstSave.promise
  creating.resolve({ review: continued })
  await creating.promise
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(requests[1][1].entryId, 'new-index')
  const saved = { ...continued, revision: 2, entries: [{ ...continued.entries[0], status: 'accept' }, continued.entries[1]] }
  answer = { review: { ...saved, revision: 3, entries: [saved.entries[0], { ...saved.entries[1], status: 'reject' }] } }
  firstSave.resolve({ review: saved })
  await Promise.all([first, second])
  assert.deepEqual(requests[2][1], { action: 'save', reviewId: 'new-review', revision: 2, entryId: 'new-other', file: 'other.js', comment: 'A note', status: 'reject' })
  assert.equal(page._unsaved, false)
  assert.deepEqual(page._reviews.find(row => row.id === published.id).entries, published.entries)
})

test('canceling a continuation save ignores a late creation response', async () => {
  const page = component(), pending = Promise.withResolvers(), published = { ...review, publishedAt: 200 }
  page._reviews = [published]; page._path = 'index.js'
  await page._change({ action: 'continue', reviewId: published.id, revision: published.revision })
  requests.length = 0; answer = pending.promise
  const saving = page._setFileStatus('index.js', 'accept')
  page._cancelSaves()
  pending.resolve({ review: { ...review, id: 'ignored' } })
  await saving
  await pending.promise
  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.deepEqual(page._reviews, [published])
})

test('loading reviews uses a dismissible toast and no layout-shifting status line', async () => {
  const page = new DependencyReviewList(), pending = Promise.withResolvers()
  answer = pending.promise
  const loading = page._load()
  const toast = loadingToasts.at(-1)
  assert.equal(toast.message, 'Loading reviews…')
  assert.deepEqual(toast.options, { duration: 0 })
  assert.equal(toast.dismissed, false)
  pending.resolve({ reviews: [], next: null })
  await loading
  assert.equal(toast.dismissed, true)
  page._key = JSON.stringify([undefined, undefined])
  assert.doesNotMatch(text(page.render()), /Loading reviews/u)
  const abandoned = Promise.withResolvers()
  answer = abandoned.promise
  const anotherLoad = page._load()
  const nextToast = loadingToasts.at(-1)
  page.disconnectedCallback()
  assert.equal(nextToast.dismissed, true)
  abandoned.resolve({ reviews: [], next: null })
  await anotherLoad
})

test('file navigation preserves unsaved edits and advances their revisions as files are saved', async () => {
  const page = component()
  page._files = ['index.js', 'other.js']
  page._resetEditor('index.js')
  page._editFile(page._file, { comment: 'Keep this unsaved edit' })
  page._selectFile('other.js')
  assert.equal(page._editorState(page._file).dirty, false)
  assert.equal(page._unsaved, true)
  page._editFile(page._file, { status: 'accept' })
  page._selectFile('index.js')
  assert.equal(page._editorState(page._file).comment, 'Keep this unsaved edit')
  answer = { review: { ...review, revision: 2, entries: [{ ...file, comment: page._editorState(page._file).comment }] } }
  await page._saveFile(page._file)
  page._selectFile('other.js')
  assert.equal(page._editorState(page._file).status, 'accept')
  assert.equal(page._editorState(page._file).revision, 2, 'our save advances the revision of our other pending changes')
  page._editFile(page._file, { status: '' })
  assert.equal(page._unsaved, false, 'reverting a restored edit does not leave a stale unsaved marker')
})

test('a failed save preserves the editor and does not move to the next file', async () => {
  const page = component()
  page._files = ['index.js', 'other.js']; page._path = 'index.js'
  page._resetEditor('index.js'); page._editFile(page._file, { comment: 'Do not lose this' })
  answer = new Error('Review changed in another tab')
  await page._saveFile(page._file)
  assert.equal(page._path, 'index.js')
  assert.equal(page._editorState(page._file).comment, 'Do not lose this')
  assert.equal(page._editorState(page._file).dirty, true)
  assert.equal(page._error, 'Review changed in another tab')
})

test('viewing a frozen set never loads or overwrites private unsaved buffers', () => {
  const page = component(), published = { ...review, id: 'published', publishedAt: 200, status: 'request-changes' }
  page._reviews = [review, published]; page._files = ['index.js', 'other.js']; page._path = 'index.js'
  page._resetEditor('index.js'); page._editFile(page._file, { comment: 'Private pending note' })
  page._showPublished(published)
  page._selectFile('other.js'); page._selectFile('index.js')
  assert.equal(page._canEdit, false)
  assert.equal(page._editorState(page._file).comment, 'A note', 'the frozen file shows its saved content')
  assert.equal(page._unsaved, true, 'changing comparison cannot discard a private edit while its frozen file is shown')
  assert.doesNotMatch(text(renderReviewEditor(page)), /<textarea/u)
  assert.match(text(renderReviewEntry(page, published)), /aria-current=true/u)
  assert.match(text(renderReviewEntry(page, review)), /aria-current=false/u)
  assert.doesNotMatch(text(renderReviewEntry(page, review)), />Revoke<|>Continue<|Publish to more teams/u, 'private reviews only expose Open')
  page._resume()
  assert.equal(page._editorState(page._file).comment, 'Private pending note')
  assert.equal(page._canEdit, true)
  assert.match(text(renderReviewEntry(page, review)), /aria-current=true/u)
  assert.match(text(renderReviewEntry(page, published)), /aria-current=false/u)
})

test('opening a specific published list row selects that snapshot even with an active review', async () => {
  const page = component(), published = { ...review, id: 'published', publishedAt: 200 }
  selectReviewOnOpen(published)
  answer = { reviews: [review, published], teams: [] }
  await page._refresh()
  assert.equal(page._shownReview.id, 'published')
  assert.equal(page._canEdit, false)
})

test('version-wide reviews keep bases separate when opening, continuing and sharing', async () => {
  const page = component(), published = { ...review, id: 'earlier-base', baseVersion: '0.8.0', baseIntegrity: 'sha512-earlier', publishedAt: 200 }
  const otherPrivate = { ...review, id: 'other-private', baseVersion: '0.9.0', baseIntegrity: 'sha512-other' }
  page._reviews = [published, otherPrivate, review]
  assert.equal(page._activeReview, review)
  assert.deepEqual(page._ownPublished, [], 'a review for another base does not freeze the current one')
  navigations.length = 0
  await page._openReview(published, true)
  assert.equal(navigations[0].reviewSpec, '0.8.0')
  page._context = { ...context, baseVersion: published.baseVersion, baseIntegrity: published.baseIntegrity }
  answer = { reviews: page._reviews, teams: [] }
  await page._refresh()
  assert.equal(requests.at(-1)[0].allBases, true)
  assert.equal(page._continuation.source, published)
  assert.equal(page._activeReview.publishedAt, null, 'continue starts privately in the selected base')
  const continuation = page._continuation
  requests.length = 0
  const anotherPublished = { ...review, id: 'original-base', publishedAt: 300 }
  page._reviews.push(anotherPublished)
  answer = { review: { ...anotherPublished, revision: 2, teams: [{ id: 'one', name: 'One' }] } }
  await page._change({ action: 'publish', reviewId: anotherPublished.id, revision: 1, teamIds: ['one'] })
  assert.equal(requests.length, 1, 'sharing an older review does not persist the active continuation')
  assert.deepEqual(requests[0][0], context, 'actions use the subject review’s base')
  assert.equal(page._continuation, continuation)
  assert.equal(page._shownReview, continuation.review)
})

test('dense file tree counts verdicts rather than notes and bounds the initial DOM for large packages', () => {
  const entries = [file, { ...file, id: 'note', file: 'other.js', status: null }]
  const states = reviewFileStates(entries)
  assert.equal(states.get('index.js').status, 'request-changes')
  assert.equal(states.get('other.js').status, null)
  const files = Array.from({ length: 10000 }, (_, i) => ({ path: `src/file-${String(i).padStart(5, '0')}.js`, kind: 'added' }))
  const page = component()
  page._files = [...files.map(row => row.path), 'index.js', 'other.js']; page._reviews = [{ ...review, entries }]
  const extensions = reviewExtensions(page)
  assert.match(text(extensions.filters), /All 10002/u)
  assert.match(text(extensions.filters), /Unchecked 10001/u)
  const treeView = new BundleCompareCode()
  treeView.base = EMPTY_REVIEW_BASE
  treeView.other = { kind: 'sourcemap', json: { sources: files.map(row => row.path), sourcesContent: files.map(() => '') } }
  treeView.files = { onlyBase: [], onlyOther: files, changed: [] }; treeView.extensions = extensions
  treeView.path = files[0].path
  treeView.willUpdate(new Map([['files']]))
  const rail = () => text(treeView._renderRail(treeView._railState(), treeView.path))
  assert.equal((rail().match(/class=bundle-code-tree-link/gu) ?? []).length, 299)
  treeView._query = 'file-09999'
  assert.match(rail(), /file-09999.js/u)
  assert.doesNotMatch(rail(), /file-00000.js/u)
  treeView._query = ''; treeView.path = files.at(-1).path
  assert.match(rail(), /file-09999.js/u, 'a selected file stays available past the tree page limit')

})


test('verdict selection autosaves in place and keeps other files pending edits', async () => {
  const page = component()
  page._mode = 'diff'; page._files = ['index.js', 'other.js']; page._path = 'index.js'
  page._resetEditor('index.js'); page._editFile(page._file, { comment: 'Pending note on the first file' })
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
  page._editFile('index.js', { comment: 'Typed during the save' })
  page._selectFile('other.js')
  assert.equal(page._path, 'other.js')
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept-with-nits' }] } })
  await saving
  assert.equal(page._path, 'other.js')
  page._selectFile('index.js')
  assert.equal(page._editorState(page._file).status, 'accept-with-nits')
  assert.equal(page._editorState(page._file).comment, 'Typed during the save')
  assert.equal(page._editorState(page._file).revision, 2)
  assert.equal(page._editorState(page._file).dirty, true)
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
  assert.equal(page._editorState(page._file).status, '', 'the earlier save does not revert the latest selection')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1][1], { action: 'save', reviewId: 'review', revision: 1, entryId: 'other', file: 'other.js', comment: '', status: null })
  second.resolve({ review: { ...created, revision: 2, entries: [{ ...created.entries[0], status: null }] } })
  await clearing
  assert.equal(page._unsaved, false)
  assert.equal(page._editorState(page._file).status, '')
})

test('cycling back to a queued verdict retains the latest selection through every save', async () => {
  const first = Promise.withResolvers(), page = component(), second = Promise.withResolvers(), third = Promise.withResolvers()
  page._resetEditor('index.js'); requests.length = 0
  answer = first.promise
  const accepting = page._setFileStatus('index.js', 'accept')
  const rejecting = page._setFileStatus('index.js', 'reject')
  const restoring = page._setFileStatus('index.js', 'accept')
  const accepted = { ...review, revision: 2, entries: [{ ...file, status: 'accept' }] }
  answer = second.promise
  first.resolve({ review: accepted }); await accepting
  assert.equal(page._editorState('index.js').status, 'accept')
  assert.equal(page._unsaved, true)
  answer = third.promise
  second.resolve({ review: { ...accepted, revision: 3, entries: [{ ...file, status: 'reject' }] } }); await rejecting
  assert.equal(page._editorState('index.js').status, 'accept', 'an intermediate response cannot overwrite the last choice')
  assert.equal(page._editorState('index.js').dirty, true)
  assert.equal(requests[2][1].revision, 3)
  third.resolve({ review: { ...accepted, revision: 4 } }); await restoring
  assert.equal(page._editorState('index.js').status, 'accept')
  assert.equal(page._unsaved, false)
})

test('only saves pending for three seconds block editing, and completion clears the block', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = component(), pending = Promise.withResolvers()
  page.details = { ...entry, kind: 'sourcemap', json: { sources: ['index.js'], sourcesContent: ['new\n'] } }
  page._base = EMPTY_REVIEW_BASE; page._target = '@scope/lib@1.0.0'; page._files = ['index.js']
  page._diff = computeBundleDiff(bundleCompareFiles(page._base), bundleCompareFiles(page.details), () => '.')
  const assertSaveUI = blocked => {
    const rendered = text(renderReview(page))
    assert.equal(rendered.includes('Unsaved changes'), blocked)
    assert.equal(rendered.includes('Saving changes…'), blocked)
    assert.match(rendered, new RegExp(`label=Review base[^>]+\\?disabled=${blocked}`, 'u'))
    assert.match(rendered, new RegExp(`label=Version to review[^>]+\\?disabled=${blocked}`, 'u'))
    assert.match(rendered, new RegExp(`aria-label=Clear review base \\?disabled=${blocked}`, 'u'))
    assert.match(rendered, new RegExp(`\\?disabled=${blocked}[^>]*>Finalize review`, 'u'))
  }
  page._resetEditor('index.js'); answer = pending.promise
  page._editFile('index.js', { comment: 'Save this note too' })
  assertSaveUI(false)
  const saving = page._setFileStatus('index.js', 'accept')
  assert.equal(page._unsaved, true, 'data protection still tracks edits during the grace period')
  assertSaveUI(false)
  t.mock.timers.tick(2999)
  assert.equal(page._blocked, false)
  assertSaveUI(false)
  t.mock.timers.tick(1)
  assert.equal(page._blocked, true)
  assertSaveUI(true)
  await page._setFileStatus('index.js', 'reject')
  assert.equal(page._editorState(page._file).status, 'accept', 'edits stop once the slow-save block appears')
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept', comment: 'Save this note too' }] } })
  await saving
  assert.equal(page._blocked, false)
  assertSaveUI(false)
  t.mock.timers.tick(3000)
  assert.equal(page._blocked, false)
})

test('version changes during the grace period save newer notes and navigate only to the latest choice', async () => {
  const first = Promise.withResolvers(), page = component(), second = Promise.withResolvers()
  page._resetEditor('index.js'); answer = first.promise; navigations.length = 0; requests.length = 0
  const saving = page._setFileStatus('index.js', 'accept-with-nits')
  const clearing = page._navigate('(empty)')
  page._editFile('index.js', { comment: 'Typed after choosing another base' })
  const selecting = page._navigate('@scope/lib@0.5.0')
  assert.deepEqual(navigations, [], 'navigation waits without disabling the editor')
  assert.equal(page._blocked, false)
  answer = second.promise
  first.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept-with-nits' }] } })
  await saving
  await Promise.resolve()
  assert.equal(requests.length, 2)
  assert.equal(requests[1][1].comment, 'Typed after choosing another base')
  assert.equal(requests[1][1].revision, 2)
  assert.deepEqual(navigations, [])
  second.resolve({ review: { ...review, revision: 3, entries: [{ ...file, status: 'accept-with-nits', comment: 'Typed after choosing another base' }] } })
  await Promise.all([clearing, selecting])
  assert.deepEqual(navigations, [{ view: 'npm', packageName: '@scope/lib', packageSpec: '2.0.0', bundleTab: 'review', reviewPackage: '@scope/lib', reviewSpec: '0.5.0' }])
  assert.equal(page._unsaved, false)
})

test('navigation preserves edits when an autosave fails or the review context changes', async () => {
  for (const outcome of ['failure', 'context-change']) {
    const page = component(), pending = Promise.withResolvers()
    page._resetEditor('index.js'); page._editFile(page._file, { comment: 'Keep this note' }); answer = pending.promise; navigations.length = 0
    const navigating = page._navigateTo({ view: 'reviews' })
    if (outcome === 'failure') pending.reject(new Error('Connection lost'))
    else { page._key = 'another review'; page._cancelSaves(); pending.resolve({ review }) }
    await navigating
    assert.deepEqual(navigations, [])
    assert.equal(page._editorState(page._file).comment, 'Keep this note')
    if (outcome === 'failure') assert.equal(page._error, 'Connection lost')
  }
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
  page._editFile('other.js', { comment: 'Keep this note' })
  t.mock.timers.tick(3000)
  pending.reject(new Error('Connection lost'))
  await Promise.all([first, second])
  assert.equal(requests.length, 1, 'queued requests stop on error')
  assert.equal(page._blocked, false)
  assert.equal(page._error, 'Connection lost')
  assert.equal(page._editorState('index.js').status, 'accept')
  assert.equal(page._editorState('other.js').status, 'reject')
  assert.equal(page._editorState(page._file).comment, 'Keep this note')
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
  page._editFile('index.js', { comment: 'Still private' })
  page._showPublished(published)
  pending.resolve({ review: { ...review, revision: 2, entries: [{ ...file, status: 'accept-with-nits' }] } })
  await saving
  assert.equal(page._shownReview.id, 'published')
  assert.equal(page._shownReview.entries[0].status, 'request-changes')
  page._resume()
  assert.equal(page._editorState(page._file).comment, 'Still private')
  assert.equal(page._editorState(page._file).revision, 2)
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

test('partial publication requires a package.json verdict and offers the file from confirmation', async () => {
  const page = component()
  page._files = ['index.js', 'package.json', 'other.js']
  page._selectedTeams = new Set(['one'])
  requests.length = 0
  await page._beginPublish()
  assert.equal(page._panel, 'publish')
  assert.equal(page._needsPackageJson, true)
  assert.match(text(renderReviewConfirmation(page, page._activeReview)), />package.json<\/button> before publishing a partial review/u)
  assert.match(text(renderReviewConfirmation(page, page._activeReview)), /type="submit"[^>]+\?disabled=true/u)
  await page._publish()
  assert.equal(requests.length, 0)
  const manifest = { ...file, id: 'manifest', file: 'package.json', status: null, comment: 'Not checked yet.' }
  page._reviews = [{ ...review, entries: [file, manifest] }]
  await page._publish()
  assert.equal(requests.length, 0, 'notes alone do not check package.json')
  page._reviews = [{ ...review, entries: [file, { ...manifest, status: 'accept' }] }]
  assert.equal(page._needsPackageJson, false)
  assert.doesNotMatch(text(renderReviewConfirmation(page, page._activeReview)), /before publishing a partial review/u)
  answer = { review: { ...page._activeReview, publishedAt: 200 } }
  await page._publish()
  assert.equal(requests[0][1].action, 'publish')
})

test('displayed notes render star lists as bullets while the editor keeps the typed text', () => {
  const comment = 'Context\n* Can we make it faster?\n* Preserve compatibility.'
  const rendered = text(reviewNote(comment))
  assert.match(rendered, /<p class="npm-review-note">Context<\/p>/u)
  assert.match(rendered, /<li>Can we make it faster\?<\/li><li>Preserve compatibility\.<\/li>/u)
  assert.doesNotMatch(rendered, /\* Can/u)
  const page = component()
  page._resetEditor('index.js')
  page._editFile(page._file, { comment: comment })
  renderReviewEditor(page)
  assert.equal(page._editorState('index.js').comment, comment)
})

test('leaving a note saves its file without changing the active editor, and unchanged notes need no save', async () => {
  const page = component()
  page._files = ['index.js', 'other.js']; page._resetEditor('index.js')
  page._editFile(page._file, { comment: 'Save on blur' })
  assert.doesNotMatch(text(renderReviewEditor(page)), /Save notes|Save &amp; next|Discard changes|Visible only to you until published/u)
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
  page._files = ['index.js']; page._resetEditor('index.js'); page._editFile(page._file, { comment: 'Save when finalizing' })
  answer = pending.promise; requests.length = 0
  const finalizing = page._beginPublish()
  assert.notEqual(page._panel, 'publish')
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
  page._files = ['index.js']; page._resetEditor('index.js'); page._editFile(page._file, { comment: 'Only save once' })
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
  page._files = ['index.js', 'other.js']; page._resetEditor('index.js'); page._editFile(page._file, { comment: 'First note' })
  page._selectFile('other.js'); page._editFile(page._file, { comment: 'Second note' }); page._editFile(page._file, { status: 'reject' })
  answer = first.promise; requests.length = 0
  const finalizing = page._beginPublish()
  answer = second.promise
  first.resolve({ review: { ...review, revision: 2, entries: [{ ...file, comment: 'First note' }] } })
  await first.promise
  await Promise.resolve()
  await Promise.resolve()
  assert.notEqual(page._panel, 'publish')
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
  page._files = ['index.js']; page._resetEditor('index.js'); page._editFile(page._file, { comment: 'Keep on failure' })
  answer = new Error('Connection lost')
  await page._beginPublish()
  assert.notEqual(page._panel, 'publish')
  assert.equal(page._editorState(page._file).comment, 'Keep on failure')
  assert.equal(page._error, 'Connection lost')
  answer = { review: { ...review, revision: 2, entries: [{ ...file, comment: 'Keep on failure' }] } }
  await page._beginPublish()
  assert.equal(page._panel, 'publish')
})

test('a blank new note does not block finalization or create an empty row', async () => {
  const page = component()
  page._files = ['index.js']; page._resetEditor(null); page._editFile(page._file, { comment: '   ' })
  requests.length = 0
  await page._beginPublish()
  assert.equal(requests.length, 0)
  assert.equal(page._panel, 'publish')
  assert.equal(page._unsaved, false)
})

test('review drawers identify the entire version comparison', () => {
  assert.equal(reviewTitle(context), '@scope/lib 1.0.0 -> 2.0.0')
  assert.equal(reviewTitle({ ...context, basePackage: '@old/lib' }), '@old/lib 1.0.0 -> @scope/lib 2.0.0')
  assert.equal(reviewTitle({ ...context, basePackage: null }), '@scope/lib 2.0.0')
})

test('review automatically uses whole diff below both line and byte limits', () => {
  const reviewViewMode = files => withinComparisonLimits(files, REVIEW_DISPLAY_LIMITS) ? 'diff' : 'code'
  assert.equal(reviewViewMode([{ before: '', after: 'a\n'.repeat(49_999) }]), 'diff')
  assert.equal(reviewViewMode([{ before: 'a\n'.repeat(25_000), after: 'b\n'.repeat(25_000) }]), 'code')
  assert.equal(reviewViewMode([{ before: '', after: 'x'.repeat(2 * 1024 * 1024 - 1) }]), 'diff')
  assert.equal(reviewViewMode([{ before: 'x'.repeat(1024 * 1024), after: 'x'.repeat(1024 * 1024) }]), 'code')
  assert.equal(reviewViewMode([{ before: '', after: 'é'.repeat(1024 * 1024) }]), 'code', 'the limit measures UTF-8 bytes')
  assert.equal(reviewViewMode([{ before: '', after: { format: 'digest', size: 2 * 1024 * 1024 } }]), 'code')
})

test('the shared tree keeps review decorations, progress and next-unchecked behavior', () => {
  const page = component()
  page._files = ['src/a.js', 'src/b.js', 'index.js']; page._path = 'src/b.js'
  page._reviews = [{ ...review, entries: [{ ...file, file: 'src/a.js', status: 'accept' }, { ...file, file: 'src/b.js', status: null }] }]
  const extras = reviewExtensions(page)
  assert.equal(extras.directorySummary({ sourcePath: 'src' }), '1/2')
  assert.match(text(extras.filePrefix('src/a.js')), /accept/u)
  assert.match(text(extras.fileSuffix('src/b.js')), /Has notes/u)
  assert.equal(extras.fileLabel('src/a.js'), 'src/a.js, Accept')
  assert.match(text(extras.filters), /Unchecked 2/u)
  const selected = []
  const footer = extras.footer(path => selected.push(path))
  footer.values.find(value => typeof value === 'function')()
  assert.deepEqual(selected, ['index.js'])
  page._unchecked = true
  const filtered = reviewExtensions(page)
  assert.equal(filtered.fileFilter('src/a.js'), false)
  assert.equal(filtered.fileFilter('src/b.js'), true, 'a note without a verdict stays unchecked')
  assert.equal(filtered.canSelect(), true)
  page._saveBlocked = true
  assert.equal(filtered.canSelect(), false)
  page._saveBlocked = false; page._panel = 'reviews'
  assert.equal(filtered.canSelect(), false, 'scrolling behind a dialog must not change the selected file')
})
