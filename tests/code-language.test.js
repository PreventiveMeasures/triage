import assert from 'node:assert/strict'
import { test } from 'node:test'
import { langForPath } from '../common/code-language.js'
import { sourceFileType } from '../ui/view/source-file-icon.js'
import { highlight } from '../ui/prism.js'

test('Stasis formats drive syntax and icons even without or despite a filename extension', () => {
  for (const [format, lang, icon] of [
    ['commonjs', 'javascript', 'js'], ['module', 'javascript', 'js'],
    ['commonjs-typescript', 'typescript', 'ts'], ['module-typescript', 'typescript', 'ts'],
    ['json', 'json', 'json'], ['solidity', 'solidity', 'solidity'],
    ['php', 'php', 'php'], ['rust', 'rust', 'rust'], ['shell', 'bash', 'generic'],
    ['java', 'java', 'generic'], ['objc', 'objectivec', 'generic'], ['objcpp', 'objectivec', 'generic'],
    ['c', 'c', 'generic'], ['c-header', 'c', 'generic'], ['cpp', 'cpp', 'generic'], ['cpp-header', 'cpp', 'generic'],
    ['ruby', 'ruby', 'generic'], ['podfile', 'ruby', 'generic'], ['podspec', 'ruby', 'generic'],
    ['fastlane', 'ruby', 'generic'], ['podfile-lock', 'yaml', 'generic'], ['xml', 'markup', 'generic'],
  ]) {
    for (const path of ['bin/example', 'misleading.py']) {
      assert.equal(langForPath(path, format), lang, `${format}: ${path}`)
      assert.equal(sourceFileType(path, format), icon, `${format}: ${path}`)
    }
  }
  assert.match(highlight('const value = require("example");', langForPath('bin/example', 'commonjs')), /class="token keyword">const/u)
})

test('missing and unrecognized formats fall back to filename detection', () => {
  for (const format of [undefined, null, '', 'future-format', 'constructor', '__proto__']) {
    for (const [path, lang, icon] of [['file.CJS', 'javascript', 'js'], ['file.tsx', 'tsx', 'ts'], ['file.py', 'python', 'python'], ['file.phtml', 'php', 'php'], ['README.md', 'markdown', 'markdown'], ['docs/GUIDE.MARKDOWN', 'markdown', 'markdown'], ['bin/example', null, 'generic']]) {
      assert.equal(langForPath(path, format), lang)
      assert.equal(sourceFileType(path, format), icon)
    }
  }
  for (const path of ['lib/index.js.map', 'dist/style.CSS.MAP']) assert.equal(sourceFileType(path), 'map', `${path}: a source map's own icon`)
  assert.equal(sourceFileType('lib/index.js.map', 'json'), 'json', 'a format names it first')
  for (const path of ['dir.js/example', 'dir/.js', 'file.constructor']) {
    assert.equal(langForPath(path), null)
    assert.equal(sourceFileType(path), 'generic')
  }
})

test('a .map file is JSON when its text is an object, whitespace aside', () => {
  for (const content of ['{"version":3,"sources":[]}', '\n  {\n  "mappings": ""\n}\n', '\uFEFF{}']) {
    assert.equal(langForPath('dist/index.js.map', undefined, content), 'json', JSON.stringify(content))
    assert.equal(langForPath('DIST/INDEX.JS.MAP', undefined, content), 'json')
  }
  for (const content of [undefined, null, '', '{', '}', ' { ', '[1, 2]', 'export default {}', '{"a": 1}\n// tail', 'not json']) {
    assert.equal(langForPath('dist/index.js.map', undefined, content), null, JSON.stringify(content))
  }
  assert.equal(langForPath('dist/index.map.js', undefined, '{}'), 'javascript', 'only the last extension counts')
  assert.equal(langForPath('dist/index.js.map', 'commonjs', '{}'), 'javascript', 'a recorded format still wins')
})

test('license files wear the license icon by name, when they are text', () => {
  for (const path of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.BSD', 'license', 'Licence', 'node_modules/pkg/LICENSE-MIT',
    'COPYING', 'COPYING.LESSER', 'copying.txt', 'UNLICENSE', 'Unlicense.md', 'COPYING.LIB', 'LICENSE.Apache-2.0', 'LICENSE.APACHE2', 'LICENSE.GPLv3',
    'LICENSE.BSD-3-Clause', 'LICENSE.0BSD', 'LICENSE.2.0', 'LICENSE-2.0.txt', 'LICENSE-MIT.txt', 'LICENSE.mit.md']) {
    assert.equal(sourceFileType(path), 'license', path)
  }
  for (const [path, icon] of [['lib/license.js', 'js'], ['license.ts', 'ts'], ['LICENSE.json', 'json'], ['copying.py', 'python'], ['licensed.txt', 'generic'],
    ['LICENSES/MIT.txt', 'generic'], ['LICENSES', 'generic'], ['my-license', 'generic'], ['copyright', 'generic'], ['license.svg', 'generic'],
    ['LICENSE.pdf', 'generic'], ['docs/license.PNG', 'generic'], ['COPYING.gz', 'generic'], ['UNLICENSE.docx', 'generic'],
    ['lib/license.js.map', 'map'], ['LICENSE.map', 'map'], ['COPYING.MAP', 'map'],
    ['license.go', 'generic'], ['COPYING.cs', 'generic'], ['license.swift', 'generic'], ['pkg/license-checker.go', 'generic'], ['license.libsonnet', 'generic'],
    ['LICENSE.asc', 'generic'], ['LICENSE-MIT.sig', 'generic']]) {
    assert.equal(sourceFileType(path), icon, path)
  }
  assert.equal(sourceFileType('LICENSE', 'commonjs'), 'js', 'a recorded format still wins')
  assert.equal(sourceFileType('LICENSE', 'resource'), 'license', 'a Stasis resource stored as text')
  for (const format of ['resource:base64', 'directory', 'binary']) assert.equal(sourceFileType('LICENSE', format), 'generic', `not text: ${format}`)
})
