import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleSourcePackageInfo } from '../ui/view/bundle-source-package.js'

test('package tooltip metadata prefers recorded identities and reads GitHub from captured npm manifests', () => {
  for (const repository of ['org/repo', 'github:org/repo', 'git+https://github.com/org/repo.git#main', 'git@github.com:org/repo.git', 'ssh://git@github.com/org/repo.git', { url: 'https://github.com/org/repo', directory: 'packages/dep' }]) {
    const info = { name: 'actual-package', version: '2.0.0', files: { 'package.json': JSON.stringify({ name: 'stale-name', version: '1.0.0', repository }) } }
    assert.deepEqual(bundleSourcePackageInfo({ name: 'installed-alias' }, info, 12), {
      ecosystem: 'npm', name: 'actual-package', version: '2.0.0', github: 'org/repo', fileCount: 12,
    })
  }
})

test('Composer and Soldeer tooltips read their captured repository metadata', () => {
  const composer = { name: 'org/php', ecosystem: 'composer', files: { 'composer.json': JSON.stringify({ support: { source: 'https://github.com/org/php/tree/main' } }) } }
  assert.equal(bundleSourcePackageInfo({ name: 'org/php' }, composer, 1).github, 'org/php')
  const soldeer = { name: '@openzeppelin-contracts', version: '5.2.0', ecosystem: 'soldeer', files: { 'package.json': JSON.stringify({ name: '@openzeppelin/contracts', version: '0.0.0', repository: 'OpenZeppelin/openzeppelin-contracts' }) } }
  assert.deepEqual(bundleSourcePackageInfo({ name: soldeer.name }, soldeer, 4), {
    ecosystem: 'soldeer', name: '@openzeppelin-contracts', version: '5.2.0', github: 'OpenZeppelin/openzeppelin-contracts', fileCount: 4,
  })
})

test('Cargo repository metadata comes from the package table, not comments or dependencies', () => {
  const files = { 'Cargo.toml': `
# repository = "https://github.com/wrong/comment"
[package]
name = "rust-dep"
version = "1.0.0"
repository = 'https://github.com/org/rust-dep'
[package.metadata]
repository = "https://github.com/wrong/metadata"
` }
  const info = bundleSourcePackageInfo({ name: 'rust-dep', ecosystem: 'cargo' }, { files }, 8)
  assert.equal(info.github, 'org/rust-dep')
  assert.equal(info.version, '1.0.0')
  files['Cargo.toml'] = '[package]\nrepository = { workspace = true }'
  assert.equal(bundleSourcePackageInfo({ name: 'rust-dep', ecosystem: 'cargo' }, { files }, 8).github, null)
})

test('missing or malformed manifests leave optional package details absent', () => {
  for (const files of [{}, { 'package.json': '{broken' }, { 'package.json': 'null' }, { 'package.json': { resource: true } }]) {
    assert.deepEqual(bundleSourcePackageInfo({ name: 'pkg' }, { files }, 1), {
      ecosystem: 'npm', name: 'pkg', version: undefined, github: null, fileCount: 1,
    })
  }
  assert.equal(bundleSourcePackageInfo({ name: 'pkg', ecosystem: 'cargo' }, { files: { 'Cargo.toml': '[broken' } }, 1).github, null)
  assert.equal(bundleSourcePackageInfo({ name: 'pkg', version: '1.0.0' }, null, 2).version, '1.0.0')
})

test('non-GitHub and malformed manifest URLs never become GitHub repositories', () => {
  for (const url of ['https://gitlab.com/org/repo', 'https://github.com.evil.test/org/repo', 'javascript:alert(1)', 'example.org/docs']) {
    for (const field of ['repository', 'homepage']) {
      const files = { 'package.json': JSON.stringify({ [field]: url }) }
      assert.equal(bundleSourcePackageInfo({ name: 'pkg' }, { files }, 1).github, null)
    }
  }
  const files = { 'package.json': JSON.stringify({ homepage: 'org/not-a-homepage', bugs: { url: 'https://github.com/org/actual/issues' } }) }
  assert.equal(bundleSourcePackageInfo({ name: 'pkg' }, { files }, 1).github, 'org/actual')
})
