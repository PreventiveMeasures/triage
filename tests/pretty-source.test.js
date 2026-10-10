import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'

const state = { bundleSourcePretty: false, bundleSourceFile: null }
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
const renders = []
mock.module('../ui/view/render.js', { exports: { render() { renders.push(state.bundleSourceFile) } } })
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
// Each request is answered by the next of `answers`, a text or an error.
const answers = [], requests = []
const answer = () => {
  const next = answers.shift() ?? new Error('unexpected request')
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
}
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmAdvisories: () => Promise.resolve({ versions: [], advisories: [] }), fetchNpmStats: () => Promise.resolve({}),
  fetchNpmPackage() {}, fetchNpmSocket: () => Promise.resolve({ socket: null }), fetchNpmTags: () => Promise.resolve({ tags: [] }), fetchNpmVersions: () => Promise.resolve({ versions: [] }), fetchBundleContents() {}, fetchBundleMetadata() {},
  fetchPrettyBundleFile: (...args) => { requests.push(['bundle', ...args]); return answer() },
  fetchPrettyNpmFile: (...args) => { requests.push(['npm', ...args]); return answer() },
} })
const { prettyCopy, prettyPrintable, togglePrettySource } = await import('../ui/view/pretty-source.js')

const minified = `${'var a=1;'.repeat(200)}\n`
const readable = 'export const a = 1\n'
const hashOf = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
let serial = 0
// A managed bundle's details, its files' hashes from its metadata.
function bundleOf(files) {
  const json = { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) }
  return { kind: 'sourcemap', integrity: `sha512-bundle-${++serial}`, json, fileHashes: new Map(Object.entries(files).map(([path, text]) => [path, hashOf(text)])) }
}
const managed = { managedId: 'bundle-1' }
const settled = () => setImmediate()

beforeEach(() => {
  state.bundleSourcePretty = false
  requests.length = 0
  answers.length = 0
  renders.length = 0
})

test('only a managed bundle\'s or npm version\'s minified code is offered pretty-printed', () => {
  const details = bundleOf({ 'dist/app.min.js': minified, 'src/a.js': readable, 'dist/app.js.map': minified, 'dist/notes.md': minified, 'dist/one.js': `${minified}${readable.repeat(400)}` })
  assert.equal(prettyPrintable(details, managed, 'dist/app.min.js', minified), true)
  assert.equal(prettyPrintable(details, {}, 'dist/app.min.js', minified), false, 'a local bundle has no server to ask')
  assert.equal(prettyPrintable(details, managed, 'src/a.js', readable), false, 'readable code')
  assert.equal(prettyPrintable(details, managed, 'dist/app.js.map', minified), false, 'a source map')
  assert.equal(prettyPrintable(details, managed, 'dist/notes.md', minified), false, 'prose')
  assert.equal(prettyPrintable(details, managed, 'dist/one.js', `${minified}${readable.repeat(400)}`), false, 'one long line among many short ones')
  assert.equal(prettyPrintable(details, managed, 'src/a.js', null), false, 'a file with no text')
  const huge = `${'x'.repeat(4 * 1024 * 1024)}\n`
  assert.equal(prettyPrintable(bundleOf({ 'big.min.js': huge }), managed, 'big.min.js', huge), false, 'past what the server formats')
  const npm = { integrity: 'sha512-npm', kind: 'sourcemap', npm: { name: 'lib', version: '1.0.0' }, json: { version: 3, sources: ['lib.min.js', 'index.js'], sourcesContent: [minified, readable] } }
  assert.equal(prettyPrintable(npm, { npm: npm.npm }, 'lib.min.js', minified), true)
  assert.equal(prettyPrintable(npm, { npm: npm.npm }, 'index.js', readable), false)
})

test('a bundle file\'s copy is asked for by its metadata hash once the toggle is on, and kept', async () => {
  const details = bundleOf({ 'dist/app.min.js': minified })
  state.bundleSourceFile = 'dist/app.min.js'
  assert.equal(prettyCopy(details, managed, 'dist/app.min.js', minified), null, 'off by default')
  assert.equal(requests.length, 0)
  togglePrettySource()
  answers.push('var a = 1;\n')
  assert.deepEqual(prettyCopy(details, managed, 'dist/app.min.js', minified), { status: 'loading' })
  await settled()
  assert.deepEqual(requests, [['bundle', 'bundle-1', 'dist/app.min.js', hashOf(minified)]])
  assert.deepEqual(renders, ['dist/app.min.js'], 'the open file repaints with its copy')
  assert.deepEqual(prettyCopy(details, managed, 'dist/app.min.js', minified), { status: 'ready', text: 'var a = 1;\n' })
  togglePrettySource()
  assert.equal(prettyCopy(details, managed, 'dist/app.min.js', minified), null)
  togglePrettySource()
  assert.equal(prettyCopy(details, managed, 'dist/app.min.js', minified).status, 'ready')
  assert.equal(requests.length, 1, 'turned back on, a kept copy is not asked for again')
})

test('an npm file\'s copy is asked for by its version and the hash of its text', async () => {
  const npm = { integrity: 'sha512-npm-hash', kind: 'sourcemap', npm: { name: '@scope/lib', version: '2.0.0' }, json: { version: 3, sources: ['lib.min.js'], sourcesContent: [minified] } }
  togglePrettySource()
  answers.push('pretty')
  prettyCopy(npm, { npm: npm.npm }, 'lib.min.js', minified)
  for (let i = 0; i < 50 && requests.length === 0; i++) await settled()
  assert.deepEqual(requests, [['npm', '@scope/lib', '2.0.0', 'lib.min.js', hashOf(minified)]])
})

test('a failure is shown, and asked again only where asking again may succeed', async () => {
  togglePrettySource()
  const details = bundleOf({ 'a.min.js': minified, 'b.min.js': `${minified}\n` })
  answers.push(Object.assign(new Error("This file couldn't be read as code."), { status: 422 }), Object.assign(new Error('Busy'), { status: 429 }))
  prettyCopy(details, managed, 'a.min.js', minified)
  prettyCopy(details, managed, 'b.min.js', `${minified}\n`)
  await settled()
  assert.deepEqual(prettyCopy(details, managed, 'a.min.js', minified), { status: 'error', message: "This file couldn't be read as code.", retry: false })
  assert.equal(prettyCopy(details, managed, 'b.min.js', `${minified}\n`).retry, true)
  togglePrettySource()
  togglePrettySource()
  answers.push('b')
  assert.equal(prettyCopy(details, managed, 'a.min.js', minified).status, 'error', 'a file that is not code stays so')
  assert.equal(prettyCopy(details, managed, 'b.min.js', `${minified}\n`).status, 'loading', 'a busy server is asked again')
  await settled()
  assert.equal(requests.length, 3)
})

test('a request a session change aborted is asked again on the next paint', async () => {
  togglePrettySource()
  const details = bundleOf({ 'a.min.js': minified })
  answers.push(new DOMException('Managed session changed', 'AbortError'), 'again')
  prettyCopy(details, managed, 'a.min.js', minified)
  await settled()
  assert.deepEqual(renders, [], 'an aborted request paints nothing')
  assert.equal(prettyCopy(details, managed, 'a.min.js', minified).status, 'loading')
  await settled()
  assert.equal(prettyCopy(details, managed, 'a.min.js', minified).text, 'again')
})
