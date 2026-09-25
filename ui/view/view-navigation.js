// Source downloads belong to one active view. Abort the transport as soon as
// navigation starts, including while the next page is still loading.
let generation = 0
let controller = new AbortController()

export function currentViewGeneration() { return generation }
export function currentViewSignal() { return controller.signal }
export function beginViewNavigation() {
  controller.abort()
  controller = new AbortController()
  return ++generation
}
