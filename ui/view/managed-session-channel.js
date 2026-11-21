// Tabs of one browser share its session cookie: a sign-in, or a view as
// another user, in one changes every other's session without telling them
// (a live feed stays on the one it opened with). So each tab tells the
// others, by BroadcastChannel, a digest of the session it finds as it
// changes; one told of another asks for its own again (sidebar.js). A public
// share's, which no cookie names, tells nothing.
const CHANNEL = 'deepview-managed-session'
let channel = null
let told = null
let heard = null
let heardCount = 0
let announcing = 0
const watchers = new Set()

function opened() {
  if (!channel && typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(CHANNEL)
    channel.addEventListener('message', event => {
      const mark = event.data?.mark
      if (typeof mark !== 'string') return
      heard = mark
      heardCount++
      if (told !== null && mark !== told) for (const watcher of watchers) watcher()
    })
    // Node's would hold its process open; a browser's has no such method.
    channel.unref?.()
  }
  return channel
}

// What tells one session from another: whose it is, its role, the admin
// viewing as them, and its CSRF token, a new sign-in's own even as the same
// user. Digested, lest the token travel; null where it can't be.
async function markOf(session) {
  if (!session) return 'signed-out'
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const text = JSON.stringify([session.id, session.role, session.viewer?.id ?? null, session.csrfToken ?? null])
  return [...new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// The session this tab found, told where it isn't the one it last told.
// Where nothing was told since its probe was sent (`since`), what it found
// is the newer, and tells over another told before; else one told before
// this tab told its own (its probe perhaps read the old cookie) is heeded
// now, once. A call a later one overtook tells nothing.
export async function announceManagedSession(session, since) {
  if (session?.publicShare) return
  const turn = ++announcing
  const mark = await markOf(session)
  if (turn !== announcing || mark === null || !opened()) return
  const first = told === null
  const over = since === heardCount && heard !== null && heard !== mark
  if (mark !== told || over) {
    told = mark
    // A BroadcastChannel reaches its own origin's tabs alone; it takes no target origin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage({ mark })
  }
  if (over) heard = mark
  else if (first && heard !== null && heard !== mark) for (const watcher of watchers) watcher()
}

// How many tellings this tab has heard, taken as a probe is sent.
export function heardManagedSessions() {
  return heardCount
}

// Whether the tab that told last told of another session than `session`, as
// when this tab's probe failed and kept the session it had.
export async function toldOtherThan(session) {
  if (heard === null || session?.publicShare) return false
  return heard !== await markOf(session)
}

// `onOther` called as another tab tells of another session than the one
// this tab last told, or told before it had told its own. Watched before a
// tab's first probe, its channel opened then, no telling during it is missed.
export function watchManagedSessions(onOther) {
  opened()
  watchers.add(onOther)
  return () => { watchers.delete(onOther) }
}
