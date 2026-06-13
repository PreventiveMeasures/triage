// Same-origin gate, shared by the e2e and managed servers (server-common).
// We don't support cross-origin browser clients, so any Origin header present
// on an incoming request MUST match the server's own host (derived from
// `req.headers.host`, or from `X-Forwarded-Host` / `X-Forwarded-Proto` when a
// trusted reverse proxy is in front).
//
// Why "present-must-match" rather than "always required":
// - Browser WebSocket handshakes always carry Origin (RFC 6455), so a
//   foreign-page session attempt always surfaces here.
// - Browser same-origin XHR/fetch may OMIT Origin; requiring it would
//   break legitimate same-origin REST calls.
// - Non-browser clients (the test suite's `ws`, an admin CLI, …) may
//   also omit Origin. There the trust boundary is the network / token.
//
// Reverse-proxy support is OPT-IN via `trustProxy`. When off, we ignore
// `X-Forwarded-*` and derive the expected origin from `req.headers.host`
// + `http://`. When on, the proxy headers take precedence. This guards
// a public-bind deployment (`HOST=0.0.0.0`, no proxy) from a trivial
// bypass: an attacker page would otherwise send its own
// `X-Forwarded-Host` + matching `Origin` and walk through. Default: ON
// for loopback binds (relay behind nginx on same host), OFF otherwise
// (operator must opt in when fronting a public bind with a proxy).

import type { IncomingMessage as HttpRequest } from 'node:http'

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

type HasHeaders = { headers: HttpRequest['headers'] }

export type OriginGate = {
  // Resolved trust-proxy decision — also read by the boot-time
  // misconfiguration fail-fast in index.ts.
  trustProxy: boolean
  isOriginAllowed(req: HasHeaders): boolean
}

function firstHeaderValue(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v.split(',')[0]!.trim() || null
  if (Array.isArray(v) && v.length > 0) return String(v[0]).trim() || null
  return null
}

export function createOriginGate(host: string, trustProxyEnv: string | undefined): OriginGate {
  const trustProxy = trustProxyEnv == null
    ? LOOPBACK_HOSTS.has(host)
    : trustProxyEnv === '1' || trustProxyEnv.toLowerCase() === 'true'

  function expectedOrigin(req: HasHeaders): string | null {
    const xfHost = trustProxy ? firstHeaderValue(req.headers['x-forwarded-host']) : null
    const xfProto = trustProxy ? firstHeaderValue(req.headers['x-forwarded-proto']) : null
    const hostHeader = xfHost ?? firstHeaderValue(req.headers['host'])
    if (!hostHeader) return null
    const proto = xfProto ?? 'http'
    return `${proto}://${hostHeader}`
  }

  function isOriginAllowed(req: HasHeaders): boolean {
    const origin = firstHeaderValue(req.headers['origin'])
    // Missing Origin → same-origin browser fetch OR non-browser client.
    // Both allowed; non-browser callers' trust boundary is the network.
    if (origin == null) return true
    const expected = expectedOrigin(req)
    if (expected == null) return false // Origin present but no Host to compare → deny
    return origin === expected
  }

  return { trustProxy, isOriginAllowed }
}
