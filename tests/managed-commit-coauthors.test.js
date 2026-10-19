import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_NAMED, coauthorFacts, coauthorsOf as told } from '../server-managed/commit-coauthors.ts'

const nobody = { login: null, id: null }
const ada = { name: 'Ada', account: nobody }
// Who made a commit beside its author (`author`), as its history keeps them
// read from its message and GitHub's list (`listed`), then told as answered.
const coauthorsOf = (message, { name, email = null, account }, listed = null) => told({ authorName: name, authorEmail: email, authorLogin: account.login,
  authorId: account.id, ...coauthorFacts(message, listed) })

test('a commit\'s co-authors are its trailers\', each the agent its account, address or name is', () => {
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Mona <3+mona@users.noreply.github.com>\nCo-authored-by: Claude Monet <monet@example.com>\n'
    + 'CO-AUTHORED-BY: Cursor Agent <CursorAgent@Cursor.com>\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>', ada), [
    { name: 'Mona', login: 'mona', id: 3 }, { name: 'Claude Monet', login: null, id: null }, { name: 'Cursor Agent', login: null, id: null, agent: 'cursor' },
  ], 'three at most: a human named like an agent is theirs')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>', ada),
    [{ name: 'Copilot', login: 'Copilot', id: 198982749, agent: 'copilot' }])
  assert.deepEqual(coauthorsOf('Fix\nCo-authored-by: no address\nCo-authored-by: <nameless@example.com>', ada), [], 'none without an address, nor one without a name or account')
  assert.deepEqual(coauthorsOf(null, ada), [])
  // Its trailers as git reads them, its last paragraph's: not an example a description or a subject holds.
  assert.deepEqual(coauthorsOf('Docs: credit co-authors\n\nAdd a line as\nCo-authored-by: Example <example@example.com>\n\nto credit them.', ada), [])
  assert.deepEqual(coauthorsOf('Co-authored-by: Example <example@example.com>', ada), [], 'a subject is no trailer')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Mona <3+mona@users.noreply.github.com>\n\n', ada), [{ name: 'Mona', login: 'mona', id: 3 }], 'past blank lines')
})

test('Codex is its trailer\'s address, not the account GitHub names for that address, someone else\'s', () => {
  const codex = { name: 'Codex', login: null, id: null, agent: 'codex' }
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Codex <codex@openai.com>', ada), [codex])
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Codex <codex@openai.com>', ada, [{ name: 'Codex', email: 'codex@openai.com', account: { login: 'someone', id: 42 } }]),
    [codex], 'as GitHub\'s GraphQL API lists it')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>', ada, [{ name: 'Claude', email: 'noreply@anthropic.com',
    account: { login: 'claude', id: 81847 } }]), [{ name: 'Claude', login: 'claude', id: 81847, agent: 'claude' }], 'an agent\'s own account, its')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Codex <codex@openai.com>', ada, []), [codex], 'by its trailer, GitHub listing none')
  assert.deepEqual(coauthorsOf('Docs\n\nCo-authored-by: Codex <codex@openai.com> is the syntax\n\nMore docs', ada, []), [], 'not a line before its trailers showing one')
})

test('the agents a commit\'s message marks come after its trailers\', each once, none the author', () => {
  const claudeSession = '🤖 Generated with [Claude Code](https://claude.com/claude-code)\nClaude-Session: https://claude.ai/code/session_01Abcdef'
  assert.deepEqual(coauthorsOf(`Fix\n\n${claudeSession}`, ada), [{ name: 'Claude', login: null, id: null, agent: 'claude' }])
  assert.deepEqual(coauthorsOf('Fix\n\nSee https://claude.ai/code/session_01Abcdef', ada), [{ name: 'Claude', login: null, id: null, agent: 'claude' }], 'its session\'s link')
  assert.deepEqual(coauthorsOf('Fix\n\n[Open in Cursor](https://cursor.com/agents?id=bc-1234)', ada), [{ name: 'Cursor', login: null, id: null, agent: 'cursor' }])
  assert.deepEqual(coauthorsOf('Fix\n\n🤖 Generated with [Neo](https://neo.example)', ada), [{ name: 'Neo', login: null, id: null, agent: 'neo' }],
    'an app agent by its fingerprint')
  assert.deepEqual(coauthorsOf('Fix\n\n> 🤖 Generated with [Neo](https://neo.example)', ada), [], 'one a message quotes, not')
  // Claude's own commits: Claude their author, none beside it.
  assert.deepEqual(coauthorsOf(`Fix\n\n${claudeSession}\nCo-Authored-By: Claude <noreply@anthropic.com>`, { name: 'Claude', email: 'noreply@anthropic.com', account: nobody }), [])
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Ada <ada@example.com>', { name: 'Ada', account: { login: 'ada', id: 1 } }), [], 'the author by their name')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: A. L. <ADA@example.com>', { name: 'Ada', email: 'ada@example.com', account: nobody }), [], 'the author by their address')
  // People of one name, by addresses or accounts of their own, are each themselves.
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Ada <ada2@example.com>\nCo-authored-by: Sam <sam@one.example>\nCo-authored-by: Sam <sam@two.example>',
    { name: 'Ada', email: 'ada@example.com', account: { login: 'ada', id: 1 } }), [
    { name: 'Ada', login: null, id: null }, { name: 'Sam', login: null, id: null }, { name: 'Sam', login: null, id: null },
  ])
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Sam <sam@one.example>\nCo-authored-by: Sam <SAM@one.example>', ada), [{ name: 'Sam', login: null, id: null }], 'one address, once')
})

test('Neo is its account, by its id whatever its login, as it is its fingerprint: one agent, its GitHub App\'s id no account of its', () => {
  const neo = { name: 'any-login[bot]', email: '274065190+any-login[bot]@users.noreply.github.com', account: { login: 'any-login[bot]', id: 274065190 } }
  assert.deepEqual(coauthorsOf('Fix\n\n🤖 Generated with [Neo](https://neo.example)', neo), [], 'its own commit, Neo its author, none beside it')
  assert.deepEqual(coauthorsOf('Fix\n\n🤖 Generated with [Neo](https://neo.example)\n\nCo-authored-by: any-login[bot] <274065190+any-login[bot]@users.noreply.github.com>', ada),
    [{ name: 'any-login[bot]', login: 'any-login[bot]', id: 274065190, agent: 'neo' }], 'its trailer and its fingerprint, once')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Someone <3115942+someone@users.noreply.github.com>', ada), [{ name: 'Someone', login: 'someone', id: 3115942 }],
    'an account of its App\'s id, someone else\'s')
  // Its App's bot its author, its account beside it, as GitHub lists it, by the older no-reply address: one Neo.
  const bot = { name: 'any-login[bot]', email: '268952163+any-login[bot]@users.noreply.github.com', account: { login: 'any-login[bot]', id: 268952163 } }
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: any-login <any-login@users.noreply.github.com>\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>', bot,
    [{ name: 'any-login', email: 'any-login@users.noreply.github.com', account: { login: 'any-login', id: 274065190 } },
      { name: 'Claude Opus 5.5', email: 'noreply@anthropic.com', account: { login: null, id: null } }]),
  [{ name: 'Claude Opus 5.5', login: null, id: null, agent: 'claude' }])
})

test('who a commit names beside its author is kept as named, by name, address and account, its message never: which are agents told as they are answered', () => {
  const facts = coauthorFacts('Fix\n\n🤖 Generated with [Neo](https://neo.example)\n\nCo-authored-by: Codex <codex@openai.com>\nCo-authored-by: Mona <3+mona@users.noreply.github.com>')
  assert.deepEqual(facts, { named: [{ name: 'Codex', email: 'codex@openai.com', login: null, id: null }, { name: 'Mona', email: '3+mona@users.noreply.github.com', login: 'mona', id: 3 }],
    markedBy: ['codex', 'neo'] })
  assert.equal(coauthorFacts(`Fix\n\n${Array.from({ length: MAX_NAMED + 2 }, (_, at) => `Co-authored-by: P${at} <p${at}@example.com>`).join('\n')}`).named.length, MAX_NAMED)
  assert.deepEqual(told({ authorName: 'Ada', authorLogin: null, ...facts }), [{ name: 'Codex', login: null, id: null, agent: 'codex' }, { name: 'Mona', login: 'mona', id: 3 },
    { name: 'Neo', login: null, id: null, agent: 'neo' }])
  assert.deepEqual(told({ authorName: 'Ada', authorLogin: null }), [], 'one kept before they were read, none')
})
