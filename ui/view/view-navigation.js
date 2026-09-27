// Source downloads and annotation reads belong to one active view. Abort as
// soon as navigation starts; the account/team feed survives same-scope changes.
let generation = 0
let controller = new AbortController()

export function currentViewGeneration() { return generation }
export function currentViewSignal() { return controller.signal }
export function beginViewNavigation() {
  controller.abort()
  controller = new AbortController()
  return ++generation
}
