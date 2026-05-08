// Ed25519 signature verification for incoming wire messages. The
// canonical signing payload format is identical to the client's
// (see client/sync-crypto.js's `canonicalSavePayload`) so a
// signature produced by a holder of the workspace seed verifies
// here without re-derivation.
//
// Two payload types:
//   save:      `<domain>\n<pubkey>\n<base>\n<nonce>\n<ciphertext>`
//   subscribe: `<domain>\n<pubkey>`
//
// Domains are different so a save signature can't be replayed as
// a subscribe and vice versa.

import { Buffer } from 'node:buffer'
import { encodeUtf8 } from '../common/utf8.js'

const SAVE_DOMAIN = 'deepview-triage-sync.v1.save'
const SUBSCRIBE_DOMAIN = 'deepview-triage-sync.v1.subscribe'

function fromB64Url(str) {
  return Buffer.from(str, 'base64url')
}

function canonicalSave({ workspaceTag, base, nonce, ciphertext }) {
  return encodeUtf8([
    SAVE_DOMAIN,
    workspaceTag,
    base == null ? '' : String(base),
    nonce,
    ciphertext,
  ].join('\n'))
}

function canonicalSubscribe({ workspaceTag, from }) {
  const fromStr = from == null ? '' : String(from)
  return encodeUtf8([SUBSCRIBE_DOMAIN, workspaceTag, fromStr].join('\n'))
}

async function verifyEd25519(pubkeyB64Url, message, sigB64Url) {
  const pubkeyBytes = fromB64Url(pubkeyB64Url)
  const sigBytes = fromB64Url(sigB64Url)
  if (pubkeyBytes.length !== 32) return false
  if (sigBytes.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      pubkeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify('Ed25519', key, sigBytes, message)
  } catch {
    return false
  }
}

// Wrap encoder + verify in a try/catch — `encodeUtf8` throws on
// non-string or lone-surrogate input (any of which on the wire is
// already a hostile / malformed message), so we treat any error
// in the canonical-payload path as a verification failure.
export function verifySaveSig(msg) {
  if (typeof msg.signature !== 'string') return false
  let payload
  try { payload = canonicalSave(msg) } catch { return false }
  return verifyEd25519(msg.workspaceTag, payload, msg.signature)
}

// Content-addressed revision id — SHA-256 of the canonical save
// bytes (same input the signature covers), base64url no padding.
// Server doesn't get to assign ids: it derives the id from received
// content and stores under that. Mirrors the client's
// `computeRevisionId` so two ends always land on the same string.
export async function computeRevisionId(msg) {
  let payload
  try { payload = canonicalSave(msg) } catch { return null }
  const digest = await crypto.subtle.digest('SHA-256', payload)
  return Buffer.from(new Uint8Array(digest)).toString('base64url')
}

export function verifySubscribeSig(msg) {
  if (typeof msg.signature !== 'string') return false
  let payload
  try { payload = canonicalSubscribe(msg) } catch { return false }
  return verifyEd25519(msg.workspaceTag, payload, msg.signature)
}
