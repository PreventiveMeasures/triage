import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmDependencyFlagTags } from '../ui/view/npm-dependency-checks.js'
import { npmDependencyFlags, npmDependencyUnimported, npmFlagDependencyChanges } from '../risk/npm/dependencies.js'
import { npmAlias, npmDependencySource, npmRegistrySpec } from '../risk/npm/specs.js'
import { templateText as text } from './_lit.js'

// A version's details: its files, by path, and its manifest.
const version = (files, manifest = {}, number = '1.1.0') => ({
  json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) }, npm: { name: 'pkg', version: number, manifest },
})

// Specs npm fetches from elsewhere than its registry, with where from, as
// npm-package-arg 12 resolves a dependency's spec, hosted-git-info reading a
// repository's host for it: checked against it over every combination of
// scheme, user, host and path, and random specs, before these were written.
const FROM_ELSEWHERE = [
  ['https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz', 'URL'], ['http://github.com/component/bind/archive/0.0.1.tar.gz', 'URL'],
  ['https:example.com/pkg.tgz', 'URL'], ['HTTP:example.com/pkg.tgz', 'URL'], ['https://github.com/a/b/archive/v1.tar.gz', 'URL'],
  ['git+https://example.com/x.git', 'git'], ['git://example.com/a/b.git#v1', 'git'], ['git+rsync://example.com/x.git', 'git'], ['git+ssh://git@example.com:a/b.git', 'git'],
  // A repository on a host npm knows, named for it, in any of the forms it takes.
  ['git+https://github.com/ethereumjs/ethereumjs-abi.git', 'GitHub'], ['git://github.com/a/b.git#v1', 'GitHub'], ['git+ssh://git@github.com:a/b.git', 'GitHub'],
  ['ssh://git@github.com/org/repo.git', 'GitHub'], ['SSH://github.com/org/repo', 'GitHub'], ['ssh://git@www.github.com/org/repo.git', 'GitHub'], ['https://github.com/a/b', 'GitHub'],
  ['git@github.com:a/b.git', 'GitHub'], ['github:web3-js/WebSocket-Node#polyfill/globalThis', 'GitHub'], ['GitHub:a/b', 'GitHub'], ['gitlab:a/b', 'GitLab'],
  ['git@gitlab.com:group/sub/repo.git', 'GitLab'], ['bitbucket:a/b', 'Bitbucket'], ['gist:11081aaa281', 'Gist'], ['sourcehut:~user/repo', 'SourceHut'], ['git@git.sr.ht:~u/repo', 'SourceHut'],
  ['git@gist.github.com:11081aaa281', 'Gist'], ['LearnBoost/socket.io-parser.git#e2fb6e', 'GitHub'], ['a/b', 'GitHub'], ['a/b#feat/x:y', 'GitHub'],
]

test('a dependency npm fetches from elsewhere than its registry is told by its spec', () => {
  for (const [spec, source] of FROM_ELSEWHERE) assert.equal(npmDependencySource(spec), source, spec)
  for (const spec of ['^1.2.3', '1.x', '>=1.0.0 <2', '1.0.0 || 2.0.0', '*', '', 'latest', 'npm:@scope/real@^1.0.0', 'npm:other', 'file:../x', 'link:../x',
    './x', '../x', '~/x', '/x', 'c:\\x', 'workspace:*', 'catalog:', '@scope/name', 'a/b/c', 'a/', 'a b/c',
    // Nor what npm doesn't install, or reads as a path: a git+ protocol it
    // doesn't know, ssh: or git@host:path on a host it doesn't know (or
    // SourceHut's over ssh:, which it doesn't take).
    'git+foo://example.com/x.git', 'ssh://git@example.com/org/repo.git', 'ssh://git@git.sr.ht/~u/repo', 'git@example.com:org/repo.git', 'user@host.example.com:path/repo.git',
    'SSH://git@github.com/a/b.git', 'git@GITHUB.COM:a/b', 'git@github.com:a',
  ]) assert.equal(npmDependencySource(spec), null, spec)
})

test('a dependency npm installs from its registry is told by its spec, as npm-package-arg reads it', () => {
  for (const spec of ['^1.2.3', '1.x', '>=1.0.0 <2', '1.0.0 || 2.0.0', '1.2.3 - 2', '*', '', 'latest', ' ^1.0.0 ', 'npm:@scope/real@^1.0.0', 'npm:other', 'NPM:other']) {
    assert.equal(npmRegistrySpec(spec), true, spec)
  }
  // Not a path (`file:`, `./x`, any with a `/`, a tarball's name), a
  // repository, a URL, nor what npm doesn't install: the registry's package
  // of that name isn't what npm installs for any.
  for (const spec of ['file:../x', 'FILE:x', './x', '../x', '.x', '~/x', '/x', 'c:/x', 'a/b/c', 'a/', '@scope/name', 'x.tgz', 'x.tar.gz', 'x.TAR',
    'github:a/b', 'a/b', 'a/b#v1', 'git@github.com:a/b.git', 'git+ssh://git@example.com:a/b.git', 'git://example.com/a/b.git', 'https://example.com/x.tgz', 'https:example.com/x.tgz',
    'workspace:*', 'link:../x', 'catalog:', 'jsr:@std/path', 'portal:../x']) {
    assert.equal(npmRegistrySpec(spec), false, spec)
  }
  // Every one npm fetches from elsewhere (npmDependencySource) among them,
  // as one reading of a spec answers both.
  for (const [spec] of FROM_ELSEWHERE) assert.equal(npmRegistrySpec(spec), false, spec)
})

test('an npm: alias names a package and its spec, as npm reads it', () => {
  assert.deepEqual(npmAlias('npm:@scope/real@^1.0.0'), { name: '@scope/real', spec: '^1.0.0' })
  assert.deepEqual(npmAlias(' NPM:other '), { name: 'other', spec: '' }, 'any case, trimmed, with no spec')
  for (const spec of ['^1.0.0', 'github:a/b', 'npm:', 'npm:a/b/c']) assert.equal(npmAlias(spec), null, spec)
})

// What DefinitelyTyped's stub of a package's types holds beside its package.json.
const STUB_FILES = { 'README.md': '# Stub', LICENSE: 'MIT License' }

test('a dependency nothing of a version imports is one no code file names as an import would, nor an install script', () => {
  const unimported = (files, name, manifest, kind = null) => npmDependencyUnimported(version(files, manifest), { name, kind })
  assert.equal(unimported({ 'lib/axios.js': 'import utils from "./utils.js"\n// plain-crypto-js\nconst x = plainCryptoJs' }, 'plain-crypto-js'), true,
    'nor in a comment, nor as a word')
  for (const code of ['require(\'dep\')', 'import x from "dep"', 'import("dep/sub.js")', 'export * from `dep`', '@import "~dep/scss/x";',
    'declare module \'dep\' {}', '/// <reference types="dep" />']) assert.equal(unimported({ 'index.js': code }, 'dep'), false, code)
  assert.equal(unimported({ 'index.js': 'require("dep-two")' }, 'dep'), true, 'another package')
  assert.equal(unimported({ 'index.js': 'require("@scope/dep")' }, 'dep'), true, 'another, in a scope')
  assert.equal(unimported({ 'binding.gyp': '"include_dirs": ["<!(node -e \\"require(\'nan\')\\")"]' }, 'nan'), false, 'binding.gyp\'s, its quotes escaped')
  // A build for the platform it runs on, its name built from a part of it.
  assert.equal(unimported({ 'dist/native.js': 'require(`@rollup/rollup-${platform}-${arch}`)' }, '@rollup/rollup-linux-x64-gnu', {}, 'optional'), false)
  assert.equal(unimported({ 'lib/getExePath.js': 'const name = "@typescript/" + expected' }, '@typescript/typescript-linux-x64', {}, 'optional'), false)
  assert.equal(unimported({ 'dist/native.js': 'require(`@rollup/rollup-${platform}`)' }, '@napi-rs/lzma-linux-x64-gnu', {}, 'optional'), true, 'not another\'s')
  assert.equal(unimported({ 'index.js': '' }, 'prebuild-install', { installScripts: { install: 'prebuild-install || node-gyp rebuild' } }), false,
    'an install script naming it')
  assert.equal(unimported({ 'index.js': '', 'binding.gyp': '{}' }, 'node-gyp'), false, 'node-gyp, run for a binding.gyp')
  assert.equal(unimported({ 'index.js': '' }, 'install', { installScripts: { install: 'prebuild-install' } }), true, 'not as part of another word')
  const setup = { installScripts: { postinstall: 'node node_modules/@scope/foo/setup.js && node scripts/bar.js' } }
  assert.equal(unimported({ 'index.js': '' }, '@scope/foo', setup), false, 'the package a path into node_modules leads into')
  assert.equal(unimported({ 'index.js': '' }, 'foo', setup), true, 'not a scope\'s package of its name')
  assert.equal(unimported({ 'index.js': '' }, 'bar', setup), true, 'nor a file of the package\'s own')
  assert.equal(unimported({ 'index.js': '' }, 'foo', { installScripts: { install: 'node node_modules/foo/install.js' } }), false)
  // Not files no import is read from: prose, source maps, lockfiles, its own package.json.
  for (const path of ['README.md', 'docs/guide.txt', 'CHANGELOG', 'HISTORY.md', 'LICENSE-MIT', 'README.org', 'LICENSE-LGPL2.1', 'CHANGES.2.0', 'dist/index.js.map',
    'npm-shrinkwrap.json', 'package.json']) {
    assert.equal(unimported({ [path]: 'require("dep")' }, 'dep'), true, path)
  }
  for (const path of ['lib/history.js', 'src/changes.ts', 'lib/readme-parser.js', 'dist/notice.min.js']) {
    assert.equal(unimported({ [path]: 'require("dep")' }, 'dep'), false, `${path}, code named as prose is`)
  }
  assert.equal(unimported({ 'docs/intro.mdx': 'import { Chart } from "dep"' }, 'dep'), false, 'MDX, prose that imports, is read')
  assert.equal(unimported({ 'lib/package.json': '{"dependencies":{"dep":"1"}}' }, 'dep'), false, 'another package.json is a file of it as any')
  assert.equal(unimported({ 'index.js': null }, 'dep'), true, 'a file that isn\'t text')
  assert.equal(unimported({ 'index.js': '' }, 'react-dom', {}, 'peer'), false, 'not a peer dependency')
  assert.equal(unimported({ 'index.js': '' }, '@types/node'), false, 'nor types')
  assert.equal(unimported({ 'index.js': 'var __awaiter = function () {}\n' }, 'tslib'), false, 'nor TypeScript\'s helpers, inlined')
  // DefinitelyTyped's stub, once a package has types of its own, depending
  // on it with no code: not that package from the registry.
  const stub = (types, files = STUB_FILES) => ({ ...version(files), npm: { name: types, version: '2.0.0', manifest: {} } })
  const dependsOn = (details, name, range) => npmDependencyUnimported(details, { name, kind: null, range })
  assert.equal(dependsOn(stub('@types/mkdirp'), 'mkdirp', '*'), false)
  assert.equal(dependsOn(stub('@types/babel__core'), '@babel/core', '*'), false, 'a scope\'s, by DefinitelyTyped\'s name for it')
  assert.equal(npmDependencyUnimported(stub('@types/mkdirp'), { name: 'mkdirp', kind: null, from: '^1.0.0', to: '*' }), false, 'a changed one by its new spec')
  assert.equal(dependsOn(stub('@types/mkdirp'), 'mkdirp', 'npm:mkdirp@^3.0.0'), false, 'an alias of itself')
  assert.equal(dependsOn(stub('@types/mkdirp'), 'plain-crypto-js', '*'), true, 'not another')
  assert.equal(dependsOn(stub('mkdirp-types'), 'mkdirp', '*'), true, 'nor for a package named otherwise')
  // Nor where npm installs another package by that name, or not the registry's.
  for (const spec of ['npm:plain-crypto-js@^4.2.1', 'github:evil/mkdirp', 'https://example.com/mkdirp.tgz', 'file:../mkdirp']) {
    assert.equal(dependsOn(stub('@types/mkdirp'), 'mkdirp', spec), true, spec)
  }
  // Nor for types with declarations of their own, which would import it.
  assert.equal(dependsOn(stub('@types/mkdirp', { ...STUB_FILES, 'index.d.ts': 'export declare function mkdirp(): void' }), 'mkdirp', '*'), true, 'types, not a stub')
  assert.equal(npmDependencyUnimported({ npm: {} }, { name: 'dep', kind: null }), false, 'nor where its files aren\'t read')
})

test('a dependency is flagged as from elsewhere than the registry, and as imported by nothing, saying why', () => {
  const details = version({ 'index.js': 'require("used")' }, {}, '1.4.2')
  assert.deepEqual(npmDependencyFlags(details, { name: 'ethereumjs-abi', kind: null, range: 'git+https://github.com/ethereumjs/ethereumjs-abi.git' }), [
    { check: 'source', label: 'non-registry', tooltip: 'From GitHub, not npm\'s registry: git+https://github.com/ethereumjs/ethereumjs-abi.git' },
    { check: 'unimported', label: 'unimported', tooltip: 'Nothing of 1.4.2 imports it: no code file names it as an import would, nor does an install script' },
  ])
  assert.deepEqual(npmDependencyFlags(details, { name: 'used', kind: null, range: 'github:a/used' }).map(({ tooltip }) => tooltip), ['From GitHub, not npm\'s registry: github:a/used'])
  assert.deepEqual(npmDependencyFlags(details, { name: 'used', kind: null, range: '^1.0.0' }), [])
  assert.deepEqual(npmDependencyFlags(null, { name: 'x', kind: null, range: 'http://example.com/x.tgz' }).map(({ check }) => check), ['source'], 'before its files are read')
  assert.match(text(npmDependencyFlagTags([{ check: 'source', label: 'non-registry', tooltip: 'From GitHub' }])),
    /^<span class=npm-dependency-flag is-source data-tooltip=From GitHub>non-registry<\/span>$/u)
})

test('Compare flags a dependency the open version takes from elsewhere anew, and one it adds that nothing of it imports', () => {
  // The one compared with, and the open one, as axios 1.14.1 and socket.io-client 1.0 had it.
  const base = version({}, { dependencies: { kept: 'github:a/kept', moved: '^1.0.0', bind: '^0.0.1' }, optionalDependencies: { promoted: '^2.0.0' } }, '1.14.0')
  const other = version({ 'index.js': 'require("kept"); require("moved"); require("socket.io-parser")' }, {}, '1.14.1')
  const changes = {
    removed: [{ key: '\0gone', name: 'gone', kind: null, range: 'github:a/gone', opens: null }],
    added: [
      { key: '\0plain-crypto-js', name: 'plain-crypto-js', kind: null, range: '^4.2.1', opens: 'plain-crypto-js' },
      { key: '\0socket.io-parser', name: 'socket.io-parser', kind: null, range: 'LearnBoost/socket.io-parser.git#e2fb6e', opens: null },
      { key: '\0promoted', name: 'promoted', kind: null, range: '^2.0.0', opens: 'promoted' },
      { key: 'peer\0react', name: 'react', kind: 'peer', range: '>=18', opens: 'react' },
    ],
    changed: [
      { key: '\0bind', name: 'bind', kind: null, from: '^0.0.1', to: 'http://github.com/component/bind/archive/0.0.1.tar.gz', opens: null },
      { key: '\0moved', name: 'moved', kind: null, from: '^1.0.0', to: '^2.0.0', opens: 'moved' },
    ],
  }
  const flagged = npmFlagDependencyChanges(changes, base, other)
  const checks = rows => rows.map(({ name, flags }) => [name, flags.map(({ check }) => check)])
  assert.deepEqual(checks(flagged.added), [['plain-crypto-js', ['unimported']], ['socket.io-parser', ['source']], ['promoted', []], ['react', []]],
    'imported by nothing, one it took as another kind before aside, and a peer one')
  assert.deepEqual(checks(flagged.changed), [['bind', ['source']], ['moved', []]], 'imported by nothing, but not new')
  assert.equal(flagged.removed, changes.removed, 'not one it drops')
  assert.equal(flagged.added[0].flags[0].tooltip, 'New in 1.14.1, and nothing of it imports it: no code file names it as an import would, nor does an install script')
  assert.equal(flagged.changed[0].flags[0].tooltip, 'From a URL, not npm\'s registry: http://github.com/component/bind/archive/0.0.1.tar.gz')
  // One it fetched from elsewhere before, by the same spec, though as another kind.
  const kept = npmFlagDependencyChanges({ removed: [], added: [{ key: 'optional\0kept', name: 'kept', kind: 'optional', range: 'github:a/kept' }], changed: [] }, base, other)
  assert.deepEqual(kept.added[0].flags, [])
})
