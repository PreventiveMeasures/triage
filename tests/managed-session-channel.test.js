// Tabs telling each other the session each finds, its cookie shared
// (ui/view/managed-session-channel.js): each instance of the module a tab.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const tab = name => import(`../ui/view/managed-session-channel.js?${name}`)
const settle = () => delay(20)
const session = (id, more = {}) => ({ id, login: id, role: 'triage', csrfToken: `csrf-${id}`, ...more })
// What the channel carries, as a tab of another page would read it.
function overheard() {
  const channel = new BroadcastChannel('deepview-managed-session'), heard = []
  channel.addEventListener('message', event => { heard.push(event.data) })
  channel.unref()
  return { heard, close: () => { channel.close() } }
}

test('a tab told of another session than the one it told asks for its own again; one told of its own, or before telling any, asks nothing', async () => {
  const [a, b] = await Promise.all([tab('a1'), tab('b1')])
  let asked = 0
  const unwatch = a.watchManagedSessions(() => { asked++ })
  await b.announceManagedSession(session('bob'))
  await settle()
  assert.equal(asked, 0, 'none told by this tab yet: its own read is still to come')
  await a.announceManagedSession(session('alice'))
  await b.announceManagedSession(session('bob'))
  await settle()
  assert.equal(asked, 0, 'what b told again, the same, not told again')
  await b.announceManagedSession(session('alice'))
  await settle()
  assert.equal(asked, 0, 'b now on this tab\'s own')
  for (const [other, why] of [[session('alice', { csrfToken: 'csrf-again' }), 'signed in again as the same user'],
    [session('alice', { role: 'manage' }), 'another role'], [session('bob', { viewer: { id: 'alice', login: 'alice' } }), 'a view as another user'],
    [null, 'signed out']]) {
    const before = asked
    await b.announceManagedSession(other)
    await settle()
    assert.equal(asked, before + 1, why)
  }
  unwatch()
  await b.announceManagedSession(session('dave'))
  await settle()
  assert.equal(asked, 4, 'no longer watched')
})

test('what a tab tells is a digest alone, no token; a public share, which no cookie names, tells nothing', async () => {
  const a = await tab('a2')
  const listener = overheard()
  await a.announceManagedSession(session('erin'))
  await a.announceManagedSession(session('erin', { csrfToken: 'csrf-share', publicShare: true }))
  await settle()
  listener.close()
  assert.equal(listener.heard.length, 1)
  assert.match(listener.heard[0].mark, /^[\da-f]{64}$/u)
  assert.ok(!JSON.stringify(listener.heard).includes('csrf-'), 'the CSRF token never travels')
})
