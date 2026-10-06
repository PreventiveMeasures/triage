// Bundle entry paints a loading shell and then its metadata while the sidebar
// reveals the selected workspace row. A document-wide crossfade snapshots
// these independently timed updates and flashes the surrounding app chrome.
export function createViewRenderer(paint) {
  let activeTransition = null, previousView = null
  return (view, { animate = true } = {}) => {
    const changed = previousView !== null && previousView !== view
    previousView = view
    if (view === 'bundles') {
      activeTransition?.skipTransition()
      animate = false
    }
    if (!animate || !changed || typeof document.startViewTransition !== 'function'
        || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint()
      return
    }
    const transition = activeTransition = document.startViewTransition(paint)
    // Skipping the animation still runs its pending update callback. The
    // painter reads current state, so it cannot restore an older view.
    transition.ready.catch(() => {})
    transition.finished.finally(() => {
      if (activeTransition === transition) activeTransition = null
    }).catch(() => {})
  }
}
