import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'

const state = { bundleSourcePretty: false }
mock.module('../client/index.js', { exports: { state } })
// Each request is answered by the next of `answers`: a text (or a promise of
// one) named as the copy of the file asked for, `{ text, source }` naming
// the file it was formatted from, or an error.
const answers = [], requests = []
const answer = hash => {
  const next = answers.shift() ?? new Error('unexpected request')
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next).then(text => (typeof text === 'string' ? { text, source: hash } : text))
}
mock.module('../ui/view/client-managed.js', { exports: {
  fetchPrettyBundleFile: (...args) => { requests.push(['bundle', ...args]); return answer(args[2]) },
  fetchPrettyNpmFile: (...args) => { requests.push(['npm', ...args]); return answer(args[3]) },
} })
const { prettyCopy: copyOf, prettyPrintable, togglePrettySource } = await import('../ui/view/pretty-source.js')
// Each copy asked for here notes its path once it comes, as a view repaints,
// in the list of the test that asked: one that comes after its test ended
// counts for no later test.
let renders = []
const prettyCopy = (details, entry, path, content) => {
  const painted = renders
  return copyOf(details, entry, path, content, () => painted.push(path))
}

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
// Turns until `done()` holds, for a copy asked for only once its file is
// hashed (an npm version's details carry no hashes), which on a loaded
// machine can take any number of turns.
async function settledUntil(done) {
  const deadline = Date.now() + 10_000
  while (!done() && Date.now() < deadline) await settled()
}

beforeEach(() => {
  state.bundleSourcePretty = false
  requests.length = 0
  answers.length = 0
  renders = []
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
  assert.equal(prettyCopy(details, managed, 'dist/app.min.js', minified), null, 'off by default')
  assert.equal(requests.length, 0)
  togglePrettySource()
  answers.push('var a = 1;\n')
  assert.deepEqual(prettyCopy(details, managed, 'dist/app.min.js', minified), { status: 'loading' })
  // Hashed as it comes, which can take any number of turns.
  await settledUntil(() => renders.length > 0)
  assert.deepEqual(requests, [['bundle', 'bundle-1', 'dist/app.min.js', hashOf(minified)]])
  assert.deepEqual(renders, ['dist/app.min.js'], 'the view that asked repaints with its copy')
  assert.deepEqual(prettyCopy(details, managed, 'dist/app.min.js', minified), { status: 'ready', text: 'var a = 1;\n', hash: hashOf('var a = 1;\n') }, 'with its own hash')
  togglePrettySource()
  assert.equal(prettyCopy(details, managed, 'dist/app.min.js', minified), null)
  togglePrettySource()
  assert.equal(prettyCopy(details, managed, 'dist/app.min.js', minified).status, 'ready')
  assert.equal(requests.length, 1, 'turned back on, a kept copy is not asked for again')
})

test('an npm file\'s copy is asked for by its version and the hash of its text', async () => {
  const npm = { integrity: 'sha512-npm-hash', kind: 'sourcemap', npm: { name: '@scope/lib', version: '2.0.0' }, json: { version: 3, sources: ['lib.min.js'], sourcesContent: [minified] } }
  const copy = () => prettyCopy(npm, { npm: npm.npm }, 'lib.min.js', minified)
  togglePrettySource()
  answers.push('pretty')
  copy()
  // Until it is read: a request left pending would take a later test's answer.
  await settledUntil(() => copy().status !== 'loading')
  assert.deepEqual(requests, [['npm', '@scope/lib', '2.0.0', 'lib.min.js', hashOf(minified)]])
})

test('a copy the server names as another file\'s, or as none, is refused', async () => {
  togglePrettySource()
  const details = bundleOf({ 'a.min.js': minified, 'b.min.js': `${minified}\n` })
  answers.push({ text: 'var b = 2;\n', source: hashOf('another file') }, { text: 'var b = 2;\n', source: null })
  const copies = () => [prettyCopy(details, managed, 'a.min.js', minified), prettyCopy(details, managed, 'b.min.js', `${minified}\n`)]
  copies()
  await settledUntil(() => copies().every(copy => copy.status !== 'loading'))
  for (const copy of copies()) assert.deepEqual(copy, { status: 'error', message: "The server's copy is of another file than the one open.", retry: true })
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
  // Until it came and was hashed, which can take any number of turns.
  await settledUntil(() => prettyCopy(details, managed, 'b.min.js', `${minified}\n`).status !== 'loading')
  assert.equal(prettyCopy(details, managed, 'b.min.js', `${minified}\n`).text, 'b')
  assert.equal(requests.length, 3)
})

test('a view asking for more copies than are kept keeps every one it waits for', async () => {
  togglePrettySource()
  // Compare's Diff view: both sides of five minified files, in one paint.
  const files = Array.from({ length: 10 }, (_, i) => `f${i}.min.js`)
  const details = bundleOf(Object.fromEntries(files.map((path, i) => [path, `${minified}${i}`])))
  for (let i = 0; i < files.length; i++) answers.push(`copy ${i}`)
  const paint = () => files.map((path, i) => prettyCopy(details, managed, path, `${minified}${i}`).status)
  assert.deepEqual(new Set(paint()), new Set(['loading']))
  // Each repaints its view once it came and was hashed, which can take any number of turns.
  await settledUntil(() => renders.length === files.length)
  assert.deepEqual(new Set(paint()), new Set(['ready']), 'none dropped while it came')
  await new Promise(resolve => { setTimeout(resolve, 1) })
  assert.deepEqual(new Set(paint()), new Set(['ready']), 'nor on a later paint')
  assert.equal(requests.length, 10, 'and none asked for twice')
})

test('copies that come once their view moved on are dropped past those kept', async () => {
  togglePrettySource()
  // The Code view, one file after another, each asked for in a paint of its own before any came.
  const files = Array.from({ length: 10 }, (_, i) => `g${i}.min.js`)
  const details = bundleOf(Object.fromEntries(files.map((path, i) => [path, `${minified}${i}`])))
  const comes = []
  for (let i = 0; i < files.length; i++) answers.push(new Promise(resolve => { comes.push(resolve) }))
  for (let i = 0; i < files.length; i++) {
    prettyCopy(details, managed, files[i], `${minified}${i}`)
    await new Promise(resolve => { setTimeout(resolve, 1) })
  }
  // In order, each repainting its view once it came and was hashed.
  const painted = renders
  for (const [i, come] of comes.entries()) {
    come(`copy ${i}`)
    await settledUntil(() => painted.length === i + 1)
  }
  answers.push('again')
  assert.equal(prettyCopy(details, managed, files[0], `${minified}0`).status, 'loading', 'the first, dropped once it came, is asked for again')
  assert.equal(requests.length, 11)
  await settledUntil(() => renders.length === files.length + 1)
})

test('a request a session change aborted is asked again on the next paint', async () => {
  togglePrettySource()
  const details = bundleOf({ 'a.min.js': minified })
  answers.push(new DOMException('Managed session changed', 'AbortError'), 'again')
  prettyCopy(details, managed, 'a.min.js', minified)
  await settled()
  assert.deepEqual(renders, [], 'an aborted request paints nothing')
  assert.equal(prettyCopy(details, managed, 'a.min.js', minified).status, 'loading')
  // Hashed as it comes, which can take any number of turns.
  await settledUntil(() => prettyCopy(details, managed, 'a.min.js', minified).status !== 'loading')
  assert.equal(prettyCopy(details, managed, 'a.min.js', minified).text, 'again')
})
