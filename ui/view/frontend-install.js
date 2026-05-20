// Install side of the cross-bundle frontend slot. Imported as the
// first thing in `ui/view.js` so the slot is set BEFORE any of
// view.js's other transitive imports get a chance to load
// `./frontend-global.js` (which reads the slot at module-init time
// and throws if it isn't there). The ordering guarantee comes from
// ESM evaluation semantics — view.js's first import declaration is
// this module, so its dependency tree (lit + lit/directives +
// @rray/frontend/state-element) finishes evaluating, this module's
// body runs (installing the slot), and only then does view.js move
// on to its next import (`./view/dom.js`, which transitively pulls
// `./view/format.js`, the first consumer of the wrapper).
//
// The lazy bundles (`ui/terminal.js`, `ui/graph.js`) don't import
// this module. They load long after boot, by which time view.js
// has already installed; their copy of `frontend-global.js` reads
// the same slot via `Symbol.for('@rray/frontend')`.

import { LitElement, html, nothing, render, unsafeCSS } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { StateElement } from '@rray/frontend/state-element'

globalThis[Symbol.for('@rray/frontend')] = { LitElement, html, nothing, render, unsafeCSS, StateElement, classMap, repeat, styleMap }
