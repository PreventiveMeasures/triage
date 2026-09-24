// Is a modal dialog open anywhere on the page? `showModal()` stacks a
// second modal on top of an open one rather than refusing, so code that
// must not stack (an `AppDialog` opened `exclusive`, the auto-opened sync
// suggestion) has to look first.
//
// `:modal` doesn't see through a shadow boundary, and the app's dialogs
// render their `<dialog>` inside a Lit shadow root, so this walks into
// every open shadow root (recursively). Import-free on purpose — no Lit,
// no CSS — so node tests can exercise it with a stub DOM.
export function hasOpenModal(root = document) {
  if (root.querySelector(':modal')) return true
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot && hasOpenModal(el.shadowRoot)) return true
  }
  return false
}
