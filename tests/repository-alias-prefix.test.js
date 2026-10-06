import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import { commonFileDirectory, matchRepositoryAlias } from '../common/managed/repository-alias.ts'
import { bundleFilePrefix } from '../server-managed/bundle.ts'
import { resolveRepositoryImportLocation } from '../server-managed/repository-aliases.ts'

const alias = { oldRepo: 'org/c', oldPath: 'a', repoId: 1, newPath: 'projects/a' }

test('shared file prefixes map the whole directory only when the existing suffix can be preserved', () => {
  const resolve = (directory, prefix, overrides = {}) => matchRepositoryAlias('ORG/C', directory, [{ ...alias, ...overrides }], prefix)
  assert.deepEqual(resolve('', 'a'), { repoId: 1, directory: 'projects' })
  assert.deepEqual(resolve('', 'a/src'), { repoId: 1, directory: 'projects' })
  assert.deepEqual(resolve('old', 'a/src', { oldPath: 'old/a' }), { repoId: 1, directory: 'projects' })
  assert.deepEqual(resolve('', 'a', { newPath: 'a' }), { repoId: 1, directory: '' })
  assert.equal(resolve('', ''), null)
  assert.equal(resolve('', 'another'), null)
  assert.equal(resolve('', 'a', { newPath: 'projects/b' }), null)
  assert.equal(resolve('', 'a', { newPath: 'projects/ba' }), null)
  assert.equal(resolve('', 'a', { oldPath: 'old/a' }), null, 'a partial common suffix is insufficient when files would need rewriting')
  assert.equal(resolve('other', 'a'), null)
  assert.deepEqual(resolve('a/src', '', { newPath: 'projects/b' }), { repoId: 1, directory: 'projects/b/src' }, 'declared-directory mappings do not need a common suffix')
  const root = { ...alias, oldPath: '', repoId: 2, newPath: 'fallback' }
  for (const aliases of [[root, alias], [alias, root]]) {
    assert.deepEqual(matchRepositoryAlias('org/c', '', aliases, 'a/src'), { repoId: 1, directory: 'projects' })
    assert.deepEqual(matchRepositoryAlias('org/c', '', aliases, 'ab/src'), { repoId: 2, directory: 'fallback' })
  }
})

test('common directories include single files and stop at path boundaries without rewriting paths', () => {
  for (const [paths, prefix] of [
    [[], ''], [['a/x.js'], 'a'], [['a/src/x.js', 'a/src/y.js'], 'a/src'],
    [['a/x.js', 'a/icon.png'], 'a'], [['a/x.js', 'ab/x.js'], ''], [['a/x.js', 'README.md'], ''],
    [['a/../outside.js'], ''], [['./a/x.js'], ''], [['a//x.js'], ''], [['a\\x.js'], ''],
  ]) assert.equal(commonFileDirectory(paths), prefix)
  function* disjoint() { yield 'a/x'; yield 'b/y'; throw new Error('must stop once the prefix is empty') }
  assert.equal(commonFileDirectory(disjoint()), '')
})

test('inventory processing is skipped before decoding when no connected alias can benefit', async t => {
  const read = t.mock.fn(() => Promise.resolve('a/src'))
  const db = {
    listRepositoryAliases: () => Promise.resolve([alias]),
    listSelectedRepos: () => Promise.resolve([{ repoId: 1 }]),
    getRepositoryImportLocation: (_github, _directory, prefix) => prefix,
  }
  for (const overrides of [
    { oldRepo: 'org/other' }, { oldPath: '' }, { oldPath: 'another/a', newPath: 'projects/a' },
    { newPath: 'projects/b' }, { newPath: 'projects/ba' }, { newPath: '' },
  ]) {
    db.listRepositoryAliases = () => Promise.resolve([{ ...alias, ...overrides }])
    assert.equal(await resolveRepositoryImportLocation(db, 'org/c', '', read), '')
  }
  db.listRepositoryAliases = () => Promise.resolve([])
  assert.equal(await resolveRepositoryImportLocation(db, 'org/c', '', read), '')
  db.listRepositoryAliases = () => Promise.resolve([alias])
  assert.equal(await resolveRepositoryImportLocation(db, 'org/c', 'other', read), '')
  assert.equal(await resolveRepositoryImportLocation(db, 'org/c', 'a', read), '')
  db.listSelectedRepos = () => Promise.resolve([])
  assert.equal(await resolveRepositoryImportLocation(db, 'org/c', '', read), '')
  assert.equal(read.mock.callCount(), 0)
  db.listSelectedRepos = () => Promise.resolve([{ repoId: 1 }])
  assert.equal(await resolveRepositoryImportLocation(db, 'org/c', '', read), 'a/src')
  assert.equal(read.mock.callCount(), 1)
})

test('bundle prefixes include assets and module paths, exclude directory captures, and tolerate opaque uploads', async () => {
  const files = { 'a/index.js': 'export default 1', 'a/icon.png': 'AP8=', 'other-directory': ['file.js'] }
  const formats = new Map([['a/index.js', 'module'], ['a/icon.png', 'resource:base64'], ['other-directory', 'directory']])
  const encode = () => brotliCompressSync(Buffer.from(new Bundle({ repo: { github: 'org/c' }, config: { scope: 'full' },
    modules: new Map([['.', { name: 'app', files }]]), formats }).serialize()))
  assert.equal(await bundleFilePrefix(encode()), 'a')
  files['outside.png'] = 'not-valid-base64'
  formats.set('outside.png', 'resource:base64')
  assert.equal(await bundleFilePrefix(encode()), '', 'an asset outside the prefix prevents mapping, even when its body cannot be decoded')
  for (const value of [Buffer.from('not brotli'), brotliCompressSync(Buffer.from('{"repo":{"github":"org/c"}}'))]) {
    assert.equal(await bundleFilePrefix(value), '')
  }
  const nested = new Bundle({ config: { scope: 'full' }, modules: new Map([
    ['a', { name: 'app', files: { 'src/x.js': 'x', 'src/y.js': 'y' } }],
    ['a/node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'dep' } }],
  ]) })
  assert.equal(await bundleFilePrefix(brotliCompressSync(Buffer.from(nested.serialize()))), 'a')
})
