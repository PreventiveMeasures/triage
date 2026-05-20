// Subresource-integrity string for a blob — `sha512-<base64>` (the
// SRI format the bundles layer stores and verifies against).
// Centralised so the create-side (`storage.saveBundle`) and the
// verify-side (objstore presence auto-download) compute byte-identical
// strings; any drift here would make freshly-fetched bundles fail
// their integrity re-hash.
export async function computeSha512Integrity(bytes) {
  const hashBuf = await crypto.subtle.digest('SHA-512', bytes)
  return `sha512-${new Uint8Array(hashBuf).toBase64()}`
}
