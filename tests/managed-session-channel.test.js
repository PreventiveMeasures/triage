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

test('a tab told of another session than the one it told asks for its own again; one told of its own, or again, asks nothing', async () => {
  const [a, b] = await Promise.all([tab('a1'), tab('b1')])
  let asked = 0
  const unwatch = a.watchManagedSessions(() => { asked++ })
  await a.announceManagedSession(session('alice'))
  await b.announceManagedSession(session('bob'))
  await settle()
  assert.equal(asked, 1, 'another session')
  await b.announceManagedSession(session('bob'))
  await settle()
  assert.equal(asked, 1, 'what b told again, the same, not told again')
  await b.announceManagedSession(session('alice'))
  await settle()
  assert.equal(asked, 1, 'b now on this tab\'s own')
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
  assert.equal(asked, 5, 'no longer watched')
})

test('another session told while a tab was finding its first is heeded once it tells its own, stale; once only, and not where it found the same', async () => {
  const [c, d, e, f] = await Promise.all([tab('c1'), tab('d1'), tab('e1'), tab('f1')])
  let asked = 0
  c.watchManagedSessions(() => { asked++ })
  await d.announceManagedSession(session('henry'))
  await settle()
  assert.equal(asked, 0, 'unheeded before c has told its own')
  await c.announceManagedSession(session('ivy'))
  assert.equal(asked, 1, 'its probe read the cookie before it changed: asked again')
  await c.announceManagedSession(session('ivy'))
  assert.equal(asked, 1, 'once only, lest a failing probe ask on and on')
  let fresh = 0
  e.watchManagedSessions(() => { fresh++ })
  await f.announceManagedSession(session('jack'))
  await settle()
  await e.announceManagedSession(session('jack'))
  assert.equal(fresh, 0, 'found the session told')
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

test('a tab whose probe failed, keeping the session it had, is told the other tab\'s still differs, and not once its own matches', async () => {
  const [a, b] = await Promise.all([tab('a3'), tab('b3')])
  assert.equal(await a.toldOtherThan(session('frank')), false, 'none told')
  await a.announceManagedSession(session('frank'))
  await b.announceManagedSession(session('grace'))
  await settle()
  assert.equal(await a.toldOtherThan(session('frank')), true, 'its probe kept frank, b told of grace')
  assert.equal(await a.toldOtherThan(session('grace')), false, 'its probe found grace')
  assert.equal(await a.toldOtherThan(session('grace', { publicShare: true })), false, 'a public share is no cookie\'s')
})

test('of two tellings whose digests end out of order, the later alone is told', async t => {
  const a = await tab('a4')
  const listener = overheard()
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  let calls = 0
  t.mock.method(crypto.subtle, 'digest', async (...args) => {
    if (++calls === 1) await delay(30)
    return digest(...args)
  })
  await Promise.all([a.announceManagedSession(session('kate')), a.announceManagedSession(session('liam'))])
  await settle()
  listener.close()
  const liam = [...new Uint8Array(await digest('SHA-256', new TextEncoder().encode(JSON.stringify(['liam', 'triage', null, 'csrf-liam']))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
  assert.deepEqual(listener.heard, [{ mark: liam }], 'kate\'s, overtaken, told nothing')
})

test('what a probe sent after a telling found is the newer: that telling, stale, is told over and heard no more; one told during the probe stays heard', async () => {
  const [a, b] = await Promise.all([tab('a5'), tab('b5')])
  let asked = 0
  a.watchManagedSessions(() => { asked++ })
  await a.announceManagedSession(session('mia'))
  await b.announceManagedSession(session('stale'))
  await settle()
  assert.equal(asked, 1, 'asked again')
  const listener = overheard()
  await a.announceManagedSession(session('mia'), a.heardManagedSessions())
  await settle()
  assert.equal(await a.toldOtherThan(session('mia')), false, 'its sender perhaps closed, the stale telling is heard no more')
  assert.equal(listener.heard.length, 1, 'told over, for a sender still open')
  const since = a.heardManagedSessions()
  await b.announceManagedSession(session('nora'))
  await settle()
  await a.announceManagedSession(session('mia'), since)
  listener.close()
  assert.equal(await a.toldOtherThan(session('mia')), true, 'told during the probe, whose answer may be the older')
  assert.equal(asked, 2)
})
