import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyChangeSet, parseDiff } from '@preventive/diff'
import { unifiedDiff, unifiedSections } from '../ui/view/bundle-compare-unified.js'
import { comparisonFileList } from '../ui/view/bundle-compare-files.js'
import { prepareComparison } from '../common/bundle-comparison.js'

// A version's files, as npm-package.js reads them (bundle-sources.js
// fileRowDetails): text, or a digest in place of what isn't.
const version = (integrity, files) => ({ integrity, kind: 'sourcemap', size: 0,
  json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files).map(text => typeof text === 'string' ? text : null) },
  fileSizes: new Map(), npmBinaries: new Map(Object.entries(files).filter(([, text]) => typeof text !== 'string').map(([path, digest]) => [path, digest])) })
const rowsOf = (before, after) => {
  const [base, other] = [version('sha512-a', before), version('sha512-b', after)]
  return comparisonFileList(base, other, prepareComparison(base, other)).toSorted((a, b) => a.path.localeCompare(b.path))
}

// Each file's text after the diff, as a patch tool takes it to the base's files.
function applied(text, files) {
  const out = new Map(Object.entries(files))
  for (const file of parseDiff(text)) {
    const [from, to] = [file.old, file.new].map(name => name === '/dev/null' ? null : name.replace(/^[ab]\//u, ''))
    const result = applyChangeSet(from === null ? '' : out.get(from), file.blocks)
    if (from !== null) out.delete(from)
    if (to !== null) out.set(to, result)
  }
  return Object.fromEntries([...out].toSorted(([a], [b]) => a.localeCompare(b)))
}

test('a comparison of text is one diff as diff -ruN prints it, each file under its paths, a renamed one removed and added', () => {
  const before = { 'lib/index.js': '1\n2\n3\n4\n5\n6\n7\n8\n9\n', 'gone.js': 'bye\n', 'old.js': 'kept\nas is\n', 'crlf.txt': 'a\r\nb\r\n' }
  const after = { 'lib/index.js': '1\n2\n3\nfour\n5\n6\n7\n8\nnine', 'new file.js': 'hi\n', 'moved.js': 'kept\nas is\n', 'crlf.txt': 'a\r\nc\r\n' }
  const rows = rowsOf(before, after)
  assert.deepEqual(rows.filter(row => row.kind === 'renamed').map(row => [row.basePath, row.path]), [['old.js', 'moved.js']], 'the comparison pairs a moved file')
  const text = unifiedDiff(unifiedSections(rows))
  assert.equal(text, [
    '--- a/crlf.txt', '+++ b/crlf.txt', '@@ -1,2 +1,2 @@', ' a\r', '-b\r', '+c\r',
    '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    '--- a/lib/index.js', '+++ b/lib/index.js', '@@ -1,9 +1,9 @@', ' 1', ' 2', ' 3', '-4', '+four', ' 5', ' 6', ' 7', ' 8', '-9', '+nine', '\\ No newline at end of file',
    '--- a/old.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-kept', '-as is',
    '--- /dev/null', '+++ b/moved.js', '@@ -0,0 +1,2 @@', '+kept', '+as is',
    '--- /dev/null', '+++ b/new file.js\t', '@@ -0,0 +1 @@', '+hi', '',
  ].join('\n'), 'a path with a space ends in a tab, for patch to read it whole')
  assert.deepEqual(applied(text, before), Object.fromEntries(Object.entries(after).toSorted(([a], [b]) => a.localeCompare(b))))
})

test('a file whose contents read the same writes nothing, and an empty one added or removed its headers alone', () => {
  const rows = [{ path: 'same.js', kind: 'changed', modified: false, before: 'x\n', after: 'x\n' },
    { path: 'routed.js', kind: 'repointed', before: '‮', after: '‮' }]
  assert.deepEqual(unifiedSections(rows), [], 'nothing to copy, and what is not in it not asked of')
  assert.equal(unifiedDiff(unifiedSections([{ path: 'empty.js', kind: 'added', before: '', after: '' }, { path: 'blank.js', kind: 'removed', before: '', after: '' }])),
    '--- /dev/null\n+++ b/empty.js\n--- a/blank.js\n+++ /dev/null\n')
})

test('a diff of anything but text, of a character the viewer boxes or of a path no header holds is none', () => {
  const text = { path: 'index.js', kind: 'changed', before: 'a\n', after: 'b\n' }
  assert.equal(unifiedSections(rowsOf({ 'logo.png': { size: 3, digest: 'one' } }, { 'logo.png': { size: 3, digest: 'two' } })), null, 'bytes not UTF-8')
  assert.equal(unifiedSections([text, { path: 'logo.png', kind: 'added', before: '', after: { format: 'digest', size: 3, digest: 'two' } }]), null)
  for (const after of ['if (x‮) {}\n', 'a b\n', `x${String.fromCodePoint(0xE0041)}\n`, 'lone \uD800\n', '﻿a\n', 'a​b\n', 'a\rb\n', 'last\r']) {
    assert.equal(unifiedSections([text, { ...text, after }]), null, JSON.stringify(after))
  }
  assert.equal(unifiedSections([{ ...text, before: 'a‮\n', after: 'b‮\n' }]), null, 'in the lines no hunk shows too')
  for (const path of ['a\tb.js', 'a\nb.js', 'a‮.js', 'a​.js']) assert.equal(unifiedSections([{ ...text, path }]), null, JSON.stringify(path))
  assert.equal(unifiedSections([{ ...text, after: '👩\u{1F3FD}‍💻 ❤️\n' }]).length, 1, 'an emoji\'s joiners and selectors are text')
})
