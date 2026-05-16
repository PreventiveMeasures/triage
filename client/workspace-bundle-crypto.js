// Workspace bundle encryption — thin domain wrapper around
// `password-crypto.js`. The plaintext is a gzipped JSON blob
// and the wire ships as raw bytes (not base64url); crypto + wire shape
// are identical to the share-link side.

import {
  decryptWithPasswordOrThrow,
  encryptWithPassword,
  isEncryptedWire,
} from './password-crypto.js'

export const isEncryptedBundle = isEncryptedWire
export const encryptBundle = encryptWithPassword

export function decryptBundle(encryptedBytes, password) {
  return decryptWithPasswordOrThrow(encryptedBytes, password, {
    malformedMsg: 'malformed encrypted bundle',
    wrongPasswordMsg: 'wrong password or corrupt bundle',
  })
}
