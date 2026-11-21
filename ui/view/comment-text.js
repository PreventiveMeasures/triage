import { html } from 'lit'
import { isManagedUiMode } from '#client/index.js'
import { parseCommentRefs } from './format.js'

// A triage comment with its validated refs (format.js parseCommentRefs)
// as links. An external ref opens in a new tab, its URL in the tooltip; a
// self-link to a finding navigates IN PLACE (a new tab would boot a second
// app), without a tooltip: its href is an opaque id.
export function renderCommentText(text) {
  return parseCommentRefs(text, { managed: isManagedUiMode() }).map((seg) => {
    if (typeof seg === 'string') return seg
    if (seg.self) {
      return html`<a class="comment-self-ref" href=${seg.url}>${seg.label}</a>`
    }
    return html`<a href=${seg.url} target="_blank" rel="noopener noreferrer" data-tooltip=${seg.url}>${seg.label}</a>`
  })
}

