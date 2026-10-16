import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { beginViewNavigation } from '../ui/view/view-navigation.js'

const state = {}
const contentsRequests = [], navigations = [], requests = []
let answer = null, contents = null, refsReads = 0
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
  fetchRepositoryRefs: () => { refsReads++; return Promise.resolve({ defaultBranch: 'main', branches: ['main', 'develop'], tags: ['v1'] }) },
  fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { openRepositoryCodeRoute, openRepositoryCodeTab, repositoryRefs, repositoryCodeDetails, repositoryCodeEntries, repositoryCodeEntry, repositoryCodePending, repositoryCodeRoute, shownRevision } = await import('../ui/view/repository-code.js')
const { bundleFileGithub } = await import('../ui/view/bundle-file-github.js')
const { repositoryCompareSource } = await import('../ui/view/repository-compare.js')
const { managedTabLocation } = await import('../ui/view/managed-bundle-navigation.js')

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
  for (const bad of [{ commit: 'abc' }, { repoId: 0 }, { path: '../x' }, { path: 'a//b' }, { path: ' a' }, { bundleTab: 'review' }, { bundleTab: 'compare', compareCommit: 'main' }]) {
    assert.equal(managedRoutePath({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code', ...bad }), null, JSON.stringify(bad))
  }
  // Compare names the commit compared with, then its mode past the Overview.
  const compared = { view: 'repository-code', repoId: 7, commit, path: 'src', bundleTab: 'compare', compareCommit: 'd'.repeat(40), compareMode: 'code' }
  assert.equal(managedRoutePath(compared), `/manage/code/7/${commit}/compare/${'d'.repeat(40)}/code?path=src`)
  assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(compared), 'https://triage.test')), compared)
  assert.equal(managedRoutePath({ ...compared, compareMode: undefined }), `/manage/code/7/${commit}/compare/${'d'.repeat(40)}?path=src`)
  assert.equal(managedRoutePath({ ...compared, bundleTab: 'search' }), `/manage/code/7/${commit}/search?path=src`, 'only Compare names one')
  for (const bad of ['/manage/code', `/manage/code/7/${commit}/search/2`, `/manage/code/7/${commit.toUpperCase()}`, `/manage/code/7/${commit}?path=a/./b`,
    `/manage/code/x/${commit}`, '/manage/code/7/search', `/manage/code/7/${commit}/compare/main`, `/manage/code/7/${commit}/compare/${commit}/x`,
    `/manage/code/7/${commit}/code/${commit}`]) {
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
  // Once the repository's branches and tags arrive, by the branch whose head
  // it is, the default branch first, else the tag on it.
  const listed = (branchCommits, tagCommits = []) => ({ status: 'ready', value: { defaultBranch: 'main', branches: [], tags: [], branchCommits, tagCommits } })
  const linked = state.bundles[0].repository
  assert.deepEqual(shownRevision(linked, listed([{ name: 'develop', sha: other }, { name: 'main', sha: other }], [{ name: 'v1', sha: other }])),
    { kind: 'branch', name: 'main' })
  assert.deepEqual(shownRevision(linked, listed([{ name: 'develop', sha: other }, { name: 'main', sha: commit }])), { kind: 'branch', name: 'develop' })
  assert.deepEqual(shownRevision(linked, listed([{ name: 'main', sha: commit }], [{ name: 'v2', sha: commit }, { name: 'v1', sha: other }])),
    { kind: 'tag', name: 'v1' })
  assert.deepEqual(shownRevision(linked, listed([{ name: 'main', sha: commit }])), { kind: 'commit', name: other })
  assert.deepEqual(shownRevision(linked, { status: 'ready', value: { defaultBranch: 'main', branches: [], tags: [] } }), { kind: 'commit', name: other },
    'a server answering no commits names none')
  assert.deepEqual(shownRevision({ ...linked, revision: { kind: 'tag', name: 'v9' } }, listed([{ name: 'main', sha: other }])), { kind: 'tag', name: 'v9' },
    'one opened by a name, by that')
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

test('another revision loading names itself in place of the directory shown, which waits under it till it opens, fails or is given up', async () => {
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code' }, () => true, () => {})
  const shown = state.bundles[0]
  assert.equal(repositoryCodePending(shown), null)
  let finish
  const develop = 'e'.repeat(40)
  answer = (repoId, ref, path) => new Promise(resolve => { finish = () => resolve({ ...data, commit: develop, path }) })
  const switching = openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, ref: 'heads/develop', revision: { kind: 'branch', name: 'develop' },
    path: '', bundleTab: 'code' }, () => true, () => {})
  assert.equal(state.currentView, 'bundles')
  assert.equal(state.bundles[0], shown, 'the directory shown stays')
  assert.deepEqual({ ...repositoryCodePending(shown), repo: undefined }, { repoId: 7, repo: undefined, commit: null, path: '', revision: { kind: 'branch', name: 'develop' } })
  finish()
  await switching
  assert.equal(state.bundles[0].repository.commit, develop)
  assert.equal(state.repositoryCodePending, null)

  // Given up, or superseded, the one shown is itself again.
  answer = () => Promise.reject(new DOMException('Managed session changed', 'AbortError'))
  assert.equal(await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, ref: 'heads/main', revision: { kind: 'branch', name: 'main' }, path: '', bundleTab: 'code' },
    () => true, () => {}), false)
  assert.equal(state.repositoryCodePending, null)
  assert.equal(state.bundles[0].repository.commit, develop)
  answer = (repoId, ref, path) => Promise.resolve({ ...data, path })
  assert.equal(await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'code' }, () => false, () => {}), false)
  assert.equal(state.repositoryCodePending, null)
})

test('a directory that fails to open says why at its route, and lists its directories to open instead where it is too large or has none to read', async () => {
  // Too large, it names the commit the branch was read at, its route naming
  // it, as History reads it, and its directories are listed there.
  answer = () => Promise.reject(Object.assign(new Error('This directory is too large to open here.'), { status: 413, code: 'directory-too-large', commit: commit.toUpperCase() }))
  contents = () => Promise.resolve({ commit, entries: [{ name: 'src', path: 'src', type: 'dir' }, { name: 'README.md', path: 'README.md', type: 'file' }, { name: 'docs', path: 'docs', type: 'dir' }] })
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, path: '', bundleTab: 'treemap' }, () => true, () => {})
  assert.deepEqual(route, { view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'treemap' })
  assert.equal(managedRoutePath(route), `/manage/code/7/${commit}/treemap`)
  assert.equal(state.currentView, 'repository-code')
  assert.equal(state.repositoryCodeOpening.error, 'This directory is too large to open here.')
  assert.equal(state.repositoryCodeOpening.commit, commit)
  assert.equal(state.repositoryCodeOpening.code, 'directory-too-large')
  await setImmediate()
  assert.deepEqual(contentsRequests, [[7, commit, '']])
  assert.deepEqual(state.repositoryCodeOpening.listing, { commit, directories: [{ name: 'docs', path: 'docs', type: 'dir' }, { name: 'src', path: 'src', type: 'dir' }] })
  // Another of its tabs fails as it did, its Commits showing, nothing read again.
  assert.deepEqual(await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'commits' }, () => true, () => {}),
    { view: 'repository-code', repoId: 7, commit, path: '', bundleTab: 'commits' })
  assert.equal(state.repositoryCodeOpening.tab, 'commits')
  assert.equal(requests.length, 1)

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

test('History at a commit opens alone, reading none of the directory\'s files, its other tabs opening them', async () => {
  repositoryRefs(7)
  await setImmediate()
  const read = refsReads
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'commits' }, () => true, () => {})
  assert.deepEqual(route, { view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'commits' })
  assert.deepEqual(requests, [], 'no files read')
  assert.equal(state.currentView, 'repository-code')
  assert.equal(state.repositoryCodeOpening.historyOnly, true)
  assert.equal(state.repositoryCodeOpening.commit, commit)
  repositoryRefs(7)
  assert.equal(refsReads, read + 1, 'its branches and tags read again as it opens')
  openRepositoryCodeTab(state.repositoryCodeOpening, 'code')
  assert.deepEqual(navigations, [{ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'code' }])
  // Code, at its route, reads them.
  await openRepositoryCodeRoute(navigations[0], () => true, () => {})
  assert.deepEqual(requests, [[7, commit, 'packages/app']])
  assert.equal(state.currentView, 'bundles')

  // At a revision named, it opens at the commit its listing reads, named so.
  requests.length = 0
  const develop = 'd'.repeat(40)
  contents = () => Promise.resolve({ commit: develop, entries: [] })
  const named = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, ref: 'heads/develop', revision: { kind: 'branch', name: 'develop' },
    path: 'packages/app', bundleTab: 'commits' }, () => true, () => {})
  assert.deepEqual(named, { view: 'repository-code', repoId: 7, commit: develop, path: 'packages/app', bundleTab: 'commits' })
  assert.deepEqual(requests, [], 'no files read')
  assert.deepEqual(contentsRequests, [[7, 'heads/develop', '']], 'the root, the directory there or not')
  assert.equal(state.repositoryCodeOpening.historyOnly, true)
  assert.deepEqual([state.repositoryCodeOpening.commit, state.repositoryCodeOpening.revision], [develop, { kind: 'branch', name: 'develop' }])
  // One its listing can't read says why.
  contents = () => Promise.reject(Object.assign(new Error('This repository is not available to you.'), { code: 'no-repository' }))
  assert.equal((await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit: null, ref: 'heads/gone', path: '', bundleTab: 'commits' }, () => true, () => {})).commit, null)
  assert.equal(state.repositoryCodeOpening.error, 'This repository is not available to you.')
})

test('Issues, Pull requests, Agents, Pulse and Replay, reading none of the directory\'s files either, open alone at routes of their own', async () => {
  for (const tab of ['issues', 'pulls', 'agents', 'pulse', 'replay']) {
    const route = { view: 'repository-code', repoId: 7, commit, path: '', bundleTab: tab }
    assert.equal(managedRoutePath(route), `/manage/code/7/${commit}/${tab}`)
    assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(route), 'https://triage.test')), route)
    assert.deepEqual(await openRepositoryCodeRoute(route, () => true, () => {}), route)
    assert.deepEqual(requests, [], 'no files read')
    assert.deepEqual([state.repositoryCodeOpening.tab, state.repositoryCodeOpening.historyOnly], [tab, true])
  }
  assert.equal(parseManagedRoute(new URL(`https://triage.test/manage/code/7/${commit}/issues/2`)), null, 'only Code names a file')
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
  // Issues, Pull requests, Agents and Pulse, the whole repository's whatever
  // its revision and directory, pick neither, nor link the commit; the
  // others do.
  for (const tab of ['code', 'treemap', 'search', 'compare', 'commits', 'issues', 'pulls', 'agents', 'pulse']) {
    header.tab = tab
    header._edit = null
    const text = templateText(header.render())
    const shown = !['issues', 'pulls', 'agents', 'pulse'].includes(tab)
    assert.equal(text.includes('<revision-select'), shown, tab)
    assert.equal(text.includes('bundles-slide-commit'), shown, tab)
    assert.equal(text.includes('repository-code-path'), shown, tab)
    assert.match(text, /<repository-selector /u, tab)
  }
})

test('Compare compares the directory with another revision of it, read as the directory is, named by the commit read, without packages or dependencies', async () => {
  const develop = 'd'.repeat(40)
  repositoryRefs(7)
  await setImmediate()
  const entry = repositoryCodeEntry(data, { kind: 'branch', name: null })
  const source = repositoryCompareSource(entry)
  assert.equal(source.noun, 'revision')
  assert.equal(source.base, commit)
  assert.equal(source.name(entry.integrity), 'main', 'the default branch, by its name once known')
  assert.deepEqual(source.dependencies(), { removed: [], added: [], changed: [] })
  // A branch reads as its head's commit, which stands for it, by its name.
  answer = (repoId, ref, path) => Promise.resolve({ ...data, commit: develop, path })
  const other = await source.load('heads/develop')
  assert.deepEqual(requests.at(-1), [7, 'heads/develop', 'packages/app'])
  assert.equal(other.compareId, develop)
  assert.equal(other.integrity, `repository:7:${develop}:packages/app`)
  assert.deepEqual(other.json.sources, ['README.md', 'logo.png', 'src/index.js'])
  assert.equal(source.name(develop), 'develop')
  assert.equal(source.name('e'.repeat(40)), 'eeeeeee', 'a commit by its first digits')
  await assert.rejects(source.load('e'.repeat(40)), /another directory/u, 'a commit answered as another')
  // A swap, or a pick on the second side, opens that one compared with the first.
  source.open(develop, commit, 'code')
  source.open('tags/v1', 'heads/develop', 'overview')
  assert.deepEqual(navigations, [
    { view: 'repository-code', repoId: 7, commit: develop, path: 'packages/app', bundleTab: 'compare', repo: 'org/repo', compareCommit: commit, compareMode: 'code' },
    { view: 'repository-code', repoId: 7, commit: null, path: 'packages/app', bundleTab: 'compare', repo: 'org/repo', ref: 'tags/v1', revision: { kind: 'tag', name: 'v1' },
      compareTarget: 'heads/develop' },
  ])
})

test('each side of Compare picks a revision as the header does, a typed one on Enter alone, and shows the one it stands for', () => {
  const entry = repositoryCodeEntry(data, { kind: 'branch', name: 'main' })
  const picked = []
  const side = { value: null, pick: id => picked.push(id) }
  const template = repositoryCompareSource(entry).select(side, 'Revision to compare with')
  assert.equal(template.values.find(value => value === true), true, 'empty, before one is picked')
  const Pick = customElements.get('repository-revision-pick')
  const pick = new Pick()
  const ids = []
  pick.dispatchEvent = event => { ids.push(event.detail); return true }
  const change = (how, kind, name) => pick.changed({ detail: { how, kind, name } })
  change('input', 'branch', 'dev')
  assert.deepEqual(pick._edit, { kind: 'branch', name: 'dev' })
  change('pick', 'branch', 'develop')
  change('submit', 'commit', 'xyz')
  change('submit', 'commit', 'ABCDEF1')
  assert.deepEqual(ids, [{ kind: 'branch', name: 'develop' }, { kind: 'commit', name: 'ABCDEF1' }])
  // What each names, picked by: a commit whole, else the ref the server reads.
  const handler = template.values.find(value => typeof value === 'function')
  for (const detail of [{ kind: 'branch', name: 'develop' }, { kind: 'tag', name: 'v1' }, { kind: 'commit', name: 'ABCDEF1' }, { kind: 'commit', name: 'F'.repeat(40) }]) handler({ detail })
  assert.deepEqual(picked, ['heads/develop', 'tags/v1', 'abcdef1', 'f'.repeat(40)])
})

test('Compare\'s route opens the directory compared with the commit it names, a bare one with none; another tab keeps it; one picked by a name names none until read', async () => {
  const develop = 'd'.repeat(40), integrity = `repository:7:${commit}:packages/app`
  const route = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'compare', compareCommit: develop, compareMode: 'code' },
    () => true, () => {})
  assert.deepEqual(state.bundleCompare, { bundle: integrity, target: develop, mode: 'code' })
  assert.equal(managedRoutePath(route), `/manage/code/7/${commit}/compare/${develop}/code?path=packages/app`)
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'code' }, () => true, () => {})
  assert.deepEqual(state.bundleCompare, { bundle: integrity, target: develop, mode: 'code' }, 'kept for Compare to open with again')
  assert.deepEqual(managedTabLocation(state, 'compare'), { compareCommit: develop, compareMode: 'code' })
  // A bare Compare route, as Back gives to one cleared, compares with none.
  const bare = await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'compare' }, () => true, () => {})
  assert.equal(state.bundleCompare, null)
  assert.equal(managedRoutePath(bare), `/manage/code/7/${commit}/compare?path=packages/app`)
  state.bundleCompare = { bundle: integrity, target: 'heads/develop', mode: 'overview' }
  assert.equal(managedTabLocation(state, 'compare'), null)
  // A swap's target picked by a name, held as the route opens.
  await openRepositoryCodeRoute({ view: 'repository-code', repoId: 7, commit, path: 'packages/app', bundleTab: 'compare', compareTarget: 'tags/v1' }, () => true, () => {})
  assert.deepEqual(state.bundleCompare, { bundle: integrity, target: 'tags/v1', mode: 'overview' })
})
