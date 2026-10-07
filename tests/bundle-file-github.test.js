import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleFileGithub } from '../ui/view/bundle-file-github.js'

const commit = 'a'.repeat(40)
function details(modules, repo) {
  const bundle = Bundle.parse(new Bundle({ modules: new Map(modules) }).serialize())
  if (repo !== undefined) bundle.repo = repo
  return { kind: 'stasis', bundle }
}
const app = ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'app', 'src/a b.js': 'space' } }]
const workspace = ['packages/lib', { name: 'lib', version: '1.0.0', files: { 'x.js': 'lib' } }]
const manifest = (name, repository) => ({ 'index.js': name, 'package.json': JSON.stringify({ name, version: '2.0.0', repository }) })

test('own files follow the bundle stamp at its directory and commit', () => {
  const pinned = details([app, workspace], { github: 'org/app', directory: 'apps/web', commit })
  assert.deepEqual(bundleFileGithub(pinned, 'src/index.js'), {
    href: `https://github.com/org/app/blob/${commit}/apps/web/src/index.js`, github: 'org/app', path: 'apps/web/src/index.js', commit, package: null,
  })
  assert.equal(bundleFileGithub(pinned, 'packages/lib/x.js').path, 'apps/web/packages/lib/x.js', 'workspace packages are own source')
  const root = details([app], { github: 'org/app', directory: '' })
  assert.equal(bundleFileGithub(root, 'src/a b.js').href, 'https://github.com/org/app/blob/HEAD/src/a%20b.js')
  // As the Overview's origin link reads the stamp, a directory it does not
  // record is the repository root; its commit still pins the link.
  assert.equal(bundleFileGithub(details([app], { github: 'org/app' }), 'src/index.js').href, 'https://github.com/org/app/blob/HEAD/src/index.js')
  assert.deepEqual(bundleFileGithub(details([app, workspace], { github: 'org/app', commit }), 'packages/lib/x.js'), {
    href: `https://github.com/org/app/blob/${commit}/packages/lib/x.js`, github: 'org/app', path: 'packages/lib/x.js', commit, package: null,
  })
  // No stamp places nothing.
  assert.equal(bundleFileGithub(details([app]), 'src/index.js'), null)
  assert.equal(bundleFileGithub(root, 'src/missing.js'), null)
  assert.equal(bundleFileGithub({ kind: 'sourcemap', json: {} }, 'src/index.js'), null)
})

test('dependency files link into their own repository and name their package, never the app repository', () => {
  const bundle = details([app,
    ['node_modules/recorded', { name: 'recorded', version: '1.2.3', repo: { github: 'org/mono', directory: 'packages/recorded', commit }, files: { 'lib/a.js': 'a' } }],
    ['node_modules/at-root', { name: 'at-root', version: '1.0.0', repo: { github: 'org/at-root', directory: '' }, files: { 'index.js': 'r' } }],
    ['node_modules/unplaced', { name: 'unplaced', version: '1.0.0', repo: { github: 'org/unplaced', commit }, files: { 'index.js': 'u' } }],
    ['node_modules/from-manifest', { name: 'from-manifest', version: '2.0.0', files: manifest('from-manifest', { url: 'github:org/mono', directory: 'packages/m' }) }],
    ['node_modules/no-repo', { name: 'no-repo', version: '1.0.0', files: { 'index.js': 'n' } }],
    ['node_modules/at-root/node_modules/nested', { name: 'nested', version: '3.0.0', repo: { github: 'org/nested', directory: 'pkg' }, files: { 'index.js': 'n' } }],
    ['vendor/org/php', { ecosystem: 'composer', name: 'org/php', version: '1.0.0', repo: { github: 'org/php' }, files: { 'src/A.php': '<?php' } }],
  ], { github: 'org/app', directory: '' })
  assert.deepEqual(bundleFileGithub(bundle, 'node_modules/recorded/lib/a.js'), {
    href: `https://github.com/org/mono/blob/${commit}/packages/recorded/lib/a.js`, github: 'org/mono', path: 'packages/recorded/lib/a.js', commit,
    package: { name: 'recorded', version: '1.2.3', ecosystem: 'npm' },
  })
  assert.equal(bundleFileGithub(bundle, 'node_modules/at-root/index.js').href, 'https://github.com/org/at-root/blob/HEAD/index.js')
  assert.equal(bundleFileGithub(bundle, 'node_modules/from-manifest/index.js').path, 'packages/m/index.js')
  assert.equal(bundleFileGithub(bundle, 'node_modules/at-root/node_modules/nested/index.js').href, 'https://github.com/org/nested/blob/HEAD/pkg/index.js', 'the nearest package places a file')
  for (const path of ['node_modules/unplaced/index.js', 'node_modules/no-repo/index.js', 'vendor/org/php/src/A.php']) {
    assert.equal(bundleFileGithub(bundle, path), null, path)
  }
})
