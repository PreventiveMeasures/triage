// REST endpoints for the objstore plane — the single-round-trip,
// SSE-session-independent alternative to the WS `objstore-fetch` /
// `objstore-put-begin` / `objstore-delete` handshakes (so these ops can't
// be interrupted by an SSE replica hop). One route, `POST
// /api/objstore/{tag}/{res}`, with a JSON body `{ op, ts, signature, ... }`:
// the workspace signs the request (the workspaceTag IS the Ed25519 pubkey,
// so verification is self-contained — no socket, no stored key), the server
// verifies it + freshness/replay-guards (the connection-nonce stand-in).
// fetch/put return the SAME token shape the WS path sends, for the UNCHANGED
// bearer-token GET / PUT byte transfers; delete mutates in place and returns
// `{ deletedVersion }` (no token — there are no bytes to move). See
// e2e-server/README.md "REST endpoints & tokens".

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'

import type { ObjstoreRestDeps, RouteMatch } from './rest.ts'
import { deny, denyConflict } from './rest-deny.ts'
import { MAX_CONTENT_LENGTH, beginPut, deleteObject, getLive, isValidContentHash, isValidIncarnation, isValidSignature, objectMetaWire } from './store.ts'
import { mintGetToken, mintPutToken } from './tokens.ts'
import { verifyObjstoreDeleteRestSig, verifyObjstoreFetchRestSig, verifyObjstorePutBeginRestSig } from './sign.ts'
import { createFetchMintGuard } from './fetch-mint-guard.ts'

// Per-process freshness + replay guard for the REST POSTs (fetch, put-begin,
// delete). They have no connection nonce to bind, so they bind a client
// timestamp — see ./fetch-mint-guard.ts. The three ops' signatures are
// globally unique (distinct canonical domains), so one guard dedups all three.
const mintGuard = createFetchMintGuard()

// Hard cap on a mint JSON body. The put-begin body (op, ts, signature,
// prevVersion, prevIncarnation, expectedLength, contentHash) is the larger
// of the two and still only a few hundred bytes; 4 KiB is comfortable
// headroom. Bounds the read so a hostile client can't stream an unbounded
// body into memory before the parse.
const MINT_BODY_MAX = 4096

// Read a small JSON request body up to `maxBytes`, returning the parsed
// value or null on overflow / parse failure / read error. Used only by
// the mint POST; the PUT body is the raw blob and streams to disk via a
// different path.
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > maxBytes) return null
      chunks.push(buf)
    }
  } catch { return null }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { return null }
}

// Extract + range-check the auth fields common to both mint ops. Gates the
// signature to the wire shape (`isValidSignature`, matching the WS plane) so
// an obviously-malformed sig is rejected up front rather than burning an
// Ed25519 verify — and, since this runs before `mintGuard.admit`, a bad sig
// never reaches the replay cache regardless.
function parseMintAuth(body: object): { ts: number; signature: string } | null {
  const ts = (body as { ts?: unknown }).ts
  const signature = (body as { signature?: unknown }).signature
  if (!Number.isSafeInteger(ts) || (ts as number) < 0) return null
  if (!isValidSignature(signature)) return null
  return { ts: ts as number, signature }
}

// Dispatch the mint by body `op`. Auth-proxy friendly: the signature rides
// the JSON body (not a header or cookie, so it never collides with a
// cookie-based proxy), and the response is JSON — no redirect, no token in
// any URL. Client note: a replayed signature is rejected, so a retry MUST
// re-sign with a fresh `ts` rather than resend the same body.
export async function handleRestMint(
  deps: ObjstoreRestDeps, req: IncomingMessage, res: ServerResponse, route: RouteMatch,
): Promise<void> {
  const body = await readJsonBody(req, MINT_BODY_MAX)
  if (!body || typeof body !== 'object') { deny(res, 400, 'bad-request'); return }
  const op = (body as { op?: unknown }).op
  if (op === 'fetch') { await handleRestFetchMint(deps, res, route, body); return }
  if (op === 'put') { await handleRestPutBegin(deps, res, route, body); return }
  if (op === 'delete') { await handleRestDelete(deps, res, route, body); return }
  deny(res, 400, 'bad-request')
}

// op:'fetch' — mirrors the WS `objstore-fetch` → `objstore-fetch-token`
// handshake; returns `{ ...meta, urlPath, token, expiresAt }` for the
// UNCHANGED bearer-token GET.
async function handleRestFetchMint(
  deps: ObjstoreRestDeps, res: ServerResponse, route: RouteMatch, body: object,
): Promise<void> {
  const auth = parseMintAuth(body)
  if (!auth) { deny(res, 400, 'bad-request'); return }
  // Verify the signature BEFORE touching the replay guard so a bad-sig
  // request can't consume cache space. The signature commits to THIS `ts`.
  if (!await verifyObjstoreFetchRestSig(route.tag, route.resourceTag, auth.ts, auth.signature)) {
    deny(res, 401, 'unauthorized'); return
  }
  // Freshness window + single-use dedup (the connection-nonce stand-in).
  // 'stale'/'replay' are both opaque 401s — the client re-signs with a
  // fresh `ts` and retries.
  if (mintGuard.admit(auth.signature, auth.ts) !== 'ok') { deny(res, 401, 'unauthorized'); return }
  const row = await getLive(deps.handle, route.tag, route.resourceTag)
  if (!row) { deny(res, 404, 'not-found'); return }
  const { token, exp } = mintGetToken(deps.secret, route.tag, route.resourceTag, row.version, row.incarnation)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    ...objectMetaWire(row),
    urlPath: `/api/objstore/${route.tag}/${route.resourceTag}`,
    token,
    expiresAt: exp,
  }))
}

// op:'put' — mirrors the WS `handlePutBegin`: verify the signed put fields,
// freshness/replay-guard, the new-workspace operator gate, then `beginPut`
// (advisory prev-check + staging row) and mint the put-token. Returns
// `{ stagingId, urlPath, token, expiresAt }` for the UNCHANGED bearer-token
// PUT; `409 conflict` (with current version/incarnation to rebase on) or
// `403 workspace-full` map `beginPut`'s refusals.
//
// New-workspace gate: REST can't read a socket's operator-auth state, so
// when a password is configured AND the workspace is never-before-seen this
// returns 401 — the client falls back to the in-band WS put-begin (which
// runs the operator auth flow). No-op for password-less deployments or
// existing workspaces (the common case).
async function handleRestPutBegin(
  deps: ObjstoreRestDeps, res: ServerResponse, route: RouteMatch, body: object,
): Promise<void> {
  const auth = parseMintAuth(body)
  if (!auth) { deny(res, 400, 'bad-request'); return }
  // Field gates mirror `handlePutBegin`'s up-front rejects.
  const expectedLength = (body as { expectedLength?: unknown }).expectedLength
  if (!Number.isSafeInteger(expectedLength) || (expectedLength as number) < 0 || (expectedLength as number) > MAX_CONTENT_LENGTH) {
    deny(res, 400, 'bad-request'); return
  }
  const prevVersionRaw = (body as { prevVersion?: unknown }).prevVersion
  if (prevVersionRaw != null && (typeof prevVersionRaw !== 'number' || !Number.isSafeInteger(prevVersionRaw))) {
    deny(res, 400, 'bad-request'); return
  }
  const prevVersion = typeof prevVersionRaw === 'number' ? prevVersionRaw : null
  const prevIncarnationRaw = (body as { prevIncarnation?: unknown }).prevIncarnation
  const prevIncarnation = typeof prevIncarnationRaw === 'string' ? prevIncarnationRaw : null
  // prevVersion/prevIncarnation travel as a null-iff-null pair (matches the
  // WS `validPrevPair`): a half-pair is malformed.
  if ((prevVersion === null) !== (prevIncarnation === null)) { deny(res, 400, 'bad-request'); return }
  // A non-null incarnation must be the wire shape (matches the WS path's
  // `isValidIncarnation` gate). Signature-covered + CAS-checked regardless,
  // but reject the obviously-malformed up front.
  if (prevIncarnation !== null && !isValidIncarnation(prevIncarnation)) { deny(res, 400, 'bad-request'); return }
  const contentHash = (body as { contentHash?: unknown }).contentHash
  if (!isValidContentHash(contentHash)) { deny(res, 400, 'bad-request'); return }

  const fields = {
    workspaceTag: route.tag, resourceTag: route.resourceTag,
    prevVersion, prevIncarnation, contentHash, expectedLength: expectedLength as number,
  }
  if (!await verifyObjstorePutBeginRestSig(fields, auth.ts, auth.signature)) { deny(res, 401, 'unauthorized'); return }
  if (mintGuard.admit(auth.signature, auth.ts) !== 'ok') { deny(res, 401, 'unauthorized'); return }
  // New-workspace operator gate — see the function header. Refusing here
  // routes the client to its in-band WS put-begin fallback.
  if (await deps.restPutGate(route.tag)) { deny(res, 401, 'unauthorized'); return }
  const result = await beginPut(deps.handle, {
    workspaceTag: route.tag, resourceTag: route.resourceTag,
    prevVersion, prevIncarnation, expectedLength: expectedLength as number,
    contentHash, signature: auth.signature,
  })
  if (!result.ok) {
    if (result.reason === 'workspace-full') { deny(res, 403, 'workspace-full'); return }
    denyConflict(res, result.conflict?.version ?? null, result.conflict?.incarnation ?? null); return
  }
  const { token, exp } = mintPutToken(deps.secret, route.tag, route.resourceTag, result.stagingId, expectedLength as number)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    stagingId: result.stagingId,
    urlPath: `/api/objstore/${route.tag}/${route.resourceTag}`,
    token,
    expiresAt: exp,
  }))
}

// op:'delete' — mirrors the WS `handleDelete`: verify the signed delete
// fields, freshness/replay-guard, then `deleteObject` (a precondition-checked
// version-CAS drop). Unlike put, there is NO operator gate — delete is
// signature-gated, idempotent, and creates nothing (the WS handleDelete has
// no authGate either). Returns 200 `{ deletedVersion }` (0 = idempotent
// no-op on a missing row with a null precondition); 409 conflict (stale
// prevVersion/incarnation); 404 not-found (a non-null precondition against a
// missing row). On a real drop it broadcasts `objstore-deleted` to
// subscribers (+ cross-instance), exactly like the WS path.
async function handleRestDelete(
  deps: ObjstoreRestDeps, res: ServerResponse, route: RouteMatch, body: object,
): Promise<void> {
  const auth = parseMintAuth(body)
  if (!auth) { deny(res, 400, 'bad-request'); return }
  const prevVersionRaw = (body as { prevVersion?: unknown }).prevVersion
  if (prevVersionRaw != null && (typeof prevVersionRaw !== 'number' || !Number.isSafeInteger(prevVersionRaw))) {
    deny(res, 400, 'bad-request'); return
  }
  const prevVersion = typeof prevVersionRaw === 'number' ? prevVersionRaw : null
  const prevIncarnationRaw = (body as { prevIncarnation?: unknown }).prevIncarnation
  const prevIncarnation = typeof prevIncarnationRaw === 'string' ? prevIncarnationRaw : null
  // null-iff-null pair (matches the WS `validPrevPair`); a non-null
  // incarnation must be the wire shape.
  if ((prevVersion === null) !== (prevIncarnation === null)) { deny(res, 400, 'bad-request'); return }
  if (prevIncarnation !== null && !isValidIncarnation(prevIncarnation)) { deny(res, 400, 'bad-request'); return }

  const fields = { workspaceTag: route.tag, resourceTag: route.resourceTag, prevVersion, prevIncarnation }
  if (!await verifyObjstoreDeleteRestSig(fields, auth.ts, auth.signature)) { deny(res, 401, 'unauthorized'); return }
  if (mintGuard.admit(auth.signature, auth.ts) !== 'ok') { deny(res, 401, 'unauthorized'); return }
  const result = await deleteObject(deps.handle, route.tag, route.resourceTag, prevVersion, prevIncarnation)
  if (!result.ok) {
    if (result.reason === 'conflict') { denyConflict(res, result.conflict?.version ?? null, result.conflict?.incarnation ?? null); return }
    deny(res, 404, 'not-found'); return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ deletedVersion: result.deletedVersion }))
  // deletedVersion 0 = nothing was live → nothing to broadcast. A real drop
  // fans out to subscribers (including the originator, matching the WS path's
  // `except: null`) so peers' `onDeleted` fire.
  if (result.deletedVersion === 0) return
  deps.broadcast(route.tag, { type: 'objstore-deleted', workspaceTag: route.tag, resourceTag: route.resourceTag, version: result.deletedVersion }, null)
  deps.publishObjDeleted(route.tag, route.resourceTag, result.deletedVersion)
}
