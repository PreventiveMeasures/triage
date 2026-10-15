import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { beginViewNavigation } from '../ui/view/view-navigation.js'

const state = {}
const requests = []
let answer = null
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryCode(repoId, commit, path) { requests.push([repoId, commit, path]); return answer(repoId, commit, path) },
  fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { openRepositoryCodeRoute, repositoryCodeDetails, repositoryCodeEntries, repositoryCodeEntry, repositoryCodeRoute } = await import('../ui/view/repository-code.js')
const { bundleFileGithub } = await import('../ui/view/bundle-file-github.js')
const { ManagedRepositoryCode } = await import('../ui/managed/repository-code.js')

const commit = 'c'.repeat(40)
const data = {
  repoId: 7, repo: 'org/repo', commit, path: 'packages/app', tree: 't'.repeat(40),
  files: [['README.md', 6, '# app\n'], ['logo.png', 4, null, 'sha256-png'], ['src/index.js', 10, 'export {}\n']],
}

beforeEach(() => {
  beginViewNavigation()
  requests.length = 0
  answer = () => Promise.resolve(data)
  Object.assign(state, { currentView: 'manage-code', bundles: [], bundleDetails: null, selectedBundle: null, bundleDetailsTab: 'overview',
    bundleSourceFile: null, bundleCodeFileRequest: null, repositoryCodeOpening: null, reports: [], currentManagedTeam: 'team', managedSession: { id: 's', role: 'manage' } })
  globalThis.document = { body: { classList: { remove() {} } }, querySelector: () => null }
})

test('a directory\'s route names its repository by id, the commit, its path and the tab, Code by default', () => {
  const route = { view: 'repository-code', repoId: 7, commit, path: 'packages/my app', bundleTab: 'code', file: 3, line: 4, endLine: 9 }
  const path = managedRoutePath(route)
  assert.equal(path, `/manage/code/7/${commit}/code/3?path=packages/my%20app#L4-L9`)
  assert.deepEqual(parseManagedRoute(new URL(path, 'https://triage.test')), route)
  assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code' }), `/manage/code/7/${commit}`)
  assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'treemap' }), `/manage/code/7/${commit}/treemap`)
  assert.deepEqual(parseManagedRoute(new URL(`https://triage.test/manage/code/7/${commit}/search`)),
    { view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'search' })
  for (const bad of [{ commit: 'abc' }, { repoId: 0 }, { path: '../x' }, { path: 'a//b' }, { path: ' a' }, { bundleTab: 'compare' }]) {
    assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code', ...bad }), null, JSON.stringify(bad))
  }
  for (const bad of [`/manage/code/7/${commit}/search/2`, `/manage/code/7/${commit.toUpperCase()}`, `/manage/code/7/${commit}?path=a/./b`, `/manage/code/x/${commit}`]) {
    assert.equal(parseManagedRoute(new URL(bad, 'https://triage.test')), null, bad)
  }
  // The page picking one, with the repository a link picks.
  assert.equal(managedRoutePath({ view: 'manage-code', codeRepoId: 7 }), '/manage/code?repo=7')
  assert.deepEqual(parseManagedRoute(new URL('https://triage.test/manage/code?repo=7')), { view: 'manage-code', codeRepoId: 7 })
  assert.deepEqual(parseManagedRoute(new URL('https://triage.test/manage/code?repo=-1')), { view: 'manage-code' })
})

test('a directory shows as a bundle of its files, text alone as source, opening on its readme, its files linked on GitHub at the commit', () => {
  const entry = repositoryCodeEntry(data)
  assert.deepEqual(entry, { integrity: `repository:7:${commit}:packages/app`, kind: 'sourcemap', name: 'org/repo/packages/app@ccccccc', size: 20,
    repository: { repoId: 7, repo: 'org/repo', commit, path: 'packages/app' } })
  const details = repositoryCodeDetails(entry, data)
  assert.deepEqual([...bundleSourcesAsMap(details)], [['README.md', '# app\n'], ['src/index.js', 'export {}\n']])
  assert.deepEqual([...details.npmBinaries], [['logo.png', { size: 4, digest: 'sha256-png' }]])
  assert.deepEqual(details.npmEntries, ['README.md'])
  assert.deepEqual(repositoryCodeEntries(['docs/README.md', 'README', 'readme.md', 'index.js']), ['readme.md'])
  assert.deepEqual(repositoryCodeEntries(['index.js']), [])
  assert.equal(bundleFileGithub(details, 'src/index.js').href, `https://github.com/org/repo/blob/${commit}/packages/app/src/index.js`)
  assert.equal(bundleFileGithub(repositoryCodeDetails(repositoryCodeEntry({ ...data, path: '' }), data), 'src/index.js').href,
    `https://github.com/org/repo/blob/${commit}/src/index.js`)
  assert.deepEqual(repositoryCodeRoute(entry, 'overview'), { view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'code' })
})

test('opening a directory shows it in the bundle view, its header while it opens, at the file its route names', async () => {
  const rendered = []
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'code', file: 2, line: 4, repo: 'org/repo' },
    () => true, () => rendered.push([state.currentView, state.repositoryCodeOpening]))
  assert.deepEqual(requests, [[7, commit, 'packages/app']])
  assert.deepEqual(rendered, [['repository-code', { repoId: 7, commit, path: 'packages/app', tab: 'code', repo: 'org/repo', error: null }], ['bundles', null]])
  assert.equal(state.currentView, 'bundles')
  assert.equal(state.selectedBundle, `repository:7:${commit}:packages/app`)
  assert.equal(state.bundleDetailsTab, 'code')
  assert.deepEqual(state.bundleCodeFileRequest, { bundle: `repository:7:${commit}:packages/app`, file: 2, line: 4 })
  assert.equal(state.currentManagedTeam, null)
  assert.equal(managedRoutePath(route), `/manage/code/7/${commit}/code/2?path=packages/app#L4`)

  // Another tab of the directory shown keeps it, without asking again.
  const details = state.bundleDetails
  const search = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'search' }, () => true, () => {})
  assert.equal(requests.length, 1)
  assert.equal(state.bundleDetails, details)
  assert.equal(managedRoutePath(search), `/manage/code/7/${commit}/search?path=packages/app`)

  // A file picked by its path, as the code page picks one, opens Code on it.
  state.currentView = 'manage-code'
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'code', filePath: 'src/index.js' }, () => true, () => {})
  assert.deepEqual(state.bundleCodeFileRequest, { bundle: `repository:7:${commit}:packages/app`, path: 'src/index.js' })
})

test('a directory that fails to open says why where it would show, at its route; one given up, or for a navigation moved on, opens nothing', async () => {
  answer = () => Promise.reject(Object.assign(new Error('This directory is too large to open here.'), { status: 413 }))
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'treemap' }, () => true, () => {})
  assert.deepEqual(route, { view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'treemap' })
  assert.equal(state.currentView, 'repository-code')
  assert.deepEqual(state.repositoryCodeOpening, { repoId: 7, commit, path: '', tab: 'treemap', repo: null, error: 'This directory is too large to open here.' })
  answer = () => Promise.resolve({ ...data, path: 'elsewhere' })
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app' }, () => true, () => {})
  assert.equal(state.repositoryCodeOpening.error, 'The server answered with another directory.')
  answer = () => Promise.resolve(data)
  assert.equal(await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app' }, () => false, () => {}), false)
  assert.notEqual(state.currentView, 'bundles')
  answer = () => Promise.reject(new DOMException('Managed session changed', 'AbortError'))
  assert.equal(await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app' }, () => true, () => {}), false)
})

test('the code page opens the directory browsed at its commit, or Code on a file of it, and none its grants reach only part of', () => {
  const page = new ManagedRepositoryCode()
  const opened = []
  page.dispatchEvent = event => { opened.push(event.detail); return true }
  page._repos = [{ repoId: 7, fullName: 'org/repo' }]
  page._repoId = 7
  page._refName = 'main'
  page.useDirectory({ path: 'packages', commit: commit.toUpperCase(), entries: [{ name: 'app', path: 'packages/app', type: 'dir' }], limited: false, scoped: true }, 'packages')
  page.open()
  assert.deepEqual(opened, [], 'a directory the reader\'s grants reach only part of opens none')
  page.useDirectory({ path: 'packages/app', commit: commit.toUpperCase(), entries: [{ name: 'index.js', path: 'packages/app/index.js', type: 'file' }], limited: false }, 'packages/app')
  page.open('packages/app/index.js')
  assert.deepEqual(opened, [{ repoId: 7, repo: 'org/repo', commit, path: 'packages/app', file: 'index.js' }])
  page._opening = false
  page.open()
  assert.deepEqual(opened[1], { repoId: 7, repo: 'org/repo', commit, path: 'packages/app' })
})
