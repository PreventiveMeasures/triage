import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = {}
const asked = []
const trees = []
let changes = null
let tree = null
let listed = 30
mock.module('../client/index.js', { exports: { state } })
const DAY = 86_400_000
const sha = at => at.toString(16).padStart(40, '0')
// A revision's history: a commit a day, the newest first, a merge among
// them, and one Claude made with Grace.
const HEAD = sha(1000)
const history = (count = 30) => Array.from({ length: count }, (_, at) => ({ sha: at === 0 ? HEAD : sha(at), parents: at === 3 ? [sha(at + 1), sha(999)] : at === count - 1 ? [] : [sha(at + 1)],
  subject: `Work ${count - at}${at === 6 ? ' (#42)' : ''}`, authorName: at % 2 ? 'Ada' : 'Grace', authorLogin: at % 2 ? 'ada' : null,
  coauthors: at === 6 ? [{ login: null, name: 'Claude', agent: 'claude' }] : [], committedAt: (count - at) * DAY }))
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryHistory: (repoId, ref, path) => Promise.resolve({ commit: ref, path, page: 1, commits: history(listed), more: false }),
  fetchRepositoryChanges(repoId, path, shas) { asked.push([repoId, path, shas]); return changes(shas, path) },
  fetchRepositoryTree(repoId, path, commit) { trees.push([repoId, path, commit]); return tree(path) },
} })
mock.module('../ui/view/repository-code.js', { exports: { navigateToRepositoryCode() {}, shownRevision: () => ({}) } })
const { makersOf } = await import('../ui/view/repository-replay.js')
const { knowGithubUsers } = await import('../ui/view/github-users.js')
const Replay = customElements.get('repository-replay')

let session = 0
beforeEach(() => {
  asked.length = 0
  trees.length = 0
  listed = 30
  tree = path => Promise.resolve({ path, files: ['README.md', 'docs/a.md', `${path ? `${path}/` : ''}src/old.js`].filter(file => !path || file.startsWith(`${path}/`)), cut: false })
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
  changes = (shas, path) => Promise.resolve({ path, changes: shas.map(item => ({ sha: item, more: false, files: [[`${path ? `${path}/` : ''}src/${item.slice(-2)}.js`, 'A']] })) })
})
const shown = (path = '') => Object.assign(new Replay(), { repository: { repoId: 7, repo: 'org/repo', commit: HEAD, path } })
// Rendered, then updated as when connected, as many times as `rounds`, each
// after what it read is answered.
async function settle(view, rounds = 4) {
  for (let round = 0; round < rounds; round++) {
    view.render()
    view.updated()
    await setImmediate()
  }
  return templateText(view.render())
}

test('Replay reads its history, then what its commits change, the oldest first, twenty at first; it plays as soon as they are read', async () => {
  const view = shown()
  assert.match(templateText(view.render()), /Reading the history…/u)
  const text = await settle(view)
  assert.deepEqual(asked.map(([repoId, path, shas]) => [repoId, path, shas.length]), [[7, '', 20], [7, '', 9]], 'every commit of the 29 played but the merge')
  assert.deepEqual(asked[0][2].slice(0, 2), [sha(29), sha(28)], 'the oldest first')
  assert.match(text, /aria-pressed=true @click=\(\) => this\.pickCount\(count\)>Last 300</u)
  assert.match(text, /class="history-summary">29 commits by 3, Jan 2, 1970 – Jan 31, 1970</u)
  assert.match(text, /class="replay-play" aria-label=Pause /u, 'playing')
  assert.match(text, /<li><span class=replay-dot is-kind-0><\/span>\.js<\/li>/u, 'the kinds of files by their colors')
  assert.doesNotMatch(text, /class="replay-status/u)
})

test('the repository\'s first commit played, it starts from no files; else from the files its first commit\'s parent holds, drawn once read', async () => {
  const first = shown()
  await settle(first)
  assert.deepEqual(trees, [], 'none read for the repository\'s first commit')
  assert.equal(first.replay.scene.files.size, 0)
  // A longer history, read for a session of its own.
  listed = 110
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
  const view = shown()
  view.pickCount(100)
  view.render()
  view.updated()
  await setImmediate()
  view.render()
  view.updated()
  assert.match(templateText(view.render()), /Reading the files as they were before Jan 11, 1970…/u, 'the oldest of the 100 latest, but the merge')
  assert.deepEqual(trees, [[7, '', sha(101)]], 'its parent\'s')
  const text = await settle(view)
  assert.deepEqual([...view.replay.scene.files.keys()], ['README.md', 'docs/a.md', 'src/old.js'], 'drawn before any commit plays')
  assert.equal(view.replay.next, 0)
  assert.match(text, /<li><span class=replay-dot is-kind-0><\/span>\.js<\/li>\s*<li><span class=replay-dot is-kind-1><\/span>\.md<\/li>/u, 'its files\' kinds counted too')
  view.seek(3)
  assert.deepEqual([...view.replay.scene.files.keys()].slice(0, 3), ['README.md', 'docs/a.md', 'src/old.js'], 'sought, from them too')
  assert.equal(view.replay.scene.files.size, 6)
  view.pickCount(300)
})

test('a directory\'s replay starts from its files within it, and one starting from more than are read says so', async () => {
  listed = 110
  tree = path => Promise.resolve({ path, files: [`${path}/src/old.js`, 'elsewhere.js'], cut: true })
  const view = shown('packages/app')
  view.pickCount(100)
  const text = await settle(view)
  assert.deepEqual(trees, [[7, 'packages/app', sha(101)]])
  assert.deepEqual([...view.replay.scene.files.keys()].slice(0, 1), ['src/old.js'])
  assert.equal(view.replay.scene.files.has('elsewhere.js'), false)
  assert.match(text, /, from 1 of its files<\/span>/u)
  view.pickCount(300)
})

test('another count picked plays its own commits, the kinds of files those read hold colored however they were read', async () => {
  const view = shown()
  await settle(view)
  const before = asked.length
  view.pickCount(100)
  const text = await settle(view)
  assert.equal(asked.length, before, 'nothing read again')
  assert.equal(view.replay.count, 100)
  assert.match(text, /<li><span class=replay-dot is-kind-0><\/span>\.js<\/li>/u)
  view.pickCount(300)
})

test('sought, it stands as its commits left it, paused where it was; ended, it plays again from the first', async () => {
  const view = shown()
  await settle(view)
  view.toggle()
  assert.equal(view.replay.playing, false)
  view.seek(12)
  assert.deepEqual([view.replay.next, view.replay.scene.files.size], [12, 12])
  assert.match(templateText(view.render()), /aria-label=Play [^]*\.value=12 [^]*aria-valuetext=12 of 29 commits/u)
  view.seek(24)
  const line = templateText(view.render())
  assert.match(line, /<span class="replay-commit-author"><span class="app-user commit-authors" data-tooltip=Grace and Claude>[^]*commit-avatar is-claude[^]*Grace</u,
    'who made the commit last played as Commits shows them, Claude by its mark')
  assert.match(line, new RegExp(`<a class="replay-sha" href=https://github\\.com/org/repo/commit/${sha(6)} [^>]*aria-label=Commit ${sha(6).slice(0, 7)} on GitHub>${sha(6).slice(0, 7)}</a>`, 'u'),
    'its id on GitHub, by the repository\'s name')
  assert.match(line, /<span class="replay-commit-subject">Work 24 \(<a href=https:\/\/github\.com\/org\/repo\/issues\/42 [^>]*>#42<\/a>\)<\/span>/u, 'the pull request it names')
  view.repo = 'org/renamed'
  assert.match(templateText(view.render()), /href=https:\/\/github\.com\/org\/renamed\/commit\//u, 'by the name the tab was handed, where it was')
  Object.assign(view, { repo: null, repository: { ...view.repository, repo: undefined } })
  assert.match(templateText(view.render()), /<code class="replay-sha">[\da-f]{7}<\/code>\s*<span class="replay-commit-subject">Work 24 \(#42\)<\/span>/u,
    'no links where the name isn\'t known yet')
  view.repository = { ...view.repository, repo: 'org/repo' }
  view.seek(500)
  assert.equal(view.replay.next, 29, 'no further than what is read')
  Object.assign(view.replay, { ended: true })
  assert.match(templateText(view.render()), /aria-label=Play again/u)
  view.toggle()
  assert.deepEqual([view.replay.next, view.replay.playing, view.replay.ended, view.replay.scene.files.size], [0, true, false, 0])
})

test('a directory\'s replay asks for its files within it, and draws them from it', async () => {
  const view = shown('packages/app')
  await settle(view)
  assert.ok(asked.every(([, path]) => path === 'packages/app'))
  view.seek(2)
  assert.deepEqual([...view.replay.scene.files.keys()], [`src/${sha(29).slice(-2)}.js`, `src/${sha(28).slice(-2)}.js`])
  assert.equal(view.pathName('src/a.js'), 'packages/app/src/a.js')
})

test('what the commits changed failing to be read is said, and read again on Retry', async () => {
  changes = () => Promise.reject(new Error('GitHub couldn’t be reached.'))
  const view = shown()
  const text = await settle(view)
  assert.match(text, /<p role="alert">GitHub couldn’t be reached\.<\/p>/u)
  assert.equal(asked.length, 1, 'not asked again by itself')
  assert.match(text, /class="replay-play" aria-label=Play \?disabled=true/u)
  changes = (shas, path) => Promise.resolve({ path, changes: shas.map(item => ({ sha: item, more: false, files: [] })) })
  view.replay.error = null
  await settle(view)
  assert.equal(asked.length, 3)
})

test('who made a commit: its author and co-authors once each, a user of the app by their account, an agent whichever of its names by its mark, each else by their avatar or letter', () => {
  knowGithubUsers({ users: { mona: { id: 'mona-id', login: 'mona', name: 'Mona Lisa' }, 'mona-work': { id: 'mona-id', login: 'mona', name: 'Mona Lisa' },
    claude: { agent: 'claude' }, 'dependabot[bot]': { agent: 'dependabot' } } })
  assert.deepEqual(makersOf({ authorLogin: 'mona-work', authorName: 'M', coauthors: [{ login: 'mona', name: 'Mona' }, { login: null, name: 'Claude', agent: 'claude' },
    { login: null, name: 'Neo', avatar: 'app-123' }, { login: 'claude', name: 'Claude' }] }), [
    { key: 'user:mona-id', label: 'Mona Lisa', letter: 'M', agent: null, mark: null, image: '/api/avatar/mona-id' },
    { key: 'agent:claude', label: 'Claude', letter: 'C', agent: 'claude', mark: 'anthropic', image: null },
    { key: 'name:neo', label: 'Neo', letter: 'N', agent: null, mark: null, image: '/api/avatar/app-123' },
  ])
  assert.deepEqual(makersOf({ authorLogin: 'dependabot[bot]', authorName: 'dependabot[bot]', coauthors: [{ login: null, name: 'Codex', agent: 'codex' },
    { login: null, name: 'Copilot', agent: 'copilot' }, { login: null, name: 'Cursor Agent', agent: 'cursor' }] }).map(({ agent, mark, image, letter }) => [agent, mark, image, letter]), [
    ['dependabot', null, '/api/avatar/app-29110', 'D'], ['codex', 'openai', null, 'C'], ['copilot', 'github-copilot', null, 'C'], ['cursor', null, null, 'C']],
  'agents by their marks as Commits draws them, Dependabot by its avatar, Cursor, with neither, by its letter')
  assert.deepEqual(makersOf({ authorLogin: 'Octo', authorName: null }), [{ key: 'login:octo', label: 'Octo', letter: 'O', agent: null, mark: null, image: null }])
})
