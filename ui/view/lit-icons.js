// Button glyphs several views draw as Lit templates. icons.js keeps the
// raw-string set that also feeds the static drop zone.
import { html } from 'lit'

// Two offset sheets: copy a finding, a path, a file's contents.
export const COPY_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
  <rect x="3" y="2.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="5.5" y="5" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// Chevrons for previous / next steppers (findings, files, history).
export const PREV_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M10 3 5 8l5 5"/>
</svg>`
export const NEXT_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M6 3 11 8l-5 5"/>
</svg>`

// Line-wrap toggle of a source or diff viewer.
export const WRAP_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5h12M2 8h9a2.5 2.5 0 0 1 0 5H8.5M10 11.5 8.5 13l1.5 1.5M2 13h3.5"/></svg>`

// "Collapse directories" in a file tree rail.
export const COLLAPSE_DIRS_ICON = html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M5 2h8a1 1 0 0 1 1 1v8M3 5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM4.5 9.5h4"/></svg>`
