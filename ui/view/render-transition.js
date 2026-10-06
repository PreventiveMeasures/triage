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

// Bundle entry paints a loading shell and then its metadata while the sidebar
// reveals the selected workspace row. A document-wide crossfade snapshots
// these independently timed updates and flashes the surrounding app chrome.
export function createViewRenderer(paint) {
  let previousView = null
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
    startViewTransition(paint)
  }
}
