import { css, html } from 'lit'

export const ADD_ROW_ICON = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`
export const REMOVE_ROW_ICON = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>`

export const ROW_ACTION_STYLES = css`
  .row-action { display: grid; place-items: center; flex: 0 0 auto; width: 1.5rem; height: 1.5rem; padding: .25rem; border: 0; border-radius: var(--ui-radius, 4px); color: var(--muted); background: transparent; }
  .row-action:hover:not(:disabled) { color: var(--text); background: var(--surface-active); }
  .row-action:disabled { opacity: .4; }
  .row-action svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.4; }
`
