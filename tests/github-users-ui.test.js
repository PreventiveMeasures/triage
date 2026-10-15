import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateText } from './_lit.js'
import { appUser, commitAgent, commitAuthor, commitAuthorName, githubUser, githubUserName, githubUsers, knowGithubUsers } from '../ui/view/github-users.js'

test('GitHub logins the server names as the app\'s users show by their avatar and chosen name, a linked account as its user; others as themselves', () => {
  const answer = { items: [], users: {
    'Mona-Work': { id: 'mona-id', login: 'mona', name: ' Mona Lisa ' },
    mona: { id: 'mona-id', login: 'mona', name: 'Mona Lisa' },
    hubot: { id: 'hubot-id', login: 'hubot', name: null },
    broken: { login: 'no id' },
  } }
  assert.equal(knowGithubUsers(answer), answer, 'the answer as it came')
  assert.equal(knowGithubUsers(undefined), undefined)
  assert.deepEqual(appUser('mona-work'), { id: 'mona-id', login: 'mona', name: 'Mona Lisa' }, 'matched as GitHub matches logins')
  assert.equal(appUser('broken'), null)
  assert.equal(appUser(null), null)
  assert.deepEqual(['mona-work', 'hubot', 'stranger', null].map(githubUserName), ['Mona Lisa', 'hubot', 'stranger', null])
  const shown = templateText(githubUser('mona-work'))
  assert.match(shown, /data-tooltip=@mona-work on GitHub/u)
  assert.match(shown, /src=\/api\/avatar\/mona-id/u, 'the avatar the user chose, as the server serves theirs')
  assert.match(shown, /<span class="app-user-name">Mona Lisa<\/span>/u)
  assert.match(templateText(githubUser('hubot')), /app-user-name">hubot</u, 'one without a name by their login')
  assert.equal(githubUser('stranger'), 'stranger')
  assert.equal(githubUser(null, 'ghost'), 'ghost')
  assert.deepEqual(githubUsers(['mona', 'stranger', 'Mona-Work', 'STRANGER', 'hubot']), ['mona', 'stranger', 'hubot'], 'each user once')
})

test('commits by Claude or Codex show by their marks: by the identities GitHub names, else by name alone where it names none', () => {
  assert.deepEqual([['claude', 'Claude'], ['Claude[bot]', null], ['chatgpt-codex-connector[bot]', null], [null, ' Codex '], [null, 'claude'],
    ['claudette', 'Claude'], ['someone', 'Codex'], [null, 'Claude Monet'], [null, null]].map(([login, name]) => commitAgent(login, name)),
  ['claude', 'claude', 'codex', 'codex', 'claude', null, null, null, null], 'a human\'s account is theirs, whatever their commits name them')
  const claude = templateText(commitAuthor('claude', 'Claude'))
  assert.match(claude, /class=app-user-mark is-claude/u, 'its bare mark, no avatar\'s disc')
  assert.match(claude, /<svg[^>]*viewBox="4 5 8 8"/u, 'Claude\'s own mark, as Agents draws it')
  assert.match(claude, /app-user-name">Claude</u)
  assert.match(claude, /data-tooltip=@claude on GitHub/u)
  const codex = templateText(commitAuthor(null, 'Codex'))
  assert.match(codex, /is-codex/u)
  assert.match(codex, /data-tooltip=Codex/u)
  assert.equal(commitAuthor('someone', 'Some One'), 'Some One', 'others by their name')
  assert.equal(commitAuthor('someone'), 'someone')
  assert.equal(commitAuthor(null, null), '')
  assert.match(templateText(commitAuthor('mona', 'M. L.')), /app-user-name">Mona Lisa</u, 'a user of the app as the app shows them')
  assert.deepEqual([commitAuthorName('claude[bot]'), commitAuthorName(null, 'Codex'), commitAuthorName('mona'), commitAuthorName(null, 'Ada'), commitAuthorName('ada', 'Ada L')],
    ['Claude', 'Codex', 'Mona Lisa', 'Ada', 'ada'])
})
