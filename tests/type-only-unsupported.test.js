// A server whose Node proves nothing to change in types alone (its type
// stripping not as @preventive/compare's proof holds it to, as amaro 1.2's is
// not) refuses a comparison of TypeScript files, 501 proof-unsupported, before
// any line is streamed, rather than telling it as one where none changed in
// types alone: an empty answer, and no switch to hide them.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { computeFileHash } from '@preventive/report'

const compare = await import('@preventive/compare')
mock.module('@preventive/compare', { namedExports: { ...compare, proveTypeOnly: () => ({ proven: false, reason: 'unsupported', at: null }) } })
const { proofUnsupported, typeOnlyFiles } = await import('../server-managed/type-only.ts')

// A comparison's side of `files` by path, as the pretty-print cache reads one.
async function side(name, files) {
  const list = await Promise.all(Object.entries(files).map(async ([path, text]) => ({ path, hash: await computeFileHash(text), extension: path.split('.').at(-1), text })))
  return { side: name, files: list, hashes: new Map(list.map(file => [file.path, file.hash])), packageDirs: null }
}

test('a Node that proves nothing refuses a comparison of TypeScript files, logged once, and leaves one of none alone', async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  const typed = await Promise.all([side('base', { 'a.d.ts': 'export type A = 1;\n', 'b.js': 'x\n' }), side('other', { 'a.d.ts': 'export type A = 2;\n', 'b.js': 'y\n' })])
  for (const runs of [false, true]) assert.throws(() => typeOnlyFiles(typed, runs), { status: 501, message: 'proof-unsupported' }, 'refused before a line is streamed')
  assert.match(proofUnsupported(), /^Node v\d+\.\d+\.\d+, amaro /u)
  assert.equal(warn.mock.callCount(), 1, 'logged once, naming the Node')
  assert.match(warn.mock.calls[0].arguments[0], /no file can be proven to change in types alone on Node v/u)
  const plain = await Promise.all([side('base', { 'b.js': 'x\n' }), side('other', { 'b.js': 'y\n' })])
  const lines = []
  for await (const line of typeOnlyFiles(plain, true)) lines.push(line)
  assert.deepEqual(lines, [], 'none to prove, none refused')
})
