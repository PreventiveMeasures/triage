import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeSpan } from '../ui/view/code-span.js'

// A path that links nowhere goes into an issue body as a code span: one
// that holds any text as written, backticks and edge spaces included.
test('a code span holds its text as written', () => {
  assert.equal(codeSpan('node_modules/@scope/pkg/a.js:3'), '`node_modules/@scope/pkg/a.js:3`')
  assert.equal(codeSpan('a`b'), '``a`b``')
  assert.equal(codeSpan('a``b`c'), '```a``b`c```')
  assert.equal(codeSpan('`a'), '`` `a ``')
  assert.equal(codeSpan('a`'), '`` a` ``')
  assert.equal(codeSpan(' a '), '`  a  `')
  assert.equal(codeSpan(' a'), '` a`')
  assert.equal(codeSpan('  '), '`  `')
  assert.equal(codeSpan(''), '')
})
