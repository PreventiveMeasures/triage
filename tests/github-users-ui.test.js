import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateText } from './_lit.js'
import { appUser, githubUser, githubUserName, githubUsers, knowGithubUsers } from '../ui/view/github-users.js'

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
