// Type declarations for `state-management.mjs`. Hand-written so the
// `.mjs` source stays untouched (it is backported upstream as-is) and
// `tsc --noEmit` doesn't need `allowJs: true` to traverse it. Mirrors
// the `common/utf8.d.ts` approach.

// Wraps an object in an observer-util reactive proxy. Reads done from
// inside a tracked reaction (StateElement.render / `autorun` / etc.)
// are recorded; mutations to those keys re-fire the reaction.
export function store<T extends object>(obj: T): T

// Reactive autorun — `method` runs once synchronously with `first =
// true`, then re-runs whenever a tracked observable it read changes
// (each subsequent run gets `first = false`). Returns a dispose
// closure that unsubscribes the reaction.
export function autorun(method: (first: boolean) => void): () => void

// Build a Promise that resolves the first time `condition(first)`
// returns a truthy value across reactive re-runs. The returned promise
// carries a `.abort(reason)` method that rejects it.
export function autopromise<T>(
  condition: (first: boolean) => T,
): Promise<NonNullable<T>> & { abort: (reason?: unknown) => void }
