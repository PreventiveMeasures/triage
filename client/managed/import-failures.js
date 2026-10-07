export const RETRY_HINT = 'You can retry the remaining steps.'

// The reason one item failed, without the batch-level retry hint or a final
// period, so several can be joined into one sentence.
export function importFailure(err) {
  return String(err?.detail ?? err?.message ?? err).replace(/\.$/u, '')
}

// Item-level failures are collected so the rest of a batch still imports.
// Cancellation (the session, the signal, or a cancelled conflict dialog) ends it.
export function stopsImport(err, signal) {
  return signal?.aborted === true || err?.name === 'AbortError' || err?.cancelled === true
}
