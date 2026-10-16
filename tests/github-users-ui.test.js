import assert from 'node:assert/strict'
import { test } from 'node:test'
import { templateText } from './_lit.js'
import { appUser, commitAgent, commitAuthor, commitAuthorName, commitAuthors, forgetGithubUsers, githubUser, githubUserName, githubUsers, knowGithubUsers, knowProfile, knowingGithubUsers } from '../ui/view/github-users.js'

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
  // As the server names them (server-managed/github-users.ts).
  knowGithubUsers({ users: { claude: { agent: 'claude' }, 'Claude[bot]': { agent: 'claude' }, 'chatgpt-codex-connector[bot]': { agent: 'codex' } } })
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

test('Copilot shows by its mark and Dependabot by its avatar, as Agents draws them: by the accounts the server names theirs, else their commits\' names', () => {
  forgetGithubUsers()
  // As the server names them: one GitHub names by Dependabot's login, but
  // another account by its id, is none; an agent the app does not draw neither.
  knowGithubUsers({ items: [{ author: 'Copilot', authorId: 198982749 }, { author: 'dependabot', authorId: 1 }],
    users: { Copilot: { agent: 'copilot' }, ghost: { agent: 'nobody' } } })
  assert.deepEqual([['Copilot', null], ['dependabot', null], [null, 'Copilot'], [null, 'dependabot[bot]'], ['copilot-fan', 'Copilot'], ['ghost', null]]
    .map(([login, name]) => commitAgent(login, name)), ['copilot', null, 'copilot', 'dependabot', null, null])
  assert.equal(appUser('Copilot'), null, 'no user of the app')
  assert.equal(githubUser('dependabot'), 'dependabot')
  const copilot = templateText(githubUser('copilot'))
  assert.match(copilot, /class=app-user-mark is-copilot/u, 'bare, no avatar\'s disc')
  assert.match(copilot, /<svg [^>]*viewBox="0 0 24 24"/u, 'its mark, as the Agents tab draws it, not its avatar fetched')
  assert.doesNotMatch(copilot, /<img/u)
  assert.match(copilot, /app-user-name">Copilot</u)
  assert.match(copilot, /data-tooltip=@copilot on GitHub/u)
  const dependabot = templateText(commitAuthor(null, 'dependabot[bot]'))
  assert.match(dependabot, /src=\/api\/avatar\/app-29110 /u, 'a commit GitHub named no account for, by its name')
  assert.match(dependabot, /data-tooltip=dependabot\[bot\]/u)
  knowGithubUsers({ commits: [{ authorLogin: 'dependabot[bot]', authorId: 49699333 }], users: { 'dependabot[bot]': { agent: 'dependabot' } } })
  assert.deepEqual([githubUserName('dependabot[bot]'), commitAuthorName(null, 'Copilot'), commitAuthorName('Copilot')], ['Dependabot', 'Copilot', 'Copilot'])
  assert.deepEqual(githubUsers(['dependabot[bot]', 'Copilot', 'DEPENDABOT[BOT]', 'copilot']), ['dependabot[bot]', 'Copilot'], 'each agent once')
  forgetGithubUsers()
})

test('a login this session\'s answers name by more than one account, one GitHub named by it once and one it names by it now, is no one\'s till another session', () => {
  forgetGithubUsers()
  // History kept from before the login was renamed and taken by another account.
  knowGithubUsers({ commits: [{ authorLogin: 'octo', authorId: 2 }], users: { octo: { id: 'octo-id', login: 'octo', name: 'Octo' } } })
  assert.equal(appUser('octo')?.id, 'octo-id')
  knowGithubUsers({ items: [{ author: 'Octo', authorId: 9 }], users: { Octo: { id: 'cat-id', login: 'cat', name: 'Cat' } } })
  assert.equal(appUser('octo'), null, 'neither account\'s')
  assert.equal(githubUser('octo'), 'octo', 'the login itself')
  knowGithubUsers({ commits: [{ authorLogin: 'octo', authorId: 2 }, { authorLogin: 'dependabot', authorId: 1 }, { authorLogin: 'dependabot', authorId: 49699333 }],
    users: { octo: { id: 'octo-id', login: 'octo', name: 'Octo' }, dependabot: { agent: 'dependabot' } } })
  assert.deepEqual([appUser('octo'), commitAgent('dependabot')], [null, null], 'nor once an answer names one of them again; nor one an answer names by two')
  knowGithubUsers({ commits: [{ authorLogin: 'ada', authorId: 7 }, { authorLogin: 'ada', authorId: null }], users: { ada: { id: 'ada-id', login: 'ada', name: null } } })
  assert.equal(appUser('ada')?.id, 'ada-id', 'one named once with its id and once without is that account')
  forgetGithubUsers()
  knowGithubUsers({ items: [{ author: 'Octo', authorId: 9 }], users: { Octo: { id: 'cat-id', login: 'cat', name: 'Cat' } } })
  assert.equal(appUser('octo')?.id, 'cat-id', 'another session\'s answers say anew')
  forgetGithubUsers()
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
  // `zoe-old`, the login Zoe signed in with before renaming on GitHub, theirs by their account's id.
  knowGithubUsers({ commits: [{ authorLogin: 'zoe' }, { authorLogin: 'zoe-work' }, { authorLogin: 'zoe-old', authorId: 1 }, { authorLogin: 'yan' }], users: {
    zoe: { id: 'zoe-id', login: 'zoe', name: 'Zoe' }, 'zoe-work': { id: 'zoe-id', login: 'zoe', name: 'Zoe' }, 'zoe-old': { id: 'zoe-id', login: 'zoe', name: 'Zoe' },
    yan: { id: 'yan-id', login: 'yan', name: 'Yan' } } })
  assert.doesNotMatch(templateText(githubUser('zoe')), /\?v=/u)
  knowProfile('zoe-id', { login: 'zoe', name: ' Zoe at Work ', accounts: [{ login: 'Zoe-Work' }] }, true)
  assert.deepEqual(['zoe', 'zoe-work', 'zoe-old', 'yan'].map(githubUserName), ['Zoe at Work', 'Zoe at Work', 'Zoe at Work', 'Yan'],
    'under every login of theirs, one before renaming too; another user\'s as it was')
  assert.match(templateText(githubUser('zoe-work')), /src=\/api\/avatar\/zoe-id\?v=1/u, 'their avatar asked for again')
  assert.doesNotMatch(templateText(githubUser('yan')), /\?v=/u)
  // `zoe-job`, the login Zoe's work account had before it was renamed, theirs by its id.
  knowGithubUsers({ commits: [{ authorLogin: 'zoe-job', authorId: 2 }], users: { 'zoe-job': { id: 'zoe-id', login: 'zoe', name: 'Zoe at Work' } } })
  knowProfile('zoe-id', { login: 'zoe', name: null, accounts: [{ login: 'zoe-side' }] }, false, { login: 'Zoe-Work', githubId: 2 })
  assert.deepEqual(['zoe', 'zoe-old'].map(login => appUser(login)?.name ?? null), [null, null])
  assert.deepEqual(['zoe-work', 'zoe-job'].map(appUser), [null, null], 'unlinked, by any login of it')
  assert.deepEqual(['zoe', 'zoe-old'].map(login => appUser(login)?.id), ['zoe-id', 'zoe-id'])
  // `zoe-old` again, by Zoe's sign-in account's id, its login now another
  // account's of theirs, linked, unlinked: still the sign-in account's.
  knowProfile('zoe-id', { login: 'zoe', name: null, accounts: [] }, false, { login: 'zoe-old', githubId: 4 })
  assert.equal(appUser('zoe-old')?.id, 'zoe-id', 'by the id answers named it by, not the login')
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
  knowProfile('wil-id', { login: 'wil', name: 'Wil W', accounts: [] }, false, { login: 'wil-work', githubId: 5 })
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

test('a commit with co-authors shows its author\'s avatar, theirs tucked behind it in turn, agents by their marks, all named in its tooltip', () => {
  forgetGithubUsers()
  knowGithubUsers({ users: { mona: { id: 'mona-id', login: 'mona', name: 'Mona Lisa' } } })
  const text = templateText(commitAuthors(null, 'Ada Lovelace', [{ name: 'M.', login: 'mona', id: 3 }, { name: 'Claude Opus 5.5', login: null, id: null, agent: 'claude' },
    { name: 'Neo', login: null, id: null, agent: 'neo', avatar: 'app-3115942' }, { name: 'Fourth', login: null, id: null }]))
  assert.match(text, /data-tooltip=Ada Lovelace, Mona Lisa, Claude Opus 5\.5 and Neo>/u, 'a user of the app as the app shows them, an agent as its commit names it')
  const avatars = [...text.matchAll(/<span class=("commit-avatar"|commit-avatar is-\w+)>(.)/gu)].map(match => [match[1], match[2]])
  assert.deepEqual(avatars, [['"commit-avatar"', 'A'], ['"commit-avatar"', 'M'], ['commit-avatar is-claude', '<'], ['"commit-avatar"', '<']],
    'the author\'s on top, by their name\'s letter; Mona\'s, Claude\'s mark, Neo\'s avatar, three at most')
  assert.match(text, /M<img src=\/api\/avatar\/mona-id /u)
  assert.match(text, /<img src=\/api\/avatar\/app-3115942 /u)
  assert.match(text, /<span class="app-user-name">Ada Lovelace<\/span><span class="sr-only"> with Mona Lisa, Claude Opus 5\.5 and Neo<\/span>/u)
  assert.doesNotMatch(text, /Fourth/u)
  // Cursor, the app having no mark of it, by its name's letter; an author by their account.
  const cursor = templateText(commitAuthors('mona', 'M. L.', [{ name: 'Cursor Agent', login: null, id: null, agent: 'cursor' }]))
  assert.match(cursor, /data-tooltip=Mona Lisa and Cursor Agent>[^]*M<img src=\/api\/avatar\/mona-id [^]*<span class=commit-avatar is-cursor>C<\/span>/u)
  assert.match(templateText(commitAuthor(null, 'Cursor Agent')), /<span class="app-user-avatar" aria-hidden="true">C<\/span><span\s+class="app-user-name">Cursor<\/span>/u)
  // None beside the author, or none told as one, the author alone.
  assert.equal(commitAuthors('someone', 'Some One', []), 'Some One')
  assert.equal(commitAuthors('someone', 'Some One', [null, 'x', { agent: 'claude' }]), 'Some One')
  assert.equal(commitAuthors('someone', 'Some One', undefined), 'Some One')
})
