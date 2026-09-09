// The glyphs the export flow is drawn with, in one place because two
// surfaces share them: the toolbar's export button
// (view/download-button.js) and the tabs of the dialog it opens
// (dialogs/export-confirm-dialog.js), where Markdown and Print are the
// two ways out of the same selection. Lit templates rather than the
// raw-SVG strings in view/icons.js — both consumers are Lit, and one
// of them renders into a shadow root where `unsafeHTML` would buy
// nothing.
//
// The button in the toolbar keeps the download arrow: what it offers
// is a copy of the report, whichever form the reader picks inside. The
// tab that writes the file says what the file IS, and wears the
// Markdown mark for it.
import { html } from 'lit'

export const DOWNLOAD_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" x2="12" y1="15" y2="3"/>
</svg>`

// The CommonMark mark — a framed M with a descending arrow. Drawn at
// the same 24-unit box as its neighbours, on a finer stroke because
// there is more inside the frame than a printer or an arrow has.
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
