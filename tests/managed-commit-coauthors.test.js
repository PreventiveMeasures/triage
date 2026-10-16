import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coauthorsOf } from '../server-managed/commit-coauthors.ts'

const nobody = { login: null, id: null }
const ada = { name: 'Ada', account: nobody }

test('a commit\'s co-authors are its trailers\', each the agent its account, address or name is', () => {
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Mona <3+mona@users.noreply.github.com>\nCo-authored-by: Claude Monet <monet@example.com>\n'
    + 'CO-AUTHORED-BY: Cursor Agent <CursorAgent@Cursor.com>\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>', ada), [
    { name: 'Mona', login: 'mona', id: 3 }, { name: 'Claude Monet', login: null, id: null }, { name: 'Cursor Agent', login: null, id: null, agent: 'cursor' },
  ], 'three at most: a human named like an agent is theirs')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>', ada),
    [{ name: 'Copilot', login: 'Copilot', id: 198982749, agent: 'copilot' }])
  assert.deepEqual(coauthorsOf('Fix\nCo-authored-by: no address\nCo-authored-by: <nameless@example.com>', ada), [], 'none without an address, nor one without a name or account')
  assert.deepEqual(coauthorsOf(null, ada), [])
})

test('the agents a commit\'s message marks come after its trailers\', each once, none the author', () => {
  const claudeSession = '🤖 Generated with [Claude Code](https://claude.com/claude-code)\nClaude-Session: https://claude.ai/code/session_01Abcdef'
  assert.deepEqual(coauthorsOf(`Fix\n\n${claudeSession}`, ada), [{ name: 'Claude', login: null, id: null, agent: 'claude' }])
  assert.deepEqual(coauthorsOf('Fix\n\nSee https://claude.ai/code/session_01Abcdef', ada), [{ name: 'Claude', login: null, id: null, agent: 'claude' }], 'its session\'s link')
  assert.deepEqual(coauthorsOf('Fix\n\n[Open in Cursor](https://cursor.com/agents?id=bc-1234)', ada), [{ name: 'Cursor', login: null, id: null, agent: 'cursor' }])
  assert.deepEqual(coauthorsOf('Fix\n\n🤖 Generated with [Neo](https://neo.example)', ada), [{ name: 'Neo', login: null, id: null, agent: 'neo', avatar: 'app-3115942' }],
    'an app agent by its fingerprint, with its avatar')
  assert.deepEqual(coauthorsOf('Fix\n\n> 🤖 Generated with [Neo](https://neo.example)', ada), [], 'one a message quotes, not')
  // Claude's own commits: Claude their author, none beside it.
  assert.deepEqual(coauthorsOf(`Fix\n\n${claudeSession}\nCo-Authored-By: Claude <noreply@anthropic.com>`, { name: 'Claude', email: 'noreply@anthropic.com', account: nobody }), [])
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: Ada <ada@example.com>', { name: 'Ada', account: { login: 'ada', id: 1 } }), [], 'the author by their name')
  assert.deepEqual(coauthorsOf('Fix\n\nCo-authored-by: A. L. <ADA@example.com>', { name: 'Ada', email: 'ada@example.com', account: nobody }), [], 'the author by their address')
})
