// Detects a captive "auth proxy" sitting in front of the sync relay.
// The target case is Cloudflare Access (`*.cloudflareaccess.com`), whose
// default for an unauthenticated XHR/fetch is a 3xx redirect to its
// login page instead of reaching the server — the same shape other
// identity-aware proxies (Google IAP, Azure AD App Proxy, an nginx
// `auth_request` gateway) take when configured to redirect.
//
// Scope is exactly that 3xx-redirect class. A proxy that instead answers
// fetches programmatically — a 401/403 with a JSON/HTML body, or a 200
// inline-login page with no redirect — emits no 3xx and is NOT detected
// here. That's a deliberate, conservative cut: the only false-negative
// cost is staying at the same stuck-"Offline" state we'd show anyway
// (no regression, no false alarm), whereas content-sniffing those other
// shapes risks mislabelling an ordinary 5xx error page as proxy auth.
//
// Why the transport can't surface this on its own: a WebSocket upgrade
// against such an origin simply fails to upgrade (the proxy answers the
// handshake with the redirect / login HTML, not a 101), so
// socket-transport falls back to SSE; the SSE POST is then
// cross-origin-redirected to the login page, which the browser reports
// as a bare `TypeError` (the followed redirect lands on a different
// origin with no CORS headers) — indistinguishable from "server down".
// The reconnect loop spins forever and the sidebar badge sits at
// "Offline" / "Connecting…" with no hint that the fix is a page reload
// to re-run the proxy login.
//
// The probe makes the signal unambiguous. A plain GET to the relay's
// HTTP origin with `redirect: 'manual'` turns any 3xx into an *opaque
// redirect* response (`res.type === 'opaqueredirect'`, status 0) rather
// than following it. The relay itself never 3xx-redirects any
// `/api/sync*` route — it answers 101 / 200 / 4xx / 5xx (see
// server/http.ts + server/sse-server.ts) — so an opaque redirect there
// can ONLY be an intermediary bouncing us to an auth endpoint. We never
// need to read WHERE it redirects (the target is cross-origin and
// opaque anyway); the redirect's mere existence on a route that should
// never redirect IS the proxy-auth signal.

import { wsUrlToSseUrl } from './sse-transport.ts'

// ─────────── detection latch + listeners ───────────
//
// CURRENT state (is the live connection being redirected to an auth
// proxy right now?), not a one-way sticky flag: it flips back off the
// moment the connection recovers, so a user who reloads — or whose
// proxy session is renewed out-of-band — clears the badge/popup without
// a second reload. Both flips fire listeners. Mirrors the
// `persistenceDegraded` latch in triage-session-store.ts.
let proxyAuthRequiredLatch = false
const listeners = new Set<(required: boolean) => void>()

export function proxyAuthRequired(): boolean {
  return proxyAuthRequiredLatch
}

export function setProxyAuthRequired(next: boolean): void {
  if (proxyAuthRequiredLatch === next) return
  proxyAuthRequiredLatch = next
  if (next) {
    console.warn(
      'triage-sync: the sync relay appears to sit behind an authentication proxy ' +
      '(e.g. Cloudflare Access) and this session is no longer authorised — reconnects ' +
      'are being redirected to the proxy login. Reload the page to sign in again.',
    )
  }
  for (const cb of listeners) {
    try { cb(next) } catch (err) { console.warn('proxyAuthRequired listener:', err) }
  }
}

// Subscribe to proxy-auth-required transitions. The listener receives
// the new value on every flip AND once on subscribe with the current
// value (queued on a microtask so subscribe returns synchronously), so
// a lazily-mounted UI badge/popup needn't poll. Each subscription wraps
// `cb` in a fresh closure so two subscriptions of the same reference
// stay independent (key on a unique Set entry). Mirrors
// `onPersistenceDegraded`.
export function onProxyAuthRequired(cb: (required: boolean) => void): () => void {
  const wrapped = (required: boolean) => cb(required)
  listeners.add(wrapped)
  queueMicrotask(() => {
    if (!listeners.has(wrapped)) return
    try { wrapped(proxyAuthRequiredLatch) } catch (err) { console.warn('proxyAuthRequired listener:', err) }
  })
  return () => listeners.delete(wrapped)
}

// ─────────── the probe ───────────

// GET-probe the relay's HTTP origin and report whether an intermediary
// is redirecting it to an auth endpoint. Resolves `true` ONLY on an
// opaque-redirect response (a definite 3xx the relay never emits
// itself); every inconclusive outcome — a normal 4xx/5xx, a network
// error, a thrown fetch (DNS/offline/CORS), no `fetch`, an unusable URL
// — resolves `false`, so a genuine outage (server down, no network) is
// never mis-reported as proxy auth.
export async function probeProxyAuth(wsUrl: string): Promise<boolean> {
  // No `fetch` (Node SSR / a hostile env) → can't probe. The SSE
  // fallback is already disabled in that case, so there's nothing to
  // diagnose.
  if (typeof fetch === 'undefined') return false
  if (!wsUrl) return false
  let url: string
  try { url = wsUrlToSseUrl(wsUrl) } catch { return false }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      // The whole point: surface a 3xx as an opaqueredirect response
      // instead of following it cross-origin (which would throw and
      // discard the signal).
      redirect: 'manual',
      // Send the proxy's session cookie (same-origin in the production
      // single-origin topology) so a still-valid session does NOT
      // redirect — only a genuinely expired/absent one does. Matches
      // the SSE transport's credentials mode.
      credentials: 'same-origin',
      // Bypass any cached 405/redirect so the probe reflects the live
      // proxy state.
      cache: 'no-store',
    })
  } catch {
    // Threw before producing a response: the followed-nowhere GET
    // couldn't reach the origin at all (offline, DNS failure) — a real
    // outage, not a redirect. Inconclusive → not proxy auth.
    return false
  }
  return res.type === 'opaqueredirect'
}
