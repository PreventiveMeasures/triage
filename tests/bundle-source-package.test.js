import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundlePackageSourceStats, bundleSourcePackageInfo } from '../ui/view/bundle-source-package.js'
import { bundleSourceCodeLineCount, bundleSourceLineCount } from '../common/bundle-metadata.js'

test('package tooltip metadata prefers recorded identities and reads GitHub from captured npm manifests', () => {
  for (const repository of ['org/repo', 'github:org/repo', 'git+https://github.com/org/repo.git#main', 'git@github.com:org/repo.git', 'ssh://git@github.com/org/repo.git', { url: 'https://github.com/org/repo', directory: 'packages/dep' }]) {
    const info = { name: 'actual-package', version: '2.0.0', files: { 'package.json': JSON.stringify({ name: 'stale-name', version: '1.0.0', repository }) } }
    assert.deepEqual(bundleSourcePackageInfo({ name: 'installed-alias' }, info, 12), {
      ecosystem: 'npm', name: 'actual-package', version: '2.0.0', github: 'org/repo', ...(repository.directory ? { directory: repository.directory } : {}), fileCount: 12,
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
  // As Stasis records it, only a package.json's `repository` names the
  // repository; `bugs` and `homepage` often keep an old name. Composer
  // manifests name theirs in those fields.
  const fields = { homepage: 'org/not-a-homepage', bugs: { url: 'https://github.com/org/actual/issues' } }
  assert.equal(bundleSourcePackageInfo({ name: 'pkg' }, { files: { 'package.json': JSON.stringify(fields) } }, 1).github, null)
  assert.equal(bundleSourcePackageInfo({ name: 'org/pkg' }, { ecosystem: 'composer', files: { 'composer.json': JSON.stringify(fields) } }, 1).github, 'org/actual')
})

test('recorded dependency repositories link packages without a captured manifest', () => {
  assert.equal(bundleSourcePackageInfo({ name: 'dep' }, { name: 'dep', version: '1.0.0', repo: { github: 'org/dep', directory: 'packages/dep' }, files: { 'index.js': '' } }, 1).github, 'org/dep')
  const files = { 'package.json': JSON.stringify({ repository: 'org/manifest' }) }
  assert.equal(bundleSourcePackageInfo({ name: 'dep' }, { repo: { github: 'org/recorded' }, files }, 1).github, 'org/recorded')
  assert.equal(bundleSourcePackageInfo({ name: 'dep' }, { repo: { github: 'not a repo' }, files }, 1).github, 'org/manifest')
})

test('package tooltips carry the repository directory a record or captured package.json places them in', () => {
  const at = info => {
    const { github, directory } = bundleSourcePackageInfo({ name: 'dep' }, info, 1)
    return [github, directory]
  }
  assert.deepEqual(at({ repo: { github: 'org/dep', directory: 'packages/dep' }, files: {} }), ['org/dep', 'packages/dep'])
  assert.deepEqual(at({ repo: { github: 'org/dep', directory: '' }, files: {} }), ['org/dep', ''])
  assert.deepEqual(at({ repo: { github: 'org/dep' }, files: {} }), ['org/dep', undefined])
  const manifest = (json, text = JSON.stringify(json)) => ({ files: { 'package.json': text } })
  assert.deepEqual(at(manifest({ repository: { url: 'git+https://github.com/org/mono.git', directory: './packages\\dep/' } })), ['org/mono', 'packages/dep'])
  assert.deepEqual(at(manifest({ repository: { url: 'https://github.com/org/mono', directory: './' } })), ['org/mono', ''])
  assert.deepEqual(at(manifest({ repository: { url: 'https://github.com/org/mono', directory: 'a/../b' } })), ['org/mono', undefined])
  assert.deepEqual(at(manifest({ repository: 'org/mono', homepage: 'https://github.com/org/mono/tree/main/packages/dep#readme' })), ['org/mono', 'packages/dep'])
  assert.deepEqual(at(manifest({ repository: 'org/mono', homepage: 'https://github.com/org/mono/tree/main/.' })), ['org/mono', undefined])
  assert.deepEqual(at(manifest(null, `\uFEFF${JSON.stringify({ repository: { url: 'github:org/bom', directory: 'lib' } })}`)), ['org/bom', 'lib'])
  // A recorded repository wins over the manifest, directory included.
  assert.deepEqual(at({ repo: { github: 'org/recorded' }, ...manifest({ repository: { url: 'org/manifest', directory: 'lib' } }) }), ['org/recorded', undefined])
})

test('package tooltips carry the commit a recorded repository pins, as its files link to', () => {
  const commit = 'a'.repeat(40)
  const at = info => bundleSourcePackageInfo({ name: 'dep' }, info, 1).commit
  assert.equal(at({ repo: { github: 'org/dep', directory: 'packages/dep', commit }, files: {} }), commit)
  assert.equal(at({ repo: { github: 'org/dep', commit: 'b'.repeat(64) }, files: {} }), 'b'.repeat(64))
  assert.equal(at({ repo: { github: 'org/dep', commit: 'main' }, files: {} }), undefined)
  assert.equal(at({ repo: { github: 'org/dep' }, files: {} }), undefined)
  // A captured manifest's repository names no commit, nor does an unusable record.
  const files = { 'package.json': JSON.stringify({ repository: 'org/manifest' }) }
  assert.equal(at({ files }), undefined)
  assert.equal(at({ repo: { github: 'not a repo', commit }, files }), undefined)
})

test('lines of code leave out blank lines and keep comments, by the line breaks the Overview counts', () => {
  for (const [content, loc] of [
    ['', 0], ['\n\n', 0], ['  \t\n \r\n', 0], ['a', 1], ['a\n', 1], ['a\n\nb', 2],
    ['// note\n/* block */\ncode()\n', 3], ['a\r\n\r\n  b  \r\n', 2], ['a\rb\r\r', 2], ['\uFEFF\n\u00A0\nx', 1],
  ]) assert.equal(bundleSourceCodeLineCount(content), loc, JSON.stringify(content))
  assert.equal(bundleSourceCodeLineCount(null), 0)
  // The Overview's count still includes the blank ones.
  assert.equal(bundleSourceLineCount('a\n\nb'), 3)
})

test('package stats weigh only the sources under the package, in bytes and non-blank lines of code', () => {
  const sources = new Map([
    ['node_modules/dep/index.js', '// a\n\nb\n'],
    ['node_modules/dep/lib/é.js', 'é'],
    ['node_modules/dep/empty.js', ''],
    ['node_modules/dep-extra/index.js', 'not\n\nmine\n'],
    ['src/app.js', 'app'],
  ])
  const stats = bundlePackageSourceStats(sources, 'node_modules/dep')
  // '// a\n\nb\n' is 8 bytes and 2 LoC (the comment counts, the blank line does not), 'é' 2 bytes and 1 LoC.
  assert.deepEqual(stats, { bytes: 10, loc: 3 })
  assert.equal(bundlePackageSourceStats(sources, 'node_modules/dep'), stats, 'kept after the first hover')
  assert.deepEqual(bundlePackageSourceStats(sources, 'node_modules/dep-extra'), { bytes: 10, loc: 2 })
  assert.deepEqual(bundlePackageSourceStats(new Map(), 'node_modules/dep'), { bytes: 0, loc: 0 }, 'kept per bundle')
})
