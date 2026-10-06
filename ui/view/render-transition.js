// Track explicit animations so navigation can remove their snapshots before
// painting the destination. View changes themselves do not animate.
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

// Navigation always paints immediately. Same-view renders inside a Kanban
// animation's update callback must leave that animation running.
export function createViewRenderer(paint) {
  let previousView = null
  return view => {
    if (previousView !== null && previousView !== view) {
      activeTransition?.skipTransition()
    }
    previousView = view
    paint()
  }
}
