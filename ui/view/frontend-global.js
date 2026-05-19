// Read side of the cross-bundle frontend slot — a Symbol-keyed
// global on which view.js publishes lit + StateElement at boot. The
// lazy bundles (`ui/terminal.js`, `ui/graph.js`) re-export lit names
// through this wrapper instead of `import … from 'lit'`, so the
// entry-point import in each lazy bundle doesn't reach into the lit
// package and pull a second copy of the runtime into the chunk.
//
// view.js itself doesn't import this module — it writes the global
// inline at boot. Lazy bundles load via `await import('./terminal.js')`
// / `await import('./graph.js')` long after view.js has finished its
// top-level boot work, so by the time this module is first imported,
// the slot is populated.
//
// The Symbol key (`Symbol.for('@rray/frontend')`) is registry-shared
// so any other bundle on the same page that needs to peek at the
// same exports can find them under the same key without us exporting
// the Symbol itself.

const slot = globalThis[Symbol.for('@rray/frontend')]
if (!slot) throw new Error('@rray/frontend global not installed; view.js must run before lazy bundles import this wrapper')

export const { LitElement, html, nothing, unsafeCSS, render, StateElement } = slot
