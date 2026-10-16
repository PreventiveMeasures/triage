import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = {}
const asked = []
let changes = null
mock.module('../client/index.js', { exports: { state } })
const DAY = 86_400_000
const sha = at => at.toString(16).padStart(40, '0')
// A revision's history: a commit a day, the newest first, a merge among them.
const HEAD = sha(1000)
const history = (count = 30) => Array.from({ length: count }, (_, at) => ({ sha: at === 0 ? HEAD : sha(at), parents: at === 3 ? [sha(at + 1), sha(999)] : at === count - 1 ? [] : [sha(at + 1)],
  subject: `Work ${count - at}`, authorName: at % 2 ? 'Ada' : 'Grace', authorLogin: at % 2 ? 'ada' : null, coauthors: [], committedAt: (count - at) * DAY }))
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryHistory: (repoId, ref, path) => Promise.resolve({ commit: ref, path, page: 1, commits: history(), more: false }),
  fetchRepositoryChanges(repoId, path, shas) { asked.push([repoId, path, shas]); return changes(shas, path) },
} })
mock.module('../ui/view/repository-code.js', { exports: { navigateToRepositoryCode() {}, shownRevision: () => ({}) } })
const { makersOf } = await import('../ui/view/repository-replay.js')
const { knowGithubUsers } = await import('../ui/view/github-users.js')
const Replay = customElements.get('repository-replay')

let session = 0
beforeEach(() => {
  asked.length = 0
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
  assert.match(text, /class="history-summary">29 commits by 2, Jan 2, 1970 – Jan 31, 1970</u)
  assert.match(text, /class="replay-play" aria-label=Pause /u, 'playing')
  assert.match(text, /<li><span class=replay-dot is-kind-0><\/span>\.js<\/li>/u, 'the kinds of files by their colors')
  assert.doesNotMatch(text, /class="replay-status/u)
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

test('who made a commit: its author and co-authors once each, a user of the app by their account, an agent whichever of its names, each by their avatar or letter', () => {
  knowGithubUsers({ users: { mona: { id: 'mona-id', login: 'mona', name: 'Mona Lisa' }, 'mona-work': { id: 'mona-id', login: 'mona', name: 'Mona Lisa' },
    claude: { agent: 'claude' }, 'dependabot[bot]': { agent: 'dependabot' } } })
  assert.deepEqual(makersOf({ authorLogin: 'mona-work', authorName: 'M', coauthors: [{ login: 'mona', name: 'Mona' }, { login: null, name: 'Claude', agent: 'claude' },
    { login: null, name: 'Neo', avatar: 'app-123' }, { login: 'claude', name: 'Claude' }] }), [
    { key: 'user:mona-id', label: 'Mona Lisa', letter: 'M', image: '/api/avatar/mona-id' },
    { key: 'agent:claude', label: 'Claude', letter: 'C', image: null },
    { key: 'name:neo', label: 'Neo', letter: 'N', image: '/api/avatar/app-123' },
  ])
  assert.deepEqual(makersOf({ authorLogin: 'dependabot[bot]', authorName: 'dependabot[bot]', coauthors: [] }),
    [{ key: 'agent:dependabot', label: 'Dependabot', letter: 'D', image: '/api/avatar/app-29110' }])
  assert.deepEqual(makersOf({ authorLogin: 'Octo', authorName: null }), [{ key: 'login:octo', label: 'Octo', letter: 'O', image: null }])
})
