import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const state = {}
let advisoriesAnswer = () => Promise.resolve({ versions: [], advisories: [] })
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmAdvisories: name => advisoriesAnswer(name), fetchNpmStats: () => Promise.resolve({}),
  fetchNpmPackage() {}, fetchNpmVersions: () => Promise.resolve({ versions: [] }), fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { npmAdvisoryStatus, npmEncodingLabel, npmFileExtension, npmFileExtensions, npmTextEncoding } = await import('../ui/view/npm-overview.js')

test('a file\'s extension follows its name\'s last dot, a declaration file\'s whole', () => {
  for (const [path, extension] of [
    ['lib/index.js', '.js'], ['README.MD', '.md'], ['dist/a.min.js', '.js'], ['lib/index.js.map', '.map'],
    ['types/index.d.ts', '.d.ts'], ['index.d.mts', '.d.mts'], ['x.D.CTS', '.d.cts'], ['.d.ts', '.ts'],
    ['LICENSE', ''], ['.npmignore', ''], ['bin/cli', ''], ['dir.v2/file', ''], ['trailing.', '.'],
  ]) assert.equal(npmFileExtension(path), extension, path)
})

test('extensions list most files first, then by name, with their sizes summed', () => {
  const paths = ['a.js', 'b.js', 'c.js', 'README.md', 'LICENSE', 'x.d.ts', 'y.d.ts', 'logo.png']
  const sizes = new Map([['a.js', 10], ['b.js', 20], ['c.js', 5], ['README.md', 100], ['x.d.ts', 3], ['y.d.ts', 4], ['logo.png', 900]])
  assert.deepEqual(npmFileExtensions(paths, sizes), [
    { extension: '.js', files: 3, bytes: 35 },
    { extension: '.d.ts', files: 2, bytes: 7 },
    { extension: '', files: 1, bytes: 0 },
    { extension: '.md', files: 1, bytes: 100 },
    { extension: '.png', files: 1, bytes: 900 },
  ])
  assert.deepEqual(npmFileExtensions([], new Map()), [])
})

test('a file is ASCII or UTF-8 text, either with control characters, or binary', () => {
  const label = text => npmEncodingLabel(npmTextEncoding(text))
  assert.equal(label('const a = 1\n\tb\r\n'), 'ASCII', 'tab, line feed and carriage return are text')
  assert.equal(label('héllo — ✓ 😀'), 'UTF-8')
  assert.equal(label('\u001B[31mred\u001B[0m'), 'ASCII + controls')
  assert.equal(label('a\u000Cb\u000Bc\u007Fd'), 'ASCII + controls', 'form feed, vertical tab and DEL are controls')
  assert.equal(label('é\u0085'), 'UTF-8 + controls', 'C1 controls')
  assert.equal(label('if (admin) {‮ } ⁦// x⁩'), 'UTF-8 + controls', 'bidirectional controls')
  assert.equal(label('﻿bom and​zero width'), 'UTF-8', 'a BOM and zero-width characters are not controls')
  assert.equal(label(null), 'Binary')
  assert.deepEqual(npmTextEncoding('a\u001Bb\u001B‮'), { kind: 'utf8', controls: new Map([[0x1B, 2], [0x202E, 1]]) })
  assert.deepEqual(npmTextEncoding('plain'), { kind: 'ascii', controls: null })
})

test('an advisory affects the version shown, is fixed in it, or covers later versions only', () => {
  const versions = ['2.0.0', '1.2.0', '1.1.0', '1.0.0']
  const advisory = affected => ({ affected })
  assert.equal(npmAdvisoryStatus(advisory([2, 3]), versions, '1.1.0'), 'affects')
  assert.equal(npmAdvisoryStatus(advisory([2, 3]), versions, '1.2.0'), 'fixed')
  assert.equal(npmAdvisoryStatus(advisory([0]), versions, '1.2.0'), 'later')
  assert.equal(npmAdvisoryStatus(advisory([3]), versions, '2.0.0-beta.1'), 'fixed', 'a version not listed compares by semver')
  assert.equal(npmAdvisoryStatus(advisory([]), versions, '1.0.0'), 'later')
})

test('downloads group into 7-day weeks ending on the last day, a partial oldest week left out', async () => {
  const { niceCeiling, npmDownloadWeeks } = await import('../ui/view/npm-downloads-chart.js')
  const days = Array.from({ length: 16 }, (_, i) => i + 1)
  const weeks = npmDownloadWeeks({ start: '2026-01-01', end: '2026-01-16', days })
  assert.deepEqual(weeks.map(week => [week.from.toISOString().slice(0, 10), week.to.toISOString().slice(0, 10), week.total]), [
    ['2026-01-03', '2026-01-09', 3 + 4 + 5 + 6 + 7 + 8 + 9],
    ['2026-01-10', '2026-01-16', 10 + 11 + 12 + 13 + 14 + 15 + 16],
  ])
  assert.deepEqual(npmDownloadWeeks({ start: '2026-01-01', end: '2026-01-03', days: [1, 2, 3] }), [])
  assert.deepEqual(npmDownloadWeeks(null), [])
  assert.deepEqual([0, 1, 7, 12, 23, 180, 2600, 999_999].map(niceCeiling), [1, 1, 10, 20, 25, 200, 5000, 1_000_000])
})
