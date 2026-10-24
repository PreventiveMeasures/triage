import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleFileImporters } from '../ui/view/bundle-code-importers.js'

function stasis(files, imports) {
  return { kind: 'stasis', integrity: 'sha512-importers', bundle: new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files }]]), imports }) }
}

test('a Stasis file\'s importers are every file resolving an import to it, under any condition or platform, by path', () => {
  const details = stasis({
    'src/a.js': 'import x from "./lib.js"\n',
    'src/b.js': '// first\n// second\nconst lib = require(\'./lib.js\')\n',
    'src/native.js': 'import "./lib"\n',
    'src/lib.js': 'import "./lib.js"\nexport default 1\n',
    'src/other.js': 'export {}\n',
  }, new Map([
    ['node, import', new Map([['src/a.js', new Map([['./lib.js', 'src/lib.js']])], ['src/lib.js', new Map([['./lib.js', 'src/lib.js']])]])],
    ['node, require', new Map([['src/b.js', new Map([['./lib.js', 'src/lib.js']])], ['src/a.js', new Map([['./lib.js', 'src/lib.js']])]])],
    ['react-native', new Map([['src/native.js', new Map([['./lib', new Map([['ios', 'src/lib.js'], ['android', 'src/other.js']])]])],
      ['app/entry.js', new Map([['../src/lib.js', 'src/lib.js']])]])],
  ]))
  assert.deepEqual(bundleFileImporters(details, 'src/lib.js'), [
    { path: 'app/entry.js', specifiers: ['../src/lib.js'], held: false, line: null },
    { path: 'src/a.js', specifiers: ['./lib.js'], held: true, line: 1 },
    { path: 'src/b.js', specifiers: ['./lib.js'], held: true, line: 3 },
    { path: 'src/native.js', specifiers: ['./lib'], held: true, line: 1 },
  ], 'one row each, a file importing itself left out, one the bundle doesn\'t hold listed apart')
  assert.deepEqual(bundleFileImporters(details, 'src/other.js').map(importer => importer.path), ['src/native.js'], 'a platform\'s own target')
  assert.deepEqual(bundleFileImporters(details, 'src/a.js'), [], 'imported by none')
})

test('a sourcemap\'s importers are its edges\'; none is told where nothing records imports', () => {
  const map = { kind: 'sourcemap', integrity: 'sha512-map', json: { version: 3, sources: ['a.js', 'b.js'], sourcesContent: ['require("./b")\n', 'x\n'] },
    edges: [['a.js', 'b.js', './b'], ['c.js', 'b.js']] }
  assert.deepEqual(bundleFileImporters(map, 'b.js'), [
    { path: 'a.js', specifiers: ['./b'], held: true, line: 1 },
    { path: 'c.js', specifiers: [], held: false, line: null },
  ])
  const npm = { kind: 'sourcemap', integrity: 'lib@1.0.0', json: { version: 3, sources: ['a.js', 'b.js'], sourcesContent: ['require("./b")\n', 'x\n'] } }
  assert.equal(bundleFileImporters(npm, 'b.js'), null, 'an npm version or a repository records no imports')
  assert.equal(bundleFileImporters({ ...map, edges: [] }, 'b.js'), null)
  assert.equal(bundleFileImporters(stasis({ 'a.js': 'a' }, new Map()), 'a.js'), null, 'nor a bundle recording none')
})
