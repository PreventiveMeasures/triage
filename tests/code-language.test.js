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
    for (const [path, lang, icon] of [['file.CJS', 'javascript', 'js'], ['file.tsx', 'tsx', 'ts'], ['file.py', 'python', 'python'], ['file.phtml', 'php', 'php'], ['bin/example', null, 'generic']]) {
      assert.equal(langForPath(path, format), lang)
      assert.equal(sourceFileType(path, format), icon)
    }
  }
  for (const path of ['dir.js/example', 'dir/.js', 'file.constructor']) {
    assert.equal(langForPath(path), null)
    assert.equal(sourceFileType(path), 'generic')
  }
})
