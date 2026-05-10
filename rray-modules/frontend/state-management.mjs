import { observable, observe, unobserve } from '@nx-js/observer-util/dist/es.es6.js';

const store = observable;

// Wrap a function in an observer-util reaction that re-runs whenever
// a tracked observable it read changes. Returns a `dispose` closure
// that unsubscribes the reaction. The first invocation receives
// `first = true` so callers can branch on initial-render vs. update.
//
// Robustness notes (audit round-15):
//   * `first = false` toggles in `finally`, so even if `method`
//     throws on the initial run, subsequent re-runs (triggered by
//     observables touched BEFORE the throw) don't replay the
//     first-run path.
//   * `observe(fn)` runs `fn` before returning the reaction handle:
//     when `fn` throws on the first run, the handle is lost and
//     observer-util's connectionStore retains the reaction for any
//     observable accessed before the throw — a leak that would
//     re-trigger the broken reaction forever. We use `lazy: true`
//     and run the reaction manually so we always have the handle,
//     and call `unobserve` in a catch block before re-throwing.
function autorun(method) {
  let first = true;
  const reaction = observe(() => {
    try {
      method(first);
    } finally {
      first = false;
    }
  }, { lazy: true });
  try {
    reaction();
  } catch (err) {
    unobserve(reaction);
    throw err;
  }
  return () => unobserve(reaction);
}

// Build a Promise that resolves the first time `condition(first)`
// returns a truthy value across reactive re-runs. `condition` is
// evaluated immediately (synchronously) and again whenever a
// tracked observable it read changes; the first matching value
// wins. The returned promise carries a `.abort(reason)` method
// that rejects it.
//
// Robustness notes (audit round-15):
//   * Synchronous first-run throws — autorun unobserves the leaked
//     reaction before re-throwing; the catch here forwards the
//     rejection to the promise.
//   * `resolved` short-circuits re-runs after a match, so a tracked
//     observable mutating between `resolve()` and the dispose call
//     can't invoke `condition` a second time (which could throw
//     from the mutation site instead of from `autopromise`'s
//     caller).
//   * Dispose runs SYNCHRONOUSLY when the match happens (rather
//     than via `promise.finally`, which defers to a microtask).
//     For a same-tick first-run resolve, `dispose` isn't assigned
//     until autorun returns; the post-autorun fixup picks it up.
function autopromise(condition) {
  let abort;
  let dispose;
  let resolved = false;
  const promise = new Promise((resolve, reject) => {
    abort = reject;
    try {
      dispose = autorun(first => {
        if (resolved) return;
        const result = condition(first);
        if (!result) return;
        resolved = true;
        resolve(result);
        if (dispose) dispose();
      });
    } catch (err) {
      reject(err);
      return;
    }
    if (resolved) dispose();
  });
  promise.abort = abort;
  return promise;
}

export { store, autorun, autopromise };
