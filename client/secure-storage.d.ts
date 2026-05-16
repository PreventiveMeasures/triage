// Hand-written type surface for `client/secure-storage.js`. Mirrors
// the `triage.d.ts` / `workspaces.d.ts` pattern so the JS source
// stays untouched while TypeScript consumers (state.ts) get types.

export const SECURE_KEYS: readonly string[]

export function getItem(key: string): string | null
export function setItem(key: string, value: string): Promise<void>
export function removeItem(key: string): void

export function hydrate(): Promise<void>

export function onAfterHydrate(cb: () => void): () => void

export function drainWriteChain(): Promise<void>

export function mutate(
  key: string,
  updater: (current: string | null) => string | null | undefined | Promise<string | null | undefined>,
): Promise<void>

export function migrateToEncrypted(opts: {
  seal: (bytes: Uint8Array, aad: Uint8Array) => Promise<Uint8Array>,
}): Promise<void>

export function migrateToPlaintext(opts: {
  open: (bytes: Uint8Array, aad: Uint8Array) => Promise<Uint8Array>,
}): Promise<void>

export const __test__: {
  reset(): void,
}
