import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleOriginLinks } from '../ui/view/bundle-origin-links.js'

test('bundle origins link GitHub directories at the recorded commit and scoped npm versions', () => {
  const commit = 'a'.repeat(40)
  assert.deepEqual(bundleOriginLinks({
    repo: { github: 'org/repo', directory: 'packages/app', commit },
    package: { npm: { name: '@org/app', version: '1.2.3-beta.5+build' } },
  }), [
    { label: 'GitHub', text: 'org/repo/packages/app', href: `https://github.com/org/repo/tree/${commit}/packages/app`,
      commit: { hash: commit, text: 'aaaaaaa', href: `https://github.com/org/repo/commit/${commit}` } },
    { label: 'npm', text: '@org/app@1.2.3-beta.5+build', href: 'https://www.npmjs.com/package/@org/app/v/1.2.3-beta.5%2Bbuild' },
  ])
})

test('origins work independently with optional versions, commits and directories', () => {
  assert.deepEqual(bundleOriginLinks({ repo: { github: 'org/repo', root: true } }), [
    { label: 'GitHub', text: 'org/repo', href: 'https://github.com/org/repo' },
  ])
  assert.equal(bundleOriginLinks({ repo: { github: 'org/repo', directory: 'app' } })[0].href, 'https://github.com/org/repo/tree/HEAD/app')
  assert.deepEqual(bundleOriginLinks({ package: { npm: { name: 'app' } } }), [
    { label: 'npm', text: 'app', href: 'https://www.npmjs.com/package/app' },
  ])
})

test('missing or invalid origin names do not produce external links', () => {
  for (const bundle of [null, {}, { repo: { github: 'javascript:alert(1)' } },
    { package: { npm: { name: '../app' } } }, { package: { cargo: { name: 'app' } } }]) {
    assert.deepEqual(bundleOriginLinks(bundle), [])
  }
})

test('commit links show seven characters, use the full commit URL and reject malformed hashes', () => {
  for (const length of [40, 64]) {
    const hash = '0123456789abcdef'.repeat(4).slice(0, length)
    assert.deepEqual(bundleOriginLinks({ repo: { github: 'org/repo', commit: hash } })[0].commit,
      { hash, text: '0123456', href: `https://github.com/org/repo/commit/${hash}` })
  }
  for (const commit of [undefined, '', 'abcdef0', '../tree/main', 'z'.repeat(40)]) {
    assert.equal(bundleOriginLinks({ repo: { github: 'org/repo', commit } })[0].commit, undefined)
  }
})
