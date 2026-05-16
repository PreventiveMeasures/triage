// `workspace-save-error` reason taxonomy — shared by server (emits)
// and client (parses). Single source of truth so a server-side
// change to the closed set surfaces at the client's
// compile-error, not at runtime as a silent `'rejected'` coercion.
//
// Wire shape (server → client):
//   { type: 'workspace-save-error',
//     workspaceTag: string,
//     base: string | null,
//     reason: SaveErrorReason }
//
// Semantics:
//   `too-large`   — ciphertext exceeded MAX_CIPHERTEXT_LEN. Hard
//                   error; retry won't help. Client surfaces via
//                   `session.error` until `dismissError()`.
//   `busy`        — per-socket inflight cap dropped the save
//                   (transport backpressure). Recoverable; the
//                   client clears `pending` and re-arms
//                   `pendingSave` for the next natural trigger.
//   `stale-base`  — concurrent commit advanced the head past the
//                   client's claimed base. The server emits the
//                   typed frame AFTER a `workspace-state` catch-up
//                   on the same wire — in normal protocol order,
//                   the catch-up handler clears `pending` first
//                   and this frame's handler then early-returns
//                   on the missing pending. So `stale-base` is
//                   NOT in the recoverable set: in the happy path
//                   the recoverable branch is unreachable; in the
//                   pathological case where wire order flipped,
//                   we'd rather mark the session errored (visible
//                   via UI + recoverable via `dismissError()`)
//                   than silently swallow a state divergence.

export type SaveErrorReason = 'too-large' | 'busy' | 'stale-base'

// Reasons the client treats as recoverable backpressure / race
// signals rather than hard rejections. Typed so a future addition
// like `'rate-limited'` MUST decide which bucket it belongs in at
// compile time. See module docstring for why `'stale-base'` is
// deliberately absent.
export const RECOVERABLE_SAVE_ERROR_REASONS: ReadonlySet<SaveErrorReason> = new Set<SaveErrorReason>([
  'busy',
])

// Every typed reason the server is currently allowed to emit.
// Tests pin this — a server-side addition that doesn't update the
// taxonomy here would fail the regression in
// `tests/save-error-reason-taxonomy.test.js`.
export const SAVE_ERROR_REASONS: ReadonlySet<SaveErrorReason> = new Set<SaveErrorReason>([
  'too-large',
  'busy',
  'stale-base',
])
