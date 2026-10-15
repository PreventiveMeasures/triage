// The app's Trusted Types policy. index.html's CSP sets
// `require-trusted-types-for 'script'`, so every DOM sink that parses
// HTML or loads a script refuses a plain string, and `trusted-types`
// admits two policies by name: Lit's own `lit-html`, which blesses its
// templates, and this one, for the few sinks outside Lit.
//
// `trustedHTML` takes the markup this app writes — an icon, Prism's
// colouring, the export preview's rows — and markup.js decides what that
// is: the same check `appMarkup()` makes for Lit, run inside the policy, so
// nothing it blesses has skipped it. A string that fails is set as the
// text it is, escaped, and reported. Never a way in for data: text a
// report, a user or the network supplied goes in as text (`textContent`,
// a Lit binding), not through here.
//
// `trustedScriptURL` admits a same-origin script only (the brotli
// fallback's worker), so a URL from anywhere else throws at the sink
// just as it would with no policy at all.
//
// Without Trusted Types (Node under the tests, a browser that predates
// them) the markup is checked all the same, and both hand back strings,
// which the sinks take as they are.
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
