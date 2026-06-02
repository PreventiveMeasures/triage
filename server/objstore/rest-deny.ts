// Shared failure-response helpers for the objstore REST plane
// (./rest.ts + ./rest-mint.ts). A uniform `{ error: <reason> }` JSON
// envelope so clients parse one shape; the 409 variant additionally
// carries the live version/incarnation so a PUT / put-begin can rebase.
// Reasons (400/401/403/404/405/409/410/411/500/503) are documented in
// server/README.md and the client decides recovery from the code —
// probe-distinguishing defense isn't a goal: the richer PUT/GET reasons are
// reachable only after the bearer-token check, while the public surfaces (an
// unauthed GET/PUT, or the signature-authed POST mint) expose only
// 400/401/404 — none of which gives a probe signal it couldn't already
// enumerate.

import type { ServerResponse } from 'node:http'

export function deny(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: body }))
}

// Variant of `deny` that augments the envelope with the live row's
// `currentVersion` + `currentIncarnation` so a 409'd PUT / put-begin can
// rebase onto the right precondition token rather than retry blindly
// against an occupied slot. Symmetric with the WS plane's
// `objstore-conflict` frame.
export function denyConflict(res: ServerResponse, currentVersion: number | null, currentIncarnation: string | null): void {
  res.writeHead(409, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'conflict', currentVersion, currentIncarnation }))
}
