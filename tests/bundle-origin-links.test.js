import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleCommitTooltip, bundleOriginLinks } from '../ui/view/bundle-origin-links.js'

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

test('GitHub links use the displayed source prefix relative to the declared repository directory', () => {
  const commit = 'a'.repeat(40)
  const link = bundleOriginLinks({ repo: { github: 'org/repo', directory: 'packages/app', commit } }, 'src/')[0]
  assert.equal(link.href, `https://github.com/org/repo/tree/${commit}/packages/app/src`)
  assert.equal(link.text, 'org/repo/packages/app/src')
  assert.equal(link.commit.href, `https://github.com/org/repo/commit/${commit}`)
  assert.equal(bundleOriginLinks({ repo: { github: 'org/repo' } }, 'packages/my app/')[0].href,
    'https://github.com/org/repo/tree/HEAD/packages/my%20app')
})

test('a managed catalog adds the cached tags of the recorded commit after it, linked to their GitHub pages', () => {
  const commit = 'a'.repeat(40)
  const bundle = { repo: { github: 'org/repo', commit } }
  const tags = ['v1.0.0', 'release/2026 #1', '', 7]
  assert.deepEqual(bundleOriginLinks(bundle, '', { sha: commit, github: 'org/repo', tags, details: null })[0].commit.tags, [
    { name: 'v1.0.0', href: 'https://github.com/org/repo/releases/tag/v1.0.0' },
    { name: 'release/2026 #1', href: 'https://github.com/org/repo/releases/tag/release/2026%20%231' },
  ])
  const moved = bundleOriginLinks(bundle, '', { sha: commit, github: 'fork/renamed', tags: ['v1.0.0'], details: null })[0]
  assert.equal(moved.commit.href, `https://github.com/org/repo/commit/${commit}`)
  assert.deepEqual(moved.commit.tags, [{ name: 'v1.0.0', href: 'https://github.com/fork/renamed/releases/tag/v1.0.0' }],
    'tags link to the repository they were cached for, not the one the stamp names')
  for (const info of [null, { sha: 'b'.repeat(40), github: 'org/repo', tags }, { sha: commit, github: 'org/repo', tags: [] },
    { sha: commit, github: 'org/repo' }, { sha: commit, tags }, { sha: commit, github: 'javascript:alert(1)', tags }]) {
    assert.equal(Object.hasOwn(bundleOriginLinks(bundle, '', info)[0].commit, 'tags'), false)
  }
  assert.equal(bundleOriginLinks({ repo: { github: 'org/repo' } }, '', { sha: commit, github: 'org/repo', tags })[0].commit, undefined, 'tags need the recorded commit')
})

test('commit tooltips carry only what they show of the catalog details, for their own commit', () => {
  const sha = 'a'.repeat(40)
  const details = { subject: 'Fix the parser', authorName: 'Alice', authorLogin: 'alice', authoredAt: 1, committedAt: 2 }
  const info = { sha, github: 'Org/Repo', tags: ['v1', ''], details }
  assert.deepEqual(JSON.parse(bundleCommitTooltip(info, sha, 'org/repo')),
    { tags: ['v1'], title: 'Fix the parser', authorName: 'Alice', authorLogin: 'alice', date: 2 })
  assert.deepEqual(JSON.parse(bundleCommitTooltip({ ...info, details: null }, sha, 'Org/Repo')), { tags: ['v1'] })
  assert.equal(JSON.parse(bundleCommitTooltip({ ...info, tags: [], details: { ...details, committedAt: null } }, sha)).date, 1)
  for (const repository of [undefined, 'upstream/repo']) {
    assert.deepEqual(JSON.parse(bundleCommitTooltip(info, sha, repository)).tags, [],
      'tags show only beside the repository they were cached for; the commit details are the same in any')
  }
  const long = JSON.parse(bundleCommitTooltip({ ...info, details: { ...details, subject: '😀'.repeat(300) } }, sha)).title
  assert.equal(long, `${'😀'.repeat(199)}…`, 'a long subject is cut short, by whole characters')
  assert.equal(JSON.parse(bundleCommitTooltip({ ...info, details: { ...details, subject: 'x'.repeat(200) } }, sha)).title, 'x'.repeat(200))
  assert.equal(bundleCommitTooltip({ ...info, tags: [], details: { ...details, subject: undefined, message: 'Old' } }, sha), undefined, 'details carry a subject')
  assert.equal(bundleCommitTooltip({ ...info, details: null }, sha, 'upstream/repo'), undefined)
  assert.equal(bundleCommitTooltip({ ...info, github: undefined, details: null }, sha, 'org/repo'), undefined)
  for (const [commitInfo, hash] of [[info, 'b'.repeat(40)], [{ sha, tags: [], details: null }, sha], [null, sha], [{ ...info, details: null }, undefined]]) {
    assert.equal(bundleCommitTooltip(commitInfo, hash, 'org/repo'), undefined)
  }
})
