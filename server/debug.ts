// Truncate a base64url tag for `DEBUG=1` logging. A full workspaceTag
// is an Ed25519 public key; operator logs shouldn't carry it verbatim.
// Shared by server/index.ts and server/objstore/handlers.ts so the two
// log surfaces stay on one convention.
export function debugTag(s: string): string { return `${s.slice(0, 12)}…` }
