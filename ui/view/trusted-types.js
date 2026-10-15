// The app's Trusted Types policy. index.html's CSP sets
// `require-trusted-types-for 'script'`, so every DOM sink that parses
// HTML or loads a script refuses a plain string, and `trusted-types`
// admits two policies by name: Lit's own `lit-html`, which blesses its
// templates (and with them every `unsafeHTML`), and this one, for the
// few sinks outside Lit.
//
// `trustedHTML` is for markup this app wrote — an icon from icons.js or
// file-display.js, a slot's empty shell — or that Prism wrote, which
// escapes the source it colours. Never for data: text a report, a user
// or the network supplied goes in as text (`textContent`, a Lit
// binding), not through here.
//
// `trustedScriptURL` admits a same-origin script only (the brotli
// fallback's worker), so a URL from anywhere else throws at the sink
// just as it would with no policy at all.
//
// Without Trusted Types (Node under the tests, a browser that predates
// them) both hand back what they were given, which the sinks take as is.
const policy = globalThis.trustedTypes?.createPolicy('deepview', {
  createHTML: html => html,
  createScriptURL: (url) => {
    const parsed = new URL(url, globalThis.location.href)
    if (parsed.origin !== globalThis.location.origin) throw new TypeError(`Not a same-origin script: ${parsed.href}`)
    return parsed.href
  },
})

export const trustedHTML = html => policy ? policy.createHTML(html) : html
export const trustedScriptURL = url => policy ? policy.createScriptURL(String(url)) : url
