import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateText } from './_lit.js'
import { appUser, commitAgent, commitAuthor, commitAuthorName, forgetGithubUsers, githubUser, githubUserName, githubUsers, knowGithubUsers, knowProfile, knowingGithubUsers } from '../ui/view/github-users.js'

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

test('an answer naming a login the server resolves to no one forgets what was kept of it; another session forgets them all', () => {
  forgetGithubUsers()
  knowGithubUsers({ commits: [{ authorLogin: 'alice-work' }, { authorLogin: 'bob' }], users: {
    'alice-work': { id: 'alice-id', login: 'alice', name: 'Alice' }, bob: { id: 'bob-id', login: 'bob', name: null } } })
  knowGithubUsers({ items: [{ author: 'alice' }], users: { alice: { id: 'alice-id', login: 'alice', name: 'Alice' } } })
  assert.deepEqual(['alice-work', 'alice', 'bob'].map(login => appUser(login)?.id ?? null), ['alice-id', 'alice-id', 'bob-id'])
  // Unlinked since: a later answer names it, resolved to no one.
  knowGithubUsers({ items: [{ author: 'Alice-Work' }, { author: 'bob' }], users: { bob: { id: 'bob-id', login: 'bob', name: null } } })
  assert.deepEqual(['alice-work', 'alice', 'bob'].map(login => appUser(login)?.id ?? null), [null, 'alice-id', 'bob-id'],
    'one it names alone, not those its users are, nor those it doesn\'t name')
  knowGithubUsers({ commits: [{ authorLogin: 'carol-work' }], users: { 'carol-work': { id: 'carol-id', login: 'alice', name: 'Carol' } } })
  assert.equal(appUser('alice')?.id, 'alice-id', 'a user\'s own login, in `users`, is not one the answer names')
  forgetGithubUsers()
  assert.deepEqual(['alice', 'bob', 'carol-work'].map(appUser), [null, null, null])
})

test('the signed-in user\'s own profile change shows in what was kept of them: their name, a fresh avatar, an account unlinked theirs no more', () => {
  forgetGithubUsers()
  knowGithubUsers({ commits: [{ authorLogin: 'zoe' }, { authorLogin: 'zoe-work' }, { authorLogin: 'yan' }], users: {
    zoe: { id: 'zoe-id', login: 'zoe', name: 'Zoe' }, 'zoe-work': { id: 'zoe-id', login: 'zoe', name: 'Zoe' }, yan: { id: 'yan-id', login: 'yan', name: 'Yan' } } })
  assert.doesNotMatch(templateText(githubUser('zoe')), /\?v=/u)
  knowProfile('zoe-id', { login: 'zoe', name: ' Zoe at Work ', accounts: [{ login: 'Zoe-Work' }] }, true)
  assert.deepEqual(['zoe', 'zoe-work', 'yan'].map(githubUserName), ['Zoe at Work', 'Zoe at Work', 'Yan'], 'another user\'s as it was')
  assert.match(templateText(githubUser('zoe-work')), /src=\/api\/avatar\/zoe-id\?v=1/u, 'their avatar asked for again')
  assert.doesNotMatch(templateText(githubUser('yan')), /\?v=/u)
  knowProfile('zoe-id', { login: 'zoe', name: null, accounts: [] })
  assert.deepEqual(['zoe', 'zoe-work'].map(login => appUser(login)?.name ?? null), [null, null])
  assert.equal(appUser('zoe-work'), null, 'unlinked')
  assert.equal(appUser('zoe')?.id, 'zoe-id')
  forgetGithubUsers()
})

test('an answer read across another session\'s start keeps none of its users; one read within its session keeps them', async () => {
  forgetGithubUsers()
  const answer = { items: [{ author: 'xan' }], users: { xan: { id: 'xan-id', login: 'xan', name: 'Xan' } } }
  const late = Promise.withResolvers()
  const reading = knowingGithubUsers(() => late.promise)
  forgetGithubUsers()
  late.resolve(answer)
  assert.equal(await reading, answer, 'answered all the same, for its caller to discard')
  assert.equal(appUser('xan'), null, 'the session it was read for had ended')
  assert.equal(await knowingGithubUsers(() => Promise.resolve(answer)), answer)
  assert.equal(appUser('xan')?.id, 'xan-id')
  await assert.rejects(knowingGithubUsers(() => Promise.reject(new Error('offline'))), /offline/u)
  forgetGithubUsers()
})

test('an answer read across the signed-in user\'s profile change keeps others\' users, and the change over what it says of them', async () => {
  forgetGithubUsers()
  knowGithubUsers({ commits: [{ authorLogin: 'wil' }, { authorLogin: 'wil-work' }], users: {
    wil: { id: 'wil-id', login: 'wil', name: 'Wil' }, 'wil-work': { id: 'wil-id', login: 'wil', name: 'Wil' } } })
  const late = Promise.withResolvers()
  const reading = knowingGithubUsers(() => late.promise)
  knowProfile('wil-id', { login: 'wil', name: 'Wil W', accounts: [] })
  // Read before the change was saved, as it was then.
  late.resolve({ commits: [{ authorLogin: 'wil' }, { authorLogin: 'wil-work' }, { authorLogin: 'vic' }], users: {
    wil: { id: 'wil-id', login: 'wil', name: 'Wil' }, 'wil-work': { id: 'wil-id', login: 'wil', name: 'Wil' }, vic: { id: 'vic-id', login: 'vic', name: 'Vic' } } })
  await reading
  assert.deepEqual(['wil', 'wil-work', 'vic'].map(githubUserName), ['Wil W', 'wil-work', 'Vic'], 'the name saved, the account unlinked, another user kept')
  // One read since the change says what the server now does.
  await knowingGithubUsers(() => Promise.resolve({ commits: [{ authorLogin: 'wil' }], users: { wil: { id: 'wil-id', login: 'wil', name: 'Wil Again' } } }))
  assert.equal(githubUserName('wil'), 'Wil Again')
  forgetGithubUsers()
})
