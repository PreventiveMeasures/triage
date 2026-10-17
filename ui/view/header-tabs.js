// A header tab strip (dialogs/dialog-tabs.css), the dialogs' (their
// shared.js re-exports it) and a page's view drawing its tabs as theirs are
// (team-dependencies.js), apart from the dialogs, which views import only
// through lazy-dialogs.js.
import { html, nothing } from 'lit'

// Header tab strip for a dialog that opens on more than one thing —
// the workspace export's two exports, the report export's download and
// print. Renders the `role="tablist"` chrome (dialog-tabs.css) and
// carries the keyboard contract that role implies: arrows walk the
// strip, wrapping at the ends, and selection follows focus.
//
//   tabs     [{ id, label, icon? }] in strip order
//   current  the selected id
//   prefix   ids are `${prefix}-tab-${id}`, panels
//            `${prefix}-panel-${id}` — the caller labels its panel
//            with the same pair
//   select   called with the id to open
//   disabled locks the tabs that are not open (mid-export, say)
//
// The host re-renders on `select`, so the focus move waits a frame for
// the roving tabindex to land on the tab it is about to focus.
export function dialogTabs({ tabs, current, prefix, select, disabled = false }) {
  const onKeydown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const at = tabs.findIndex((t) => t.id === current)
    const step = e.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(at + step + tabs.length) % tabs.length]
    if (!next || next.id === current) return
    const list = e.currentTarget
    select(next.id)
    requestAnimationFrame(() => list.querySelector(`#${prefix}-tab-${next.id}`)?.focus())
  }
  return html`
    <div class="dlg-tabs" role="tablist" @keydown=${onKeydown}>
      ${tabs.map((t) => html`<button
        type="button"
        role="tab"
        class="dlg-tab"
        id=${`${prefix}-tab-${t.id}`}
        aria-controls=${`${prefix}-panel-${t.id}`}
        aria-selected=${String(current === t.id)}
        tabindex=${current === t.id ? 0 : -1}
        ?disabled=${disabled && current !== t.id}
        @click=${() => select(t.id)}
      >${t.icon ?? nothing}${t.label}</button>`)}
    </div>
  `
}
