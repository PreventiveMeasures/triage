// A view's callback (its `_repaint`, one for as long as it lives), as a cache
// kept past the view holds it: a comparison kept for the next view to open
// holds the callback weakly, not the view with it, which is told while it is
// still there. One wrapper for each callback, so that a set of those to tell
// tells each once.
const wrappers = new WeakMap()
export function weakNotify(notify) {
  if (typeof notify !== 'function' || typeof WeakRef !== 'function') return notify ?? null
  let wrapper = wrappers.get(notify)
  if (!wrapper) {
    const held = new WeakRef(notify)
    wrapper = () => held.deref()?.()
    wrappers.set(notify, wrapper)
  }
  return wrapper
}
