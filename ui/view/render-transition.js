// Track every document transition, including Kanban detail animations, so
// synchronous bundle navigation can remove snapshots started by any caller.
let activeTransition = null

export function startViewTransition(update) {
  const transition = activeTransition = document.startViewTransition(update)
  // Skipping the animation still runs its pending update callback. Callers
  // render current state, so it cannot restore an older view.
  transition.ready.catch(() => {})
  transition.finished.finally(() => {
    if (activeTransition === transition) activeTransition = null
  }).catch(() => {})
  return transition
}

// Navigation into and out of bundles updates the main content and sidebar
// independently. Keep both directions synchronous so a document-wide
// crossfade cannot flash the surrounding app chrome during those updates.
export function createViewRenderer(paint) {
  let previousView = null
  return (view, { animate = true } = {}) => {
    const changed = previousView !== null && previousView !== view
    if (view === 'bundles' || previousView === 'bundles') {
      activeTransition?.skipTransition()
      animate = false
    }
    previousView = view
    if (!animate || !changed || typeof document.startViewTransition !== 'function'
        || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint()
      return
    }
    startViewTransition(paint)
  }
}
