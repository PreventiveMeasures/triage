import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { beginViewNavigation } from '../ui/view/view-navigation.js'

const state = {}
const contentsRequests = [], navigations = [], requests = []
let answer = null, contents = null
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
mock.module('../ui/view/managed-history.js', { namedExports: { managedHistory: { active: true, navigate: route => { navigations.push(route) } } } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryCode(repoId, ref, path) { requests.push([repoId, ref, path]); return answer(repoId, ref, path) },
  fetchRepositoryContents(repoId, ref, path) { contentsRequests.push([repoId, ref, path]); return contents(repoId, ref, path) },
  fetchBrowsableRepositories: () => Promise.resolve([{ repoId: 7, fullName: 'org/repo' }, { repoId: 8, fullName: 'org/other' }]),
  fetchRepositoryRefs: () => Promise.resolve({ defaultBranch: 'main', branches: ['main', 'develop'], tags: ['v1'] }),
  fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { openRepositoryCodeRoute, repositoryCodeDetails, repositoryCodeEntries, repositoryCodeEntry, repositoryCodeRoute, shownRevision } = await import('../ui/view/repository-code.js')
const { bundleFileGithub } = await import('../ui/view/bundle-file-github.js')

const commit = 'c'.repeat(40)
const data = {
  repoId: 7, repo: 'org/repo', commit, path: 'packages/app', tree: 't'.repeat(40),
  files: [['README.md', 6, '# app\n'], ['logo.png', 4, null, 'sha256-png'], ['src/index.js', 10, 'export {}\n']],
}

let session = 0
beforeEach(() => {
  beginViewNavigation()
  requests.length = 0
  contentsRequests.length = 0
  navigations.length = 0
  answer = (repoId, ref, path) => Promise.resolve({ ...data, path })
  contents = () => Promise.resolve({ commit, entries: [] })
  // A session of its own each, so nothing kept from another test answers.
  Object.assign(state, { currentView: 'findings', bundles: [], bundleDetails: null, selectedBundle: null, bundleDetailsTab: 'overview',
    bundleSourceFile: null, bundleCodeFileRequest: null, repositoryCodeOpening: null, reports: [], currentManagedTeam: 'team',
    managedSession: { id: `s-${++session}`, role: 'manage' } })
  globalThis.document = { body: { classList: { remove() {} } }, querySelector: () => null }
})

test('a directory\'s route names its repository by id, the commit, its path and the tab, Code by default; without a commit, the repository alone', () => {
  const route = { view: 'repository-code', repoId: 7, commit, path: 'packages/my app', bundleTab: 'code', file: 3, line: 4, endLine: 9 }
  const path = managedRoutePath(route)
  assert.equal(path, `/manage/code/7/${commit}/code/3?path=packages/my%20app#L4-L9`)
  assert.deepEqual(parseManagedRoute(new URL(path, 'https://triage.test')), route)
  assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code' }), `/manage/code/7/${commit}`)
  assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'treemap' }), `/manage/code/7/${commit}/treemap`)
  assert.deepEqual(parseManagedRoute(new URL(`https://triage.test/manage/code/7/${commit}/search`)),
    { view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'search' })
  // A repository alone opens its default branch's head; a revision held in
  // memory (`ref`) opens there, the route its URL alone.
  assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7 }), '/manage/code/7')
  assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit: null, ref: 'heads/develop', path: 'src', bundleTab: 'search' }), '/manage/code/7?path=src')
  assert.deepEqual(parseManagedRoute(new URL('https://triage.test/manage/code/7')), { view: 'repository-code', repoId: 7, commit: null, path: '', bundleTab: 'code' })
  for (const bad of [{ commit: 'abc' }, { repoId: 0 }, { path: '../x' }, { path: 'a//b' }, { path: ' a' }, { bundleTab: 'compare' }]) {
    assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code', ...bad }), null, JSON.stringify(bad))
  }
  for (const bad of ['/manage/code', `/manage/code/7/${commit}/search/2`, `/manage/code/7/${commit.toUpperCase()}`, `/manage/code/7/${commit}?path=a/./b`,
    `/manage/code/x/${commit}`, '/manage/code/7/search']) {
    assert.equal(parseManagedRoute(new URL(bad, 'https://triage.test')), null, bad)
  }
})

test('a directory shows as a bundle of its files, text alone as source, opening on its readme, its files linked on GitHub at the commit', () => {
  const entry = repositoryCodeEntry(data)
  assert.deepEqual(entry, { integrity: `repository:7:${commit}:packages/app`, kind: 'sourcemap', name: 'org/repo/packages/app@ccccccc', size: 20,
    repository: { repoId: 7, repo: 'org/repo', commit, path: 'packages/app', revision: null } })
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

test('a repository alone opens its default branch\'s head, its route then naming the commit, and its header the default branch', async () => {
  const rendered = []
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, path: '', bundleTab: 'code' },
    () => true, () => rendered.push([state.currentView, state.repositoryCodeOpening?.revision]))
  assert.deepEqual(requests, [[7, '', '']])
  assert.deepEqual(rendered, [['repository-code', { kind: 'branch', name: null }], ['bundles', undefined]], 'its header shows while it opens')
  assert.equal(managedRoutePath(route), `/manage/code/7/${commit}`)
  const { repository } = state.bundles[0]
  assert.deepEqual(repository.revision, { kind: 'branch', name: null })
  assert.deepEqual(shownRevision(repository, null), { kind: 'branch', name: '' })
  assert.deepEqual(shownRevision(repository, { status: 'ready', value: { defaultBranch: 'main' } }), { kind: 'branch', name: 'main' })
  // Its commit's own route, as Back or a reload gives it, names it as it was opened.
  state.currentView = 'findings'
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code' }, () => true, () => {})
  assert.deepEqual(requests.at(-1), [7, commit, ''])
  assert.deepEqual(state.bundles[0].repository.revision, { kind: 'branch', name: null })
  // A commit no name opened shows as one.
  state.currentView = 'findings'
  const other = 'd'.repeat(40)
  answer = (repoId, ref, path) => Promise.resolve({ ...data, commit: other, path })
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: other, path: '', bundleTab: 'code' }, () => true, () => {})
  assert.deepEqual(shownRevision(state.bundles[0].repository, null), { kind: 'commit', name: other })
})

test('opening a directory shows it in the bundle view at the file its route names; another tab keeps it; another revision keeps it until it opens', async () => {
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'code', file: 2, line: 4, repo: 'org/repo' },
    () => true, () => {})
  assert.deepEqual(requests, [[7, commit, 'packages/app']])
  assert.equal(state.currentView, 'bundles')
  assert.equal(state.selectedBundle, `repository:7:${commit}:packages/app`)
  assert.deepEqual(state.bundleCodeFileRequest, { bundle: `repository:7:${commit}:packages/app`, file: 2, line: 4 })
  assert.equal(state.currentManagedTeam, null)
  assert.equal(managedRoutePath(route), `/manage/code/7/${commit}/code/2?path=packages/app#L4`)

  const details = state.bundleDetails
  const search = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'search' }, () => true, () => {})
  assert.equal(requests.length, 1)
  assert.equal(state.bundleDetails, details)
  assert.equal(managedRoutePath(search), `/manage/code/7/${commit}/search?path=packages/app`)

  // A branch picked in the header: the directory shown stays until it opens.
  const rendered = []
  const develop = 'e'.repeat(40)
  answer = (repoId, ref, path) => Promise.resolve({ ...data, commit: develop, path })
  const switched = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, ref: 'heads/develop', revision: { kind: 'branch', name: 'develop' },
    path: 'packages/app', bundleTab: 'search' }, () => true, () => rendered.push(state.currentView))
  assert.deepEqual(requests.at(-1), [7, 'heads/develop', 'packages/app'])
  assert.deepEqual(rendered, ['bundles'])
  assert.equal(managedRoutePath(switched), `/manage/code/7/${develop}/search?path=packages/app`)
  assert.deepEqual(state.bundles[0].repository.revision, { kind: 'branch', name: 'develop' })

  // A file picked by its path opens Code on it.
  state.currentView = 'findings'
  answer = (repoId, ref, path) => Promise.resolve({ ...data, path })
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'code', filePath: 'src/index.js' }, () => true, () => {})
  assert.deepEqual(state.bundleCodeFileRequest, { bundle: `repository:7:${commit}:packages/app`, path: 'src/index.js' })
})

test('a directory that fails to open says why at its route, and lists its directories to open instead where it is too large or has none to read', async () => {
  answer = () => Promise.reject(Object.assign(new Error('This directory is too large to open here.'), { status: 413, code: 'directory-too-large' }))
  contents = () => Promise.resolve({ commit, entries: [{ name: 'src', path: 'src', type: 'dir' }, { name: 'README.md', path: 'README.md', type: 'file' }, { name: 'docs', path: 'docs', type: 'dir' }] })
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, path: '', bundleTab: 'treemap' }, () => true, () => {})
  assert.deepEqual(route, { view: 'repository-code', repoId: 7, commit: null, path: '', bundleTab: 'treemap' })
  assert.equal(managedRoutePath(route), '/manage/code/7')
  assert.equal(state.currentView, 'repository-code')
  assert.equal(state.repositoryCodeOpening.error, 'This directory is too large to open here.')
  await setImmediate()
  assert.deepEqual(contentsRequests, [[7, '', '']])
  assert.deepEqual(state.repositoryCodeOpening.listing, { commit, directories: [{ name: 'docs', path: 'docs', type: 'dir' }, { name: 'src', path: 'src', type: 'dir' }] })

  // Any other failure lists none.
  answer = () => Promise.reject(Object.assign(new Error('GitHub couldn’t be reached.'), { status: 502, code: 'github-unreachable' }))
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'src', bundleTab: 'code' }, () => true, () => {})
  await setImmediate()
  assert.equal(contentsRequests.length, 1)
  assert.equal(state.repositoryCodeOpening.listing, undefined)

  answer = () => Promise.resolve({ ...data, path: 'elsewhere' })
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app' }, () => true, () => {})
  assert.equal(state.repositoryCodeOpening.error, 'The server answered with another directory.')
  answer = (repoId, ref, path) => Promise.resolve({ ...data, path })
  assert.equal(await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app' }, () => false, () => {}), false)
  assert.notEqual(state.currentView, 'bundles')
  answer = () => Promise.reject(new DOMException('Managed session changed', 'AbortError'))
  assert.equal(await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app' }, () => true, () => {}), false)
})

test('the header opens another repository at its default branch, another revision of the directory on the same tab, and a typed one on Enter alone', () => {
  const Source = customElements.get('repository-code-source')
  const header = new Source()
  header.repository = { repoId: 7, repo: 'org/repo', commit, path: 'packages/app', revision: { kind: 'branch', name: 'main' } }
  header.tab = 'search'
  const change = (how, kind, name) => header.revisionChanged({ detail: { how, kind, name } })
  change('pick', 'branch', 'develop')
  change('kind', 'tag', '')
  change('input', 'tag', 'v1')
  assert.deepEqual(header._edit, { kind: 'tag', name: 'v1' }, 'typing opens nothing')
  change('submit', 'tag', ' v1 ')
  change('submit', 'commit', 'xyz')
  change('submit', 'commit', 'ABCDEF1')
  change('submit', 'commit', 'F'.repeat(40))
  assert.deepEqual(navigations, [
    { view: 'repository-code', repoId: 7, commit: null, path: 'packages/app', bundleTab: 'search', ref: 'heads/develop', revision: { kind: 'branch', name: 'develop' }, repo: 'org/repo' },
    { view: 'repository-code', repoId: 7, commit: null, path: 'packages/app', bundleTab: 'search', ref: 'tags/v1', revision: { kind: 'tag', name: 'v1' }, repo: 'org/repo' },
    { view: 'repository-code', repoId: 7, commit: null, path: 'packages/app', bundleTab: 'search', ref: 'abcdef1', revision: { kind: 'commit', name: 'ABCDEF1' }, repo: 'org/repo' },
    { view: 'repository-code', repoId: 7, commit: 'f'.repeat(40), path: 'packages/app', bundleTab: 'search', repo: 'org/repo' },
  ], 'a commit that is not hex opens nothing; a full one opens by its own route')
})
