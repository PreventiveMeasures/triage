// Keep the bearer credential in the fragment and request header, never cookies,
// local storage, the query string, or requests to other origins.
export function parsePublicShare(hash) {
  if (!hash?.startsWith('#public=')) return null
  const match = /^#public=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(hash)
  // Malformed links stay in public mode and fail closed instead of using a
  // signed-in account that happens to be present in this browser.
  return match ? { teamId: match[1], token: match[2] } : { teamId: '', token: '' }
}
const initialHash = globalThis.location?.hash
const share = parsePublicShare(initialHash)
// Pasting a public link while already viewing the same team can be only a
// fragment navigation. Reinitialize before an existing login or another
// capability can remain attached to the new URL.
globalThis.addEventListener?.('hashchange', () => {
  const hash = globalThis.location?.hash
  if (hash?.startsWith('#public=') && hash !== initialHash) globalThis.location.reload()
})
export function getPublicShare() { return share }
export function publicSharePath(path, value = share) {
  return value ? `${path}#public=${value.teamId}.${value.token}` : path
}
