// The app's Trusted Types policy. index.html's CSP sets
// `require-trusted-types-for 'script'`, so every sink parsing HTML or loading
// a script refuses a plain string; `trusted-types` admits Lit's own
// `lit-html` and this policy, for the few sinks outside Lit.
//
// `trustedHTML` takes the markup this app writes, which markup.js decides —
// the check `appMarkup()` makes, run inside the policy, so nothing it
// blesses skipped it. A failing string is set as its escaped text, and
// reported. Never a way in for data: text from a report, a user or the
// network goes in as text (`textContent`, a Lit binding).
//
// `trustedScriptURL` admits a same-origin script only (the brotli fallback's
// worker); any other URL throws at the sink, as with no policy at all.
//
// Without Trusted Types (Node in tests, an older browser) the markup is
// checked all the same and both return strings.
import { isAppMarkup, refusedMarkup } from './markup.js'

const escapeText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const checkedHTML = html => isAppMarkup(html) ? html : escapeText(refusedMarkup(String(html)))

const policy = globalThis.trustedTypes?.createPolicy('deepview', {
  createHTML: checkedHTML,
  createScriptURL: (url) => {
    const parsed = new URL(url, globalThis.location.href)
    if (parsed.origin !== globalThis.location.origin) throw new TypeError(`Not a same-origin script: ${parsed.href}`)
    return parsed.href
  },
})

export const trustedHTML = html => policy ? policy.createHTML(html) : checkedHTML(html)
export const trustedScriptURL = url => policy ? policy.createScriptURL(String(url)) : url
