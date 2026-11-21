// A component's event for its host: bubbling and composed, so a listener
// above any shadow root hears it (events.js listens on #report).
export function emit(el, type, detail) {
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }))
}
