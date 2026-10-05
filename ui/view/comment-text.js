import { html } from 'lit'
import { isManagedUiMode } from '#client/index.js'
import { parseCommentRefs } from './format.js'

// Render a triage comment, linkifying any GitHub issue / PR / commit /
// security-advisory URL the user pasted, plus any per-finding deep link
// into this instance ("duplicate of https://…/#finding=…").
// parseCommentRefs (format.js) does the strict validation + tokenisation;
// here we only map its segments to templates — plain `string` runs pass
// through untouched (an all-prose comment comes back as a single string),
// and each validated token becomes a compact `<a>`.
//
// The two token kinds render differently on purpose. An external ref
// (`owner/repo#123`, `owner/repo@sha`, `GHSA-xxxx-xxxx-xxxx`) opens in a
// new tab with the full URL in `title`. A self-link carries a
// finding href and must navigate IN PLACE: `target="_blank"` would
// boot a second copy of the app just to show a finding the reader is
// already three inches away from. Its `title` names the action rather
// than the href, which is an opaque id the reader can't act on.
export function renderCommentText(text) {
  return parseCommentRefs(text, { managed: isManagedUiMode() }).map((seg) => {
    if (typeof seg === 'string') return seg
    if (seg.self) {
      return html`<a class="comment-self-ref" href=${seg.url}>${seg.label}</a>`
    }
    return html`<a href=${seg.url} target="_blank" rel="noopener noreferrer" data-tooltip=${seg.url}>${seg.label}</a>`
  })
}

