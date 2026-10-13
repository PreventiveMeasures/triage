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
// An npm version's request for all its copies, or a comparison's for its
// changed files', its lines sent, and the request ended or failed, by the test.
const changeRequests = [], npmRequests = []
const lines = (...asked) => {
  requests.push(asked.filter(part => typeof part === 'string'))
  return new Promise((end, fail) => { changeRequests.push({ send: asked.find(part => typeof part === 'function'), end, fail }) })
}
mock.module('../ui/view/client-managed.js', { exports: {
  fetchPrettyBundleFile: (...args) => { requests.push(['bundle', ...args]); return answer(args[2]) },
  fetchPrettyNpmFiles: (name, version, onLine) => {
    requests.push(['npm', name, version])
    return new Promise((end, fail) => { npmRequests.push({ send: onLine, end, fail }) })
  },
  fetchPrettyNpmFile: (...args) => { requests.push(['npm file', ...args]); return answer(args[3]) },
  fetchPrettyBundleChanges: (id, other, onLine) => lines('bundle changes', id, other, onLine),
  fetchPrettyNpmChanges: (name, version, otherVersion, onLine) => lines('npm changes', name, version, otherVersion, onLine),
} })
const { comparedCopy, prettyCopy: copyOf, prettyPrintable, prettySettled, togglePrettySource } = await import('../ui/view/pretty-source.js')
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
// An npm version's details, its files' texts, which carry no hashes.
const npmOf = files => ({ integrity: `sha512-npm-${++serial}`, kind: 'sourcemap', npm: { name: '@scope/lib', version: '2.0.0' },
  json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) } })
const MISMATCH = "The server's copy is of another file than the one open."
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
  npmRequests.length = 0
  changeRequests.length = 0
  renders = []
})

// Two managed bundles of a comparison, and a side's file asked for, as
// Compare asks whatever the toggle.
function comparisonOf(baseFiles, otherFiles) {
  const base = { ...bundleOf(baseFiles), managedId: 'bundle-1' }, other = { ...bundleOf(otherFiles), managedId: 'bundle-2' }
  const painted = renders
  const copy = (side, path, content = (side === 'base' ? baseFiles : otherFiles)[path]) => comparedCopy(base, other, side, path, content, () => painted.push(`${side} ${path}`))
  return { base, other, copy }
}

test('a comparison\'s changed files come in one request, both sides\', whether or not the toggle is on, each checked against its side\'s file, one it brought none of asked for alone', async () => {
  const { copy } = comparisonOf({ 'a.js': readable, 'b.min.js': minified, 'c.js': 'c' }, { 'a.js': `${readable}a`, 'b.min.js': `${minified}b`, 'c.js': 'cc' })
  assert.equal(state.bundleSourcePretty, false)
  assert.deepEqual(['base a.js', 'other a.js', 'base b.min.js', 'other b.min.js'].map(asked => copy(...asked.split(' ')).status), ['loading', 'loading', 'loading', 'loading'])
  assert.deepEqual(requests, [['bundle changes', 'bundle-1', 'bundle-2']], 'one request for both sides\' files, the toggle off')
  const [asked] = changeRequests
  const settledBefore = prettySettled()
  await asked.send({ side: 'base', path: 'a.js', source: hashOf(readable), text: 'export const a = 1;\n' })
  await asked.send({ side: 'other', path: 'a.js', source: hashOf(readable), text: 'export const a = 1;\n' })
  await asked.send({ side: 'base', path: 'b.min.js', source: hashOf(minified), status: 422, message: "This file couldn't be read as code." })
  // A side named as neither, its copy of no file of either.
  await asked.send({ side: '__proto__', path: 'c.js', source: hashOf('c'), text: 'c;\n' })
  assert.deepEqual(copy('base', 'a.js'), { status: 'ready', text: 'export const a = 1;\n', hash: hashOf('export const a = 1;\n') })
  assert.deepEqual(copy('other', 'a.js'), { status: 'error', message: MISMATCH, retry: true }, 'one naming another file than its side\'s is refused')
  assert.deepEqual(copy('base', 'b.min.js'), { status: 'error', message: "This file couldn't be read as code.", retry: false })
  assert.equal(copy('other', 'b.min.js').status, 'loading', 'one still coming waits')
  assert.equal(prettySettled(), settledBefore + 4)
  await settledUntil(() => renders.length > 0)
  assert.deepEqual(renders, ['other b.min.js'], 'the view that asked repaints once, for copies that come close together')
  asked.end()
  await settledUntil(() => renders.length > 1)
  answers.push('var b = 2;\n', 'c;\n')
  assert.deepEqual(copy('other', 'b.min.js'), { status: 'loading' }, 'one it brought none of, asked for alone once it ended')
  assert.deepEqual(copy('base', 'c.js'), { status: 'loading' }, 'one under a side named as neither too')
  assert.deepEqual(requests.slice(1), [['bundle', 'bundle-2', 'b.min.js', hashOf(`${minified}b`)], ['bundle', 'bundle-1', 'c.js', hashOf('c')]])
  await settledUntil(() => copy('other', 'b.min.js').status === 'ready')
  assert.equal(copy('other', 'b.min.js').text, 'var b = 2;\n')
  assert.deepEqual(copy('base', 'a.js', `${readable}x`), { status: 'error', message: MISMATCH, retry: false }, 'a text other than its side\'s file has none')
  assert.equal(requests.length, 3)
})

test('an npm comparison\'s changed files are asked of the two versions', async () => {
  const files = { 'a.min.js': minified }
  const [base, other] = [npmOf(files), { ...npmOf(files), npm: { name: '@scope/lib', version: '3.0.0' } }]
  assert.equal(comparedCopy(base, other, 'other', 'a.min.js', minified, () => {}).status, 'loading')
  assert.deepEqual(requests, [['npm changes', '@scope/lib', '2.0.0', '3.0.0']])
  await changeRequests[0].send({ side: 'other', path: 'a.min.js', source: hashOf(minified), text: 'var a = 1;\n' })
  await settledUntil(() => comparedCopy(base, other, 'other', 'a.min.js', minified, () => {}).status === 'ready')
  assert.equal(comparedCopy(base, other, 'other', 'a.min.js', minified, () => {}).text, 'var a = 1;\n', 'checked against a file it hashes itself')
  changeRequests[0].end()
  await settled()
  answers.push('var a = 1;\n')
  assert.equal(comparedCopy(base, other, 'base', 'a.min.js', minified, () => {}).status, 'loading')
  await settledUntil(() => requests.length > 1)
  assert.deepEqual(requests[1], ['npm file', '@scope/lib', '2.0.0', 'a.min.js', hashOf(minified)], 'one it brought none of asked of its version alone')
  await settledUntil(() => comparedCopy(base, other, 'base', 'a.min.js', minified, () => {}).status === 'ready')
})

test('a comparison\'s request that fails fails each file, and is asked again whole as the toggle turns on where that may succeed', async () => {
  const { copy } = comparisonOf({ 'a.js': readable }, { 'a.js': `${readable}a` })
  assert.equal(copy('base', 'a.js').status, 'loading')
  changeRequests[0].fail(Object.assign(new Error('The server is busy.'), { status: 503 }))
  await settledUntil(() => copy('base', 'a.js').status === 'error')
  assert.deepEqual(copy('base', 'a.js'), { status: 'error', message: 'The server is busy.', retry: true })
  assert.equal(requests.length, 1, 'not asked again unasked')
  togglePrettySource()
  assert.equal(copy('base', 'a.js').status, 'loading', 'turned on, asked again')
  assert.equal(requests.length, 2)
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

test('an npm version\'s copies come in one request, all its files that need it, each as it comes', async () => {
  const files = { 'a.min.js': minified, 'b.min.js': `${minified}b`, 'c.min.js': `${minified}c`, 'd.min.js': `${minified}d`, 'index.js': readable }
  const npm = npmOf(files)
  const copy = path => prettyCopy(npm, { npm: npm.npm }, path, files[path])
  assert.equal(copy('a.min.js'), null, 'off by default')
  togglePrettySource()
  assert.deepEqual(['a.min.js', 'b.min.js', 'c.min.js', 'd.min.js'].map(path => copy(path).status), ['loading', 'loading', 'loading', 'loading'])
  assert.deepEqual(requests, [['npm', '@scope/lib', '2.0.0']], 'one request for them all')
  const asked = npmRequests[0]
  const settledBefore = prettySettled()
  await asked.send({ path: 'a.min.js', source: hashOf(minified), text: 'var a = 1;\n' })
  assert.deepEqual(renders, ['a.min.js'], 'the view that asked repaints as each comes')
  assert.deepEqual(copy('a.min.js'), { status: 'ready', text: 'var a = 1;\n', hash: hashOf('var a = 1;\n') }, 'with its own hash')
  assert.equal(copy('b.min.js').status, 'loading', 'one still coming waits')
  assert.equal(prettySettled(), settledBefore + 1, 'counted as come, for a view to tell its own work stale by')
  await asked.send({ path: 'b.min.js', source: hashOf('another file'), text: 'var b = 2;\n' })
  assert.deepEqual(copy('b.min.js'), { status: 'error', message: MISMATCH, retry: true }, 'one the server names as another file\'s is refused')
  await asked.send({ path: 'c.min.js', source: hashOf(`${minified}c`), status: 422, message: "This file couldn't be read as code." })
  assert.deepEqual(copy('c.min.js'), { status: 'error', message: "This file couldn't be read as code.", retry: false })
  asked.end()
  await settledUntil(() => renders.length === 4)
  assert.deepEqual(copy('d.min.js'), { status: 'error', message: "The server didn't pretty-print this file.", retry: false }, 'one it brought none of')
  assert.deepEqual(prettyCopy(npm, { npm: npm.npm }, 'a.min.js', `${minified}x`), { status: 'error', message: MISMATCH, retry: false },
    'a text other than the version\'s file has none')
  togglePrettySource()
  togglePrettySource()
  assert.equal(copy('a.min.js').status, 'loading', 'turned back on, a version is asked again whole where a copy failed for a reason that may pass')
  assert.equal(requests.length, 2)
  npmRequests[1].end()
  await settledUntil(() => copy('a.min.js').status !== 'loading')
})

test('an npm version\'s request that fails fails each file, and is asked again whole where that may succeed', async () => {
  togglePrettySource()
  const files = { 'a.min.js': minified }
  const npm = npmOf(files)
  const copy = () => prettyCopy(npm, { npm: npm.npm }, 'a.min.js', minified)
  copy()
  npmRequests[0].fail(Object.assign(new Error('Too many packages are loading. Try again shortly.'), { status: 429 }))
  await settledUntil(() => copy().status !== 'loading')
  assert.deepEqual(copy(), { status: 'error', message: 'Too many packages are loading. Try again shortly.', retry: true })
  assert.deepEqual(renders, ['a.min.js'])
  togglePrettySource()
  togglePrettySource()
  assert.equal(copy().status, 'loading')
  assert.equal(requests.length, 2, 'asked again whole')
  await npmRequests[1].send({ path: 'a.min.js', source: hashOf(minified), text: 'var a = 1;\n' })
  npmRequests[1].end()
  assert.equal(copy().text, 'var a = 1;\n')
  const gone = npmOf(files)
  prettyCopy(gone, { npm: gone.npm }, 'a.min.js', minified)
  npmRequests[2].fail(Object.assign(new Error('No such package version, or it is not available to you.'), { status: 404 }))
  await settledUntil(() => prettyCopy(gone, { npm: gone.npm }, 'a.min.js', minified).status !== 'loading')
  togglePrettySource()
  togglePrettySource()
  assert.equal(prettyCopy(gone, { npm: gone.npm }, 'a.min.js', minified).retry, false, 'one that is not there stays so')
  assert.equal(requests.length, 3)
})

test('an npm version\'s request a session change aborted is asked again on the next paint', async () => {
  togglePrettySource()
  const npm = npmOf({ 'a.min.js': minified })
  const copy = () => prettyCopy(npm, { npm: npm.npm }, 'a.min.js', minified)
  copy()
  npmRequests[0].fail(new DOMException('Managed session changed', 'AbortError'))
  await settled()
  assert.deepEqual(renders, [], 'an aborted request paints nothing')
  assert.equal(copy().status, 'loading')
  assert.equal(requests.length, 2)
  npmRequests[1].end()
  await settledUntil(() => copy().status !== 'loading')
})

test('bundle copies are asked of the server two at a time, the rest in turn as they were asked', async () => {
  togglePrettySource()
  const files = Array.from({ length: 4 }, (_, i) => `h${i}.min.js`)
  const details = bundleOf(Object.fromEntries(files.map((path, i) => [path, `${minified}${i}`])))
  const comes = []
  for (let i = 0; i < files.length; i++) answers.push(new Promise(resolve => { comes.push(resolve) }))
  for (const [i, path] of files.entries()) prettyCopy(details, managed, path, `${minified}${i}`)
  await settledUntil(() => requests.length === 2)
  await settled()
  assert.deepEqual(requests.map(([, , path]) => path), ['h0.min.js', 'h1.min.js'])
  comes[1]('copy 1')
  await settledUntil(() => requests.length === 3)
  assert.equal(requests[2][2], 'h2.min.js', 'the next as one came')
  for (const [i, come] of comes.entries()) come(`copy ${i}`)
  await settledUntil(() => renders.length === files.length)
  assert.equal(requests.length, 4)
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
