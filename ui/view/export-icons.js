// The export flow's glyphs, shared by the toolbar's button (download-button.js)
// and its dialog's tabs (dialogs/export-confirm-dialog.js). Lit templates: both
// consumers are Lit. The button keeps the download arrow — whichever form is
// picked, it offers a copy of the report — while the tab writing the file
// wears the Markdown mark.
import { html } from 'lit'

export const DOWNLOAD_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" x2="12" y1="15" y2="3"/>
</svg>`

// The CommonMark mark, a framed M over a descending arrow, on a finer
// stroke for the more it holds.
export const MARKDOWN_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="1.8" y="5" width="20.4" height="14" rx="2"/>
  <path d="M5.6 15.6V8.4l3.1 3.6 3.1-3.6v7.2"/>
  <path d="M16.9 8.4v7.2m-2.6-2.9 2.6 2.9 2.6-2.9"/>
</svg>`

export const PRINT_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M6 9V2h12v7"/>
  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
  <rect x="6" y="14" width="12" height="8"/>
</svg>`
