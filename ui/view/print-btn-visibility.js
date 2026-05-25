// Print-button visibility — toggles `body.show-print-btn` based on
// whether a report is loaded AND the current view-mode is printable.
// The print button (`#print-btn` in index.html) is hidden by
// default; this body class flips it visible.
//
// Previously this was a `document.body.classList.toggle('show-print-btn',
// ...)` call inside `renderImpl()` that re-ran on EVERY render(),
// plus two imperative `classList.remove('show-print-btn')` calls in
// ingest.js to handle workspace/unload flows.
//
// Now an `autorun()` from `@rray/frontend/state-management` —
// observer-util tracks the four state reads inside the callback and
// re-fires the body-class update synchronously on any mutation, so
// the rendering pipeline no longer carries this concern and the
// imperative ingest.js removals fall out (state.reports clearing
// triggers the autorun, which sets reports.length === 0 → class
// removed). Same reactivity infrastructure StateElement uses, just
// without a component wrapper — autoruns are the right shape for
// pure side effects.
import { autorun } from '@rray/frontend/state-management'
import { state } from '#client/index.js'

autorun(() => {
  const visible = (
    state.reports.length > 0 &&
    state.currentView === 'findings' &&
    state.viewMode !== 'graph' &&
    state.viewMode !== 'kanban'
  )
  document.body.classList.toggle('show-print-btn', visible)
})
